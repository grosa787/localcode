/**
 * PlanModeOverlay — visual surface for `permissions.profile === 'plan'`.
 *
 * Two pure-presentational pieces:
 *
 *   - <PlanModeBanner /> — bordered top-of-screen banner. Mounted from
 *     `app.tsx` PLAN-MODE-OVERLAY-SECTION whenever the active profile is
 *     `plan`. Hidden in every other profile so unrelated terminal real
 *     estate isn't taxed.
 *
 *   - <PlanModeBlockedBadge /> — inline `[BLOCKED IN PLAN] <tool>` chip
 *     used to flag tool calls that the executor rejected because Plan
 *     Mode was active. Drop-in for surfaces that would normally render an
 *     ApprovalPrompt or DiffView.
 *
 * Locale: both components consume `useT()` so `/language ru` flips the
 * copy without remount. Keys live in `src/i18n/strings/{en,ru}.ts`
 * (`plan.banner.*`, `plan.toolBlocked`).
 *
 * Visual choices:
 *   - Banner uses `noxPalette.highlight` (lavender) for the border and
 *     a bold yellow lock glyph so it stands clear of the regular chat
 *     stream without being shouty.
 *   - Badge uses `theme.warning` (yellow) to match the banner's accent.
 *
 * The components are entirely render-only — no `useInput`, no effects.
 * The keystroke that toggles plan mode lives in `app.tsx`
 * PLAN-MODE-HOTKEY-SECTION; the executor side-effect (blocking the
 * tool) lives in `src/llm/tool-executor.ts` PLAN-MODE-BLOCK-SECTION.
 */

import React from 'react';
import { Box, Text } from 'ink';

import { useT } from '@/i18n';
import { noxPalette, textMuted } from '../theme.js';

export interface PlanModeBannerProps {
  /**
   * Optional override of the lock glyph. Defaults to the unicode lock
   * (U+1F512). Exposed so the host can swap it for a plain ASCII
   * fallback (`[P]`) on terminals with poor emoji rendering.
   */
  readonly icon?: string;
}

/**
 * Top-of-screen Plan Mode banner. Render WITHOUT any width prop so it
 * naturally fills its parent Box (ChatScreen mounts inside a column
 * flex container). The banner is intentionally a single row so it does
 * not push the chat scroll position.
 */
export function PlanModeBanner({
  icon = '🔒',
}: PlanModeBannerProps): React.JSX.Element {
  const { t } = useT();
  return (
    <Box
      borderStyle="round"
      borderColor={noxPalette.highlight}
      paddingX={1}
      flexDirection="row"
    >
      <Text bold color={noxPalette.yellow}>
        {`${icon} ${t('plan.banner.title')}`}
      </Text>
      <Text color={textMuted}>{` — ${t('plan.banner.hint')}`}</Text>
    </Box>
  );
}

export interface PlanModeBlockedBadgeProps {
  /** Tool name the executor refused, e.g. `write_file`. */
  readonly toolName: string;
}

/**
 * Inline badge surfaced in place of ApprovalPrompt / DiffView when the
 * Plan Mode short-circuit fires. The wording mirrors the executor's
 * structured error so the user sees exactly what the model is told.
 */
export function PlanModeBlockedBadge({
  toolName,
}: PlanModeBlockedBadgeProps): React.JSX.Element {
  const { t } = useT();
  return (
    <Box paddingX={1}>
      <Text bold color={noxPalette.yellow}>
        {t('plan.toolBlocked', { tool: toolName })}
      </Text>
    </Box>
  );
}

export default PlanModeBanner;
