/**
 * Reducer + types for the main chat screen state.
 *
 * Lives in `src/integration/` because it glues UI types (PendingApproval /
 * ToolCallState exported from ChatScreen) to domain types (Message) and is
 * only consumed by `src/app.tsx`.
 *
 * Kept as a pure reducer so every state transition is traceable and tests
 * (Agent 9) can exercise it without rendering React.
 *
 * R2 additions:
 *   - `inputHistory`           — readonly string[] of past user submissions
 *                                (fed to InputBar for ↑/↓ navigation).
 *   - `pendingQueue`           — single source of truth for the
 *                                type-ahead-while-busy queue. Inputs
 *                                arriving during streaming / approval
 *                                are appended via `ENQUEUE_PENDING`;
 *                                the ChatScreen flush effect drains
 *                                the queue (concat + `CLEAR_PENDING`)
 *                                when the gate opens.
 *   - `skillOverlay`           — boolean toggle for the SkillInputOverlay.
 *   - `sessionTotalOut`        — cumulative assistant output tokens for
 *                                this session (shown in the usage footer).
 */

import type { Message, OverlayKind } from '@/types/global';
import type {
  PendingApproval,
  ToolCallState,
} from '@/ui/screens/ChatScreen';

export interface ChatState {
  readonly messages: readonly Message[];
  readonly isStreaming: boolean;
  readonly currentOutput: string;
  /**
   * R12 (Agent 8) — accumulating buffer of MODEL THINKING content for
   * the in-flight stream. Fed by the LLM adapter's `onThinkingChunk`
   * callback (R13 splitter). Reset on `START_STREAM` / `RESET` /
   * `REPLACE_MESSAGES` and persisted onto the resulting assistant
   * message via `Message.thinking` once the stream commits.
   *
   * Empty string when no thinking is active. Lives next to
   * `currentOutput` so the UI can render `<ThinkingBlock>` above the
   * streaming reply with the same lifecycle.
   */
  readonly currentThinking: string;
  readonly pendingApproval: PendingApproval | null;
  readonly thinkingStartedAt: number | null;
  readonly toolCallStates: ReadonlyMap<string, ToolCallState>;
  /**
   * Incremented whenever the chat should be hard-reset (e.g. /clear or
   * resume). Used by effects that want to detect "start a fresh run".
   */
  readonly generation: number;
  /**
   * History of user submissions (oldest → newest). Fed to InputBar for
   * ↑/↓ navigation. We keep it on the reducer side so a session replace
   * (e.g. /resume) can reseed it deterministically.
   */
  readonly inputHistory: readonly string[];
  /**
   * FIFO queue of type-ahead inputs typed while the model is streaming
   * or an approval is pending. This is the SINGLE source of truth for
   * the pending queue — ChatScreen consumes it via props (`pendingQueue`,
   * `onEnqueuePending`, `onClearPending`) rather than holding its own
   * useState mirror.
   *
   * Lifecycle:
   *   - `ENQUEUE_PENDING` appends the text on a streaming-time submit.
   *   - The ChatScreen flush effect concatenates the queue with `\n\n`
   *     and dispatches a single `onSubmit(...)` once the gate opens
   *     (`!isStreaming && pendingApproval === null && lastTurnError === null`).
   *   - `CLEAR_PENDING` empties the queue — fired by the flush right
   *     before re-submission, by the double-Esc handler, by the
   *     Ctrl+X error-discard path, and by session reset paths.
   */
  readonly pendingQueue: readonly string[];
  /**
   * When true, the chat screen renders the SkillInputOverlay instead of
   * the input bar. Toggled via /new-skill + overlay actions.
   */
  readonly skillOverlay: boolean;
  /**
   * Cumulative output tokens for the active session — shown in the
   * usage footer under each assistant reply.
   */
  readonly sessionTotalOut: number;
  /**
   * Active slash-command overlay (FIX #32). `null` means no overlay.
   * Opened via `SHOW_OVERLAY`, closed via `CLOSE_OVERLAY`. Other actions
   * deliberately leave this alone so chat activity (streaming, messages
   * arriving) doesn't accidentally dismiss a panel the user is using.
   */
  readonly overlayKind: OverlayKind | null;
  /**
   * R13 (Agent 8) — pre-seeded filter query for the model overlay,
   * supplied by the slash-command parser when the user types
   * `/model <query>` and `<query>` is not an exact match against the
   * cached model list. The overlay opens in browse mode with this
   * filter already applied so arrows navigate the narrowed list
   * immediately. `null` when no filter is staged.
   *
   * Lives next to `overlayKind` rather than inside it so existing
   * callers (`SHOW_OVERLAY` without data) keep working unchanged. The
   * field is cleared by `CLOSE_OVERLAY` so the next `/model` open
   * starts clean unless the slash command sets a new filter.
   */
  readonly modelOverlayFilter: string | null;
  /**
   * R7 (FIX #8) — timestamp (ms) of the first Ctrl+C press in a
   * two-press exit-confirmation window. `null` when no press is
   * pending. The second Ctrl+C within 2000ms confirms the exit; the
   * window auto-resets via `CANCEL_EXIT_CONFIRM`.
   */
  readonly confirmExitAt: number | null;
  /**
   * Type-ahead-queue safety: when the most recent turn ended with an
   * error (e.g. exhausted retry budget on a transient upstream
   * failure), this holds the error string. The flush effect in
   * ChatScreen MUST skip auto-draining the pending queue while this
   * is non-null — otherwise an outage during one turn fans out into
   * an error toast spam as each queued message immediately fires
   * another doomed request.
   *
   * Cleared by `START_STREAM` (the user explicitly retried) and by
   * `CLEAR_TURN_ERROR` (Retry / Discard buttons in the queue banner).
   */
  readonly lastTurnError: string | null;
  // AGENT-PANEL-SECTION (Wave 5A — TA team)
  /**
   * Multi-agent TUI: who the composer is currently sending to. `'lead'`
   * = the default chat path (LLM stream). When set to a worker agent
   * id, the composer routes the next Enter through `teamBus.send` to
   * that worker, and incoming agent output streams render inline
   * prefixed with `<agent-id> →`. Esc returns to `'lead'`.
   *
   * Decoupled from `agentFocusMode` so the panel can be navigated
   * (browsing workers) without yet attaching the composer — the user
   * presses Enter to commit the attach.
   */
  readonly currentConversant: 'lead' | string;
  /**
   * When true, the AgentPanel below the InputBar owns ↑/↓/Enter/Esc
   * for selection. The composer text field still shows but its
   * submit is suspended until the user exits agent-focus (Tab or Esc).
   *
   * Lifecycle:
   *   - Tab while not streaming flips this on (mode = 'agent-focus').
   *   - ↑/↓ moves `agentSelectedIdx`; Enter sets `currentConversant`
   *     to the selected worker id and exits focus.
   *   - Tab or Esc exits focus without committing attach.
   */
  readonly agentFocusMode: boolean;
  /**
   * Index into the live worker list (orchestrator.list()) shown in
   * AgentPanel. The panel clamps this when the worker list shrinks.
   * Always 0 when no workers are present.
   */
  readonly agentSelectedIdx: number;
  // OUTPUT-FILTER-SECTION (Wave 6A2 — output visibility) — start
  /**
   * View-only filter for the chat tree. Affects which existing rows
   * the renderer mounts; NEVER mutates persisted message data. The
   * cycle order driven by Shift+H / `/filter` rotates through five
   * presets:
   *
   *   0. all on              {thinking, toolCalls, systemNotes} = true
   *   1. hide thinking       {thinking:false, toolCalls:true,  systemNotes:true}
   *   2. hide thinking+tools {thinking:false, toolCalls:false, systemNotes:true}
   *   3. hide thinking+tools+system {thinking:false, toolCalls:false, systemNotes:false}
   *   4. all on              (cycles back)
   *
   * Defaults to all-true so casual users see the full chat unchanged.
   */
  readonly outputFilters: {
    readonly thinking: boolean;
    readonly toolCalls: boolean;
    readonly systemNotes: boolean;
  };
  // OUTPUT-FILTER-SECTION — end
  // READING-MODE-SECTION (Wave 6A2 — focus mode) — start
  /**
   * When true, ChatScreen hides the AgentPanel, StatusPill row, and
   * the composer (InputBar) so the user can read the conversation
   * without UI chrome. F toggles it; Esc / Ctrl+C cancels existing
   * streams as before. Off by default.
   */
  readonly readingMode: boolean;
  // READING-MODE-SECTION — end
}

