/**
 * BatchApprovalDialog — unified batch-approval modal fired when the LLM
 * emits N or more mutating tool calls in a single turn (default N=3 per
 * `permissions.batchApprovalThreshold`).
 *
 * UX
 * --
 * Two-pane layout:
 *   - Left  — scrollable list of items (tool name + filename + line
 *             delta + per-item status icon: pending / approved /
 *             rejected).
 *   - Right — preview of the currently selected item (diff content for
 *             write/edit tools; command line for run_command; raw args
 *             for other mutators).
 *
 * Hotkeys
 * -------
 *   ↑ / ↓        navigate items
 *   Space, Enter toggle current item between approved/rejected
 *   A            approve all
 *   R            reject all
 *   Ctrl+Enter   confirm selections and close (uncommitted = rejected)
 *   Esc          cancel everything (all rejected)
 *
 * Wiring
 * ------
 * The dialog is OWN screen while mounted — its `useInputModeHandler`
 * subscribes to `'approval'` mode so no other component (composer,
 * slash menu, etc.) receives keystrokes. The parent (app.tsx
 * BATCH-APPROVAL-SECTION) renders us inside a dedicated
 * InputDispatcherProvider with mode='approval', identical to the
 * existing ApprovalPrompt / DiffView wiring.
 *
 * The `onConfirm` callback resolves the awaiting `batchApprovalCallback`
 * promise inside the ToolExecutor with the user's per-item decisions.
 * `onCancel` resolves with every item rejected.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  useInputModeHandler,
  type InputEvent,
} from './InputDispatcher.js';
import { useT } from '@/i18n';

/**
 * Per-item payload shown in the dialog. The `previewOutput` field is
 * the result of the tool's `preview` phase (diff content for file
 * mutators; rendered command string for run_command). The dialog
 * never re-runs the preview — the caller (app.tsx) builds previews
 * upfront before mounting the dialog so the user sees diffs
 * immediately on open.
 */
export interface BatchApprovalDialogItem {
  readonly toolCallId: string;
  readonly toolName: string;
  /** Filename for diff-style tools, command for run_command, else empty. */
  readonly label: string;
  /**
   * Pre-rendered preview text (diff or command). When empty the
   * right-hand pane shows a neutral "(no preview available)" notice
   * — the user can still approve based on toolName + label alone.
   */
  readonly previewOutput: string;
  /** Optional `+N -M` line-delta summary for the row. */
  readonly lineDelta?: { readonly added: number; readonly removed: number };
}

export type BatchApprovalItemStatus = 'pending' | 'approved' | 'rejected';

export interface BatchApprovalDialogProps {
  readonly items: readonly BatchApprovalDialogItem[];
  /**
   * Resolves the awaiting executor promise. Map keys are toolCallIds;
   * values are 'approved' | 'rejected'. Pending items at confirm time
   * are coerced to 'rejected' (per spec: uncommitted = rejected).
   */
  readonly onConfirm: (
    decisions: ReadonlyMap<string, 'approved' | 'rejected'>,
  ) => void;
  /** Esc-out — every item rejected. */
  readonly onCancel: () => void;
}

function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  if (i < 0) return 0;
  if (i >= len) return len - 1;
  return i;
}

