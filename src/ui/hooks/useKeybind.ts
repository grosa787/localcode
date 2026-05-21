/**
 * useKeybind — React hook that returns the currently-bound KeySpec for
 * an action ID.
 *
 * Pattern of use:
 *
 *   const submitKey = useKeybind('composer.submit', registry);
 *   // later, inside the input handler:
 *   if (keyMatches(submitKey, event)) onSubmit();
 *
 * The hook subscribes to the registry so when the user edits
 * `~/.localcode/keybinds.toml` the consumer re-renders with the new
 * spec — no full TUI restart needed.
 *
 * When no registry is supplied the hook falls back to a freshly-built
 * default-only registry. This makes it safe to drop the hook into any
 * component without wiring through the registry from the composition
 * root — tests can mount a single component and still get a sensible
 * default keybind.
 */

import { useEffect, useState } from 'react';
import {
  DEFAULT_KEYBINDS,
  KeybindRegistry,
  parseKeySpec,
  type KeySpec,
  type KeybindAction,
} from '@/config/keybinds';

/**
 * Module-level fallback registry. Lazily-created singleton — built once
 * the first time a caller invokes the hook without an explicit
 * registry. Kept module-scoped so multiple components share the same
 * cached defaults; the registry never watches the filesystem (start()
 * is never called on it), so it's a cheap purely-in-memory object.
 */
let fallbackRegistry: KeybindRegistry | null = null;

function getFallbackRegistry(): KeybindRegistry {
  if (fallbackRegistry === null) {
    fallbackRegistry = new KeybindRegistry();
  }
  return fallbackRegistry;
}

export function useKeybind(
  action: KeybindAction,
  registry?: KeybindRegistry,
): KeySpec {
  const active = registry ?? getFallbackRegistry();
  const [spec, setSpec] = useState<KeySpec>(() => active.lookup(action));
  useEffect(() => {
    setSpec(active.lookup(action));
    const unsub = active.subscribe(() => {
      setSpec(active.lookup(action));
    });
    return unsub;
  }, [action, active]);
  return spec;
}

/**
 * Non-hook variant — useful for callers outside the React render tree
 * (e.g. the InputDispatcher's keystroke pump). Falls back to the
 * compiled-in default when no registry is supplied.
 */
export function resolveKeybind(
  action: KeybindAction,
  registry?: KeybindRegistry,
): KeySpec {
  if (registry !== undefined) return registry.lookup(action);
  const fallback = DEFAULT_KEYBINDS[action];
  const parsed = parseKeySpec(fallback);
  if (parsed === null) {
    return { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  }
  return parsed;
}