export const initialChatState: ChatState = {
  messages: [],
  isStreaming: false,
  currentOutput: '',
  currentThinking: '',
  pendingApproval: null,
  thinkingStartedAt: null,
  toolCallStates: new Map<string, ToolCallState>(),
  generation: 0,
  inputHistory: [],
  pendingQueue: [],
  skillOverlay: false,
  sessionTotalOut: 0,
  overlayKind: null,
  modelOverlayFilter: null,
  confirmExitAt: null,
  lastTurnError: null,
  currentConversant: 'lead',
  agentFocusMode: false,
  agentSelectedIdx: 0,
  // OUTPUT-FILTER-SECTION — start
  outputFilters: {
    thinking: true,
    toolCalls: true,
    systemNotes: true,
  },
  // OUTPUT-FILTER-SECTION — end
  // READING-MODE-SECTION — start
  readingMode: false,
  // READING-MODE-SECTION — end
};

export type ChatAction =
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'REPLACE_MESSAGES'; messages: readonly Message[] }
  | { type: 'START_STREAM' }
  | { type: 'APPEND_CHUNK'; text: string }
  | { type: 'APPEND_THINKING'; text: string }
  | { type: 'RESET_THINKING' }
  | { type: 'END_STREAM'; error?: string | null }
  | { type: 'CLEAR_TURN_ERROR' }
  | { type: 'SET_PENDING_APPROVAL'; approval: PendingApproval | null }
  | {
      type: 'UPSERT_TOOL_CALL_STATE';
      id: string;
      state: ToolCallState;
    }
  | { type: 'CLEAR_TOOL_CALL_STATES' }
  | { type: 'RESET' }
  | { type: 'PUSH_HISTORY'; text: string }
  | { type: 'SET_HISTORY'; history: readonly string[] }
  // Type-ahead-while-busy queue (mirrors Claude Code). `ENQUEUE_PENDING`
  // appends a user submission to `pendingQueue` while the model is
  // streaming; `CLEAR_PENDING` empties the queue (called by the
  // ChatScreen flush effect right before re-submission, by double-Esc,
  // by Ctrl+X discard, and by session reset paths).
  | { type: 'ENQUEUE_PENDING'; text: string }
  | { type: 'CLEAR_PENDING' }
  | { type: 'OPEN_SKILL_OVERLAY' }
  | { type: 'CLOSE_SKILL_OVERLAY' }
  | { type: 'ADD_OUTPUT_TOKENS'; tokens: number }
  | { type: 'SET_SESSION_TOTAL_OUT'; tokens: number }
  | {
      type: 'SHOW_OVERLAY';
      kind: OverlayKind;
      /**
       * R13 (Agent 8) — optional data payload. Currently only consumed
       * for `kind === 'model'` to pre-seed `modelOverlayFilter`; other
       * kinds ignore it. Keeping this on the action (rather than a
       * dedicated `SET_MODEL_FILTER` action) means the overlay open and
       * its filter are dispatched atomically — the UI never observes a
       * frame where the overlay is open with a stale filter from a
       * previous invocation.
       */
      data?: { filter?: string };
    }
  | { type: 'CLOSE_OVERLAY' }
  | { type: 'START_EXIT_CONFIRM'; timestamp: number }
  | { type: 'CANCEL_EXIT_CONFIRM' }
  // AGENT-PANEL-SECTION (Wave 5A — TA team) — multi-agent UX
  | { type: 'AGENT_FOCUS_ENTER' }
  | { type: 'AGENT_FOCUS_EXIT' }
  | { type: 'AGENT_SELECT_NEXT'; workerCount: number }
  | { type: 'AGENT_SELECT_PREV'; workerCount: number }
  | { type: 'AGENT_SET_SELECTED'; index: number; workerCount: number }
  | { type: 'AGENT_ATTACH'; agentId: string }
  | { type: 'AGENT_DETACH' }
  // OUTPUT-FILTER-SECTION — start
  // Cycles through 5 presets in order (see ChatState.outputFilters
  // comment). Uniform action so callers (hotkey + /filter) don't have
  // to know the current state.
  | { type: 'CYCLE_OUTPUT_FILTER' }
  // Allows /filter <preset> to jump straight to a named preset
  // without rotating through intermediate states.
  | {
      type: 'SET_OUTPUT_FILTER';
      filters: {
        thinking: boolean;
        toolCalls: boolean;
        systemNotes: boolean;
      };
    }
  // OUTPUT-FILTER-SECTION — end
  // READING-MODE-SECTION — start
  | { type: 'TOGGLE_READING_MODE' }
  | { type: 'SET_READING_MODE'; on: boolean };
