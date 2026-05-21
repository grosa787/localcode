/**
 * Custom keybindings — `~/.localcode/keybinds.toml`.
 *
 * Lets a user remap any TUI shortcut by writing a TOML file like:
 *
 *   [keybinds]
 *   "nav.toc.toggle" = "Ctrl+T"
 *   "nav.search"     = "Ctrl+F"
 *   "agent.focus"    = "Tab"
 *   "composer.cancel" = "Ctrl+C"
 *
 * The file is optional — when absent, every action falls back to its
 * compiled-in default in `DEFAULT_KEYBINDS`. Any keybind that fails to
 * parse, or names an action the registry doesn't recognise, is reported
 * as a warning in `KeybindRegistry.warnings` and the default is used.
 *
 * The registry is hot-reloaded via `chokidar` whenever the file
 * changes. Consumers subscribe via `KeybindRegistry.subscribe()` or via
 * the React `useKeybind` hook (see `src/ui/hooks/useKeybind.ts`).
 *
 * Activation: the entire module is dormant when the keybinds.toml file
 * does not exist on disk — no watcher armed, no warnings emitted. Users
 * who never opt in see zero behaviour change.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import chokidar, { type FSWatcher } from 'chokidar';

/**
 * Parsed key shape. Mirrors ink's `Key` modifiers (ctrl/shift/alt/meta)
 * plus the literal key name in `key`. The key name is canonicalised to
 * lowercase for printable chars; special keys keep their lowercased
 * pseudo-name (`enter`, `escape`, `tab`, `up`, `down`, `left`, `right`,
 * `space`, `backspace`, `f1`..`f12`).
 */
export interface KeySpec {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  /** Canonical key — lowercase letter, digit, or named special key. */
  readonly key: string;
}

/**
 * The exhaustive list of action IDs the TUI recognises. Adding a new
 * action means appending here AND providing a default in
 * `DEFAULT_KEYBINDS`. Type-safe in that consumers must pass a literal
 * from this union to `useKeybind` / `lookup`.
 */
export const KEYBIND_ACTIONS = [
  'composer.submit',
  'composer.newline',
  'composer.cancel',
  'composer.clear',
  'nav.toc.toggle',
  'nav.timeline.toggle',
  'nav.search',
  'nav.palette',
  'agent.focus',
  'reading.toggle',
  'filter.cycle',
  'branch.picker',
  'model.swap',
  'snippet.select',
  'usage.dashboard',
  'cost.dashboard',
  'perf.dashboard',
  'history.prev',
  'history.next',
  'vim.toggle',
  'help.show',
] as const;

export type KeybindAction = (typeof KEYBIND_ACTIONS)[number];

/**
 * Default keybinds shipped with the TUI. Each entry MUST be parseable
 * by `parseKeySpec` — there's a constructor-time assert below.
 *
 * Keep this table in lockstep with `KEYBIND_ACTIONS`; the type check
 * (`Record<KeybindAction, string>`) prevents accidental drift.
 */
export const DEFAULT_KEYBINDS: Record<KeybindAction, string> = {
  'composer.submit': 'Enter',
  'composer.newline': 'Shift+Enter',
  'composer.cancel': 'Escape',
  'composer.clear': 'Ctrl+U',
  'nav.toc.toggle': 'Ctrl+T',
  'nav.timeline.toggle': 'Ctrl+B',
  'nav.search': 'Ctrl+F',
  'nav.palette': 'Ctrl+P',
  'agent.focus': 'Tab',
  'reading.toggle': 'Ctrl+R',
  'filter.cycle': 'Ctrl+J',
  'branch.picker': 'Ctrl+Y',
  'model.swap': 'Ctrl+M',
  'snippet.select': 'Ctrl+S',
  'usage.dashboard': 'Ctrl+G',
  'cost.dashboard': 'Ctrl+D',
  'perf.dashboard': 'Ctrl+E',
  'history.prev': 'Up',
  'history.next': 'Down',
  'vim.toggle': 'Ctrl+V',
  'help.show': 'Ctrl+H',
};

/** Recognised special key names — lowercase, dash-free. */
const SPECIAL_KEYS = new Set<string>([
  'enter',
  'return',
  'escape',
  'esc',
  'tab',
  'up',
  'down',
  'left',
  'right',
  'space',
  'backspace',
  'delete',
  'pageup',
  'pagedown',
  'home',
  'end',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
]);

/**
 * Parse a "Ctrl+Shift+P"-style spec to a structured KeySpec. Returns
 * `null` if the input is malformed (unknown special key, empty key,
 * duplicate modifier, etc.). Order-insensitive on modifiers.
 *
 * Whitespace is tolerated around `+`. Modifier aliases:
 *   - `Ctrl` / `Control` / `C`
 *   - `Shift` / `S`
 *   - `Alt` / `Option` / `Opt` / `Meta` (treated as alt — ink reports
 *     option-key combos as alt on macOS)
 *   - `Cmd` / `Super` / `Win` — treated as meta
 *
 * Single-letter keys are lowercased so `"a"` and `"A"` produce the
 * same canonical form (use `Shift+A` to express explicit uppercase
 * intent).
 */
