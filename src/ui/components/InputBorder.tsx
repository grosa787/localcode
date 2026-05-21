/**
 * Wave 5A — TUI input bar polish.
 *
 * Thin wrapper around ink's `<Box borderStyle="round">` that:
 *   - guarantees full-width composition (`flexGrow={1}` + `flexBasis="0%"`),
 *   - applies the focus-aware default colour (`--accent` lavender when
 *     focused, `dimSeparator` when not) without each caller hand-rolling
 *     the conditional,
 *   - exposes the same `paddingX={1}` rhythm the previous InputBar used
 *     so the visible inner box doesn't shift when we swap layouts.
 *
 * Why a helper at all? The input-row composition needs to stack three
 * pieces (pill / bordered editor / hint) and apply the same focus-aware
 * border colour to the middle piece in two different contexts (the
 * bordered live editor + the bash-mode green override). Centralising
 * the border rendering keeps both paths visually identical.
 *
 * ink's `borderStyle="round"` already produces the soft Unicode frame
 * `╭─` `─╮` `╰─` `─╯` with `│` sides that the spec asks for. We do NOT
 * draw the frame manually — that would duplicate ink's wcwidth-aware
 * width handling and break on non-mono glyphs.
 */

import React from 'react';
import { Box } from 'ink';
import { dimSeparator, noxPalette } from '../theme.js';

export interface InputBorderProps {
  /**
   * When true the border picks up the accent colour (lavender). When
   * false it falls back to the dim separator. Bash-mode green and
   * other one-off colour overrides are routed through `borderColor`.
   */
  readonly focused: boolean;
  /** Explicit colour override. Wins over the focus default. */
  readonly borderColor?: string;
  readonly children: React.ReactNode;
}

/**
 * Default border colour for the focused/unfocused state. Exposed for
 * tests that don't render the component but verify the colour pick.
 */
export function defaultBorderColor(focused: boolean): string {
  return focused ? noxPalette.light : dimSeparator;
}

function InputBorder(props: InputBorderProps): React.JSX.Element {
  const color = props.borderColor ?? defaultBorderColor(props.focused);
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="round"
      borderColor={color}
      flexGrow={1}
      flexShrink={1}
      flexBasis="0%"
    >
      {props.children}
    </Box>
  );
}

export default InputBorder;

export const __test__ = {
  defaultBorderColor,
};