// READING-MODE-SECTION — end

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };
    case 'REPLACE_MESSAGES':
      return {
        ...state,
        messages: action.messages,
        currentOutput: '',
        currentThinking: '',
        isStreaming: false,
        thinkingStartedAt: null,
        pendingApproval: null,
        toolCallStates: new Map(),
        lastTurnError: null,
      };
    case 'START_STREAM':
      // R12 (Agent 8) — also clear `currentThinking` so the next turn
      // starts with an empty buffer, mirroring `currentOutput`'s reset.
      // Type-ahead error gate (Fix 2): a fresh stream means the user
      // explicitly retried, so any prior turn-error is cleared and the
      // flush effect can drain the queue again.
      return {
        ...state,
        isStreaming: true,
        currentOutput: '',
        currentThinking: '',
        thinkingStartedAt: Date.now(),
        lastTurnError: null,
      };
    case 'APPEND_CHUNK':
      return { ...state, currentOutput: state.currentOutput + action.text };
    case 'APPEND_THINKING':
      // R12 (Agent 8) — fed by `LLMAdapter.streamChat({ onThinkingChunk })`.
      // Accumulates the model's `<think>...</think>` content for the
      // in-flight stream. Reset by `RESET_THINKING` (called from app.tsx
      // after the assistant message commits) and by START_STREAM /
      // REPLACE_MESSAGES / RESET / END_STREAM.
      return {
        ...state,
        currentThinking: state.currentThinking + action.text,
      };
    case 'RESET_THINKING':
      return { ...state, currentThinking: '' };
    case 'END_STREAM':
      // R12 (Agent 8) — also clear `currentThinking` so the live
      // <ThinkingBlock> stops rendering once the stream ends. The
      // assistant-message commit site in app.tsx tracks thinking via
      // a local accumulator (mirroring the `accumulated` content
      // variable), so a state reset here cannot race the commit.
      //
      // Fix 2: when the turn ended with an error, capture it so the
      // ChatScreen flush effect can short-circuit. A successful turn
      // (no error supplied) clears any prior banner.
      return {
        ...state,
        isStreaming: false,
        currentOutput: '',
        currentThinking: '',
        thinkingStartedAt: null,
        lastTurnError:
          typeof action.error === 'string' && action.error.length > 0
            ? action.error
            : null,
      };
    case 'CLEAR_TURN_ERROR':
      return { ...state, lastTurnError: null };
    case 'SET_PENDING_APPROVAL':
      return { ...state, pendingApproval: action.approval };
    case 'UPSERT_TOOL_CALL_STATE': {
      const next = new Map(state.toolCallStates);
      next.set(action.id, action.state);
      return { ...state, toolCallStates: next };
    }
    case 'CLEAR_TOOL_CALL_STATES':
      return { ...state, toolCallStates: new Map() };
    case 'RESET':
      return {
        ...initialChatState,
        generation: state.generation + 1,
      };
    case 'PUSH_HISTORY': {
      // Skip duplicate consecutive entries.
      const last = state.inputHistory[state.inputHistory.length - 1];
      if (last === action.text) return state;
      return {
        ...state,
        inputHistory: [...state.inputHistory, action.text],
      };
    }
    case 'SET_HISTORY':
      return { ...state, inputHistory: action.history };
    case 'ENQUEUE_PENDING': {
      // Reject empty / whitespace-only inputs — accidental Enter while
      // streaming should not pollute the queue with blank entries that
      // would later concatenate into stray `\n\n` separators.
      if (action.text.trim().length === 0) return state;
      return {
        ...state,
        pendingQueue: [...state.pendingQueue, action.text],
      };
    }
    case 'CLEAR_PENDING':
      return { ...state, pendingQueue: [] };
    case 'OPEN_SKILL_OVERLAY':
      return { ...state, skillOverlay: true };
    case 'CLOSE_SKILL_OVERLAY':
      return { ...state, skillOverlay: false };
    case 'ADD_OUTPUT_TOKENS':
      return {
        ...state,
        sessionTotalOut:
          state.sessionTotalOut +
          (Number.isFinite(action.tokens) && action.tokens > 0
            ? Math.floor(action.tokens)
            : 0),
      };
    case 'SET_SESSION_TOTAL_OUT':
      return {
        ...state,
        sessionTotalOut:
          Number.isFinite(action.tokens) && action.tokens >= 0
            ? Math.floor(action.tokens)
            : 0,
      };
    case 'SHOW_OVERLAY': {
      // FIX #32 — open the requested overlay. Also dismiss any
      // competing local UI surfaces (slash-command result text isn't
      // affected) so there's always exactly one panel vying for input.
      //
      // R13 (Agent 8) — when opening the model overlay, accept an
      // optional `data.filter` to pre-seed the inline filter (e.g.
      // `/model claude` → opens with filter='claude' applied). For any
      // other kind, or when the model overlay is opened without a
      // filter, reset `modelOverlayFilter` to null so an unrelated
      // overlay open doesn't carry over a stale filter from a prior
      // `/model <query>` invocation.
      const filterRaw =
        action.kind === 'model' ? action.data?.filter ?? null : null;
      const nextFilter =
        typeof filterRaw === 'string' && filterRaw.trim().length > 0
          ? filterRaw
          : null;
      return {
        ...state,
        overlayKind: action.kind,
        modelOverlayFilter: nextFilter,
        skillOverlay: false,
      };
    }
    case 'CLOSE_OVERLAY':
      // R13 (Agent 8) — also clear `modelOverlayFilter` so the next
      // open starts clean. The filter is only valid for the lifetime of
      // the open it was dispatched with.
      return { ...state, overlayKind: null, modelOverlayFilter: null };
    case 'START_EXIT_CONFIRM':
      return { ...state, confirmExitAt: action.timestamp };
    case 'CANCEL_EXIT_CONFIRM':
      return { ...state, confirmExitAt: null };
    // AGENT-PANEL-SECTION (Wave 5A — TA team)
    case 'AGENT_FOCUS_ENTER':
      return { ...state, agentFocusMode: true };
    case 'AGENT_FOCUS_EXIT':
      return { ...state, agentFocusMode: false };
    case 'AGENT_SELECT_NEXT': {
      // Empty list → selection always 0. Last-index clamps without
      // wrapping (matches Claude Code's terminal-list behaviour and
      // avoids a surprising jump from bottom→top mid-browse).
      if (action.workerCount <= 0) return { ...state, agentSelectedIdx: 0 };
      const next = Math.min(state.agentSelectedIdx + 1, action.workerCount - 1);
      return { ...state, agentSelectedIdx: next };
    }
    case 'AGENT_SELECT_PREV': {
      if (action.workerCount <= 0) return { ...state, agentSelectedIdx: 0 };
      const prev = Math.max(state.agentSelectedIdx - 1, 0);
      return { ...state, agentSelectedIdx: prev };
    }
    case 'AGENT_SET_SELECTED': {
      // Clamp into [0, workerCount-1]. workerCount=0 collapses to 0.
      if (action.workerCount <= 0) return { ...state, agentSelectedIdx: 0 };
      const max = action.workerCount - 1;
      const clamped =
        action.index < 0 ? 0 : action.index > max ? max : action.index;
      return { ...state, agentSelectedIdx: clamped };
    }
    case 'AGENT_ATTACH':
      // Attach commits the conversant + exits focus so the composer
      // takes the next keystroke. Caller decides whether to also flush
      // any in-progress lead stream (we deliberately do NOT cancel
      // here — leads keep running in background while the user talks
      // to a worker).
      return {
        ...state,
        currentConversant: action.agentId,
        agentFocusMode: false,
      };
    case 'AGENT_DETACH':
      return { ...state, currentConversant: 'lead', agentFocusMode: false };
    // OUTPUT-FILTER-SECTION — start
    case 'CYCLE_OUTPUT_FILTER': {
      const f = state.outputFilters;
      // Determine current preset by reading the boolean tuple, then
      // step to the next one in the documented order.
      let next: ChatState['outputFilters'];
      if (f.thinking && f.toolCalls && f.systemNotes) {
        // 0 → 1
        next = { thinking: false, toolCalls: true, systemNotes: true };
      } else if (!f.thinking && f.toolCalls && f.systemNotes) {
        // 1 → 2
        next = { thinking: false, toolCalls: false, systemNotes: true };
      } else if (!f.thinking && !f.toolCalls && f.systemNotes) {
        // 2 → 3
        next = { thinking: false, toolCalls: false, systemNotes: false };
      } else {
        // 3 → 0 (also handles any unrecognised intermediate state)
        next = { thinking: true, toolCalls: true, systemNotes: true };
      }
      return { ...state, outputFilters: next };
    }
    case 'SET_OUTPUT_FILTER':
      return {
        ...state,
        outputFilters: {
          thinking: action.filters.thinking === true,
          toolCalls: action.filters.toolCalls === true,
          systemNotes: action.filters.systemNotes === true,
        },
      };
    // OUTPUT-FILTER-SECTION — end
    // READING-MODE-SECTION — start
    case 'TOGGLE_READING_MODE':
      return { ...state, readingMode: !state.readingMode };
    case 'SET_READING_MODE':
      return { ...state, readingMode: action.on === true };
    // READING-MODE-SECTION — end
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

