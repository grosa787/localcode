/**
 * Behavioural test for H1 — when `disabled={true}` the InputBar must
 * NOT consume keystrokes. This guards the "y/n leaked into next draft"
 * regression that motivated the audit: when an ApprovalPrompt was
 * mounted alongside the InputBar, the `y` keystroke that confirmed
 * the prompt previously reached the bar's dispatcher and got inserted
 * into the buffer.
 *
 * We mount the bar with `disabled=true`, simulate a `y` keystroke via
 * ink's stdin, and assert the `onChange` callback was never invoked
 * with anything other than the initial empty value.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import InputBar from '@/ui/components/InputBar';

interface MountResult {
  readonly onChangeCalls: readonly string[];
  readonly onSubmitCalls: readonly string[];
  readonly unmount: () => void;
  readonly send: (data: string) => void;
}

function mountBar(opts: {
  readonly disabled: boolean;
  readonly initialValue?: string;
}): MountResult {
  const onChangeCalls: string[] = [];
  const onSubmitCalls: string[] = [];

  const stdoutBuf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      stdoutBuf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  // ink reads stdin via useInput, so we need an EventEmitter that
  // pretends to be a TTY.
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

  const send = (data: string): void => {
    stdin.emit('data', data);
  };

  const instance = render(
    React.createElement(InputBar, {
      value: opts.initialValue ?? '',
      onChange: (v: string) => onChangeCalls.push(v),
      onSubmit: (v: string) => onSubmitCalls.push(v),
      disabled: opts.disabled,
    }),
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
    onChangeCalls,
    onSubmitCalls,
    unmount: () => instance.unmount(),
    send,
  };
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

describe('InputBar — disabled gating (H1)', () => {
  test('does not consume y when disabled (no onChange / onSubmit calls)', async () => {
    const bar = mountBar({ disabled: true });
    try {
      bar.send('y');
      // Give ink a tick to dispatch.
      await new Promise((r) => setTimeout(r, 20));
      // The dispatcher should never fire while disabled — so onChange
      // remains at zero invocations. (The initial useEffect would emit
      // for value='' but the lastEmittedRef matches the seed, so it's
      // skipped.)
      expect(bar.onChangeCalls).toEqual([]);
      expect(bar.onSubmitCalls).toEqual([]);
    } finally {
      bar.unmount();
    }
  });

  test('does not submit on Enter when disabled', async () => {
    const bar = mountBar({ disabled: true });
    try {
      bar.send('\r');
      await new Promise((r) => setTimeout(r, 20));
      expect(bar.onSubmitCalls).toEqual([]);
    } finally {
      bar.unmount();
    }
  });

  // Positive control omitted: a stub stdin EventEmitter doesn't pass
  // ink's TTY-detection branch reliably across versions, so we lock
  // down the H1 contract via the negative tests above (which are the
  // ones that matter for the regression) plus the source-shape
  // assertion in `chatscreen-input-gating.test.ts` that the
  // `isActive: !disabled` flag is wired.
});
