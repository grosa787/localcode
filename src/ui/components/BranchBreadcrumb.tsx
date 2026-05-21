/**
 * BranchBreadcrumb — single-line trail at the top of the chat showing
 * the chain from root to the active branch:
 *
 *   📍 main → experiment-A → fix-edge-case
 *
 * Visibility contract
 * -------------------
 * - Hidden when there are no branches in the family OR the chain is a
 *   single root with no name (clean default for users who never branch).
 * - Visible the moment any branch in the chain has a name OR there's
 *   more than one entry — the user clearly cares about branching by
 *   then.
 *
 * Purely presentational — keystroke navigation (Ctrl+B to open the
 * picker) is owned by the parent. The breadcrumb does NOT subscribe to
 * input.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
import type { BranchInfo } from '../../sessions/session-manager.js';

/**
 * One node in the breadcrumb chain. The parent (app.tsx) flattens its
 * `SessionManager.getBranchChain()` output into this shape so the
 * component stays orthogonal to the BranchInfo schema.
 */
export interface BranchCrumb {
  /** Session id of this crumb (so picker switches can reuse it). */
  readonly id: string;
  /** Display label — branch name if present, otherwise title-or-root fallback. */
  readonly label: string;
  /** True when this crumb is the currently-active session. */
  readonly active: boolean;
}

export interface BranchBreadcrumbProps {
  /** Chain from root → current. Empty array → component renders null. */
  readonly chain: readonly BranchCrumb[];
  /**
   * When false, force-hide the component even if `chain.length > 0`.
   * Defaults to true. Tests use it to assert the auto-hide rule.
   */
  readonly visible?: boolean;
}

/** Glyph that prefixes the breadcrumb so the line is easy to spot. */
const PIN_GLYPH = '\u{1F4CD}';
/** Separator between crumbs. */
const ARROW_GLYPH = ' → ';

/**
 * Pure helper — derive the display chain from BranchInfo[] and the
 * active session id. The parent uses this so the projection has a
 * single canonical implementation (and so the test can call it without
 * mounting React).
 *
 * Behaviour:
 *   - Build the chain by walking parent_session_id from the active id
 *     up to the root. The caller passes the OUTPUT of `getBranchChain`
 *     (already root-first) so we don't re-derive the parent link here.
 *   - Skip archived ancestors from the visible chain (the active
 *     session itself is always included, even if archived, so the user
 *     can see where they are).
 *   - Label preference: branchName → title → `(root <id8>)`.
 */
export function buildBreadcrumbChain(
  rootToCurrent: readonly BranchInfo[],
  activeSessionId: string | null,
): readonly BranchCrumb[] {
  if (rootToCurrent.length === 0) return [];
  const out: BranchCrumb[] = [];
  for (const info of rootToCurrent) {
    if (info.branchArchived && info.id !== activeSessionId) {
      // Archived ancestors are hidden from the breadcrumb so an old
      // soft-deleted parent doesn't clutter the trail. The active
      // session itself stays visible even if archived (rare, but
      // visually defensible — user is clearly looking at it).
      continue;
    }
    const labelRaw =
      info.branchName !== null && info.branchName.length > 0
        ? info.branchName
        : info.title !== null && info.title.length > 0
          ? info.title
          : `(root ${info.id.slice(0, 8)})`;
    out.push({
      id: info.id,
      label: labelRaw,
      active: info.id === activeSessionId,
    });
  }
  return out;
}

/**
 * Decide whether the breadcrumb should be visible given a chain. A
 * chain with a single root crumb that has no name OR title gets
 * hidden — that's the "user never branched" default and we don't want
 * to clutter the chat for them.
 */
export function shouldShowBreadcrumb(
  chain: readonly BranchCrumb[],
): boolean {
  if (chain.length === 0) return false;
  if (chain.length === 1) {
    const only = chain[0];
    if (only === undefined) return false;
    // Hide when the sole crumb is a bare root with the (root xxxxxxxx)
    // placeholder label — i.e. the user has not yet named anything and
    // there are no siblings.
    return !only.label.startsWith('(root ');
  }
  return true;
}

function BranchBreadcrumb({
  chain,
  visible = true,
}: BranchBreadcrumbProps): React.JSX.Element | null {
  if (!visible) return null;
  if (!shouldShowBreadcrumb(chain)) return null;

  return (
    <Box flexDirection="row" paddingX={1}>
      <Text color={noxPalette.highlight}>{`${PIN_GLYPH} `}</Text>
      {chain.map((crumb, idx) => {
        const isLast = idx === chain.length - 1;
        const colour = crumb.active
          ? noxPalette.white
          : isLast
            ? noxPalette.light
            : textMuted;
        return (
          <React.Fragment key={`crumb-${crumb.id}`}>
            <Text color={colour} bold={crumb.active}>
              {crumb.label}
            </Text>
            {idx < chain.length - 1 ? (
              <Text color={dimSeparator}>{ARROW_GLYPH}</Text>
            ) : null}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

export default BranchBreadcrumb;

/** Exported for tests so the assertion strings stay in one place. */
export const __test__ = {
  PIN_GLYPH,
  ARROW_GLYPH,
  buildBreadcrumbChain,
  shouldShowBreadcrumb,
};