// THROTTLE-ADAPTIVE-SECTION  ── start
/**
 * Adaptive stream throttle (R-perf, 2026-05).
 *
 * The legacy throttle in `ChatScreen.tsx` uses a fixed `STREAM_THROTTLE_MS`
 * (150ms) with a leading-edge fast path and a `\n`-boundary flush. That
 * works but is too coarse for two scenarios:
 *
 *   1. Tool-call intermissions. Between an assistant's tool call and the
 *      next text chunk the stream goes quiet for hundreds of ms while the
 *      tool runs. The fixed-150 trailing timer ends up firing in empty
 *      space and the post-intermission first chunk pays the full 150ms
 *      again — both wasted cycles.
 *   2. Paragraph endings. Once the model emits the closing token of a
 *      paragraph, the user wants it on screen immediately so the prose
 *      stops feeling "held". The 150ms window adds visible chunkiness.
 *
 * The state machine here is a PURE function of (mode, last-chunk-at,
 * incoming-chunk timestamp, has-newline) → (throttle-ms, next-mode,
 * should-flush-now). Wall-clock is injected so tests assert deterministic
 * transitions. The intended consumer is the ChatScreen throttle effect,
 * but the helper is exported so the orchestration code can stay in its
 * owner file (ChatScreen) without leaking the state machine into JSX.
 *
 * Modes:
 *   - 'normal'        — ordinary streaming. Throttle = NORMAL_MS (80ms).
 *   - 'fast'          — a `\n` boundary or paragraph-ending chunk. Throttle
 *                       collapses to FAST_MS (3ms) so the terminal advances
 *                       row-by-row.
 *   - 'intermission'  — no chunks for >INTERMISSION_GAP_MS (500ms). The
 *                       throttle widens to SLOW_MS (200ms) so any stray
 *                       trickles in this window (e.g. a tool-result echo
 *                       printed lazily) coalesce instead of flickering.
 *                       The FIRST chunk after the gap flushes instantly
 *                       (zero throttle) and bumps mode back down.
 *
 * Detection rules:
 *   - `delta > INTERMISSION_GAP_MS` → mode flips to 'intermission' for the
 *     classification, AND the chunk arriving NOW counts as the post-gap
 *     first chunk → flush immediately, then mode falls back to 'normal'.
 *   - `hasNewline` → mode 'fast' for THIS chunk → flush immediately.
 *   - otherwise → mode 'normal', throttle 80ms.
 *
 * The values are deliberately a tight tuple so the throttle effect can
 * apply `result.flushImmediately ? sync-flush : trailing-timer(result.throttleMs)`
 * without further logic.
 */

