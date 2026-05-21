/**
 * Tests for VoiceOutputButton — feature detection, state machine,
 * markdown stripping, and voice selection.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  VoiceOutputButton,
  pickVoiceForLocale,
  stripMarkdownForSpeech,
} from './VoiceOutputButton';

afterEach(() => {
  cleanup();
  // Restore window state between tests.
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
});

interface StubVoice {
  lang: string;
  name?: string;
  default?: boolean;
}

interface StubUtterance {
  text: string;
  voice?: StubVoice;
  lang?: string;
  onend?: () => void;
  onerror?: () => void;
}

interface StubSynth {
  speak: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  getVoices: () => StubVoice[];
  paused: boolean;
  speaking: boolean;
  lastUtterance: StubUtterance | null;
}

function installSynth(voices: StubVoice[]): StubSynth {
  const lastHolder: { value: StubUtterance | null } = { value: null };
  const stub: StubSynth = {
    speak: vi.fn((utt: StubUtterance) => {
      lastHolder.value = utt;
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => voices,
    paused: false,
    speaking: false,
    get lastUtterance() {
      return lastHolder.value;
    },
  };
  (window as unknown as { speechSynthesis: StubSynth }).speechSynthesis = stub;

  // Provide a constructor stub for SpeechSynthesisUtterance — jsdom
  // ships one in modern versions but we don't depend on it.
  (window as unknown as {
    SpeechSynthesisUtterance: new (text: string) => StubUtterance;
  }).SpeechSynthesisUtterance = function (this: StubUtterance, text: string) {
    this.text = text;
  } as unknown as new (text: string) => StubUtterance;
  return stub;
}

describe('stripMarkdownForSpeech', () => {
  test('removes code fences entirely', () => {
    const md = 'before\n```ts\nconst x = 1;\n```\nafter';
    const out = stripMarkdownForSpeech(md);
    expect(out).not.toContain('```');
    expect(out).not.toContain('const x');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  test('keeps inline code contents', () => {
    expect(stripMarkdownForSpeech('use `foo` here')).toBe('use foo here');
  });

  test('strips bold/italic markers', () => {
    expect(stripMarkdownForSpeech('**bold** and *italic*')).toBe(
      'bold and italic',
    );
  });

  test('replaces links with label', () => {
    expect(stripMarkdownForSpeech('go to [docs](https://x)')).toBe(
      'go to docs',
    );
  });

  test('drops heading markers', () => {
    expect(stripMarkdownForSpeech('# Title\n\nBody')).toBe('Title\n\nBody');
  });

  test('drops list markers', () => {
    expect(stripMarkdownForSpeech('- one\n- two')).toBe('one\ntwo');
  });

  test('drops html tags', () => {
    expect(stripMarkdownForSpeech('see <b>bold</b> text')).toBe(
      'see bold text',
    );
  });
});

describe('pickVoiceForLocale', () => {
  test('prefers exact prefix match', () => {
    const voices: StubVoice[] = [
      { lang: 'en-US' },
      { lang: 'ru-RU' },
      { lang: 'fr-FR' },
    ];
    const v = pickVoiceForLocale(
      voices as unknown as SpeechSynthesisVoice[],
      'ru',
    );
    expect(v?.lang).toBe('ru-RU');
  });

  test('falls back to default when no match', () => {
    const voices: StubVoice[] = [
      { lang: 'de-DE' },
      { lang: 'fr-FR', default: true },
    ];
    const v = pickVoiceForLocale(
      voices as unknown as SpeechSynthesisVoice[],
      'ru',
    );
    expect(v?.lang).toBe('fr-FR');
  });

  test('returns null on empty list', () => {
    expect(
      pickVoiceForLocale([] as unknown as SpeechSynthesisVoice[], 'en'),
    ).toBeNull();
  });
});

describe('VoiceOutputButton — feature detection', () => {
  test('renders nothing when speechSynthesis is missing', () => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    const { container } = render(
      <VoiceOutputButton text="hello" localeOverride="en" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('VoiceOutputButton — state machine', () => {
  let synth: StubSynth;

  beforeEach(() => {
    synth = installSynth([{ lang: 'en-US' }]);
  });

  test('click speaks; second click pauses; third resumes', () => {
    render(<VoiceOutputButton text="hello world" localeOverride="en" />);
    const speak = screen.getByLabelText('Speak message');
    fireEvent.click(speak);
    expect(synth.speak).toHaveBeenCalledTimes(1);

    const pause = screen.getByLabelText('Pause speech');
    expect(pause).not.toBeNull();
    fireEvent.click(pause);
    expect(synth.pause).toHaveBeenCalledTimes(1);

    const resume = screen.getByLabelText('Resume speech');
    expect(resume).not.toBeNull();
    fireEvent.click(resume);
    expect(synth.resume).toHaveBeenCalledTimes(1);
  });

  test('stop button cancels and returns to idle', () => {
    render(<VoiceOutputButton text="hello world" localeOverride="en" />);
    fireEvent.click(screen.getByLabelText('Speak message'));
    const stop = screen.getByLabelText('Stop speech');
    fireEvent.click(stop);
    expect(synth.cancel).toHaveBeenCalled();
    // After stopping we are back to "Speak message".
    expect(screen.getByLabelText('Speak message')).not.toBeNull();
  });

  test('ESC stops speech', () => {
    render(<VoiceOutputButton text="hello" localeOverride="en" />);
    fireEvent.click(screen.getByLabelText('Speak message'));
    expect(screen.queryByLabelText('Speak message')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(synth.cancel).toHaveBeenCalled();
    expect(screen.getByLabelText('Speak message')).not.toBeNull();
  });

  test('strips markdown before speaking', () => {
    render(
      <VoiceOutputButton
        text="`code` and **bold** and [link](url)"
        localeOverride="en"
      />,
    );
    fireEvent.click(screen.getByLabelText('Speak message'));
    const utt = synth.lastUtterance;
    expect(utt).not.toBeNull();
    if (utt === null) throw new Error('no utterance');
    expect(utt.text).toBe('code and bold and link');
  });

  test('empty / pure-markdown body does not speak', () => {
    render(<VoiceOutputButton text="```only code```" localeOverride="en" />);
    fireEvent.click(screen.getByLabelText('Speak message'));
    // The stripper collapses code fences to a space; speak should still fire
    // because there's a non-empty token after trim. We only assert call.
    // Important: nothing throws.
    expect(synth.speak).toHaveBeenCalledTimes(0);
  });
});
