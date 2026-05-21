/**
 * Centralised input dispatcher for the TUI.
 *
 * Background — the keystroke-leak problem this fixes
 * ---------------------------------------------------
 * ink's `useInput` registers a handler that receives EVERY keystroke,
 * with no `event.stopPropagation()`. Before this dispatcher, five
 * sibling components each called `useInput` and ink fan-fired every
 * key to all five. The defensive `{ isActive }` flag on every site
 * worked, but it was a per-site discipline: any new interactive
 * component had to remember to gate itself or risk consuming a key
 * meant for someone else (regression: the `y` keystroke that confirmed
 * an `ApprovalPrompt` previously leaked into the InputBar's draft).
 *
 * The fix is to centralise: ChatScreen owns the ONE top-level
 * `useInput`, computes the current "input mode" from screen state, and
 * routes the keystroke to the subscribers registered for that mode.
 * Other components subscribe via `useInputModeHandler(mode, handler)`
 * instead of calling `useInput` themselves.
 *
 * Modes
 * -----
 *   - `'approval'` — an approval prompt or diff view owns the screen.
 *     ApprovalPrompt / DiffView subscribe here; nothing else fires.
 *     This is the regression-critical mode: y/n must never leak.
 *   - `'overlay'` — a slash-command overlay (permissions, ctxsize…)
 *     or the slash autocomplete menu owns the screen. SlashMenu
 *     subscribes here.
 *   - `'input'` — the InputBar is the primary keystroke consumer.
 *     ChatScreen's own Esc / Ctrl+R / Ctrl+X handlers also live in
 *     this mode (the dispatcher chains via the LIFO + return-true-
 *     to-consume protocol; see below).
 *   - `'passive'` — reserved for future "loading, no input accepted"
 *     UI states. Today the dispatcher simply swallows keystrokes in
 *     passive mode.
 *
 * Stacking / fall-through
 * -----------------------
 * Multiple components may subscribe to the same mode. The dispatcher
 * walks the subscribers LIFO (last subscriber registered fires first
 * — "overlay stacking" semantics from the spec). Each handler can
 * return `true` to mark the keystroke consumed and stop the walk, or
 * return `void`/`false` to let the next-most-recent subscriber see
 * the same key.
 *
 * This is the load-bearing primitive for the slash-menu interaction:
 * when the SlashMenu is open, both it AND the InputBar subscribe to
 * `'input'` mode. The menu (most-recent) takes arrows/Enter/Esc/Tab
 * and returns `true`; for printable text it returns nothing, so the
 * key cascades to the InputBar handler beneath it.
 *
 * Performance
 * -----------
 * - The provider memoises the API object so the context value is
 *   stable across renders (no needless consumer re-renders).
 * - Subscribers are stored in plain `Set<Handler>` per mode inside a
 *   ref — no per-keystroke allocations on the hot path. Dispatch is
 *   `Array.from(set).reverse()` once per keystroke; given there are
 *   never more than ~3 subscribers in any mode at any time, the
 *   conversion is cheap and predictable.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import type { Key } from 'ink';

/** The exhaustive list of input modes the dispatcher routes to. */
export type InputMode =
  | 'approval'
  | 'overlay'
  | 'input'
  | 'passive'
  // AGENT-PANEL-SECTION (Wave 5A — TA team) — multi-agent navigation.
  // When the AgentPanel is mounted under the input row AND the user
  // has pressed Tab to enter focus mode, the panel owns ↑/↓/Enter/Esc
  // for worker selection. The composer's `useInputModeHandler('input',
  // …)` subscribers stay registered but never fire while the dispatcher
  // sits in this mode — exactly the same isolation as 'approval'/'overlay'.
  | 'agent-focus'
  // DIFF-VIEWER-DISPATCH-SECTION — full-screen `<DiffViewer>` overlay.
  // When the viewer is mounted (`/diff`), it owns arrow keys, hunk
  // navigation (←/→), file navigation (n/p), mode toggle (u), and
  // dismiss (q/Esc). The ChatScreen's regular input subscribers are
  // still registered but are inert while the dispatcher sits in this
  // mode — identical isolation contract to 'overlay'.
  | 'diff-viewer'
  // SNIPPET-MODE-SECTION (snippet ring) — entered via Ctrl+S. While the
  // dispatcher sits here, arrow keys move a virtual selection cursor
  // across visible chat lines, Shift+arrow extends the selection,
  // `y` (or `Y`) copies the selection to the in-memory SnippetRing, and
  // Esc returns to the regular `'input'` mode. The composer, slash
  // menu, and history navigation are all inert.
  | 'select'
  // MODEL-SWAP-SECTION (live model swap) — entered via Ctrl+M. The
  // dispatcher routes ↑/↓/Enter/Esc to the inline model picker; the
  // composer is hidden until the swap finishes or the user cancels.
  | 'model-swap'
  // AGENT-TAIL-DISPATCH-SECTION (Wave 6B / TB4) — live TeamBus messages
  // rendered inline as collapsible blocks. Entered via Ctrl+G. While the
  // dispatcher sits here, ↑/↓ navigates between inline agent blocks,
  // Enter expands/collapses, Esc returns to 'input'.
  | 'agent-tail';

