/**
 * InlineDiff — line-oriented unified diff with Nox-flavoured colours.
 *
 * Accepts old and new content; computes a minimal LCS diff and renders
 * each line as added (`+`), removed (`-`), or context (` `). Line
 * numbers are rendered in `--text-faint` and padded to fit the longest
 * number.
 *
 * The diff algorithm is the classic Myers-style LCS. For chat-message
 * sized inputs (a few hundred lines max) this is plenty fast.
 */

import { useMemo, type JSX } from 'react';

import styles from './InlineDiff.module.css';

export interface InlineDiffProps {
  /** Optional file path shown above the diff. */
  path?: string;
  oldContent: string;
  newContent: string;
}

type Op =
  | { kind: 'context'; oldNo: number; newNo: number; text: string }
  | { kind: 'add'; newNo: number; text: string }
  | { kind: 'remove'; oldNo: number; text: string };

function diffLines(oldText: string, newText: string): Op[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // LCS table.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const row = dp[i] ?? [];
      const next = dp[i + 1] ?? [];
      if (oldLines[i] === newLines[j]) {
        row[j] = (next[j + 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(next[j] ?? 0, row[j + 1] ?? 0);
      }
    }
  }

  // Walk the table to emit ops.
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'context', oldNo: i + 1, newNo: j + 1, text: oldLines[i] ?? '' });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'remove', oldNo: i + 1, text: oldLines[i] ?? '' });
      i++;
    } else {
      ops.push({ kind: 'add', newNo: j + 1, text: newLines[j] ?? '' });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: 'remove', oldNo: i + 1, text: oldLines[i] ?? '' });
    i++;
  }
  while (j < n) {
    ops.push({ kind: 'add', newNo: j + 1, text: newLines[j] ?? '' });
    j++;
  }
  return ops;
}

export function InlineDiff({ path, oldContent, newContent }: InlineDiffProps): JSX.Element {
  const ops = useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);
  const maxLineNo = Math.max(
    oldContent.split('\n').length,
    newContent.split('\n').length,
  );
  const gutterWidth = String(maxLineNo).length;

  return (
    <div className={styles.root} role="region" aria-label="File diff">
      {path !== undefined && path.length > 0 ? (
        <div className={styles.path}>{path}</div>
      ) : null}
      <div className={styles.body}>
        {ops.map((op, idx) => renderOp(op, idx, gutterWidth))}
      </div>
    </div>
  );
}

function renderOp(op: Op, idx: number, width: number): JSX.Element {
  switch (op.kind) {
    case 'context':
      return (
        <div key={idx} className={styles.lineContext}>
          <span className={styles.gutter} style={{ minWidth: `${width}ch` }}>
            {op.oldNo}
          </span>
          <span className={styles.gutter} style={{ minWidth: `${width}ch` }}>
            {op.newNo}
          </span>
          <span className={styles.sign}>{' '}</span>
          <span className={styles.text}>{op.text === '' ? ' ' : op.text}</span>
        </div>
      );
    case 'add':
      return (
        <div key={idx} className={styles.lineAdd}>
          <span className={styles.gutter} style={{ minWidth: `${width}ch` }} />
          <span className={styles.gutter} style={{ minWidth: `${width}ch` }}>
            {op.newNo}
          </span>
          <span className={styles.sign}>+</span>
          <span className={styles.text}>{op.text === '' ? ' ' : op.text}</span>
        </div>
      );
    case 'remove':
      return (
        <div key={idx} className={styles.lineRemove}>
          <span className={styles.gutter} style={{ minWidth: `${width}ch` }}>
            {op.oldNo}
          </span>
          <span className={styles.gutter} style={{ minWidth: `${width}ch` }} />
          <span className={styles.sign}>−</span>
          <span className={styles.text}>{op.text === '' ? ' ' : op.text}</span>
        </div>
      );
  }
}
