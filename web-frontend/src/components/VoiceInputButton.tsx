/**
 * VoiceInputButton — push-to-talk dictation via the Web Speech API.
 *
 * Behaviour:
 *   - Feature-detected: if neither `SpeechRecognition` nor
 *     `webkitSpeechRecognition` is present on `window`, the button
 *     renders nothing (a no-op shell). The caller can still mount it
 *     unconditionally; the consumer adds zero footprint on unsupported
 *     browsers.
 *   - Push-to-talk: pointerdown → start, pointerup / pointercancel /
 *     pointerleave → stop. Touchstart/touchend forward to the same
 *     handlers so iPad Safari (which DOES ship SpeechRecognition) works.
 *   - The dictated text is APPENDED to the current draft, separated by
 *     a single space when the existing draft is non-empty and doesn't
 *     already end in whitespace. The append-after-space contract is
 *     documented so callers know they can pre-populate the composer
 *     and not have it wiped.
 *   - Locale: `lang` is mapped from the store's `Locale` slice
 *     (`en` → `en-US`, `ru` → `ru-RU`). The mapping is intentionally
 *     coarse — Web Speech only needs a BCP-47 tag.
 *   - Permission denied / no-microphone errors raise a toast via the
 *     `pushToast` action.
 *
 * Browser support (May 2026):
 *   - Chrome / Edge / Opera (Chromium): yes (webkit prefix until very
 *     recently; both names work).
 *   - Safari (macOS 14+ / iOS 14.5+): yes, prefix-only.
 *   - Firefox: NO — Mozilla never shipped a stable implementation.
 *     The feature-detect short-circuits and the button is hidden.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useT } from '../i18n';
import { Mic, MicOff } from '../icons';
import { useStore, type Locale } from '../state/store';

import styles from './VoiceInputButton.module.css';

/**
 * Minimal subset of the W3C SpeechRecognition contract we depend on.
 * The DOM lib doesn't ship full typings; defining the shape locally
 * keeps the component strict-mode clean without `any`.
 */
interface SpeechRecognitionResultLite {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface SpeechRecognitionResultListLite {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLite;
}
interface SpeechRecognitionEventLite {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLite;
}
interface SpeechRecognitionErrorEventLite {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionLite {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLite) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLite) => void) | null;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLite;

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

/**
 * Pull the SpeechRecognition constructor from `window`, prefix-tolerant.
 * Exported so tests can verify the resolution order.
 */
export function getSpeechRecognitionCtor(
  win: SpeechRecognitionWindow | undefined = typeof window === 'undefined'
    ? undefined
    : (window as unknown as SpeechRecognitionWindow),
): SpeechRecognitionCtor | null {
  if (win === undefined) return null;
  if (typeof win.SpeechRecognition === 'function') return win.SpeechRecognition;
  if (typeof win.webkitSpeechRecognition === 'function') {
    return win.webkitSpeechRecognition;
  }
  return null;
}

/** BCP-47 tag for the active locale. */
export function recognitionLangForLocale(locale: Locale): string {
  if (locale === 'ru') return 'ru-RU';
  return 'en-US';
}

/**
 * Append `transcript` to `draft`. If `draft` already ends in whitespace,
 * the transcript is appended verbatim; otherwise a single space is
 * inserted as the separator so words don't collide. Empty drafts return
 * the transcript unchanged (no leading space).
 */
export function appendTranscript(draft: string, transcript: string): string {
  if (transcript.length === 0) return draft;
  if (draft.length === 0) return transcript;
  if (/\s$/.test(draft)) return `${draft}${transcript}`;
  return `${draft} ${transcript}`;
}

export interface VoiceInputButtonProps {
  /** Current composer draft — used to compute the appended result. */
  draft: string;
  /** Receives the new draft text whenever an interim/final result lands. */
  onTranscript: (next: string) => void;
  /** Disable the button (mirrors the composer's disabled state). */
  disabled: boolean;
  /** Inject a SpeechRecognition factory for tests. */
  factory?: () => SpeechRecognitionLite | null;
}

