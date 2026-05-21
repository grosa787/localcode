/**
 * ContextBudgetBar — verifies zone partitioning math and colour roles.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import ContextBudgetBar, {
  partitionCells,
  ZONE_COLORS,
  type ContextBudgetBarProps,
} from '@/ui/components/ContextBudgetBar';

interface CapturedOutput {
  readonly text: string;
}

function renderBar(props: ContextBudgetBarProps): CapturedOutput {
  const buf: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = 120;
  (stream as unknown as { rows: number }).rows = 10;
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  const instance = render(React.createElement(ContextBudgetBar, props), {
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

describe('partitionCells', () => {
  test('zones sum to total cells when fully filled', () => {
    const cells = partitionCells(
      {
        systemPromptTokens: 1000,
        skillsTokens: 1000,
        memoryTokens: 1000,
        messagesTokens: 1000,
        toolResultsTokens: 1000,
        total: 5000,
        max: 5000,
      },
      30,
    );
    const sum =
      cells.system + cells.skills + cells.memory + cells.messages + cells.toolResults + cells.empty;
    expect(sum).toBe(30);
    // Five even zones — each should get ~6.
    expect(cells.system).toBe(6);
    expect(cells.skills).toBe(6);
    expect(cells.memory).toBe(6);
    expect(cells.messages).toBe(6);
    expect(cells.toolResults).toBe(6);
    expect(cells.empty).toBe(0);
  });

  test('half-full bar — empty cells make up the difference', () => {
    const cells = partitionCells(
      {
        systemPromptTokens: 500,
        skillsTokens: 500,
        memoryTokens: 0,
        messagesTokens: 1000,
        toolResultsTokens: 0,
        total: 2000,
        max: 4000,
      },
      20,
    );
    const sum =
      cells.system + cells.skills + cells.memory + cells.messages + cells.toolResults + cells.empty;
    expect(sum).toBe(20);
    // Total fill is half (2000/4000) — empty must be at least half (10).
    expect(cells.empty).toBeGreaterThanOrEqual(10);
    expect(cells.memory).toBe(0);
    expect(cells.toolResults).toBe(0);
  });

  test('empty bar — everything goes to empty', () => {
    const cells = partitionCells(
      {
        systemPromptTokens: 0,
        skillsTokens: 0,
        memoryTokens: 0,
        messagesTokens: 0,
        toolResultsTokens: 0,
        total: 0,
        max: 1000,
      },
      20,
    );
    expect(cells.empty).toBe(20);
    expect(cells.system).toBe(0);
  });

  test('width=0 yields all zeros', () => {
    const cells = partitionCells(
      {
        systemPromptTokens: 1000,
        skillsTokens: 1000,
        memoryTokens: 1000,
        messagesTokens: 1000,
        toolResultsTokens: 1000,
        total: 5000,
        max: 5000,
      },
      0,
    );
    expect(cells.system).toBe(0);
    expect(cells.empty).toBe(0);
  });
});

describe('ContextBudgetBar rendering', () => {
  test('emits block chars + percent label', () => {
    const out = renderBar({
      breakdown: {
        systemPromptTokens: 100,
        skillsTokens: 100,
        memoryTokens: 0,
        messagesTokens: 200,
        toolResultsTokens: 100,
        total: 500,
        max: 1000,
      },
      width: 20,
    });
    const stripped = strip(out.text);
    expect(stripped).toMatch(/[█░]/);
    expect(stripped).toContain('50%');
  });

  test('compact mode omits legend text', () => {
    const out = renderBar({
      breakdown: {
        systemPromptTokens: 50,
        skillsTokens: 50,
        memoryTokens: 0,
        messagesTokens: 100,
        toolResultsTokens: 0,
        total: 200,
        max: 1000,
      },
      width: 30,
      compact: true,
    });
    const stripped = strip(out.text);
    // In non-compact mode the legend includes the words `sys skills mem msg tools`.
    // In compact mode these labels are suppressed.
    expect(stripped).not.toContain('sys skills');
    expect(stripped).toContain('20%');
  });

  test('ZONE_COLORS exposes the five canonical colours', () => {
    expect(ZONE_COLORS.system).toBeDefined();
    expect(ZONE_COLORS.skills).toBeDefined();
    expect(ZONE_COLORS.memory).toBeDefined();
    expect(ZONE_COLORS.messages).toBeDefined();
    expect(ZONE_COLORS.toolResults).toBeDefined();
  });
});