/** Throttle-window: paragraph-ending / newline chunk (effectively instant). */
export const ADAPTIVE_THROTTLE_FAST_MS = 3;
/** Throttle-window: ordinary in-flight streaming. */
export const ADAPTIVE_THROTTLE_NORMAL_MS = 80;
/** Throttle-window: intermission (tool-call / quiet period). */
export const ADAPTIVE_THROTTLE_SLOW_MS = 200;
/** Idle gap above which the stream is considered to be in an intermission. */
export const ADAPTIVE_INTERMISSION_GAP_MS = 500;

/** Throttle-state machine mode. */
export type AdaptiveThrottleMode = 'fast' | 'normal' | 'slow';

/**
 * Persistent state of the adaptive throttle. `lastChunkAt = 0` is the
 * sentinel for "no chunk yet"; the first chunk of any stream therefore
 * always lands in the leading-edge fast path. `mode` is the WINDOW for
 * trailing-edge fires; the per-chunk classification can briefly diverge
 * (e.g. a single `\n` chunk during otherwise-normal streaming → THIS
 * chunk's throttle is 'fast', but `mode` stays at 'normal' for any
 * coalesced followers).
 */
export interface AdaptiveThrottleState {
  readonly mode: AdaptiveThrottleMode;
  readonly lastChunkAt: number;
}

