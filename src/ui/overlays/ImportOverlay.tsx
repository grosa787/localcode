/**
 * ImportOverlay — pick projects + sessions from a Claude Code scan and
 * trigger the import.
 *
 * Displays a flat checkbox tree of the scanned projects/sessions:
 *
 *   ┌─ Import from Claude Code ──────────────────────────┐
 *   │ Found N session(s) across M project(s).            │
 *   │                                                     │
 *   │ [x] /Users/foo/myrepo  (3 sessions)                 │
 *   │     [x] abcd1234  12 msgs · hi there                │
 *   │     [x] efgh5678  47 msgs · refactor the parser     │
 *   │     [ ] ijkl9012   2 msgs · ping                    │
 *   │ [ ] /Users/foo/otherproj  (1 session)               │
 *   │     [ ] mnop3456  5 msgs · debug worker hang        │
 *   │                                                     │
 *   │ ↑/↓ move · space toggle · enter import · esc cancel │
 *   └─────────────────────────────────────────────────────┘
 *
 * The overlay is purely presentational — the composition root supplies
 * the scanned `ImportPlan` and `onSubmit` / `onClose` callbacks. The
 * caller is responsible for actually running the import and showing
 * progress (we hand back the set of selected `filepath`s).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ImportPlan } from '@/migration/from-claude-code';
import { useT } from '@/i18n';

export interface ImportOverlayProps {
  readonly plan: ImportPlan;
  /**
   * Called when the user presses Enter. Receives the absolute filepaths
   * of every selected .jsonl. The caller drives `importSession` /
   * `importAll` and surfaces progress.
   */
  readonly onSubmit: (selectedFilepaths: readonly string[]) => void;
  readonly onClose: () => void;
  /**
   * Optional progress tuple driven by the host once import starts.
   * When present, the overlay renders a footer "{done}/{total}" line
   * in place of the navigation hint until `done === total`.
   */
  readonly progress?: { readonly done: number; readonly total: number } | null;
  /** Optional final summary line ("Imported N sessions"). */
  readonly summary?: string | null;
}

/**
 * Internal flattened-row model — one entry per project header AND one
 * per session, in display order. `kind: 'project'` rows toggle every
 * session under them; `kind: 'session'` rows toggle individually.
 */
interface Row {
  readonly kind: 'project' | 'session';
  /** Stable id — slug for projects, sessionId for sessions. */
  readonly id: string;
  /** Index of the owning project (used by toggle handlers). */
  readonly projectIndex: number;
  /** When kind === 'session', index inside the project's sessions[]. */
  readonly sessionIndex: number | null;
}

function buildRows(plan: ImportPlan): Row[] {
  const rows: Row[] = [];
  plan.projects.forEach((proj, pi) => {
    rows.push({
      kind: 'project',
      id: proj.pathSlug,
      projectIndex: pi,
      sessionIndex: null,
    });
    proj.sessions.forEach((sess, si) => {
      rows.push({
        kind: 'session',
        id: sess.sessionId,
        projectIndex: pi,
        sessionIndex: si,
      });
    });
  });
  return rows;
}

/**
 * Two-dimensional selection state: outer array indexed by project,
 * inner by session. Initialised "all selected" so the common case
 * (import everything) is one Enter press.
 */
function buildInitialSelection(plan: ImportPlan): boolean[][] {
  return plan.projects.map((p) => p.sessions.map(() => true));
}

