/**
 * Single source of truth for colors and visual constants.
 *
 * Round 3 (FIX #26): switched to the Nox purple palette. Every UI
 * component routes its colour through the `theme` object or the
 * `noxPalette` map — no component should import `chalk` directly.
 *
 * The `theme` object's keys are stable across rounds; only the values
 * change (generally towards lavender/purple shades). A handful of new
 * fields have been appended (`userMessageBg`, `userMessageBar`,
 * `assistantBar`, `assistantLabel`) so MessageBlock / ChatScreen can
 * render the new visual language from FIX #24 without each component
 * hand-rolling hex codes.
 */

import chalk from 'chalk';

/**
 * Canonical Nox palette (FIX #26). Every letter maps 1:1 to the
 * PIXEL_MAP used by the `<NoxBig>` / `<NoxMini>` components so we can
 * reason about the mascot art and the surrounding UI in the same
 * vocabulary.
 */
export const noxPalette = {
  darkest: '#2d1b69', // D — shadow
  darker: '#4c1d95', // M — dark purple
  primary: '#7c3aed', // B — main purple
  light: '#a855f7', // L — light purple
  highlight: '#c084fc', // H — highlight
  white: '#e9d5ff', // W — near-white / off-white
  yellow: '#fbbf24', // Y — eyes / accent
  pupil: '#1e1b4b', // P — pupils / deepest contrast
} as const;

/**
 * Round 4 (Agent 4): bumped foreground muted/desc/arg/result/lineNum
 * colours from `noxPalette.darker` (#4c1d95 — barely legible on a
 * black terminal) to a softer lavender (`textMuted` below). Background
 * fills (`userMessageBg`) keep the vivid darker shade because the
 * contrast comes from the foreground white text, not the bg itself.
 *
 * Round 12 (Agent 4): user reported the lavender (#9d8fc7) is STILL
 * too dim on common dark terminals — running text and overlay copy
 * essentially require squinting. Bumped to `#cbb8e8`, an almost-white
 * with a faint purple tint that retains the brand hue while landing
 * comfortably above the ~7:1 contrast threshold against `#000`/`#0d0d0d`
 * shells. Treat this as "muted" for *visual* hierarchy only — the
 * character is no longer barely legible.
 */
export const textMuted = '#cbb8e8';

/**
 * Round 6 (Agent 4): bright off-white tuned for assistant message
 * bodies on a dark terminal. The previous default was the terminal's
 * inherited foreground, which on most "dark" themes lands somewhere
 * between #cccccc and a muted gray — readable but tiring, especially
 * during long replies. `assistantText` matches `noxPalette.white`
 * (#e9d5ff, a warm lavender-tinted off-white) so the body text picks
 * up the same hue as the assistant label/bar without screaming for
 * attention. If even more punch is needed, bump to `#f3e8ff`.
 *
 * Round 12 (Agent 4): nudged from `#e9d5ff` to `#f5edff` — closer to
 * pure white but still warm. Pairs with the brighter `textMuted` so
 * assistant prose stands a clear notch above muted UI chrome instead
 * of bleeding into the same colour band.
 */
export const assistantText = '#f5edff';

/**
 * Round 12 (Agent 4): the previous border colour was `noxPalette.darker`
 * (#4c1d95) — saturated but very dark, so bordered overlays on a black
 * terminal looked like they had no frame at all. `dimSeparator` is a
 * mid-purple that *is visible* but stays decorative; use it for
 * `borderStyle="round"` frames and for the dotted message separator.
 */
export const dimSeparator = '#a98fd8';

export const theme = {
  // Structural elements
  border: chalk.hex(dimSeparator),
  muted: chalk.hex(textMuted),

  // Statuses — success/error stay chromatic so they remain readable.
  success: chalk.hex('#86efac'),
  error: chalk.hex('#fca5a5'),
  warning: chalk.hex(noxPalette.yellow),
  info: chalk.hex(noxPalette.white),

  // Diff — purple-on-white for added, dark-red-on-white for removed.
  diffAdded: chalk.bgHex(noxPalette.primary).hex(noxPalette.white),
  diffRemoved: chalk.bgHex('#991b1b').hex(noxPalette.white),
  diffLineNum: chalk.hex(textMuted),

  // Tool calls
  toolBullet: chalk.hex(noxPalette.highlight)('●'),
  toolName: chalk.hex(noxPalette.white).bold,
  toolArg: chalk.hex(textMuted),
  toolResult: chalk.hex(textMuted)('└─'),

  // Header / logo
  logo: chalk.hex(noxPalette.white).bold('◆ LocalCode'),
  ctxGreen: chalk.hex(noxPalette.light),
  ctxYellow: chalk.hex(noxPalette.yellow),
  ctxRed: chalk.hex('#fca5a5'),

  // Input
  prompt: chalk.hex(noxPalette.highlight).bold('❯'),

  // Slash menu
  cmdName: chalk.hex(noxPalette.white).bold,
  cmdDesc: chalk.hex(textMuted),
  selected: chalk.bgHex(noxPalette.primary).hex(noxPalette.white),

  // User message style (FIX #24) — coloured bg strip, no textual label.
  userMessageBg: chalk.bgHex(noxPalette.darker).hex(noxPalette.white),
  userMessageBar: chalk.hex(noxPalette.light)('▎'),

  // Assistant label (kept as ink-styled helpers so MessageBlock can
  // render `▎ <model>` without another `chalk.hex(...)` import).
  assistantBar: chalk.hex(noxPalette.primary)('▎'),
  assistantLabel: chalk.hex(noxPalette.highlight).bold,
} as const;

