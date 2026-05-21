/**
 * VoiceOutputButton — per-message speak control for assistant messages.
 *
 * Uses the Web Speech API (`window.speechSynthesis`). Strips markdown
 * before feeding the text to a `SpeechSynthesisUtterance`. Picks a voice
 * matching the active locale from the Zustand store; falls back to the
 * platform default when no exact match is available.
 *
 * State machine (`'idle' | 'speaking' | 'paused'`):
 *   - idle    → click: start speaking
 *   - speaking → click: pause (browser keeps the queue); Esc / long-press: stop
 *   - paused  → click: resume
 *
 * Feature-detected: the component renders `null` when
 * `window.speechSynthesis` is absent (Safari iframe sandboxes, ancient
 * browsers, jsdom test runs without the polyfill).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import { useStore } from '../state/store';
import { Pause, Play, StopCircle } from '../icons';

import styles from './VoiceOutputButton.module.css';

export interface VoiceOutputButtonProps {
  /** Raw assistant message body (markdown). Stripped before speaking. */
  text: string;
  /** Optional explicit locale override (e.g. for unit tests). */
  localeOverride?: 'en' | 'ru';
}

export type VoiceOutputState = 'idle' | 'speaking' | 'paused';

/**
 * Minimal narrowing of the Web Speech API surface we touch. Exported so
 * tests can inject a hand-rolled stub without monkey-patching globals.
 */
export interface SpeechSynth {
  speak(utterance: SpeechSynthesisUtterance): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  getVoices(): SpeechSynthesisVoice[];
  paused: boolean;
  speaking: boolean;
}

/**
 * Strip the small subset of markdown that's annoying for TTS:
 *   - Triple-backtick code fences (block removed entirely)
 *   - Single-backtick inline code (kept, fences removed)
 *   - `**bold**` / `*italic*` / `_emphasis_`
 *   - `[label](url)` → `label`
 *   - Heading markers, blockquote markers, bullet/ordered list markers
 *   - HTML tags
 *
 * Intentionally simple — we want short readable speech, not a markdown
 * parser. Anything we miss reads as text, which is fine.
 */
export function stripMarkdownForSpeech(input: string): string {
  if (input.length === 0) return '';
  let out = input;
  // Code fences first (multi-line). Removed entirely.
  out = out.replace(/```[\s\S]*?```/g, ' ');
  // Inline code — keep contents.
  out = out.replace(/`([^`]+)`/g, '$1');
  // Images — drop, replace with alt text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links — replace with label.
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Bold / italic / strikethrough markers.
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(\*|_)(.*?)\1/g, '$2');
  out = out.replace(/~~(.*?)~~/g, '$1');
  // Headings (start of line `#`).
  out = out.replace(/^\s*#{1,6}\s+/gm, '');
  // Blockquote markers.
  out = out.replace(/^\s*>\s?/gm, '');
  // List markers (ordered + unordered).
  out = out.replace(/^\s*([-*+]|\d+\.)\s+/gm, '');
  // HTML tags.
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  // Collapse runs of whitespace.
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Pick a voice for the requested locale. Prefers an exact two-letter
 * prefix match; falls back to the system default when nothing fits.
 */
export function pickVoiceForLocale(
  voices: SpeechSynthesisVoice[],
  locale: 'en' | 'ru',
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const prefix = locale === 'ru' ? 'ru' : 'en';
  for (const v of voices) {
    const lang = (v.lang ?? '').toLowerCase();
    if (lang.startsWith(`${prefix}-`)) return v;
  }
  for (const v of voices) {
    const lang = (v.lang ?? '').toLowerCase();
    if (lang.startsWith(prefix)) return v;
  }
  return voices.find((v) => v.default === true) ?? voices[0] ?? null;
}

/** Returns the global `speechSynthesis` if supported, else `null`. */
function getSynth(): SpeechSynth | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { speechSynthesis?: SpeechSynth };
  return w.speechSynthesis ?? null;
}

function VoiceOutputButtonImpl({
  text,
  localeOverride,
}: VoiceOutputButtonProps): JSX.Element | null {
  const storeLocale = useStore((s) => s.locale);
  const locale = localeOverride ?? storeLocale;

  const [state, setState] = useState<VoiceOutputState>('idle');
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const synthRef = useRef<SpeechSynth | null>(null);

  // Resolve the synth handle once. Calling `getSynth()` repeatedly in the
  // render path keeps feature detection but pins the reference for the
  // event handlers we attach below.
  useEffect(() => {
    synthRef.current = getSynth();
    return () => {
      // Best-effort: stop any speech that this button started when the
      // host message unmounts (e.g. session switch). We can't tell from
      // the API whether *this* utterance is still active, but we do own
      // `utteranceRef`, so cancelling on unmount is the safe default.
      const s = synthRef.current;
      if (s !== null && utteranceRef.current !== null) {
        try {
          s.cancel();
        } catch {
          // Some browsers throw on cancel() with no active speech.
        }
      }
    };
  }, []);

  // ESC key as a global stop. Active only while we own the queue.
  useEffect(() => {
    if (state === 'idle') return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        const s = synthRef.current;
        if (s !== null) {
          try {
            s.cancel();
          } catch {
            // ignore
          }
        }
        setState('idle');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  const handleClick = useCallback(() => {
    const s = synthRef.current;
    if (s === null) return;
    if (state === 'idle') {
      const clean = stripMarkdownForSpeech(text);
      if (clean.length === 0) return;
      const utt = new SpeechSynthesisUtterance(clean);
      const voice = pickVoiceForLocale(s.getVoices(), locale);
      if (voice !== null) utt.voice = voice;
      utt.lang = locale === 'ru' ? 'ru-RU' : 'en-US';
      utt.onend = () => {
        utteranceRef.current = null;
        setState('idle');
      };
      utt.onerror = () => {
        utteranceRef.current = null;
        setState('idle');
      };
      utteranceRef.current = utt;
      try {
        s.cancel();
      } catch {
        // ignore
      }
      s.speak(utt);
      setState('speaking');
      return;
    }
    if (state === 'speaking') {
      try {
        s.pause();
      } catch {
        // ignore
      }
      setState('paused');
      return;
    }
    if (state === 'paused') {
      try {
        s.resume();
      } catch {
        // ignore
      }
      setState('speaking');
    }
  }, [state, text, locale]);

  const handleStop = useCallback(() => {
    const s = synthRef.current;
    if (s === null) return;
    try {
      s.cancel();
    } catch {
      // ignore
    }
    utteranceRef.current = null;
    setState('idle');
  }, []);

  if (getSynth() === null) return null;

  let icon: JSX.Element;
  let label: string;
  if (state === 'speaking') {
    icon = <Pause size={14} aria-hidden="true" />;
    label = 'Pause speech';
  } else if (state === 'paused') {
    icon = <Play size={14} aria-hidden="true" />;
    label = 'Resume speech';
  } else {
    icon = <Play size={14} aria-hidden="true" />;
    label = 'Speak message';
  }

  return (
    <div
      className={styles.row}
      role="group"
      aria-label="Speech controls"
      data-state={state}
    >
      <button
        type="button"
        className={styles.button}
        onClick={handleClick}
        aria-label={label}
        aria-pressed={state !== 'idle'}
        title={label}
      >
        {icon}
      </button>
      {state !== 'idle' ? (
        <button
          type="button"
          className={styles.button}
          onClick={handleStop}
          aria-label="Stop speech"
          title="Stop speech"
        >
          <StopCircle size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export const VoiceOutputButton = VoiceOutputButtonImpl;