/** Initial state for a fresh stream. */
export const initialAdaptiveThrottleState: AdaptiveThrottleState = {
  mode: 'normal',
  lastChunkAt: 0,
};

/**
 * Classification result for a single chunk arrival. The owner of the
 * throttle (ChatScreen) decides whether to flush synchronously or arm a
 * trailing timer using the values returned here.
 *
 * - `throttleMs`        — the window length to use for the trailing timer.
 *                         Ignored when `flushImmediately` is true.
 * - `flushImmediately`  — render NOW without waiting for the throttle
 *                         window. True for: first chunk ever, newline
 *                         boundary, first chunk after an intermission.
 * - `nextState`         — replaces the prior throttle state so the next
 *                         classification sees the updated mode + clock.
 */
export interface AdaptiveThrottleDecision {
  readonly throttleMs: number;
  readonly flushImmediately: boolean;
  readonly nextState: AdaptiveThrottleState;
}

/**
 * Inputs for a single classification call. `now` is the wall-clock
 * timestamp of the chunk arrival (`Date.now()` in production, injectable
 * stub in tests). `hasNewline` is true when the new chunk text contains a
 * `\n` — the caller already inspects the delta for this in the existing
 * fast-flush path, so we lift that flag in rather than re-scanning.
 */
export interface AdaptiveThrottleInput {
  readonly now: number;
  readonly hasNewline: boolean;
}

