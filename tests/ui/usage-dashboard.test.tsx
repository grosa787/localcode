/**
 * UsageDashboard overlay — render tests.
 *
 * We mount the component into ink's `render()` with `debug: true` and
 * a captured Writable, then assert on STRUCTURAL features of the
 * rendered output (no ANSI assertions — chalk output drifts).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import UsageDashboard, {
  type UsageDashboardProps,
} from '@/ui/overlays/UsageDashboard';

interface CapturedOutput {
  readonly text: string;
}

function renderDashboard(props: UsageDashboardProps): CapturedOutput {
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

  const instance = render(React.createElement(UsageDashboard, props), {
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

describe('UsageDashboard', () => {
  test('header renders totals and favorite model', () => {
    const out = renderDashboard({
      data: {
        totalCost: 12.34,
        totalTokens: 1_250_000,
        sessionCount: 42,
        favoriteModel: 'anthropic/claude-3.5-sonnet',
        perModel: [],
        topSessions: [],
      },
      onRefresh: () => undefined,
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('Usage');
    expect(stripped).toContain('$12.34');
    expect(stripped).toContain('1.3M tokens');
    expect(stripped).toContain('42 sessions');
    expect(stripped).toContain('anthropic/claude-3.5-sonnet');
  });

  test('renders per-model table rows', () => {
    const out = renderDashboard({
      data: {
        totalCost: 1,
        totalTokens: 1000,
        sessionCount: 1,
        favoriteModel: 'gpt-4o',
        perModel: [
          {
            model: 'gpt-4o',
            inputTokens: 1000,
            outputTokens: 500,
            cachedTokens: 200,
            cost: 0.0125,
            cacheHitPct: 20,
          },
          {
            model: 'claude-3.5-sonnet',
            inputTokens: 5000,
            outputTokens: 800,
            cachedTokens: 100,
            cost: 0.027,
            cacheHitPct: 2,
          },
        ],
        topSessions: [],
      },
      onRefresh: () => undefined,
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('By model');
    expect(stripped).toContain('gpt-4o');
    expect(stripped).toContain('claude-3.5-sonnet');
    // Cache-hit percent appears.
    expect(stripped).toContain('20%');
  });

  test('renders top-sessions table with the cursor on the first row', () => {
    const out = renderDashboard({
      data: {
        totalCost: 0,
        totalTokens: 0,
        sessionCount: 0,
        favoriteModel: null,
        perModel: [],
        topSessions: [
          {
            sessionId: 's1',
            title: 'Refactor X',
            model: 'gpt-4o',
            tokens: 1500,
            cost: 0.0125,
            when: Date.now() - 60_000,
          },
        ],
      },
      onRefresh: () => undefined,
      onClose: () => undefined,
      onSelectSession: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('Top sessions');
    expect(stripped).toContain('Refactor X');
    expect(stripped).toContain('❯');
    expect(stripped).toContain('enter resume');
  });

  test('shows empty placeholders when both tables are empty', () => {
    const out = renderDashboard({
      data: {
        totalCost: 0,
        totalTokens: 0,
        sessionCount: 0,
        favoriteModel: null,
        perModel: [],
        topSessions: [],
      },
      onRefresh: () => undefined,
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('(no model usage recorded yet)');
    expect(stripped).toContain('(no sessions with token data yet)');
  });

  test('footer hint includes r refresh / esc close', () => {
    const out = renderDashboard({
      data: {
        totalCost: 0,
        totalTokens: 0,
        sessionCount: 0,
        favoriteModel: null,
        perModel: [],
        topSessions: [],
      },
      onRefresh: () => undefined,
      onClose: () => undefined,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('r refresh');
    expect(stripped).toContain('esc close');
  });
});
