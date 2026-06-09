/**
 * Eval-report rendering.
 *
 * `formatReport` produces an aligned, monospace-friendly table for the
 * TUI (one row per task plus a summary line). `toJson` produces the
 * stable JSON shape written by `/eval export`.
 */

import type { EvalReport, TaskResult } from './types';

interface Column {
  readonly header: string;
  readonly cell: (r: TaskResult) => string;
  /** Right-align numeric columns; left-align text. */
  readonly align: 'left' | 'right';
}

const COLUMNS: readonly Column[] = [
  { header: 'task', cell: (r) => r.taskId, align: 'left' },
  { header: 'result', cell: (r) => (r.passed ? 'PASS' : 'FAIL'), align: 'left' },
  { header: 'turns', cell: (r) => String(r.turns), align: 'right' },
  { header: 'tok-in', cell: (r) => String(r.tokensIn), align: 'right' },
  { header: 'tok-out', cell: (r) => String(r.tokensOut), align: 'right' },
  { header: '$', cell: (r) => formatUsd(r.costUsd), align: 'right' },
  { header: 'ms', cell: (r) => String(r.wallMs), align: 'right' },
];

/**
 * Render an {@link EvalReport} as an aligned text table followed by a
 * summary line. Pure — no IO. Suitable for `ctx.print`.
 */
export function formatReport(report: EvalReport): string {
  const header = `Eval: ${report.model} @ ${report.backend}  (${formatDate(
    report.ranAt,
  )})`;

  if (report.results.length === 0) {
    return `${header}\n(no tasks run)`;
  }

  // Compute per-column width = max(header, widest cell).
  const widths = COLUMNS.map((col) => {
    let w = col.header.length;
    for (const r of report.results) {
      w = Math.max(w, col.cell(r).length);
    }
    return w;
  });

  const headerRow = COLUMNS.map((col, i) =>
    pad(col.header, widths[i] ?? col.header.length, col.align),
  ).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');

  const rows = report.results.map((r) =>
    COLUMNS.map((col, i) =>
      pad(col.cell(r), widths[i] ?? 0, col.align),
    ).join('  '),
  );

  const passes = report.results.filter((r) => r.passed).length;
  const summary = [
    `pass-rate ${formatPercent(report.passRate)} (${passes}/${report.results.length})`,
    `tok-in ${report.totalTokensIn}`,
    `tok-out ${report.totalTokensOut}`,
    `cost ${formatUsd(report.totalCostUsd)}`,
    `wall ${report.totalWallMs}ms`,
  ].join('  ·  ');

  return [header, '', headerRow, separator, ...rows, '', summary].join('\n');
}

/**
 * Serialise the report to a deterministic JSON object. Returns the same
 * shape as {@link EvalReport} but with arrays copied so callers can't
 * mutate the source. `JSON.stringify` it for disk export.
 */
export function toJson(report: EvalReport): EvalReport {
  return {
    model: report.model,
    backend: report.backend,
    ranAt: report.ranAt,
    results: report.results.map((r) => ({ ...r })),
    passRate: report.passRate,
    totalTokensIn: report.totalTokensIn,
    totalTokensOut: report.totalTokensOut,
    totalCostUsd: report.totalCostUsd,
    totalWallMs: report.totalWallMs,
  };
}

// ---------- helpers ----------

function pad(text: string, width: number, align: 'left' | 'right'): string {
  if (text.length >= width) return text;
  const fill = ' '.repeat(width - text.length);
  return align === 'right' ? fill + text : text + fill;
}

function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${Math.round(fraction * 100)}%`;
}

function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export const __test__ = {
  pad,
  formatUsd,
  formatPercent,
};