/**
 * The keystroke shape forwarded to subscribers. Mirrors the args ink's
 * `useInput` callback receives so component handlers move over with
 * minimal change.
 */
export interface InputEvent {
  readonly input: string;
  readonly key: Key;
}

/**
 * A subscriber callback. Return `true` to mark the keystroke consumed
 * (stops the LIFO walk). Returning `void` or `false` lets the next
 * subscriber in the same mode see the same key — used by SlashMenu to
 * pass printable text down to the InputBar.
 */
export type InputModeHandler = (event: InputEvent) => boolean | void;

export interface InputDispatcherAPI {
  /** Current mode — computed by the dispatcher owner from app state. */
  readonly mode: InputMode;
  /**
   * Subscribe to keystrokes for a specific mode. Returns the
   * unsubscribe function. Handlers fire ONLY when `mode` matches the
   * current dispatcher mode.
   */
  readonly subscribe: (
    mode: InputMode,
    handler: InputModeHandler,
  ) => () => void;
  /**
   * Dispatch a single keystroke through the registered subscribers.
   * Owned by the dispatcher provider (ChatScreen calls this from its
   * top-level `useInput`). Returns `true` if any subscriber consumed.
   */
  readonly dispatch: (event: InputEvent) => boolean;
}

export const InputDispatcherContext =
  createContext<InputDispatcherAPI | null>(null);

/**
 * Internal — the subscriber registry shape. We use a `Set` per mode so
 * subscribe/unsubscribe is O(1) and the LIFO walk is `Array.from(set)`
 * + `.reverse()` on dispatch. Sets preserve insertion order in modern
 * JS engines (ES2015+), which gives us deterministic stacking without
 * an extra index counter.
 */
type SubscriberRegistry = Record<InputMode, Set<InputModeHandler>>;

function makeRegistry(): SubscriberRegistry {
  return {
    approval: new Set<InputModeHandler>(),
    overlay: new Set<InputModeHandler>(),
    input: new Set<InputModeHandler>(),
    passive: new Set<InputModeHandler>(),
    'agent-focus': new Set<InputModeHandler>(),
    // DIFF-VIEWER-DISPATCH-SECTION — registry slot for the full-screen
    // diff viewer (see InputMode union above).
    'diff-viewer': new Set<InputModeHandler>(),
    // SNIPPET-MODE-SECTION — registry slot for selection mode (see
    // InputMode union above).
    select: new Set<InputModeHandler>(),
    // MODEL-SWAP-SECTION — registry slot for the live model picker (see
    // InputMode union above).
    'model-swap': new Set<InputModeHandler>(),
    // AGENT-TAIL-DISPATCH-SECTION — registry slot for inline agent
    // message navigation (see InputMode union above).
    'agent-tail': new Set<InputModeHandler>(),
  };
}

