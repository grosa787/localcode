/**
 * Report rendering tests — `formatReport` aligned table + summary, and
 * `toJson` shape. Pure fixtures, no model.
 */

import { describe, expect, test } from 'bun:test';

import { formatReport, toJson } from '@/eval/report';
import { aggregate } from '@/eval/runner';
import type { EvalReport, TaskResult } from '@/eval/types';

function fixtureReport(): EvalReport {
  const results: TaskResult[] = [
    {
      taskId: 'add-function-sum',
      passed: true,
      turns: 2,
      tokensIn: 1200,
      tokensOut: 340,
      costUsd: 0.0021,
      wallMs: 4200,
    },
    {
      taskId: 'fix-failing-multiply',
      passed: false,
      turns: 5,
      tokensIn: 3000,
      tokensOut: 800,
      costUsd: 0.0055,
      wallMs: 9100,
      error: 'command exited 1, expected 0',
    },
  ];
  return aggregate(results, 'gpt-4o-mini', 'openai', 1_700_000_000_000);
}

describe('formatReport', () => {
  test('renders a header, one row per task, and a summary', () => {
    const out = formatReport(fixtureReport());

    expect(out).toContain('gpt-4o-mini');
    expect(out).toContain('openai');
    // Both task rows present.
    expect(out).toContain('add-function-sum');
    expect(out).toContain('fix-failing-multiply');
    // Verdicts surfaced.
    expect(out).toContain('PASS');
    expect(out).toContain('FAIL');
    // Summary with pass-rate.
    expect(out).toContain('pass-rate 50% (1/2)');
  });

  test('column cells stay aligned (header + rows share a width)', () => {
    const out = formatReport(fixtureReport());
    const lines = out.split('\n');
    // Find the header row (contains the literal column titles).
    const headerIdx = lines.findIndex(
      (l) => l.includes('task') && l.includes('result') && l.includes('turns'),
    );
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    const headerLine = lines[headerIdx];
    const separatorLine = lines[headerIdx + 1];
    const firstRow = lines[headerIdx + 2];
    expect(headerLine).toBeDefined();
    expect(separatorLine).toBeDefined();
    expect(firstRow).toBeDefined();
    // Separator + header + first data row must share width (aligned table).
    expect(separatorLine?.length).toBe(headerLine?.length);
    expect(firstRow?.length).toBe(headerLine?.length);
  });

  test('handles an empty report', () => {
    const empty = aggregate([], 'm', 'b', 0);
    const out = formatReport(empty);
    expect(out).toContain('no tasks run');
    expect(empty.passRate).toBe(0);
  });
});

describe('toJson', () => {
  test('produces a faithful, deep-copied snapshot', () => {
    const report = fixtureReport();
    const json = toJson(report);

    expect(json.model).toBe('gpt-4o-mini');
    expect(json.backend).toBe('openai');
    expect(json.results.length).toBe(2);
    expect(json.passRate).toBe(0.5);
    expect(json.totalTokensIn).toBe(4200);
    expect(json.totalTokensOut).toBe(1140);

    // Deep copy — mutating the JSON snapshot must not touch the source.
    const firstResult = json.results[0];
    expect(firstResult).toBeDefined();
    if (firstResult !== undefined) {
      expect(firstResult.taskId).toBe('add-function-sum');
    }
    expect(json.results).not.toBe(report.results);

    // Round-trips through JSON.stringify without throwing.
    const serialised = JSON.stringify(toJson(report));
    const reparsed = JSON.parse(serialised) as EvalReport;
    expect(reparsed.results.length).toBe(2);
  });
});

describe('aggregate', () => {
  test('computes totals and pass-rate from results', () => {
    const report = fixtureReport();
    expect(report.passRate).toBe(0.5);
    expect(report.totalTokensIn).toBe(4200);
    expect(report.totalTokensOut).toBe(1140);
    expect(report.totalWallMs).toBe(13300);
    // 0.0021 + 0.0055 = 0.0076 (rounded to 6 places).
    expect(report.totalCostUsd).toBeCloseTo(0.0076, 6);
  });
});
