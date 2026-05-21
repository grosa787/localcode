/**
 * NOX mascot — the pixel-art owl/cat familiar that greets the user on
 * an empty ChatScreen and sits next to the InputBar during chat. FIX
 * #25.
 *
 * Three variants:
 *   - `<NoxBig>`        : 16×14-pixel hero rendered centered on empty
 *                         screen + `N  O  X` name label and tagline
 *                         (the labels were removed in Round 4).
 *   - `<NoxMini>`       : 6×4-pixel compact icon next to the InputBar;
 *                         its eyes blink (yellow → highlight) while
 *                         streaming.
 *   - `<NoxTamagotchi>` : Round 6 — TINY 3-pixel × 2-row companion that
 *                         lives flush against the right edge of the
 *                         InputBar. Slow breathing animation alternates
 *                         the body shade between primary and light
 *                         every 2 s when `active` is true; static
 *                         silhouette otherwise.
 *
 * Why so many spaces in the map? Each pixel is rendered as two
 * background-coloured space characters (`'  '`), giving us square-ish
 * cells in a TTY that uses 1×2 cell ratios. The map itself is a simple
 * grid where every second character is a key letter (`B`, `L`, `H`…)
 * separated by a literal space to keep it readable in source — we
 * iterate at even indices only.
 *
 * Colour key (mirrors `noxPalette` in theme.ts):
 *   D = darkest, M = darker, B = primary, L = light, H = highlight,
 *   W = white, Y = yellow (eyes), P = pupil.
 *   ' ' (space, odd-index, or unknown) → transparent (no bg emitted).
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import chalk from 'chalk';
import { noxPalette } from '../theme.js';

/**
 * Hero 16×14 pixel map. Each row is read in 2-char strides — the
 * letter at even index is the colour key, the following space is just
 * visual padding in source. Width = 32 characters → 16 pixels.
 */
const PIXEL_MAP: readonly string[] = [
  '        B B         B B         ',
  '      M B L         L B M       ',
  '    D M B L H H H H L B M D     ',
  '    D M B W W H L L W W B M D   ',
  '  D M B W Y Y W B W Y Y W B M D ',
  '  D M B W Y P W B W P Y W B M D ',
  '  D M B W W W W Y W W W W B M D ',
  '  D M B H W W W W W W W H B M D ',
  'D M B L H W W W W W W W H L B M D',
  'D M B B L B L H W W H L B L B M D',
  '  D M B L B L H H H H L B L B M D',
  '    D M B B L H H H L L B B M D ',
  '      D M B B B L L B B B M D   ',
  '        D D M M B B M M D D     ',
];

/** Compact 6×4 variant rendered next to the InputBar. */
const MINI_MAP: readonly string[] = [
  ' M B L L B M',
  ' M W Y Y W M',
  ' M W P P W M',
  ' D M B B M D',
];

function baseColorFor(ch: string): string | null {
  switch (ch) {
    case 'D':
      return noxPalette.darkest;
    case 'M':
      return noxPalette.darker;
    case 'B':
      return noxPalette.primary;
    case 'L':
      return noxPalette.light;
    case 'H':
      return noxPalette.highlight;
    case 'W':
      return noxPalette.white;
    case 'Y':
      return noxPalette.yellow;
    case 'P':
      return noxPalette.pupil;
    default:
      return null; // space / unknown → transparent cell
  }
}

/**
 * Render one row of a pixel map — iterates across characters in steps
 * of two (each cell is `<letter><space>`), painting a 2-char-wide
 * background for each coloured cell and emitting two plain spaces for
 * transparent cells. Returns a single ANSI-coloured string suitable
 * for a single ink `<Text>` child.
 */
function renderPixelRow(
  line: string,
  colorFor: (ch: string) => string | null = baseColorFor,
): string {
  let out = '';
  for (let i = 0; i < line.length; i += 2) {
    const ch = line[i] ?? ' ';
    const colour = colorFor(ch);
    if (colour === null) {
      out += '  ';
    } else {
      out += chalk.bgHex(colour)('  ');
    }
  }
  return out;
}

/**
 * Big mascot shown as a splash on an empty chat screen. Centers the
 * 32-char-wide art horizontally to the terminal width; if the
 * terminal is narrower than the art, no padding is emitted (the art
 * will wrap/overflow gracefully — there's no safer thing to do
 * without distorting the mascot).
 *
 * Round 4 (Agent 4): the `N  O  X` name label and `your local ai`
 * tagline were removed at the user's explicit request — the pixel art
 * speaks for itself. We keep `marginY={1}` so the splash still has
 * vertical breathing room before the next ChatScreen content.
 */