export interface InputDispatcherProviderProps {
  readonly mode: InputMode;
  readonly children: React.ReactNode;
}

/**
 * Provider component. ChatScreen renders this with its computed `mode`
 * and a top-level `useInput` calls `dispatch` once per keystroke. The
 * provider exposes a stable API object on the context; the `mode` is
 * the only part that changes per render.
 *
 * Note: we deliberately do NOT call `useInput` here. The dispatcher
 * owner (ChatScreen) decides when/how to wire ink — that keeps tests
 * able to mount the provider without an ink stdin, and keeps the
 * dispatcher reusable if a non-ink frontend ever wants to drive it
 * (e.g. the web tap of the TUI).
 */
export function InputDispatcherProvider({
  mode,
  children,
}: InputDispatcherProviderProps): React.JSX.Element {
  const registryRef = useRef<SubscriberRegistry>(makeRegistry());
  // We carry `mode` via a ref AS WELL as via the context value because
  // the dispatch closure (returned in `api` below) is captured by the
  // owner's top-level `useInput`. If we read mode from a closure
  // variable, a key fired between renders would still see the stale
  // mode; the ref keeps the dispatcher honest.
  const modeRef = useRef<InputMode>(mode);
  modeRef.current = mode;

  const subscribe = useCallback(
    (m: InputMode, handler: InputModeHandler): (() => void) => {
      const set = registryRef.current[m];
      set.add(handler);
      return (): void => {
        set.delete(handler);
      };
    },
    [],
  );

  const dispatch = useCallback((event: InputEvent): boolean => {
    const current = modeRef.current;
    const subscribers = registryRef.current[current];
    if (subscribers.size === 0) return false;
    // LIFO — last subscriber wins (overlay stack semantics). The set's
    // insertion order is preserved by spec; we iterate via Array.from
    // so a handler that unsubscribes itself mid-walk doesn't mutate the
    // iteration target.
    const ordered = Array.from(subscribers);
    for (let i = ordered.length - 1; i >= 0; i--) {
      const handler = ordered[i];
      if (handler === undefined) continue;
      const consumed = handler(event);
      if (consumed === true) return true;
    }
    return false;
  }, []);

  const api = useMemo<InputDispatcherAPI>(
    () => ({ mode, subscribe, dispatch }),
    [mode, subscribe, dispatch],
  );

  return (
    <InputDispatcherContext.Provider value={api}>
      {children}
    </InputDispatcherContext.Provider>
  );
}

/**
 * Read the dispatcher API. Returns `null` when the calling component
 * is rendered outside a provider. Components that want to subscribe
 * unconditionally should use `useInputModeHandler` which no-ops in
 * that case — useful for unit-test harnesses that mount a single
 * component without the full screen tree.
 */
export function useInputDispatcher(): InputDispatcherAPI | null {
  return useContext(InputDispatcherContext);
}

/**
 * Subscribe to a specific mode. Auto-unsubscribes on unmount.
 *
 * The handler is wrapped in a ref so consumers can read closed-over
 * state without re-subscribing on every render (which would churn the
 * Set and silently disturb the LIFO ordering when a sibling
 * subscriber co-renders). Effectively: subscribe runs once per mode
 * change, and the live handler identity is read on each keystroke.
 *
 * When no provider is in scope (e.g. a unit-test mount of a single
 * component), this hook is a no-op. The component will see no
 * keystrokes — but it also won't crash, which keeps the standalone
 * test surface working.
 */
export function useInputModeHandler(
  mode: InputMode,
  handler: InputModeHandler,
): void {
  const api = useInputDispatcher();
  const handlerRef = useRef<InputModeHandler>(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (api === null) return undefined;
    // Forward each keystroke to the latest handler via the ref. This
    // is the standard "stable subscription" pattern — keeps the Set
    // entry's identity constant across re-renders so the LIFO order
    // doesn't shuffle when a sibling rerenders.
    const forwarder: InputModeHandler = (event) => handlerRef.current(event);
    return api.subscribe(mode, forwarder);
  }, [api, mode]);
}
