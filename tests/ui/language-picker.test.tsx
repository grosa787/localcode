/**
 * LanguagePicker — first-launch TUI screen.
 *
 * Covers:
 *   - Renders both flag + label rows.
 *   - Title + subtitle visible in both languages.
 *   - Active row highlighted (selection marker present).
 *   - Initial highlight respects the `initial` prop.
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';

import LanguagePicker from '@/ui/screens/LanguagePicker';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountPicker(props: {
  readonly initial?: 'en' | 'ru';
  readonly onSelect: (locale: 'en' | 'ru') => void;
}): MountResult {
  const buf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 200;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  const instance = render(
    React.createElement(LanguagePicker, props),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: stdout as any,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  return {
    read: () => stripAnsi(Buffer.concat(buf).toString('utf8')),
    unmount: () => instance.unmount(),
  };
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

describe('LanguagePicker', () => {
  test('renders title in both languages', () => {
    const m = mountPicker({
      onSelect: () => {
        /* no-op */
      },
    });
    const out = m.read();
    m.unmount();
    expect(out).toContain('Welcome to LocalCode');
    expect(out).toContain('Добро пожаловать в LocalCode');
  });

  test('renders subtitle in both languages', () => {
    const m = mountPicker({
      onSelect: () => {
        /* no-op */
      },
    });
    const out = m.read();
    m.unmount();
    expect(out).toContain('Choose your language');
    expect(out).toContain('Выберите язык');
  });

  test('renders both rows with flags + labels', () => {
    const m = mountPicker({
      onSelect: () => {
        /* no-op */
      },
    });
    const out = m.read();
    m.unmount();
    // Flag emojis present.
    expect(out).toContain('🇬🇧');
    expect(out).toContain('🇷🇺');
    // Labels present.
    expect(out).toContain('English');
    expect(out).toContain('Русский');
  });

  test('default highlight lands on the first row (English)', () => {
    const m = mountPicker({
      onSelect: () => {
        /* no-op */
      },
    });
    const out = m.read();
    m.unmount();
    // The active row carries the `▸  ` marker; assert it appears
    // BEFORE the English row (i.e. the English row is the selected one).
    const idxMarker = out.indexOf('▸');
    const idxEnglish = out.indexOf('English');
    const idxRussian = out.indexOf('Русский');
    expect(idxMarker).toBeGreaterThanOrEqual(0);
    expect(idxEnglish).toBeGreaterThanOrEqual(0);
    expect(idxRussian).toBeGreaterThanOrEqual(0);
    // Marker is on the English line — that line index precedes Russian.
    expect(idxMarker).toBeLessThan(idxRussian);
    expect(idxMarker).toBeLessThan(idxEnglish);
  });

  test('initial="ru" pre-highlights the Russian row', () => {
    const m = mountPicker({
      initial: 'ru',
      onSelect: () => {
        /* no-op */
      },
    });
    const out = m.read();
    m.unmount();
    // The marker should appear AFTER the English label but BEFORE
    // (or at) the Russian label — i.e. on the Russian row.
    const idxMarker = out.indexOf('▸');
    const idxEnglish = out.indexOf('English');
    const idxRussian = out.indexOf('Русский');
    expect(idxMarker).toBeGreaterThan(idxEnglish);
    expect(idxMarker).toBeLessThan(idxRussian);
  });

  test('shows navigation hint footer', () => {
    const m = mountPicker({
      onSelect: () => {
        /* no-op */
      },
    });
    const out = m.read();
    m.unmount();
    expect(out).toContain('Enter');
    expect(out).toMatch(/[↑↓]/);
  });
});
