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

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
// LOCALE-APPLY-SECTION — the walkthrough is the very first screen a new
// user sees after picking a language, so every word here must follow
// `config.locale`. Copy lives in the string tables; this module only
// holds the key order.
import { useT } from '../../i18n/index.js';
import type { StringKey } from '../../i18n/strings/en.js';
// LOCALE-APPLY-SECTION-END

export interface TutorialStep {
  readonly title: string;
  readonly body: string;
  readonly hint?: string;
}

/** String-table keys backing one card. Resolved at render time. */
export interface TutorialStepKeys {
  readonly titleKey: StringKey;
  readonly bodyKey: StringKey;
  readonly hintKey?: StringKey;
}

export const TUTORIAL_STEP_KEYS: readonly TutorialStepKeys[] = [
  {
    titleKey: 'tutorial.step1.title',
    bodyKey: 'tutorial.step1.body',
    hintKey: 'tutorial.step1.hint',
  },
  {
    titleKey: 'tutorial.step2.title',
    bodyKey: 'tutorial.step2.body',
    hintKey: 'tutorial.step2.hint',
  },
  {
    titleKey: 'tutorial.step3.title',
    bodyKey: 'tutorial.step3.body',
    hintKey: 'tutorial.step3.hint',
  },
  {
    titleKey: 'tutorial.step4.title',
    bodyKey: 'tutorial.step4.body',
    hintKey: 'tutorial.step4.hint',
  },
  {
    titleKey: 'tutorial.step5.title',
    bodyKey: 'tutorial.step5.body',
    hintKey: 'tutorial.step5.hint',
  },
] as const;

export const TUTORIAL_STEP_COUNT: number = TUTORIAL_STEP_KEYS.length;

/**
 * Materialise the cards for the active locale. Kept as a free function
 * (not a hook) so non-React callers and tests can resolve the copy with
 * an explicit translator.
 */
export function resolveTutorialSteps(
  translate: (key: StringKey) => string,
): readonly TutorialStep[] {
  return TUTORIAL_STEP_KEYS.map((keys) => ({
    title: translate(keys.titleKey),
    body: translate(keys.bodyKey),
    ...(keys.hintKey !== undefined ? { hint: translate(keys.hintKey) } : {}),
  }));
}

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
  // LOCALE-APPLY-SECTION
  const { t } = useT();
  // `t` is memoised on the active locale, so the cards are rebuilt only
  // when the user actually switches language.
  const steps = useMemo(() => resolveTutorialSteps(t), [t]);
  // LOCALE-APPLY-SECTION-END

  const safeInitial = Math.max(0, Math.min(initialStep, steps.length - 1));
  const [step, setStep] = useState<number>(safeInitial);
  const finished = step >= steps.length;

  const advance = useCallback((): void => {
    setStep((s) => {
      if (s + 1 >= TUTORIAL_STEP_KEYS.length) {
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

  const current = steps[step] ?? steps[0];
  if (current === undefined) {
    return <Box />;
  }
  const total = steps.length;
  const progress = t('tutorial.progress', { n: step + 1, total });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        {/* LOCALE-APPLY-SECTION */}
        <Text color={textMuted}>{t('tutorial.title')}</Text>
        <Text color={textMuted}>{'  ·  '}</Text>
        <Text color={noxPalette.highlight}>{progress}</Text>
        {/* LOCALE-APPLY-SECTION-END */}
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
            {/* LOCALE-APPLY-SECTION */}
            <Text color={textMuted}>
              {t('tutorial.focus', { name: current.hint })}
            </Text>
            {/* LOCALE-APPLY-SECTION-END */}
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1}>
        {/* LOCALE-APPLY-SECTION */}
        <Text color={textMuted} dimColor>
          {t('tutorial.footer')}
        </Text>
        {/* LOCALE-APPLY-SECTION-END */}
      </Box>
    </Box>
  );
}

export default TutorialOverlay;

// Test-only surface so unit tests can introspect the step list without
// redeclaring magic strings. Copy is locale-dependent now, so tests get
// the key order plus the resolver instead of a frozen English array.
export const __test__ = {
  TUTORIAL_STEP_KEYS,
  TUTORIAL_STEP_COUNT,
  resolveTutorialSteps,
};