export const NoxBig: React.FC = () => {
  // H5 — react to SIGWINCH so the art stays centred when the terminal
  // is resized. Without this the splash captured the width on mount
  // and never updated, leaving NoxBig off-centre after a resize.
  const { stdout } = useStdout();
  const [terminalWidth, setTerminalWidth] = useState<number>(
    () => stdout?.columns ?? process.stdout.columns ?? 80,
  );

  useEffect(() => {
    if (stdout === undefined) return undefined;
    const onResize = (): void => {
      setTerminalWidth(stdout.columns ?? 80);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const artWidth = 32; // 16 pixels × 2 chars
  const leftPad = Math.max(0, Math.floor((terminalWidth - artWidth) / 2));
  const pad = ' '.repeat(leftPad);

  return (
    <Box flexDirection="column" marginY={1}>
      {PIXEL_MAP.map((line, i) => (
        <Text key={`nox-big-${i}`}>
          {pad}
          {renderPixelRow(line)}
        </Text>
      ))}
    </Box>
  );
};

export interface NoxMiniProps {
  /**
   * When true, the eyes blink between yellow and highlight every
   * 600 ms to signal streaming activity. When false, the eyes stay on
   * plain yellow and no timer runs.
   */
  readonly isStreaming?: boolean;
}

export const NoxMini: React.FC<NoxMiniProps> = ({ isStreaming = false }) => {
  const [blinkOn, setBlinkOn] = useState<boolean>(false);

  useEffect(() => {
    if (!isStreaming) {
      setBlinkOn(false);
      return;
    }
    const id = setInterval(() => setBlinkOn((b) => !b), 600);
    return () => clearInterval(id);
  }, [isStreaming]);

  // While blinking, `Y` cells pulse highlight instead of yellow.
  const eyeColour =
    isStreaming && blinkOn ? noxPalette.highlight : noxPalette.yellow;

  const colorFor = (ch: string): string | null => {
    if (ch === 'Y') return eyeColour;
    return baseColorFor(ch);
  };

  return (
    <Box flexDirection="column">
      {MINI_MAP.map((line, i) => (
        <Text key={`nox-mini-${i}`}>{renderPixelRow(line, colorFor)}</Text>
      ))}
    </Box>
  );
};

/**
 * Tiny 3-pixel × 2-row "tamagotchi" companion (Round 6, Agent 4).
 *
 * Lives flush against the right edge of the InputBar — the 3 pixels
 * (= 6 character columns) sit small enough that they don't compete
 * with the bar's content but big enough to read at a glance:
 *
 *   ┌── row 0 ── B Y B   (body | eye | body, top half)
 *   └── row 1 ── M B M   (foot | belly | foot, bottom half)
 *
 * When `active` is true, the body cells (`B`) breathe by alternating
 * between `noxPalette.primary` and `noxPalette.light` every 2 s. The
 * single eye (`Y`) holds yellow continuously — too much movement
 * would distract from the user's typing. When `active=false` the
 * pixels stay on the primary shade, becoming a quiet silhouette.
 */
const TAMAGOTCHI_MAP: readonly string[] = [
  ' B Y B',
  ' M B M',
];

const TAMAGOTCHI_BREATHE_MS = 2000;

export interface NoxTamagotchiProps {
  /**
   * When true, the body pixels alternate primary↔light every 2 s. When
   * false (default) they stay on `noxPalette.primary` and no timer
   * runs.
   */
  readonly active?: boolean;
}

export const NoxTamagotchi: React.FC<NoxTamagotchiProps> = ({
  active = false,
}) => {
  const [breatheOn, setBreatheOn] = useState<boolean>(false);

  useEffect(() => {
    if (!active) {
      setBreatheOn(false);
      return;
    }
    const id = setInterval(
      () => setBreatheOn((b) => !b),
      TAMAGOTCHI_BREATHE_MS,
    );
    return () => clearInterval(id);
  }, [active]);

  // Breathe: `B` cells pulse `light` on the inhale frame, primary on
  // the exhale. The shadow row (`M`) breathes the opposite phase to
  // keep the silhouette consistent without visually shifting.
  const bodyColour =
    active && breatheOn ? noxPalette.light : noxPalette.primary;
  const shadowColour =
    active && breatheOn ? noxPalette.primary : noxPalette.darker;

  const colorFor = (ch: string): string | null => {
    if (ch === 'B') return bodyColour;
    if (ch === 'M') return shadowColour;
    return baseColorFor(ch);
  };

  return (
    <Box flexDirection="column">
      {TAMAGOTCHI_MAP.map((line, i) => (
        <Text key={`nox-tama-${i}`}>{renderPixelRow(line, colorFor)}</Text>
      ))}
    </Box>
  );
};

export default NoxBig;