/**
 * Classify the throttle behaviour for the chunk arriving at `input.now`.
 * Pure function. Does NOT mutate `state`; returns the updated state via
 * `nextState` for the caller to commit.
 */
export function classifyAdaptiveThrottle(
  state: AdaptiveThrottleState,
  input: AdaptiveThrottleInput,
): AdaptiveThrottleDecision {
  const { now, hasNewline } = input;

  // First chunk ever: always flush immediately. Sentinel lastChunkAt=0
  // makes the delta arithmetic harmless even when `now` is also tiny in
  // tests (production `Date.now()` is always > 0).
  if (state.lastChunkAt === 0) {
    return {
      throttleMs: ADAPTIVE_THROTTLE_NORMAL_MS,
      flushImmediately: true,
      nextState: { mode: 'normal', lastChunkAt: now },
    };
  }

  const delta = now - state.lastChunkAt;

  // Post-intermission burst: the previous chunk was >GAP ago. Treat THIS
  // chunk as the leading edge of a fresh burst — flush instantly and let
  // mode fall back to 'normal' for the next classification. This matches
  // the user-visible rule: "first chunk after an intermission flushes
  // immediately".
  if (delta > ADAPTIVE_INTERMISSION_GAP_MS) {
    return {
      throttleMs: ADAPTIVE_THROTTLE_NORMAL_MS,
      flushImmediately: true,
      nextState: { mode: 'normal', lastChunkAt: now },
    };
  }

  // Newline boundary: flush instantly, throttle window for any coalesced
  // followers collapses to FAST_MS so the next non-newline chunk lands
  // within ~one frame. Mode stays 'fast' so a back-to-back code block
  // (line, line, line) keeps the cadence tight.
  if (hasNewline) {
    return {
      throttleMs: ADAPTIVE_THROTTLE_FAST_MS,
      flushImmediately: true,
      nextState: { mode: 'fast', lastChunkAt: now },
    };
  }

  // Steady-state streaming: 80ms trailing window. Mode resets to 'normal'
  // so a previous 'fast' window (post-newline) doesn't outlive its chunk.
  return {
    throttleMs: ADAPTIVE_THROTTLE_NORMAL_MS,
    flushImmediately: false,
    nextState: { mode: 'normal', lastChunkAt: now },
  };
}

/**
 * Idle-tick check. Call from a `setInterval` (or after a scheduled
 * trailing fire) to detect whether the stream has crossed into
 * intermission territory without a new chunk arriving. Returns the
 * post-tick state — mode flips to 'slow' once `delta > GAP_MS`. Does NOT
 * advance `lastChunkAt`; only a real chunk does. The caller decides
 * whether the mode change should re-arm anything (the trailing timer's
 * own fire is enough in most cases).
 */
export function tickAdaptiveThrottle(
  state: AdaptiveThrottleState,
  now: number,
): AdaptiveThrottleState {
  if (state.lastChunkAt === 0) return state;
  const delta = now - state.lastChunkAt;
  if (delta > ADAPTIVE_INTERMISSION_GAP_MS && state.mode !== 'slow') {
    return { mode: 'slow', lastChunkAt: state.lastChunkAt };
  }
  return state;
}
// THROTTLE-ADAPTIVE-SECTION  ── end
