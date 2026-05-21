/**
 * UpdateOverlay — full-screen ink overlay surfaced when the auto-updater
 * detects a newer release. Mirrors the web `UpdateModal` content; the
 * key bindings are `i` (install), `l` (later — 24h dismiss), `s` (skip
 * this version), and `Esc` (dismiss without persistence).
 *
 * Rendering contract:
 *   - Header: `Update available: v0.19.0 → v0.20.0`
 *   - Optional release name as a subtitle.
 *   - Delta release notes body (best-effort markdown left intact).
 *   - Footer hint listing the four key bindings.
 *
 * The overlay does NOT own its own input pump; it relies on the parent
 * `<InputDispatcherProvider>` (the same pattern used by BranchPicker /
 * DiffViewer) so other overlays can coexist without input conflicts.
 */

import React, { useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

export interface UpdateOverlayPayload {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly releaseUrl: string;
  readonly releaseName: string;
  readonly body: string;
}

export interface UpdateOverlayProps {
  readonly info: UpdateOverlayPayload;
  /** True once the staged binary has finished downloading. */
  readonly downloaded?: boolean;
  readonly onInstall: () => void;
  readonly onLater: () => void;
  readonly onSkip: (version: string) => void;
  readonly onClose: () => void;
}

const MAX_BODY_LINES = 24;

function truncateBody(body: string): readonly string[] {
  if (body.length === 0) return ['(no release notes provided)'];
  const lines = body.split(/\r?\n/);
  if (lines.length <= MAX_BODY_LINES) return lines;
  const head = lines.slice(0, MAX_BODY_LINES - 1);
  const more = lines.length - (MAX_BODY_LINES - 1);
  head.push(`… (+${more} more lines)`);
  return head;
}

function UpdateOverlay({
  info,
  downloaded = false,
  onInstall,
  onLater,
  onSkip,
  onClose,
}: UpdateOverlayProps): React.JSX.Element {
  useInput(
    useCallback(
      (input: string, key: { escape?: boolean }) => {
        if (key.escape) {
          onClose();
          return;
        }
        const ch = (input ?? '').toLowerCase();
        if (ch === 'i') {
          onInstall();
          return;
        }
        if (ch === 'l') {
          onLater();
          return;
        }
        if (ch === 's') {
          onSkip(info.latestVersion);
          return;
        }
      },
      [info.latestVersion, onClose, onInstall, onLater, onSkip],
    ),
  );

  const bodyLines = truncateBody(info.body);
  const installLabel = downloaded ? 'i restart-to-apply' : 'i install';

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} paddingY={1}>
      <Box>
        <Text bold>📦 Update available: </Text>
        <Text>{`v${info.currentVersion} → v${info.latestVersion}`}</Text>
      </Box>
      {info.releaseName.length > 0 ? (
        <Box marginTop={0}>
          <Text dimColor>{info.releaseName}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {bodyLines.map((line, idx) => (
          <Text key={`note-${idx}`}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{info.releaseUrl}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{`${installLabel} · l later · s skip · esc dismiss`}</Text>
      </Box>
    </Box>
  );
}

export default UpdateOverlay;

/** Exported for tests. */
export const __test__ = {
  truncateBody,
  MAX_BODY_LINES,
};
