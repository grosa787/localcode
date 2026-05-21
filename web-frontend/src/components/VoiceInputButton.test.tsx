/**
 * VoiceInputButton — push-to-talk dictation tests.
 *
 * Web Speech API is not available in jsdom; we feature-detect via a
 * factory injection seam and verify:
 *   - When neither SpeechRecognition nor webkitSpeechRecognition exists
 *     and no factory is injected, the button renders nothing.
 *   - With a fake factory, the start/stop state machine flips correctly
 *     and emits onresult / onerror / onend lifecycle frames.
 *   - The locale slice maps to the right BCP-47 tag.
 *   - The transcript is APPENDED (after a space) to the existing draft.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  VoiceInputButton,
  appendTranscript,
  getSpeechRecognitionCtor,
  recognitionLangForLocale,
  type SpeechRecognitionLite,
} from './VoiceInputButton';
import { useStore } from '../state/store';

afterEach(() => cleanup());

// ---- Pure helper tests ----

describe('recognitionLangForLocale', () => {
  test('en → en-US', () => {
    expect(recognitionLangForLocale('en')).toBe('en-US');
  });
  test('ru → ru-RU', () => {
    expect(recognitionLangForLocale('ru')).toBe('ru-RU');
  });
});

describe('appendTranscript', () => {
  test('appends with a leading space when the draft has no trailing space', () => {
    expect(appendTranscript('hello', 'world')).toBe('hello world');
  });
  test('respects existing trailing space', () => {
    expect(appendTranscript('hello ', 'world')).toBe('hello world');
  });
  test('respects existing trailing newline', () => {
    expect(appendTranscript('hello\n', 'world')).toBe('hello\nworld');
  });
  test('empty draft → transcript without leading space', () => {
    expect(appendTranscript('', 'world')).toBe('world');
  });
  test('empty transcript → draft unchanged', () => {
    expect(appendTranscript('hello', '')).toBe('hello');
  });
});

describe('getSpeechRecognitionCtor', () => {
  test('returns null when neither name is defined', () => {
    expect(getSpeechRecognitionCtor({})).toBeNull();
  });
  test('prefers unprefixed SpeechRecognition', () => {
    const Std = function () {} as unknown as new () => SpeechRecognitionLite;
    const Webkit = function () {} as unknown as new () => SpeechRecognitionLite;
    expect(
      getSpeechRecognitionCtor({
        SpeechRecognition: Std,
        webkitSpeechRecognition: Webkit,
      }),
    ).toBe(Std);
  });
  test('falls back to webkitSpeechRecognition', () => {
    const Webkit = function () {} as unknown as new () => SpeechRecognitionLite;
    expect(
      getSpeechRecognitionCtor({ webkitSpeechRecognition: Webkit }),
    ).toBe(Webkit);
  });
});

// ---- Component tests ----

/**
 * Fake SpeechRecognition implementing the subset we depend on. Tests
 * inject this via the `factory` prop, so the production feature-detect
 * path is exercised independently above.
 */
function makeFakeRecognition(): SpeechRecognitionLite & {
  __fire: {
    result: (transcript: string, isFinal?: boolean) => void;
    error: (error: string) => void;
  };
} {
  let onresult: SpeechRecognitionLite['onresult'] = null;
  let onerror: SpeechRecognitionLite['onerror'] = null;
  let onstart: SpeechRecognitionLite['onstart'] = null;
  let onend: SpeechRecognitionLite['onend'] = null;
  const rec: SpeechRecognitionLite & {
    __fire: {
      result: (transcript: string, isFinal?: boolean) => void;
      error: (error: string) => void;
    };
  } = {
    lang: '',
    continuous: false,
    interimResults: false,
    start(): void {
      if (onstart !== null) onstart(new Event('start'));
    },
    stop(): void {
      if (onend !== null) onend(new Event('end'));
    },
    abort(): void {
      if (onend !== null) onend(new Event('end'));
    },
    get onresult() {
      return onresult;
    },
    set onresult(fn) {
      onresult = fn;
    },
    get onerror() {
      return onerror;
    },
    set onerror(fn) {
      onerror = fn;
    },
    get onstart() {
      return onstart;
    },
    set onstart(fn) {
      onstart = fn;
    },
    get onend() {
      return onend;
    },
    set onend(fn) {
      onend = fn;
    },
    __fire: {
      result(transcript: string, isFinal = false): void {
        if (onresult === null) return;
        onresult({
          resultIndex: 0,
          results: {
            length: 1,
            0: { isFinal, 0: { transcript } },
          },
        });
      },
      error(error: string): void {
        if (onerror !== null) onerror({ error });
      },
    },
  };
  return rec;
}

beforeEach(() => {
  // Reset locale + toasts so each test starts clean.
  useStore.setState({ locale: 'en', toasts: [] });
});

