/**
 * Wave 5A — InputBar responsive layout.
 *
 * Locks down the breakpoint table that drives the status-pill row:
 *   - >= 80 columns → full pill (provider · model · pct% · profile · style)
 *   - 40..79        → compact pill (model · pct%)
 *   - < 40          → no pill row (the bordered editor still spans)
 *
 * The pure helper is verified directly (no ink mount). For an actual
 * render-shape assertion at 120 cols we mount the bar with a forced
 * `testColumns` and inspect the rendered output. The two narrow widths
 * are also rendered to confirm the pill / hint disappear as expected.
 *
 * Mount harness mirrors `tests/ui/input-bar-disabled.test.tsx` so the
 * stdin emitter + writable stdout idioms stay consistent.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import InputBar, { __test__ as inputBarTest } from '@/ui/components/InputBar';

const { pickPillLayout } = inputBarTest;

/**
 * Strip ANSI escape sequences so test assertions can match raw text
 * (chalk's exact escape shape — `38;2;…` vs `38;5;…` — depends on the
 * terminal capability detection and is irrelevant to our layout tests).
 * Pattern matches CSI sequences (the only ones the renderer emits).
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountBar(opts: {
  readonly testColumns: number;
  readonly status?: {
    readonly provider: string;
    readonly model: string;
    readonly contextPercent: number;
    readonly profile: string;
    readonly outputStyle: string;
  };
  readonly showHint?: boolean;
}): MountResult {
  const stdoutBuf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      stdoutBuf.push(Buffer.from(chunk));
      cb();
    },
  });
  // Set a generous baseline column count on the writable too so ink's
  // own internal width arithmetic doesn't clamp our render below the
  // testColumns we forced into the component.
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

  const instance = render(
    React.createElement(InputBar, {
      value: '',
      onChange: () => undefined,
      onSubmit: () => undefined,
      status: opts.status,
      showHint: opts.showHint,
      testColumns: opts.testColumns,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
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

describe('InputBar — pickPillLayout breakpoint table', () => {
  test('120 columns → full pill (compact=false, hidden=false)', () => {
    const layout = pickPillLayout(120);
    expect(layout.compact).toBe(false);
    expect(layout.hidden).toBe(false);
  });

  test('exactly 80 columns → full pill (boundary inclusive)', () => {
    expect(pickPillLayout(80)).toEqual({ compact: false, hidden: false });
  });

  test('79 columns → compact pill', () => {
    expect(pickPillLayout(79)).toEqual({ compact: true, hidden: false });
  });

  test('60 columns → compact pill', () => {
    expect(pickPillLayout(60)).toEqual({ compact: true, hidden: false });
  });

  test('exactly 40 columns → compact pill (boundary inclusive)', () => {
    expect(pickPillLayout(40)).toEqual({ compact: true, hidden: false });
  });

  test('39 columns → hidden pill', () => {
    expect(pickPillLayout(39)).toEqual({ compact: true, hidden: true });
  });

  test('20 columns → hidden pill (minimal mode)', () => {
    expect(pickPillLayout(20)).toEqual({ compact: true, hidden: true });
  });
});

describe('InputBar — pill row rendering at various widths', () => {
  const STATUS = {
    provider: 'openrouter',
    model: 'qwen3-coder',
    contextPercent: 35,
    profile: 'default',
    outputStyle: 'concise',
  } as const;

  test('120 cols → full pill shows provider, model, profile, outputStyle', async () => {
    const bar = mountBar({ testColumns: 120, status: STATUS });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const out = bar.read();
      expect(out).toContain('openrouter');
      expect(out).toContain('qwen3-coder');
      expect(out).toContain('35%');
      expect(out).toContain('default');
      expect(out).toContain('concise');
    } finally {
      bar.unmount();
    }
  });

  test('60 cols → compact pill drops provider / profile / outputStyle', async () => {
    const bar = mountBar({ testColumns: 60, status: STATUS });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const out = bar.read();
      expect(out).toContain('qwen3-coder');
      expect(out).toContain('35%');
      // The dropped segments should not appear in the compact form.
      expect(out).not.toContain('openrouter');
      expect(out).not.toContain('concise');
    } finally {
      bar.unmount();
    }
  });

  test('30 cols → minimal mode hides the whole pill row', async () => {
    const bar = mountBar({ testColumns: 30, status: STATUS });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const out = bar.read();
      // The pill body opens with `[ ` and closes with ` ]`; the minimal
      // mode must omit both.
      expect(out).not.toContain('[ ');
      expect(out).not.toContain(' ]');
    } finally {
      bar.unmount();
    }
  });

  test('legacy callers (no `status` prop) render without a pill row', async () => {
    const bar = mountBar({ testColumns: 120 });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const out = bar.read();
      // No status payload → no pill row at all (legacy compatibility).
      expect(out).not.toContain('openrouter');
      expect(out).not.toContain('35%');
    } finally {
      bar.unmount();
    }
  });
});

describe('InputBar — footer hint row', () => {
  test('120 cols → full hint row visible (↵ send · ⇧↵ newline …)', async () => {
    const bar = mountBar({ testColumns: 120 });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const out = bar.read();
      // `↵` and `⇧↵` glyphs identify the row uniquely.
      expect(out).toContain('↵ send');
      expect(out).toContain('⇧↵ newline');
      expect(out).toContain('/ commands');
    } finally {
      bar.unmount();
    }
  });

  test('60 cols → hint row collapses (drops `! bash` and `⇥ agent`)', async () => {
    const bar = mountBar({ testColumns: 60 });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const out = bar.read();
      expect(out).toContain('↵ send');
      expect(out).not.toContain('! bash');
      expect(out).not.toContain('⇥ agent');
    } finally {
      bar.unmount();
    }
  });

  test('30 cols → hint row hidden in minimal mode', async () => {
    const bar = mountBar({ testColumns: 30 });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const out = bar.read();
      expect(out).not.toContain('↵ send');
    } finally {
      bar.unmount();
    }
  });

  test('showHint=false suppresses the hint row entirely', async () => {
    const bar = mountBar({ testColumns: 120, showHint: false });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const out = bar.read();
      expect(out).not.toContain('↵ send');
    } finally {
      bar.unmount();
    }
  });
});