function BatchApprovalDialogImpl({
  items,
  onConfirm,
  onCancel,
}: BatchApprovalDialogProps): React.JSX.Element {
  const { t } = useT();
  const [statuses, setStatuses] = useState<readonly BatchApprovalItemStatus[]>(
    () => items.map(() => 'pending' as BatchApprovalItemStatus),
  );
  const [cursor, setCursor] = useState<number>(0);

  const counts = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    let pending = 0;
    for (const s of statuses) {
      if (s === 'approved') approved += 1;
      else if (s === 'rejected') rejected += 1;
      else pending += 1;
    }
    return { approved, rejected, pending };
  }, [statuses]);

  const setStatusAt = useCallback(
    (index: number, next: BatchApprovalItemStatus): void => {
      setStatuses((prev) => {
        if (index < 0 || index >= prev.length) return prev;
        const out = prev.slice();
        out[index] = next;
        return out;
      });
    },
    [],
  );

  const setAll = useCallback((next: BatchApprovalItemStatus): void => {
    setStatuses((prev) => prev.map(() => next));
  }, []);

  const finalise = useCallback((): void => {
    const map = new Map<string, 'approved' | 'rejected'>();
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const status = statuses[i];
      if (item === undefined) continue;
      // Uncommitted (`pending`) is coerced to rejected — spec.
      map.set(item.toolCallId, status === 'approved' ? 'approved' : 'rejected');
    }
    onConfirm(map);
  }, [items, statuses, onConfirm]);

  const handleInput = useCallback(
    (event: InputEvent): boolean => {
      const { input, key } = event;
      if (key.escape) {
        onCancel();
        return true;
      }
      // Ctrl+Enter (or Cmd+Enter) confirms. ink's Key has `ctrl` flag.
      if (key.return && key.ctrl === true) {
        finalise();
        return true;
      }
      if (key.upArrow) {
        setCursor((c) => clampIndex(c - 1, items.length));
        return true;
      }
      if (key.downArrow) {
        setCursor((c) => clampIndex(c + 1, items.length));
        return true;
      }
      // Space or plain Enter toggles the focused item.
      if (input === ' ' || (key.return && key.ctrl !== true)) {
        const current = statuses[cursor];
        const next: BatchApprovalItemStatus =
          current === 'approved' ? 'rejected' : 'approved';
        setStatusAt(cursor, next);
        return true;
      }
      const lower = input.toLowerCase();
      if (lower === 'a') {
        setAll('approved');
        return true;
      }
      if (lower === 'r') {
        setAll('rejected');
        return true;
      }
      // Swallow everything else — we OWN the screen while mounted.
      return true;
    },
    [items.length, statuses, cursor, setStatusAt, setAll, finalise, onCancel],
  );

  useInputModeHandler('approval', handleInput);

  if (items.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="yellow">
        <Text color="yellow" bold>
          {t('batch.title', { n: 0 })}
        </Text>
        <Text color="gray">{t('batch.empty')}</Text>
      </Box>
    );
  }

  const selected = items[cursor];
  const selectedStatus = statuses[cursor] ?? 'pending';

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="yellow">
      <Box flexDirection="row" justifyContent="space-between">
        <Text color="yellow" bold>
          {t('batch.title', { n: items.length })}
        </Text>
        <Text color="gray">
          {`${cursor + 1} / ${items.length}`}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="row">
        {/* Left pane: item list */}
        <Box flexDirection="column" width="45%" marginRight={2}>
          {items.map((it, i) => {
            const status = statuses[i] ?? 'pending';
            const isFocus = i === cursor;
            const icon =
              status === 'approved' ? '✓' : status === 'rejected' ? '✗' : '·';
            const iconColor =
              status === 'approved'
                ? 'green'
                : status === 'rejected'
                  ? 'red'
                  : 'gray';
            const delta =
              it.lineDelta !== undefined
                ? `  +${it.lineDelta.added} -${it.lineDelta.removed}`
                : '';
            return (
              <Box key={`batch-item-${it.toolCallId}`} flexDirection="row">
                <Text color={isFocus ? 'cyan' : 'gray'}>
                  {isFocus ? '▶ ' : '  '}
                </Text>
                <Text color={iconColor}>{icon} </Text>
                <Text color={isFocus ? 'white' : 'gray'} bold={isFocus}>
                  {`${it.toolName} ${it.label}${delta}`}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Right pane: preview of the focused item */}
        <Box flexDirection="column" width="55%">
          {selected !== undefined ? (
            <>
              <Text color="white" bold>
                {`${selected.toolName} ${selected.label}`}
              </Text>
              <Box marginTop={1} flexDirection="column">
                {selected.previewOutput.length === 0 ? (
                  <Text color="gray">(no preview available)</Text>
                ) : (
                  selected.previewOutput
                    .split(/\r?\n/)
                    .slice(0, 30)
                    .map((line, j) => (
                      <Text
                        key={`preview-${j}`}
                        color={
                          line.startsWith('+')
                            ? 'green'
                            : line.startsWith('-')
                              ? 'red'
                              : line.startsWith('@@')
                                ? 'magenta'
                                : 'gray'
                        }
                      >
                        {line}
                      </Text>
                    ))
                )}
              </Box>
              <Box marginTop={1}>
                <Text color="gray">
                  {`status: `}
                </Text>
                <Text
                  color={
                    selectedStatus === 'approved'
                      ? 'green'
                      : selectedStatus === 'rejected'
                        ? 'red'
                        : 'yellow'
                  }
                >
                  {selectedStatus}
                </Text>
              </Box>
            </>
          ) : null}
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="row">
        <Text color="green">{t('batch.hint.approve')}</Text>
        <Text color="gray">  </Text>
        <Text color="red">{t('batch.hint.reject')}</Text>
        <Text color="gray">  </Text>
        <Text color="cyan">{t('batch.hint.all')}</Text>
      </Box>
      <Box>
        <Text color="gray">
          {t('batch.status', {
            approved: counts.approved,
            rejected: counts.rejected,
            pending: counts.pending,
          })}
        </Text>
      </Box>
    </Box>
  );
}

// Memoise so external re-renders (streaming output ticking while the
// dialog is awaiting a decision) don't reset the cursor / status state.
// The props are stable references from the parent (frozen list +
// stable callbacks).
const BatchApprovalDialog = React.memo(BatchApprovalDialogImpl);

export default BatchApprovalDialog;
