/**
 * ProactiveSuggestionsPanel — Wave 6 intelligence sidebar.
 *
 * Renders a single dim row above the InputBar when the proactive
 * detector surfaces a high-confidence sub-agent suggestion. The user
 * can:
 *   - Press the bound hotkey (default Ctrl+Shift+D) to spawn the
 *     suggested template.
 *   - Press Esc / use `/suggest panel off` to dismiss the panel.
 *
 * The component is purely presentational. Detection, hotkey
 * dispatch, and visibility persistence live in the host (ChatScreen /
 * app.tsx). Keeping it dumb means the proactive-detector tests can
 * cover the brain and the component test can pin the UI shape without
 * coupling.
 *
 * Visibility contract:
 *   - When `visible` is false → render `null` (zero vertical space).
 *   - When `suggestion` is undefined → render `null`.
 *   - Otherwise render exactly one row: `💡 <reason> (<hotkey>)`.
 *
 * Visual treatment matches `SuggestedFollowUps` — dim italic muted
 * text. We deliberately keep the layout to a single line so the panel
 * never eats more than one row of the user's vertical real estate.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { textMuted } from '../theme.js';

import type { ProactiveSuggestion } from '@/agents/proactive-detector';

export interface ProactiveSuggestionsPanelProps {
  /** Top suggestion to render. Optional — null/undefined hides the row. */
  readonly suggestion?: ProactiveSuggestion | null;
  /**
   * Toggleable via `/suggest panel off`. When false the panel renders
   * `null` so it contributes zero vertical space.
   */
  readonly visible: boolean;
  /**
   * Hotkey label shown next to the reason. Host-defined so the bind
   * site and the display stay in lockstep. Defaults to `Ctrl+Shift+D`.
   */
  readonly hotkeyLabel?: string;
}

const DEFAULT_HOTKEY_LABEL = 'Ctrl+Shift+D';

function ProactiveSuggestionsPanelImpl({
  suggestion,
  visible,
  hotkeyLabel,
}: ProactiveSuggestionsPanelProps): React.JSX.Element | null {
  if (!visible) return null;
  if (suggestion === null || suggestion === undefined) return null;

  const label = hotkeyLabel ?? DEFAULT_HOTKEY_LABEL;
  return (
    <Box paddingX={1}>
      <Text color={textMuted} dimColor italic>
        {`💡 ${suggestion.reason} (${label})`}
      </Text>
    </Box>
  );
}

export const ProactiveSuggestionsPanel = React.memo(ProactiveSuggestionsPanelImpl);
export default ProactiveSuggestionsPanel;
