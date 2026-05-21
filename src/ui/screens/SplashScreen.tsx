/**
 * SplashScreen — animated first-run welcome.
 *
 * Shown ONCE on first launch (no `~/.localcode/config.toml`) before the
 * language picker. The animation:
 *   - Logo letters appear staggered left-to-right (50ms / letter).
 *   - The `✨` sparkle pulses through `✦✨✧✦` (200ms / frame).
 *   - The subtitle fades in after the logo completes.
 *   - The tagline rotates through 3 phrases (1000ms each).
 *   - Auto-completes after `AUTO_ADVANCE_MS` (~3s); Enter / Space / Esc
 *     skip immediately.
 *
 * Non-TTY stdout (CI, pipes, `--no-tty`) gets a single static frame and
 * advances on the next tick — no animation, no input blocking.
 *
 * The component is intentionally self-contained: zero dependencies on
 * the rest of the app, no service injection. The composition root
 * decides when to mount it and supplies a single `onDone` callback.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { noxPalette, textMuted } from '../theme.js';

const LOGO_LETTERS = ['L', 'o', 'c', 'a', 'l', 'C', 'o', 'd', 'e'] as const;
const SPARKLE_FRAMES = ['✦', '✨', '✧', '✦'] as const;
const TAGLINES = [
  'Bring your own LLM',
  '30+ tools, full control',
  'Built for power users',
] as const;
const SUBTITLE = 'Local-first AI pair programmer';
const VERSION_LINE = 'v0.20.0 · MIT';

/** Per-letter reveal delay (ms). */
const LETTER_STEP_MS = 50;
/** Sparkle frame cycle (ms). */
const SPARKLE_STEP_MS = 200;
/** Tagline rotation (ms). */
const TAGLINE_STEP_MS = 1000;
/** Auto-advance to the next screen after this many ms. */
const AUTO_ADVANCE_MS = 3000;
/** Subtitle fade-in delay after logo completes (ms). */
const SUBTITLE_DELAY_MS = LOGO_LETTERS.length * LETTER_STEP_MS + 100;