export function parseKeySpec(raw: string): KeySpec | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let meta = false;
  let keyToken: string | null = null;
  for (const part of parts) {
    const lc = part.toLowerCase();
    if (lc === 'ctrl' || lc === 'control' || lc === 'c') {
      if (ctrl) return null;
      ctrl = true;
      continue;
    }
    if (lc === 'shift' || lc === 's') {
      if (shift) return null;
      shift = true;
      continue;
    }
    if (lc === 'alt' || lc === 'option' || lc === 'opt' || lc === 'meta') {
      if (alt) return null;
      alt = true;
      continue;
    }
    if (lc === 'cmd' || lc === 'super' || lc === 'win') {
      if (meta) return null;
      meta = true;
      continue;
    }
    if (keyToken !== null) return null; // two non-modifier tokens
    keyToken = part;
  }
  if (keyToken === null) return null;
  const key = canonicalKey(keyToken);
  if (key === null) return null;
  return { ctrl, shift, alt, meta, key };
}

function canonicalKey(token: string): string | null {
  const lc = token.toLowerCase();
  if (SPECIAL_KEYS.has(lc)) {
    // Normalise return → enter, esc → escape.
    if (lc === 'return') return 'enter';
    if (lc === 'esc') return 'escape';
    return lc;
  }
  // Single printable char.
  if (token.length === 1) {
    return lc;
  }
  return null;
}

/** Stable string form of a KeySpec — used for conflict detection. */
export function keySpecToString(spec: KeySpec): string {
  const mods: string[] = [];
  if (spec.ctrl) mods.push('Ctrl');
  if (spec.shift) mods.push('Shift');
  if (spec.alt) mods.push('Alt');
  if (spec.meta) mods.push('Meta');
  mods.push(spec.key);
  return mods.join('+');
}

/** Validation schema for the on-disk file. */
const KeybindsFileSchema = z.object({
  keybinds: z.record(z.string(), z.string()).default({}),
});

export type KeybindsFile = z.infer<typeof KeybindsFileSchema>;

export interface KeybindWarning {
  readonly action: string;
  readonly value: string;
  readonly reason: string;
}

/**
 * KeybindRegistry — runtime resolution of action→KeySpec with hot
 * reload. Constructors are lightweight; the registry only starts
 * watching the file when `start()` is called (the TUI does this from
 * its top-level `useEffect`).
 *
 * Lookup precedence:
 *   1. Parsed user override from keybinds.toml
 *   2. Compiled-in default from `DEFAULT_KEYBINDS`
 *
 * The registry is intentionally NOT a React context — callers consume
 * it via the `useKeybind` hook which subscribes to change events.
 */
export class KeybindRegistry {
  private filePath: string;
  private overrides: Map<KeybindAction, KeySpec> = new Map();
  private listeners: Set<() => void> = new Set();
  private watcher: FSWatcher | null = null;
  private lastWarnings: KeybindWarning[] = [];

  constructor(opts: { readonly filePath?: string } = {}) {
    this.filePath =
      opts.filePath ?? path.join(homedir(), '.localcode', 'keybinds.toml');
    // Validate the default table at construction time — a typo in
    // `DEFAULT_KEYBINDS` would otherwise only manifest at the first
    // `lookup()` call.
    for (const [action, value] of Object.entries(DEFAULT_KEYBINDS)) {
      const spec = parseKeySpec(value);
      if (spec === null) {
        throw new Error(
          `KeybindRegistry: built-in default for "${action}" is unparseable: "${value}"`,
        );
      }
    }
  }

  /** Returns warnings collected during the most recent `reload()`. */
  get warnings(): readonly KeybindWarning[] {
    return this.lastWarnings;
  }

  /** Synchronous lookup. Returns the bound spec or the default. */
  lookup(action: KeybindAction): KeySpec {
    const override = this.overrides.get(action);
    if (override !== undefined) return override;
    const fallback = DEFAULT_KEYBINDS[action];
    const parsed = parseKeySpec(fallback);
    if (parsed === null) {
      // Unreachable — the constructor validates the defaults — but the
      // type system can't prove that. We return a minimal spec rather
      // than throw so a caller can still render its UI.
      return { ctrl: false, shift: false, alt: false, meta: false, key: '' };
    }
    return parsed;
  }