/**
 * Round 13 (Agent C, ROADMAP #3): syntax highlighting palette for
 * fenced code blocks. The token names match the categories that
 * highlight.js (and our `cli-highlight` wrapper) emit, but we keep the
 * map *flat* and free-standing so consumers can:
 *   1. assemble a `cli-highlight` `Theme` object from it (see
 *      `src/ui/highlighting/syntax-highlight.ts`), or
 *   2. apply individual colourizers ad-hoc (e.g. inline-code style for
 *      `MessageBlock`'s text segments).
 *
 * Every value is a `chalk` instance so callers can compose further
 * (e.g. `syntaxTheme.keyword.dim(...)`) without re-deriving styles.
 *
 * Hex choices align with `noxPalette` so the highlighter NEVER drifts
 * outside the brand:
 *   - keywords/types/builtins hover in the purple band,
 *   - strings stay green-cool for contrast,
 *   - numbers/literals/attrs share the warm yellow accent,
 *   - comments use the muted lavender so they recede,
 *   - functions/identifiers go bright off-white so the eye lands on
 *     the meaningful symbol first.
 */
export const syntaxTheme = {
  /** Reserved words: `function`, `if`, `return`, `class`, ... */
  keyword: chalk.hex(noxPalette.highlight).bold,
  /** String literals (single, double, template). */
  string: chalk.hex('#86efac'),
  /** Numeric literals (int, float, hex, binary). */
  number: chalk.hex(noxPalette.yellow),
  /** Line and block comments. */
  comment: chalk.hex('#9d8fc7').italic,
  /** Function names at definition and call sites. */
  function: chalk.hex(assistantText).bold,
  /** User-defined types, generics, type parameters. */
  type: chalk.hex(noxPalette.light),
  /** Local/global variables, parameters, fields. */
  variable: chalk.hex(noxPalette.white),
  /** Operators (`+`, `=>`, `==`, `&&`, ...). */
  operator: chalk.hex(textMuted),
  /** Punctuation (`,`, `;`, `()`, `{}`, `[]`). */
  punctuation: chalk.hex(textMuted),
  /** Class names at definition and call sites. */
  className: chalk.hex(noxPalette.light).bold,
  /** Built-in identifiers (e.g. `Math`, `console`, `print`, `len`). */
  builtin: chalk.hex(noxPalette.highlight),
  /** Regular-expression literals. */
  regexp: chalk.hex('#86efac'),
  /** HTML/JSX/CSS attribute names. */
  attr: chalk.hex(noxPalette.yellow),
  /** HTML/XML tag names. */
  tag: chalk.hex(noxPalette.highlight),
  /** Language literals: `true`, `false`, `null`, `None`, `nil`. */
  literal: chalk.hex(noxPalette.yellow),
} as const;

/**
 * Inline-code styling for prose. Single-backtick spans inside assistant
 * text use this — distinct from the full code-block syntax theme
 * because inline code typically isn't long enough to be worth a full
 * tokenisation pass and reads better with a single accented colour.
 */
export const inlineCode = chalk.hex(noxPalette.yellow);

/**
 * Frames for the thinking/processing spinner.
 * 10-frame braille spinner; animate at 80 ms interval.
 */
export const spinnerFrames: readonly string[] = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
];

/**
 * Pick a colorizer for the context bar based on fill percentage.
 * - < 60%  green-ish (lavender)
 * - < 85%  yellow
 * - >= 85% red
 */
export function ctxColor(percent: number): (s: string) => string {
  if (percent >= 85) return theme.ctxRed;
  if (percent >= 60) return theme.ctxYellow;
  return theme.ctxGreen;
}

/**
 * Palette of hex values used by the thinking-spinner gradient effect
 * (FIX #28). Each character of the phrase picks a colour from this
 * cycle and it rotates at ~150 ms → visual "flow" left to right.
 *
 * The cycle is intentionally ping-pong (bright ↔ light ↔ bright) so
 * there's no hard seam when the sequence wraps.
 */
export const phraseGradient: readonly string[] = [
  noxPalette.primary,
  noxPalette.light,
  noxPalette.highlight,
  noxPalette.white,
  noxPalette.highlight,
  noxPalette.light,
] as const;