export interface SplashScreenProps {
  /** Called when the splash finishes (auto-advance or user skip). */
  readonly onDone: () => void;
  /** Test seam — when supplied, replaces the global `setInterval`. */
  readonly setIntervalFn?: (cb: () => void, ms: number) => unknown;
  /** Test seam — when supplied, replaces the global `clearInterval`. */
  readonly clearIntervalFn?: (handle: unknown) => void;
  /** Test seam — when supplied, replaces the global `setTimeout`. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Test seam — when supplied, replaces the global `clearTimeout`. */
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

function SplashScreen({
  onDone,
  setIntervalFn,
  clearIntervalFn,
  setTimeoutFn,
  clearTimeoutFn,
}: SplashScreenProps): React.JSX.Element {
  const { stdout } = useStdout();
  // Honour the `prefers-reduced-motion` equivalent — when stdout is not
  // a TTY, render the final frame statically so test harnesses + piped
  // output stay deterministic.
  const reducedMotion =
    stdout === undefined || (stdout as { isTTY?: boolean }).isTTY !== true;

  const [letterIdx, setLetterIdx] = useState<number>(
    reducedMotion ? LOGO_LETTERS.length : 0,
  );
  const [sparkleIdx, setSparkleIdx] = useState<number>(0);
  const [taglineIdx, setTaglineIdx] = useState<number>(0);
  const [subtitleShown, setSubtitleShown] = useState<boolean>(reducedMotion);

  // Test seams default to the globals; assigning a typed local first
  // keeps the function-pointer types narrow (no `any`).
  const setIntervalImpl =
    setIntervalFn ??
    ((cb: () => void, ms: number): unknown => globalThis.setInterval(cb, ms));
  const clearIntervalImpl =
    clearIntervalFn ??
    ((h: unknown): void => {
      // Node's setInterval handle is a NodeJS.Timeout object; cast at
      // the boundary so we don't poison the rest of the file with `any`.
      globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]);
    });
  const setTimeoutImpl =
    setTimeoutFn ??
    ((cb: () => void, ms: number): unknown => globalThis.setTimeout(cb, ms));
  const clearTimeoutImpl =
    clearTimeoutFn ??
    ((h: unknown): void => {
      globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0]);
    });

  const finish = useCallback((): void => {
    onDone();
  }, [onDone]);

  // ── Animation: letter reveal ──────────────────────────────────────
  useEffect(() => {
    if (reducedMotion) return undefined;
    if (letterIdx >= LOGO_LETTERS.length) return undefined;
    const handle = setTimeoutImpl(() => {
      setLetterIdx((i) => Math.min(i + 1, LOGO_LETTERS.length));
    }, LETTER_STEP_MS);
    return (): void => {
      clearTimeoutImpl(handle);
    };
  }, [letterIdx, reducedMotion, setTimeoutImpl, clearTimeoutImpl]);

  // ── Animation: sparkle pulse ──────────────────────────────────────
  useEffect(() => {
    if (reducedMotion) return undefined;
    const handle = setIntervalImpl(() => {
      setSparkleIdx((i) => (i + 1) % SPARKLE_FRAMES.length);
    }, SPARKLE_STEP_MS);
    return (): void => {
      clearIntervalImpl(handle);
    };
  }, [reducedMotion, setIntervalImpl, clearIntervalImpl]);

  // ── Animation: tagline rotation ───────────────────────────────────
  useEffect(() => {
    if (reducedMotion) return undefined;
    const handle = setIntervalImpl(() => {
      setTaglineIdx((i) => (i + 1) % TAGLINES.length);
    }, TAGLINE_STEP_MS);
    return (): void => {
      clearIntervalImpl(handle);
    };
  }, [reducedMotion, setIntervalImpl, clearIntervalImpl]);

  // ── Animation: subtitle fade-in ───────────────────────────────────
  useEffect(() => {
    if (reducedMotion) return undefined;
    if (subtitleShown) return undefined;
    const handle = setTimeoutImpl(() => {
      setSubtitleShown(true);
    }, SUBTITLE_DELAY_MS);
    return (): void => {
      clearTimeoutImpl(handle);
    };
  }, [reducedMotion, subtitleShown, setTimeoutImpl, clearTimeoutImpl]);

  // ── Auto-advance ──────────────────────────────────────────────────
  useEffect(() => {
    const handle = setTimeoutImpl(finish, AUTO_ADVANCE_MS);
    return (): void => {
      clearTimeoutImpl(handle);
    };
  }, [finish, setTimeoutImpl, clearTimeoutImpl]);

  // ── Skip on any key ───────────────────────────────────────────────
  useInput(
    useCallback(
      (
        _input: string,
        key: { return?: boolean; escape?: boolean },
      ) => {
        if (key.return === true || key.escape === true) {
          finish();
          return;
        }
        // Any other keypress also skips — first impression should never
        // hold the user hostage.
        finish();
      },
      [finish],
    ),
  );

  const revealedLetters = LOGO_LETTERS.slice(0, letterIdx).join(' ');
  const sparkle = SPARKLE_FRAMES[sparkleIdx] ?? SPARKLE_FRAMES[0];
  const tagline = TAGLINES[taglineIdx] ?? TAGLINES[0];

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text color={noxPalette.yellow}>    {sparkle}</Text>
      </Box>
      <Box>
        <Text bold color={noxPalette.highlight}>
          {'     '}
          {revealedLetters}
        </Text>
      </Box>
      <Box>
        <Text color={noxPalette.primary}>   ─────────────────────────</Text>
      </Box>
      <Box>
        <Text color={subtitleShown ? noxPalette.white : textMuted} dimColor={!subtitleShown}>
          {'   '}
          {SUBTITLE}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={textMuted}>{'       '}{VERSION_LINE}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={textMuted} dimColor>
          {'   '}
          {tagline}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={textMuted} dimColor>
          {'   '}
          Press Enter to continue…
        </Text>
      </Box>
    </Box>
  );
}

export default SplashScreen;

// Test-only constants so unit tests can reason about the animation
// without re-declaring magic numbers.
export const __test__ = {
  LOGO_LETTERS,
  SPARKLE_FRAMES,
  TAGLINES,
  SUBTITLE,
  VERSION_LINE,
  LETTER_STEP_MS,
  SPARKLE_STEP_MS,
  TAGLINE_STEP_MS,
  AUTO_ADVANCE_MS,
  SUBTITLE_DELAY_MS,
};
