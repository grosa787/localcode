/**
 * TOOL-RENDERERS-SECTION — file-reference registry.
 *
 * Tracks every `<FileRef path line />` rendered in a given subtree so the
 * `Ctrl+O` ref-pick overlay can build a numbered jump list. Scoped via
 * React context so a single `<ToolCallBlock>` (or any other consumer)
 * gets a self-contained registry — refs from one tool call don't bleed
 * into another's numbering.
 *
 * Refs are stored in a `useRef<Map>` (NOT state) so registration during
 * a parent render doesn't trigger another render cycle. The overlay
 * reads the live Map via `snapshot()` when it opens — at that point
 * the render has settled and the ids are stable.
 *
 * Numbering: the registry hands out 1-based ids in registration order.
 * A `<FileRef>` rendered earlier in the tree gets a lower id, which is
 * the order the overlay shows them in.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from 'react';

/** Public shape returned by `useRefRegistry()` for `<FileRef>` callers. */
export interface RefEntry {
  /** 1-based id. Stable for the lifetime of the registry. */
  readonly id: number;
  /** Absolute file path (anchored at projectRoot when input was relative). */
  readonly path: string;
  /** 1-based line number, or `undefined` when only a path was matched. */
  readonly line?: number;
  /** 1-based column number, when the source supplied one. */
  readonly column?: number;
}

/** Internal API exposed via context. */
export interface RefRegistryAPI {
  /**
   * Register a new entry; returns its assigned id. Stable across
   * re-renders for the same `(path, line, column)` triple — re-mounting
   * the same FileRef doesn't allocate a new id.
   */
  readonly register: (
    path: string,
    line?: number,
    column?: number,
  ) => number;
  /** Read the entries in registration order. */
  readonly snapshot: () => readonly RefEntry[];
  /** Total count of entries — handy for "N file references" UI. */
  readonly size: () => number;
}

const NULL_API: RefRegistryAPI = {
  register: (_path, _line, _column) => 0,
  snapshot: () => [],
  size: () => 0,
};

const RefRegistryContext = createContext<RefRegistryAPI | null>(null);

/** Internal — entry shape used by the Map keyed by `path:line:column`. */
function keyFor(path: string, line?: number, column?: number): string {
  return `${path}:${line ?? ''}:${column ?? ''}`;
}

/**
 * Create a fresh registry API. Used by `<RefRegistryProvider>` and by
 * tests that need a standalone registry without a provider tree.
 */
export function createRefRegistry(): RefRegistryAPI {
  const entries: RefEntry[] = [];
  const byKey = new Map<string, number>();

  const register = (
    path: string,
    line?: number,
    column?: number,
  ): number => {
    const key = keyFor(path, line, column);
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const id = entries.length + 1;
    entries.push({ id, path, line, column });
    byKey.set(key, id);
    return id;
  };

  const snapshot = (): readonly RefEntry[] => entries.slice();
  const size = (): number => entries.length;

  return { register, snapshot, size };
}

export interface RefRegistryProviderProps {
  readonly children: React.ReactNode;
}

/**
 * Provider for the ref registry. Wrap any subtree that contains
 * `<FileRef>` instances; the provider creates a single registry that
 * the ref-pick overlay can introspect. Multiple providers nest cleanly
 * — each one owns its own counter.
 */
export function RefRegistryProvider({
  children,
}: RefRegistryProviderProps): React.JSX.Element {
  // useRef so re-renders don't churn the registry identity. The Map
  // lives for the provider's lifetime; unmount drops it on the floor.
  const apiRef = useRef<RefRegistryAPI | null>(null);
  if (apiRef.current === null) {
    apiRef.current = createRefRegistry();
  }

  const api = apiRef.current;

  // Memoise the value object so consumer renders don't churn. The
  // underlying methods are already stable identities from createRefRegistry.
  const value = useMemo<RefRegistryAPI>(
    () => ({
      register: api.register,
      snapshot: api.snapshot,
      size: api.size,
    }),
    [api],
  );

  return (
    <RefRegistryContext.Provider value={value}>
      {children}
    </RefRegistryContext.Provider>
  );
}

/**
 * Consumer-side hook. Returns the registry API or a null-object when
 * the calling component is mounted outside a `<RefRegistryProvider>`.
 * The null-object semantics let `<FileRef>` render as a plain styled
 * link in environments without ref-pick (e.g. unit tests that mount a
 * single component without the full chat tree).
 *
 * The hook also exposes a memoised `jumpTo(id)` helper that returns
 * the entry for a numeric id, or undefined. Overlays consume this when
 * the user presses a digit key.
 */
export function useRefRegistry(): RefRegistryAPI {
  const api = useContext(RefRegistryContext);
  return api ?? NULL_API;
}

/**
 * Standalone helper for callers that want a stable `register`
 * closure. Mirrors the `useInputModeHandler` pattern — components
 * subscribe at mount time via this hook and don't have to thread the
 * registry down manually.
 *
 * Returns `{ id, entry }` for the registration; `id === 0` means the
 * registry is unavailable (no provider in scope) — components should
 * still render their text in that case.
 */
export function useRegisterFileRef(
  path: string,
  line?: number,
  column?: number,
): { readonly id: number; readonly entry: RefEntry | undefined } {
  const api = useRefRegistry();
  // useCallback so we don't re-allocate on every render; the
  // registry's `register` is itself stable so this is mostly cosmetic.
  const register = useCallback(api.register, [api]);
  const id = register(path, line, column);
  const entry = id === 0 ? undefined : { id, path, line, column };
  return { id, entry };
}
