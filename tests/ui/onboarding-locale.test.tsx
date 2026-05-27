/**
 * Smoke test for the LocaleProvider wiring on OnboardingScreen.
 *
 * The bug we're guarding against: v0.20.0 persisted `config.locale` but
 * every onboarding string was a hardcoded English literal. Wrapping the
 * screen in `<LocaleProvider locale="ru">` must surface the Russian
 * copy in the first paint without modifying the screen's props shape.
 *
 * Mount harness mirrors `tests/ui/agent-panel.test.tsx` — fake
 * stdout/stdin so we can read the painted frame.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { render } from 'ink';

import OnboardingScreen from '@/ui/screens/OnboardingScreen';
import { LocaleProvider, setActiveLocale } from '@/i18n';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountOnboarding(locale: 'en' | 'ru'): MountResult {
  const stdoutBuf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      stdoutBuf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 200;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin: EventEmitter & {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => void;
    setEncoding?: (enc: string) => void;
    resume?: () => void;
    pause?: () => void;
    read?: () => null;
    ref?: () => void;
    unref?: () => void;
  } = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.setEncoding = () => undefined;
  stdin.resume = () => undefined;
  stdin.pause = () => undefined;
  stdin.read = () => null;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;

  const noop = async (): Promise<true> => true;
  const noopList = async (): Promise<string[]> => [];

  const instance = render(
    React.createElement(
      LocaleProvider,
      { locale, children: React.createElement(OnboardingScreen, {
        pingBackend: noop,
        fetchModels: noopList,
        onComplete: () => undefined,
      }) },
    ),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: stdout as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdin: stdin as any,
      debug: false,
      exitOnCtrlC: false,
    },
  );

  return {
    read: () => stripAnsi(Buffer.concat(stdoutBuf).toString('utf8')),
    unmount: () => instance.unmount(),
  };
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

beforeEach(() => {
  setActiveLocale('en');
});

afterEach(() => {
  setActiveLocale('en');
});

describe('OnboardingScreen + LocaleProvider', () => {
  test('renders Russian copy when locale is ru', async () => {
    const view = mountOnboarding('ru');
    try {
      // Give ink a tick to flush.
      await new Promise((r) => setTimeout(r, 200));
      const frame = view.read();
      expect(frame.includes('Добро пожаловать')).toBe(true);
      expect(frame.includes('перемещение')).toBe(true);
      expect(frame.includes('Pick the LLM backend')).toBe(false);
      expect(frame.includes('navigate · Enter to select')).toBe(false);
    } finally {
      view.unmount();
    }
  });

  test('renders English copy when locale is en', async () => {
    const view = mountOnboarding('en');
    try {
      await new Promise((r) => setTimeout(r, 200));
      const frame = view.read();
      expect(frame.includes('Pick the LLM backend')).toBe(true);
      expect(frame.includes('navigate · Enter to select')).toBe(true);
    } finally {
      view.unmount();
    }
  });
});