  /** Subscribe to change events (fired on each successful reload). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Read the file once and parse it. Safe to call repeatedly; never
   * throws — corrupt files just leave the prior overrides in place
   * and append warnings.
   */
  reload(): void {
    let raw = '';
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // File missing → no overrides. Clear any stale entries.
      this.overrides = new Map();
      this.lastWarnings = [];
      for (const fn of this.listeners) fn();
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseToml(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastWarnings = [
        { action: '*', value: this.filePath, reason: `Failed to parse TOML: ${msg}` },
      ];
      for (const fn of this.listeners) fn();
      return;
    }
    const validation = KeybindsFileSchema.safeParse(parsed);
    if (!validation.success) {
      this.lastWarnings = [
        { action: '*', value: this.filePath, reason: validation.error.message },
      ];
      for (const fn of this.listeners) fn();
      return;
    }
    const next: Map<KeybindAction, KeySpec> = new Map();
    const warnings: KeybindWarning[] = [];
    const seen: Map<string, KeybindAction> = new Map();
    const knownActions = new Set<string>(KEYBIND_ACTIONS);
    for (const [action, value] of Object.entries(validation.data.keybinds)) {
      if (!knownActions.has(action)) {
        warnings.push({ action, value, reason: 'unknown action id' });
        continue;
      }
      const spec = parseKeySpec(value);
      if (spec === null) {
        warnings.push({ action, value, reason: 'unparseable key spec' });
        continue;
      }
      const key = keySpecToString(spec);
      const prior = seen.get(key);
      if (prior !== undefined) {
        warnings.push({
          action,
          value,
          reason: `key "${key}" already bound to "${prior}"`,
        });
        continue;
      }
      seen.set(key, action as KeybindAction);
      next.set(action as KeybindAction, spec);
    }
    this.overrides = next;
    this.lastWarnings = warnings;
    for (const fn of this.listeners) fn();
  }

  /**
   * Begin watching `~/.localcode/keybinds.toml` for changes. Safe to
   * call when the file doesn't exist — chokidar will pick it up on
   * first write.
   */
  start(): void {
    if (this.watcher !== null) return;
    this.reload();
    const watcher = chokidar.watch(this.filePath, {
      ignoreInitial: true,
      persistent: true,
      // Atomic-rename-aware so editors that write via tmp+rename
      // (vim's default) don't make the watcher re-arm.
      atomic: true,
    });
    const onAny = (): void => {
      this.reload();
    };
    watcher.on('add', onAny);
    watcher.on('change', onAny);
    watcher.on('unlink', onAny);
    watcher.on('error', () => { /* swallow */ });
    this.watcher = watcher;
  }

  /** Stop the watcher (no-op when not started). */
  async stop(): Promise<void> {
    const w = this.watcher;
    this.watcher = null;
    if (w === null) return;
    await w.close();
  }
}

/**
 * Test helper — return whether a runtime key event matches a KeySpec.
 * Used by `useKeybind` callers to decide whether to fire the bound
 * action.
 *
 * The runtime key shape is intentionally narrow (subset of ink's
 * `Key`) so the same matcher works for synthetic test events.
 */
export function keyMatches(
  spec: KeySpec,
  event: {
    readonly input: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly alt?: boolean;
    readonly meta?: boolean;
    readonly return?: boolean;
    readonly escape?: boolean;
    readonly tab?: boolean;
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly backspace?: boolean;
    readonly delete?: boolean;
    readonly pageUp?: boolean;
    readonly pageDown?: boolean;
  },
): boolean {
  const ctrl = event.ctrl === true;
  const shift = event.shift === true;
  const alt = event.alt === true;
  const meta = event.meta === true;
  if (spec.ctrl !== ctrl) return false;
  if (spec.alt !== alt) return false;
  if (spec.meta !== meta) return false;
  // Map ink's named keys to canonical strings.
  let runtimeKey = '';
  if (event.return === true) runtimeKey = 'enter';
  else if (event.escape === true) runtimeKey = 'escape';
  else if (event.tab === true) runtimeKey = 'tab';
  else if (event.upArrow === true) runtimeKey = 'up';
  else if (event.downArrow === true) runtimeKey = 'down';
  else if (event.leftArrow === true) runtimeKey = 'left';
  else if (event.rightArrow === true) runtimeKey = 'right';
  else if (event.backspace === true) runtimeKey = 'backspace';
  else if (event.delete === true) runtimeKey = 'delete';
  else if (event.pageUp === true) runtimeKey = 'pageup';
  else if (event.pageDown === true) runtimeKey = 'pagedown';
  else if (event.input.length === 1) runtimeKey = event.input.toLowerCase();
  else runtimeKey = event.input.toLowerCase();
  if (runtimeKey !== spec.key) return false;
  // Shift is special — when the spec says Shift+a, the runtime should
  // see Shift+a OR a capital A (which terminals report as `input: "A"`
  // without the shift flag). Accept either form.
  if (spec.shift) {
    if (shift) return true;
    // Single-letter specs where the user typed a capital.
    if (spec.key.length === 1 && /[a-z]/.test(spec.key) && event.input === spec.key.toUpperCase()) {
      return true;
    }
    return false;
  }
  return true;
}