export function VoiceInputButton(
  props: VoiceInputButtonProps,
): JSX.Element | null {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const pushToast = useStore((s) => s.pushToast);

  // Feature-detect once. If the factory is injected (tests) we still go
  // through the same code path so behaviour is identical.
  const [supported] = useState<boolean>(() => {
    if (props.factory !== undefined) return true;
    return getSpeechRecognitionCtor() !== null;
  });

  const [listening, setListening] = useState<boolean>(false);

  // The active recognition instance + the baseline draft captured at
  // start. We compose every interim result onto the baseline so that
  // backspacing while listening stays sane — we never re-insert an old
  // interim chunk on top of itself.
  const recRef = useRef<SpeechRecognitionLite | null>(null);
  const baselineRef = useRef<string>('');
  const lastTranscriptRef = useRef<string>('');

  // Always tear down on unmount so an in-flight session doesn't keep the
  // microphone hot after the user navigates away.
  useEffect(() => {
    return () => {
      const rec = recRef.current;
      if (rec !== null) {
        try {
          rec.abort();
        } catch {
          /* ignored */
        }
        recRef.current = null;
      }
    };
  }, []);

  const stop = useCallback((): void => {
    const rec = recRef.current;
    if (rec === null) return;
    try {
      rec.stop();
    } catch {
      /* ignored — common when called twice */
    }
  }, []);

  const start = useCallback((): void => {
    if (listening) return;
    let rec: SpeechRecognitionLite | null;
    if (props.factory !== undefined) {
      rec = props.factory();
    } else {
      const Ctor = getSpeechRecognitionCtor();
      if (Ctor === null) {
        pushToast({ level: 'warning', message: t('composer.voice.unavailable') });
        return;
      }
      try {
        rec = new Ctor();
      } catch {
        pushToast({ level: 'error', message: t('composer.voice.unavailable') });
        return;
      }
    }
    if (rec === null) {
      pushToast({ level: 'error', message: t('composer.voice.unavailable') });
      return;
    }
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = recognitionLangForLocale(locale);
    baselineRef.current = props.draft;
    lastTranscriptRef.current = '';

    rec.onresult = (ev): void => {
      // Concatenate every result from this session — the API emits both
      // interim and final pieces, and we want a stable rolling transcript.
      let transcript = '';
      for (let i = 0; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        if (r !== undefined) transcript += r[0].transcript;
      }
      lastTranscriptRef.current = transcript;
      props.onTranscript(appendTranscript(baselineRef.current, transcript));
    };
    rec.onerror = (ev): void => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        pushToast({ level: 'warning', message: t('composer.voice.denied') });
      } else if (ev.error === 'no-speech' || ev.error === 'aborted') {
        // Silent: these fire on push-to-talk releases without speech.
      } else {
        pushToast({
          level: 'error',
          message: t('composer.voice.error', { message: ev.error }),
        });
      }
    };
    rec.onstart = (): void => setListening(true);
    rec.onend = (): void => {
      setListening(false);
      recRef.current = null;
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      // Some browsers throw if start() is called too quickly after a
      // previous session ended. Surface as a toast and reset state.
      recRef.current = null;
      setListening(false);
      pushToast({
        level: 'warning',
        message: t('composer.voice.error', { message: 'busy' }),
      });
    }
  }, [listening, locale, props, pushToast, t]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>): void => {
      if (props.disabled || !supported) return;
      e.preventDefault();
      // Capture so we still get pointerup even if the user drags off.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported in some test environments */
      }
      start();
    },
    [props.disabled, supported, start],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!supported) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignored */
      }
      stop();
    },
    [supported, stop],
  );

  const onPointerCancel = useCallback((): void => {
    stop();
  }, [stop]);

  if (!supported) return null;

  const label = listening
    ? t('composer.voice.stopAria')
    : t('composer.voice.startAria');
  const title = listening
    ? t('composer.voice.stop')
    : t('composer.voice.start');

  return (
    <button
      type="button"
      className={styles.btn}
      data-active={listening ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={label}
      aria-pressed={listening}
      title={title}
      disabled={props.disabled}
    >
      {listening ? (
        <MicOff size={16} strokeWidth={1.5} />
      ) : (
        <Mic size={16} strokeWidth={1.5} />
      )}
    </button>
  );
}
