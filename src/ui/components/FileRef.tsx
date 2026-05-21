/**
 * TOOL-RENDERERS-SECTION — single clickable file:line reference.
 *
 * Looks like a styled link in the chat log:
 *
 *   src/foo.ts:42
 *   ^^^^^^^^^^^^^ underlined, accent colour
 *
 * Each `<FileRef>` registers itself with the surrounding
 * `<RefRegistryProvider>` (via `useRefRegistry`). The ref-pick overlay
 * reads that registry to build a numbered jump list.
 *
 * The component renders an `[N]` badge prefix when the registration
 * returned a non-zero id — that way the user can SEE the jump number
 * inline without opening the overlay first. When no registry is in
 * scope (e.g. unit tests that mount a single component), the badge is
 * suppressed and the ref still renders as a styled link.
 */

import React from 'react';
import { Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import { useRegisterFileRef } from '../hooks/useRefRegistry.js';

export interface FileRefProps {
  /** Path string as it appeared in the source text. */
  readonly path: string;
  /** 1-based line number. */
  readonly line?: number;
  /** Optional 1-based column. */
  readonly column?: number;
  /**
   * When false, suppresses the leading numeric badge. Useful for inline
   * uses where the badge would clutter the row (e.g. a header that
   * already shows the file name).
   */
  readonly showBadge?: boolean;
}

function FileRefImpl({
  path,
  line,
  column,
  showBadge = true,
}: FileRefProps): React.JSX.Element {
  const { id } = useRegisterFileRef(path, line, column);
  const label =
    line !== undefined
      ? column !== undefined
        ? `${path}:${line}:${column}`
        : `${path}:${line}`
      : path;
  return (
    <Text>
      {showBadge && id > 0 && (
        <Text color={textMuted}>{`[${id}] `}</Text>
      )}
      <Text color={noxPalette.highlight} underline>
        {label}
      </Text>
    </Text>
  );
}

function arePropsEqual(prev: FileRefProps, next: FileRefProps): boolean {
  if (prev.path !== next.path) return false;
  if (prev.line !== next.line) return false;
  if (prev.column !== next.column) return false;
  if ((prev.showBadge ?? true) !== (next.showBadge ?? true)) return false;
  return true;
}

const FileRef = React.memo(FileRefImpl, arePropsEqual);

export default FileRef;
