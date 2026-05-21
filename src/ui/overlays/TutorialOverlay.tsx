/**
 * TutorialOverlay — interactive first-run walkthrough.
 *
 * Five sequential cards highlighting the most important LocalCode
 * primitives (input bar, slash menu, memory, agents, done). Each card
 * dims the rest of the screen and renders a bordered spotlight box.
 *
 * Navigation:
 *   - Enter / RightArrow → next step
 *   - LeftArrow         → previous step
 *   - Esc / `q`         → dismiss the whole tutorial
 *
 * The overlay is purely presentational — the composition root decides
 * when to mount it and supplies an `onDone` callback that persists
 * `firstRunTutorialShown = true` and unmounts.
 *
 * Mounted from `app.tsx` inside the `// TUTORIAL-MOUNT-SECTION` block.
 * Also re-invoked on demand via the `/tutorial` slash command.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { noxPalette, textMuted } from '../theme.js';

export interface TutorialStep {
  readonly title: string;
  readonly body: string;
  readonly hint?: string;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    title: '1. Type to chat',
    body: 'The input bar at the bottom is your conversation with the model. Press / to open the command menu.',
    hint: 'InputBar',
  },
  {
    title: '2. Slash commands',
    body: 'Try /model to switch models, /usage to see token cost, /spawn to delegate to a sub-agent.',
    hint: 'Slash menu',
  },
  {
    title: '3. Project memory',
    body: 'Long-term notes about this project live in /memory. Save important context once, recall it forever.',
    hint: 'Memory',
  },
  {
    title: '4. Specialist agents',
    body: 'Spawn focused workers with /spawn <role>. Try /spawn architect for high-level design help.',
    hint: 'Agents',
  },
  {
    title: '5. Ready to roll',
    body: "That's the tour. Press Enter to start chatting. You can re-open this anytime with /tutorial.",
    hint: 'Done',
  },
] as const;

export interface TutorialOverlayProps {
  /**
   * Called once when the tutorial finishes — either the user walked
   * through every step OR pressed Esc to dismiss. The composition root
   * persists `firstRunTutorialShown = true` regardless of the reason
   * (the tutorial is skippable; we never re-show it).
   */
  readonly onDone: () => void;
  /** Optional starting step (0-indexed). Defaults to 0. */
  readonly initialStep?: number;
}

function TutorialOverlay({
  onDone,
  initialStep = 0,
}: TutorialOverlayProps): React.JSX.Element {
  const safeInitial = Math.max(
    0,
    Math.min(initialStep, TUTORIAL_STEPS.length - 1),
  );
  const [step, setStep] = useState<number>(safeInitial);
  const finished = step >= TUTORIAL_STEPS.length;

  const advance = useCallback((): void => {
    setStep((s) => {
      if (s + 1 >= TUTORIAL_STEPS.length) {
        // Defer onDone to the next tick so React doesn't fire it inside
        // the input handler (avoids "setState during render" footguns).
        queueMicrotask(onDone);
        return s + 1;
      }
      return s + 1;
    });
  }, [onDone]);

  const back = useCallback((): void => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const dismiss = useCallback((): void => {
    onDone();
  }, [onDone]);

  useInput(
    useCallback(
      (
        input: string,
        key: {
          return?: boolean;
          rightArrow?: boolean;
          leftArrow?: boolean;
          escape?: boolean;
        },
      ) => {
        if (finished) {
          return;
        }
        if (key.escape === true || input === 'q' || input === 'Q') {
          dismiss();
          return;
        }
        if (key.return === true || key.rightArrow === true) {
          advance();
          return;
        }
        if (key.leftArrow === true) {
          back();
          return;
        }
      },
      [advance, back, dismiss, finished],
    ),
  );

  // After onDone fires we render an empty fragment for one frame before
  // the parent unmounts us. Keeps the overlay defensive against a slow
  // unmount.
  if (finished) {
    return <Box />;
  }

  const current = TUTORIAL_STEPS[step] ?? TUTORIAL_STEPS[0];
  if (current === undefined) {
    return <Box />;
  }
  const total = TUTORIAL_STEPS.length;
  const progress = `Step ${step + 1} of ${total}`;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text color={textMuted}>Welcome tour</Text>
        <Text color={textMuted}>{'  ·  '}</Text>
        <Text color={noxPalette.highlight}>{progress}</Text>
      </Box>
      <Box
        flexDirection="column"
        marginTop={1}
        paddingX={2}
        paddingY={1}
        borderStyle="round"
        borderColor={noxPalette.primary}
      >
        <Text bold color={noxPalette.white}>
          {current.title}
        </Text>
        <Box marginTop={1}>
          <Text color={noxPalette.white}>{current.body}</Text>
        </Box>
        {current.hint !== undefined ? (
          <Box marginTop={1}>
            <Text color={textMuted}>↳ Focus: {current.hint}</Text>
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={textMuted} dimColor>
          ← back  ·  Enter / → next  ·  Esc / q skip
        </Text>
      </Box>
    </Box>
  );
}

export default TutorialOverlay;

// Test-only surface so unit tests can introspect the step list
// without redeclaring magic strings.
export const __test__ = {
  TUTORIAL_STEPS,
};
