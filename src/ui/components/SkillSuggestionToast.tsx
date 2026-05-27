/**
 * SkillSuggestionToast — subtle, opt-in toast surfaced when the user's
 * latest message matches a non-active skill's `triggers` frontmatter.
 *
 * The component is purely presentational. It renders a single bordered
 * row with the toast headline and the keyboard hints (Tab to activate,
 * Esc to dismiss). Key handling lives in the parent (`app.tsx`), which
 * owns the active-set mutation and dismissal timer; the toast itself
 * has no `useInput` so it doesn't steal keystrokes from the composer.
 *
 * Stacking: pass one `<SkillSuggestionToast/>` per suggestion to the
 * renderer above; the caller maps the suggestion list to a vertical
 * stack.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';

export interface SkillSuggestionToastProps {
  /**
   * Localised toast headline — already substituted (`{name}` resolved).
   * Example: `"Skill React Specialist looks relevant"`.
   */
  readonly toastText: string;
  /**
   * Trigger excerpt that produced the match — surfaced as a muted
   * subtitle so the user can see *why* the skill is being suggested.
   * Optional; when absent or empty the "matched" row is hidden.
   */
  readonly reason?: string;
  /** Localised hint shown next to the `Tab` key label. */
  readonly tabHint: string;
  /** Localised hint shown next to the `Esc` key label. */
  readonly escHint: string;
}

/**
 * Subtle accent-bordered box. We intentionally do NOT use the loudest
 * palette colours — the toast is meant to sit above the chat input
 * without dominating the screen.
 */
function SkillSuggestionToast({
  toastText,
  reason,
  tabHint,
  escHint,
}: SkillSuggestionToastProps): React.JSX.Element {
  const trimmedReason =
    typeof reason === 'string' ? reason.trim() : '';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={noxPalette.light}
      paddingX={1}
    >
      <Box>
        <Text color={noxPalette.highlight}>● </Text>
        <Text color={noxPalette.white}>{toastText}</Text>
      </Box>
      {trimmedReason.length > 0 && (
        <Box>
          <Text color={textMuted}>matched: </Text>
          <Text color={dimSeparator}>{trimmedReason}</Text>
        </Box>
      )}
      <Box>
        <Text color={noxPalette.light}>Tab</Text>
        <Text color={textMuted}> {tabHint} · </Text>
        <Text color={noxPalette.light}>Esc</Text>
        <Text color={textMuted}> {escHint}</Text>
      </Box>
    </Box>
  );
}

export default SkillSuggestionToast;
