/**
 * Generic approval prompt. Used by the ChatScreen to gate
 * `run_command` before execution (write_file goes through DiffView
 * which has its own approval UI).
 *
 * Hotkeys captured via the centralised input dispatcher (mode
 * `'approval'`):
 *   y  → onApprove()
 *   n  → onReject()
 *   Esc→ onReject()
 *   a  → onApproveAllInTurn?() — only when offered.
 *   s  → onApproveForSession?() — only when offered (run_command).
 *
 * Architecture note — this component used to call `useInput` directly
 * with `isActive: true`, alongside four sibling components doing the
 * same thing. ink's `useInput` has no `event.stopPropagation()`, so a
 * `y` keystroke that confirmed the prompt also leaked into the
 * InputBar's draft buffer. The dispatcher routes a keystroke to a
 * single mode at a time, so an approval-mode key cannot reach the
 * input-mode subscribers by construction.
 */

import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { useInputModeHandler, type InputEvent } from './InputDispatcher.js';

export interface ApprovalPromptProps {
  readonly title: string;
  readonly description: string;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  /**
   * Optional handler for `[A] Approve all writes in this turn`. When
   * provided, the prompt offers the batched approval button and the
   * `a` hotkey fires it. When undefined, the button is hidden — the
   * caller decides on a per-tool basis whether batching is meaningful
   * (e.g. only for mutating tools).
   */
  readonly onApproveAllInTurn?: () => void;
  /**
   * Optional handler for `[S] Auto-approve this command for this
   * session`. Only meaningful for `run_command`; pass undefined for
   * other tools and the button is hidden.
   */
  readonly onApproveForSession?: () => void;
}

function ApprovalPrompt({
  title,
  description,
  onApprove,
  onReject,
  onApproveAllInTurn,
  onApproveForSession,
}: ApprovalPromptProps): React.JSX.Element {
  const handleInput = useCallback(
    (event: InputEvent): boolean => {
      const lower = event.input.toLowerCase();
      if (lower === 'y') {
        onApprove();
        return true;
      }
      if (lower === 'n' || event.key.escape) {
        onReject();
        return true;
      }
      if (lower === 'a' && onApproveAllInTurn !== undefined) {
        onApproveAllInTurn();
        return true;
      }
      if (lower === 's' && onApproveForSession !== undefined) {
        onApproveForSession();
        return true;
      }
      // Swallow other keystrokes — we OWN the screen while mounted.
      return true;
    },
    [onApprove, onReject, onApproveAllInTurn, onApproveForSession],
  );

  useInputModeHandler('approval', handleInput);

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="yellow">
      <Text color="yellow" bold>
        ⚠ {title}
      </Text>
      {description.length > 0 && <Text color="gray">{description}</Text>}
      <Box marginTop={1} flexDirection="row">
        <Text color="gray">Proceed?  </Text>
        <Text color="green">[y] yes</Text>
        <Text color="gray">  </Text>
        <Text color="red">[n] no</Text>
        {onApproveAllInTurn !== undefined && (
          <>
            <Text color="gray">  </Text>
            <Text color="cyan">[a] approve all in turn</Text>
          </>
        )}
        {onApproveForSession !== undefined && (
          <>
            <Text color="gray">  </Text>
            <Text color="cyan">[s] auto-approve for session</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

export default ApprovalPrompt;