describe('VoiceInputButton — feature detection', () => {
  test('renders nothing when SpeechRecognition is unavailable AND no factory injected', () => {
    // jsdom has no SpeechRecognition by default — and no factory => null.
    const { container } = render(
      <VoiceInputButton draft="" onTranscript={vi.fn()} disabled={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders the button when a factory is injected (test seam)', () => {
    const factory = vi.fn(() => makeFakeRecognition());
    const { container } = render(
      <VoiceInputButton
        draft=""
        onTranscript={vi.fn()}
        disabled={false}
        factory={factory}
      />,
    );
    expect(container.querySelector('button')).not.toBeNull();
  });

  test('hidden when window has neither prefix (pure feature detect)', () => {
    // Even if we manually wipe both, the component still renders nothing
    // without an injected factory.
    // The default state in jsdom IS already absent of the API.
    const win = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    expect(win.SpeechRecognition).toBeUndefined();
    expect(win.webkitSpeechRecognition).toBeUndefined();
    const { container } = render(
      <VoiceInputButton draft="" onTranscript={vi.fn()} disabled={false} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('VoiceInputButton — start/stop state machine', () => {
  test('pointerdown starts recognition; the button reflects listening state', () => {
    const rec = makeFakeRecognition();
    const onTranscript = vi.fn();
    const { container } = render(
      <VoiceInputButton
        draft=""
        onTranscript={onTranscript}
        disabled={false}
        factory={() => rec}
      />,
    );
    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    if (btn === null) return;
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(btn.getAttribute('data-active')).toBe('true');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  test('configures continuous=false, interimResults=true', () => {
    const rec = makeFakeRecognition();
    const { container } = render(
      <VoiceInputButton
        draft=""
        onTranscript={vi.fn()}
        disabled={false}
        factory={() => rec}
      />,
    );
    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    if (btn === null) return;
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(true);
  });

  test('onresult appends transcript to the existing draft via onTranscript', () => {
    const rec = makeFakeRecognition();
    const onTranscript = vi.fn();
    const { container } = render(
      <VoiceInputButton
        draft="hello"
        onTranscript={onTranscript}
        disabled={false}
        factory={() => rec}
      />,
    );
    const btn = container.querySelector('button');
    if (btn === null) throw new Error('no button');
    fireEvent.pointerDown(btn, { pointerId: 1 });
    rec.__fire.result('there', true);
    // Existing draft "hello" + space + transcript.
    expect(onTranscript).toHaveBeenCalledWith('hello there');
  });

  test('pointerup ends recognition; button returns to idle', () => {
    const rec = makeFakeRecognition();
    const { container } = render(
      <VoiceInputButton
        draft=""
        onTranscript={vi.fn()}
        disabled={false}
        factory={() => rec}
      />,
    );
    const btn = container.querySelector('button');
    if (btn === null) throw new Error('no button');
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(btn.getAttribute('data-active')).toBe('true');
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(btn.getAttribute('data-active')).toBe('false');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  test('not-allowed error fires a toast and ends listening', () => {
    const rec = makeFakeRecognition();
    const { container } = render(
      <VoiceInputButton
        draft=""
        onTranscript={vi.fn()}
        disabled={false}
        factory={() => rec}
      />,
    );
    const btn = container.querySelector('button');
    if (btn === null) throw new Error('no button');
    fireEvent.pointerDown(btn, { pointerId: 1 });
    rec.__fire.error('not-allowed');
    // Toast pushed via the store.
    const toasts = useStore.getState().toasts;
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[toasts.length - 1]?.level).toBe('warning');
  });

  test('disabled button does not start recognition', () => {
    const rec = makeFakeRecognition();
    const start = vi.spyOn(rec, 'start');
    const { container } = render(
      <VoiceInputButton
        draft=""
        onTranscript={vi.fn()}
        disabled={true}
        factory={() => rec}
      />,
    );
    const btn = container.querySelector('button');
    if (btn === null) throw new Error('no button');
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('VoiceInputButton — locale propagation', () => {
  test('en locale → recognition.lang === en-US', () => {
    useStore.setState({ locale: 'en' });
    const rec = makeFakeRecognition();
    const { container } = render(
      <VoiceInputButton
        draft=""
        onTranscript={vi.fn()}
        disabled={false}
        factory={() => rec}
      />,
    );
    const btn = container.querySelector('button');
    if (btn === null) throw new Error('no button');
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(rec.lang).toBe('en-US');
  });

  test('ru locale → recognition.lang === ru-RU', () => {
    useStore.setState({ locale: 'ru' });
    const rec = makeFakeRecognition();
    const { container } = render(
      <VoiceInputButton
        draft=""
        onTranscript={vi.fn()}
        disabled={false}
        factory={() => rec}
      />,
    );
    const btn = container.querySelector('button');
    if (btn === null) throw new Error('no button');
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(rec.lang).toBe('ru-RU');
  });
});