export function ImportOverlay(props: ImportOverlayProps): React.JSX.Element {
  const { t } = useT();
  const { plan, onSubmit, onClose, progress, summary } = props;
  const rows = useMemo(() => buildRows(plan), [plan]);
  const [selection, setSelection] = useState<boolean[][]>(() =>
    buildInitialSelection(plan),
  );
  const [cursor, setCursor] = useState<number>(0);

  const toggleAt = useCallback(
    (rowIndex: number) => {
      const row = rows[rowIndex];
      if (row === undefined) return;
      setSelection((prev) => {
        const next = prev.map((arr) => arr.slice());
        const projArr = next[row.projectIndex];
        if (projArr === undefined) return prev;
        if (row.kind === 'session' && row.sessionIndex !== null) {
          projArr[row.sessionIndex] = !projArr[row.sessionIndex];
        } else {
          // Project header — toggle every session under it.
          const anyOn = projArr.some((b) => b);
          for (let i = 0; i < projArr.length; i += 1) projArr[i] = !anyOn;
        }
        return next;
      });
    },
    [rows],
  );

  const submit = useCallback(() => {
    const out: string[] = [];
    plan.projects.forEach((proj, pi) => {
      const projSel = selection[pi];
      if (projSel === undefined) return;
      proj.sessions.forEach((sess, si) => {
        if (projSel[si] === true) out.push(sess.filepath);
      });
    });
    onSubmit(out);
  }, [plan, selection, onSubmit]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
      return;
    }
    if (input === ' ') {
      toggleAt(cursor);
      return;
    }
    if (key.return) {
      submit();
      return;
    }
  });

  const selectedCount = useMemo(() => {
    let n = 0;
    for (const arr of selection) for (const b of arr) if (b) n += 1;
    return n;
  }, [selection]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="cyan" bold>
        {t('import.title')}
      </Text>
      <Box marginTop={1}>
        <Text color="gray">
          {t('import.projects', {
            n: String(plan.projects.length),
          })}
          {' · '}
          {t('import.sessions', { n: String(plan.totalSessions) })}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 ? (
          <Text color="gray" dimColor>
            {t('import.empty')}
          </Text>
        ) : (
          rows.map((row, idx) => {
            const isCursor = idx === cursor;
            const checked = isRowChecked(row, selection);
            const indent = row.kind === 'session' ? '    ' : '';
            const mark = checked ? '[x]' : '[ ]';
            const label = formatRowLabel(row, plan);
            return (
              <Text
                key={`${row.kind}-${row.id}-${idx}`}
                color={isCursor ? 'cyan' : undefined}
              >
                {indent}
                {isCursor ? '› ' : '  '}
                {mark} {label}
              </Text>
            );
          })
        )}
      </Box>

      {progress !== null && progress !== undefined ? (
        <Box marginTop={1}>
          <Text color="yellow">
            {t('import.progress', {
              done: String(progress.done),
              total: String(progress.total),
            })}
          </Text>
        </Box>
      ) : null}

      {summary !== null && summary !== undefined && summary.length > 0 ? (
        <Box marginTop={1}>
          <Text color="green">{summary}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {t('import.confirm', { n: String(selectedCount) })}
        </Text>
      </Box>
    </Box>
  );
}

function isRowChecked(row: Row, selection: readonly (readonly boolean[])[]): boolean {
  const projArr = selection[row.projectIndex];
  if (projArr === undefined) return false;
  if (row.kind === 'session' && row.sessionIndex !== null) {
    return projArr[row.sessionIndex] === true;
  }
  // Project header is checked when every session under it is on.
  return projArr.length > 0 && projArr.every((b) => b);
}

function formatRowLabel(row: Row, plan: ImportPlan): string {
  const proj = plan.projects[row.projectIndex];
  if (proj === undefined) return '(missing project)';
  if (row.kind === 'project') {
    return `${proj.absolutePath}  (${proj.sessions.length})`;
  }
  if (row.sessionIndex === null) return '(missing session)';
  const sess = proj.sessions[row.sessionIndex];
  if (sess === undefined) return '(missing session)';
  const id8 = sess.sessionId.slice(0, 8);
  const previewSafe =
    sess.preview.length > 0 ? sess.preview : '(no preview)';
  return `${id8}  ${sess.messageCount} msgs · ${previewSafe}`;
}

export default ImportOverlay;
