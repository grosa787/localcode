/**
 * CostDashboard overlay — render tests.
 *
 * Verifies per-turn list rendering, sticky total row, and empty-state
 * placeholder.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import CostDashboard, {
  type CostDashboardProps,
} from '@/ui/overlays/CostDashboard';

interface CapturedOutput {
  readonly text: string;
}

function renderDashboard(props: CostDashboardProps): CapturedOutput {
  const buf: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = 140;
  (stream as unknown as { rows: number }).rows = 40;
  (stream as unknown as { isTTY: boolean }).isTTY = true;

  const instance = render(React.createElement(CostDashboard, props), {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: stream as any,
    debug: true,
    exitOnCtrlC: false,
  });
  instance.unmount();
  return { text: Buffer.concat(buf).toString('utf8') };
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '3';
});

describe('CostDashboard', () => {
  test('renders header and per-turn rows', () => {
    const out = renderDashboard({
      turns: [
        {
          turn: 1,
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 0,
          durationMs: 1200,
          cost: 0.0024,
          model: 'gpt-4o',
        },
        {
          turn: 2,
          inputTokens: 200,
          outputTokens: 80,
          cachedTokens: 10,
          durationMs: 800,
          cost: 0.005,
          model: 'gpt-4o',
        },
      ],
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('Cost');
    expect(stripped).toContain('gpt-4o');
    expect(stripped).toContain('1.2s');
    expect(stripped).toContain('TOTAL');
  });

  test('empty turns shows placeholder', () => {
    const out = renderDashboard({
      turns: [],
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('(no assistant turns recorded yet)');
    expect(stripped).toContain('TOTAL');
  });

  test('sums total tokens and cost in sticky row', () => {
    const out = renderDashboard({
      turns: [
        {
          turn: 1,
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 0,
          durationMs: 1000,
          cost: 0.0025,
          model: 'gpt-4o',
        },
        {
          turn: 2,
          inputTokens: 200,
          outputTokens: 80,
          cachedTokens: 0,
          durationMs: 1000,
          cost: 0.0050,
          model: 'gpt-4o',
        },
      ],
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    // Total input: 100+200 = 300; total output 50+80 = 130; cost ~ 0.0075.
    expect(stripped).toContain('300');
    expect(stripped).toContain('130');
    expect(stripped).toContain('$0.0075');
  });

  test('footer carries esc + arrow hint', () => {
    const out = renderDashboard({
      turns: [],
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('esc close');
    expect(stripped).toContain('scroll');
  });

  test('optional sessionLabel renders', () => {
    const out = renderDashboard({
      turns: [],
      sessionLabel: 'abc12345',
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('abc12345');
  });
});
