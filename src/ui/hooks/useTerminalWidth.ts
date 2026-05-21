/**
 * Wave 5A — TUI input bar polish.
 *
 * Hook that reports the current terminal width in columns. Subscribes to
 * ink's `stdout` `'resize'` event so consumers re-render whenever the
 * window is reflowed. Falls back to a safe default (80) when the
 * underlying stdout has no `columns` field (e.g. piped output, certain
 * CI runners) so callers don't need to NaN-guard every consumer.
 *
 * Pattern mirrors the existing `<NoxBig>` resize subscription in
 * `src/ui/components/Nox.tsx` — we keep the lifecycle short: register
 * on mount, remove on unmount.
 *
 * Tests can swap the source by passing in a `Writable`-shaped object
 * via ink's render `stdout` override; the hook only reads `columns` and
 * calls `on`/`off` on the same emitter.
 */

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

const DEFAULT_COLUMNS = 80;

interface MinimalStdout {
  readonly columns?: number;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

function readColumns(stdout: MinimalStdout | null | undefined): number {
  if (stdout === null || stdout === undefined) return DEFAULT_COLUMNS;
  const cols = stdout.columns;
  if (typeof cols !== 'number' || !Number.isFinite(cols) || cols <= 0) {
    return DEFAULT_COLUMNS;
  }
  return Math.floor(cols);
}

/**
 * Returns the current terminal width in columns, kept in sync with
 * `process.stdout.on('resize', ...)`. SSR / non-TTY environments fall
 * back to `80`.
 */
export function useTerminalWidth(): number {
  const { stdout } = useStdout();
  // Cast through `unknown` so we narrow ink's `NodeJS.WriteStream` down
  // to the resize-emitter shape we actually depend on. No `any`.
  const source = stdout as unknown as MinimalStdout | null | undefined;
  const [columns, setColumns] = useState<number>(() => readColumns(source));

  useEffect(() => {
    if (source === null || source === undefined) return;
    const onResize = (): void => {
      setColumns(readColumns(source));
    };
    // Read once on mount in case the columns changed between the
    // initial render and the effect firing (uncommon but possible
    // during ink's mount cycle on macOS).
    setColumns(readColumns(source));
    source.on('resize', onResize);
    return (): void => {
      source.off('resize', onResize);
    };
  }, [source]);

  return columns;
}

export const __test__ = {
  readColumns,
  DEFAULT_COLUMNS,
};
