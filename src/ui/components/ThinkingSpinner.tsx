/**
 * Animated spinner + elapsed-time counter used while the model is
 * generating. FIX #28: now surfaces a rotating phrase bank with a
 * gradient colour flow.
 *
 * One-line output:
 *
 *   ⠋  <coloured phrase>  (2m 14s)
 *
 * Intervals in play:
 *   - 80 ms   → spinner frame advance
 *   - 1000 ms → seconds counter
 *   - 30 s    → phrase rotation (see `PHRASE_ROTATE_MS`)
 *   - 150 ms  → gradient hue offset (see `GRADIENT_STEP_MS`)
 *
 * All intervals are cleaned up on unmount / when `startedAt` changes.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { phraseGradient, spinnerFrames } from '../theme.js';
import {
  GRADIENT_STEP_MS,
  PHRASE_ROTATE_MS,
  pickPhrase,
} from './ThinkingPhrases.js';

export interface ThinkingSpinnerProps {
  readonly startedAt: number;
  /** Optional locale for phrase bank; defaults to English. */
  readonly locale?: 'en' | 'ru';
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * M3 — collapse 4 intervals into 2. The 80ms spinner tick and 150ms
 * gradient tick happen on close enough timescales that we can drive both
 * from a single setInterval; on every tick we advance the spinner frame
 * and conditionally advance the gradient phase. Similarly the 1s elapsed
 * tick and 30s phrase rotation share a 1s pump.
 *
 * Net wakeups per second go from 12.5 + 1 + ~6.7 + 0.033 ≈ 20 to
 * ~12.5 + ~1 ≈ 13.5, halving the number of setState slots ink has to
 * reconcile during streaming.
 */
const FAST_TICK_MS = 80;
const SLOW_TICK_MS = 1000;
const GRADIENT_STEPS_PER_FAST_TICK = Math.max(
  1,
  Math.round(GRADIENT_STEP_MS / FAST_TICK_MS),
);
const PHRASE_STEPS_PER_SLOW_TICK = Math.max(
  1,
  Math.round(PHRASE_ROTATE_MS / SLOW_TICK_MS),
);

function ThinkingSpinnerImpl({
  startedAt,
  locale = 'en',
}: ThinkingSpinnerProps): React.JSX.Element {
  const [frame, setFrame] = useState<number>(0);
  const [elapsedMs, setElapsedMs] = useState<number>(() => Date.now() - startedAt);
  const [phraseIndex, setPhraseIndex] = useState<number>(0);
  const [gradientPhase, setGradientPhase] = useState<number>(0);

  // Fast pump: spinner frame + gradient phase. Computing both values
  // per tick (with the gradient gated by a step counter) lets us drop
  // a whole setInterval slot while preserving the visual cadence.
  useEffect(() => {
    let fastCounter = 0;
    const handle = setInterval(() => {
      fastCounter += 1;
      setFrame((f) => (f + 1) % spinnerFrames.length);
      if (fastCounter % GRADIENT_STEPS_PER_FAST_TICK === 0) {
        setGradientPhase((p) =>
          phraseGradient.length === 0 ? 0 : (p + 1) % phraseGradient.length,
        );
      }
    }, FAST_TICK_MS);
    return () => clearInterval(handle);
  }, []);

  // Slow pump: elapsed counter + phrase rotation. The phrase advances
  // every PHRASE_STEPS_PER_SLOW_TICK whole seconds, which lands within
  // a frame of the legacy 30s cadence.
  useEffect(() => {
    // Reset elapsed at mount / when `startedAt` changes, then tick each
    // second. The slow counter restarts so the phrase doesn't jump on
    // re-mount.
    setElapsedMs(Date.now() - startedAt);
    let slowCounter = 0;
    const handle = setInterval(() => {
      slowCounter += 1;
      setElapsedMs(Date.now() - startedAt);
      if (slowCounter % PHRASE_STEPS_PER_SLOW_TICK === 0) {
        setPhraseIndex((i) => i + 1);
      }
    }, SLOW_TICK_MS);
    return () => clearInterval(handle);
  }, [startedAt]);

  const glyph = spinnerFrames[frame] ?? spinnerFrames[0] ?? '⠋';

  // Build the coloured phrase string. Each character picks a colour
  // offset by its index + the current gradient phase; wrap with modulo
  // so the cycle is seamless. Empty phraseGradient (shouldn't happen)
  // falls back to palette white.
  const colouredPhrase = useMemo(() => {
    const phrase = pickPhrase(locale, phraseIndex);
    const n = phraseGradient.length;
    if (n === 0) return phrase;
    return phrase
      .split('')
      .map((ch, i) => {
        // Don't waste colour codes on whitespace — it reads the same
        // uncoloured and halves the escape-sequence byte count.
        if (ch === ' ') return ' ';
        const slot = (i + gradientPhase) % n;
        const hex = phraseGradient[slot] ?? '#e9d5ff';
        return chalk.hex(hex)(ch);
      })
      .join('');
  }, [gradientPhase, locale, phraseIndex]);

  return (
    <Box flexDirection="row" paddingX={1}>
      <Text color="yellow">{glyph}</Text>
      <Text> </Text>
      <Text>{colouredPhrase}</Text>
      <Text color="gray">{`  (${formatElapsed(elapsedMs)})`}</Text>
    </Box>
  );
}

/**
 * R7 (Agent 4) — flicker reduction.
 *
 * `ThinkingSpinner` runs four independent intervals (spinner frame,
 * elapsed counter, phrase rotation, gradient phase) — those drive
 * its OWN re-renders via `useState`, which is fine. The memo wrap
 * here protects against a different problem: parent re-renders
 * (streaming chunks, queue updates, slash menu opens, …) that would
 * otherwise re-call the function component, force-resetting the
 * gradient/phrase computation `useMemo` despite identical props. The
 * two props are primitives, so the default comparator is correct.
 */
const ThinkingSpinner = React.memo(ThinkingSpinnerImpl);

export default ThinkingSpinner;
