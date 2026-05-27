/**
 * ChatRuntime — per-session bridge between the existing transport-
 * agnostic LLM core (LLMAdapter / ToolExecutor / ContextManager /
 * SessionManager) and the WebSocket event bus.
 *
 * One `ChatRuntime` exists per active session. The `RuntimePool`
 * decides when to create / evict instances; the WS router dispatches
 * `send_message` / `cancel_stream` calls to the relevant runtime.
 *
 * The streaming loop mirrors `runStreamLoop` in `src/app.tsx`:
 *   1. Persist + emit the user message.
 *   2. Call `llm.streamChat`, forwarding `chunk` / `thinking_chunk` /
 *      `usage` events to the bus.
 *   3. On done, commit the assistant message.
 *   4. If tool calls were emitted, execute them sequentially — each
 *      result is persisted, emitted as `tool_result`, and added to
 *      context. Recurse so the model takes its next turn.
 *   5. Emit `done` with the originating `clientReqId`.
 *
 * Approval: the executor's `approvalCallback` is wired to the
 * `ApprovalBridge`. The runtime emits `approval_request` over the bus
 * before suspending the executor — the WS layer relays it to the
 * browser. When `approval_response` arrives, the bridge resolves the
 * pending promise and the executor resumes.
 *
 * Cancel: `cancel()` triggers the active `AbortController` used by
 * `LLMAdapter.streamChat` (via the `signal` option). In-flight tool
 * calls are NOT cancelled — interrupting a `write_file` mid-write
 * would leave a half-written file on disk.
 */

import type {
  ToolPreviewWire,
  WireChatMessage,
  WSServerMessage,
} from '@/web/protocol/messages';
import type { Message, ToolCall } from '@/types/global';
import type { HookEngine, HookUsageSnapshot } from '@/hooks';
import type { ContextManager } from '@/llm/context-manager';
import {
  applyRecentWindow,
  DEFAULT_MAX_RECENT_MESSAGES,
  estimateContextTokens,
} from '@/llm/context-manager';
import type { ToolExecutor } from '@/llm/tool-executor';
import type { LLMAdapter } from '@/llm/adapter';
import type { SessionManager } from '@/sessions/session-manager';
import type { ToolSchema } from '@/types/message';
import {
  autoCompressCooldownElapsed,
  DEFAULT_AUTO_COMPRESS_COOLDOWN_MS,
  DEFAULT_AUTO_COMPRESS_TRIGGER_PERCENT,
  shouldAutoCompress,
} from '@/llm/auto-compress';
import {
  globalBreakerRegistry,
  type CircuitBreakerRegistry,
} from '@/llm/circuit-breaker';

import type { ApprovalBridge } from './approval-bridge';
import type { SessionEventBus } from './event-bus';
import type {
  AgentOrchestrator,
  OrchestratorEvent,
} from '@/agents/orchestrator';

// TODO Agent 1: replace these local mirrors with `import type { ... } from '@/browser/session'`
// once `src/browser/session.ts` lands. Keep shapes byte-identical to the
// contract documented in the multi-agent brief.
export interface BrowserScreencastFrame {
  jpegBase64: string;
  width: number;
  height: number;
  capturedAt: number;
}
export interface BrowserCursorEvent {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs: number;
  action: 'click' | 'hover' | 'type';
}
export interface BrowserConsoleEvent {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  source?: string;
  line?: number;
}
export interface BrowserSessionSubscribeHandlers {
  onFrame?: (frame: BrowserScreencastFrame) => void;
  onCursor?: (cursor: BrowserCursorEvent) => void;
  onConsole?: (entry: BrowserConsoleEvent) => void;
  onError?: (err: Error) => void;
}
export interface BrowserSession {
  subscribe(handlers: BrowserSessionSubscribeHandlers): () => void;
  forwardUserClick(x: number, y: number, button?: 'left' | 'right'): Promise<void> | void;
  forwardUserKey(key: string, modifiers?: readonly ('shift' | 'ctrl' | 'alt' | 'meta')[]): Promise<void> | void;
  forwardUserScroll(deltaY: number): Promise<void> | void;
  close(): Promise<void> | void;
}

/**
 * Minimal LLM surface used by the runtime. Lets tests inject a fake
 * adapter without dragging the full `LLMAdapter` constructor.
 */
export interface LLMLike {
  streamChat: LLMAdapter['streamChat'];
}

export interface ChatRuntimeDeps {
  sessionId: string;
  /**
   * Tool schema sent to the model on every turn. Defaults to the full
   * `TOOLS_SCHEMA` from `@/llm/tools-schema`, but is injected so tests
   * can pass a smaller set.
   */
  tools: readonly ToolSchema[];
  /** System message prepended on every turn. The composition root is
   *  responsible for re-rendering this when skills / LOCALCODE.md
   *  change between turns. */
  buildSystemMessage: () => Message;
  /** Maximum context tokens — used by `maybeSummarize`. */
  maxContextTokens: number;
  /**
   * Sliding-window cap on the number of trailing messages forwarded to
   * the LLM each turn. System prompt and any synthetic
   * `[Compressed context]` summary message are always pinned on top of
   * this. `0` (or undefined) disables — the full in-memory history is
   * sent. Defaults to {@link DEFAULT_MAX_RECENT_MESSAGES}.
   */
  maxRecentMessages?: number;
  /**
   * Auto-compress trigger threshold (0..1). When the estimated
   * context-token count crosses this fraction of `maxContextTokens` at
   * the end of a turn, the runtime invokes `contextManager.maybeSummarize`
   * to collapse older history (no-op unless the manager was constructed
   * with a `summarizer`). Defaults to
   * {@link DEFAULT_AUTO_COMPRESS_TRIGGER_PERCENT}.
   */
  autoCompressPercent?: number;
  llm: LLMLike;
  toolExecutor: ToolExecutor;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  eventBus: SessionEventBus;
  approvalBridge: ApprovalBridge;
  /**
   * Optional factory for the per-session browser sandbox. The runtime
   * lazy-creates the session on first `browser_*` tool call, subscribes
   * to its events, and forwards them as `browser_*` WS frames.
   */
  createBrowserSession?: () => BrowserSession;
  /**
   * Optional multi-agent orchestrator. When supplied, the runtime
   *   - subscribes to orchestrator events for THIS session and forwards
   *     them as `agent_*` WS frames,
   *   - on dispose, calls `orchestrator.disposeTeam(sessionId)` so all
   *     sub-agents under this parent are cancelled and worktrees are
   *     cleaned up.
   *
   * The composition root is responsible for ensuring the same instance
   * is also threaded into the `ToolContext` used by the executor (so
   * the agent_* tools can reach it).
   */
  agentOrchestrator?: AgentOrchestrator;
  /**
   * Optional circuit-breaker registry. Defaults to the module-wide
   * `globalBreakerRegistry`. Tests can inject a dedicated registry to
   * isolate state. When the runtime is given a registry, it subscribes
   * once at construction and emits `backend_circuit_state` WS frames on
   * every breaker transition so the UI can show a banner.
   */
  breakerRegistry?: CircuitBreakerRegistry;
  /**
   * Optional hook engine for the settings-driven `UserPromptSubmit`
   * trigger. When supplied, the runtime calls `engine.run({trigger:
   * 'UserPromptSubmit', userPrompt})` before persisting + streaming
   * the prompt. A blocking failure rejects the submission and emits
   * an `error` frame. When omitted (or empty hooks), the runtime
   * behaves identically to before.
   */
  hookEngine?: HookEngine;
  /**
   * Project root forwarded into the hook context as cwd. Optional —
   * defaults to `process.cwd()` when omitted.
   */
  projectRoot?: string;
}

/**
 * Hard cap on tool-call loops per user turn (audit M8). Matches the
 * worker-side cap in `agents/runner-factory.ts`. Models that loop on
 * tool calls beyond this almost certainly need a more specific prompt.
 */
const MAX_TURNS = 20;

// PRESENCE-SECTION
/**
 * Per-peer tracked state for a multi-user session. `lastSeenMs` is
 * stamped by the server clock (NOT the client's wall time) so peers
 * cannot lie about freshness. The reaper drops entries older than
 * {@link PRESENCE_REAP_AFTER_MS} from the in-memory set.
 */
export interface PresencePeerInfo {
  userId: string;
  displayName: string;
  typing: boolean;
  lastSeenMs: number;
}

/** Drop peers from the tracked set after this much silence. */
export const PRESENCE_REAP_AFTER_MS = 60_000;

/** How often the reaper sweeps. */
const PRESENCE_REAP_INTERVAL_MS = 15_000;
// PRESENCE-SECTION-END

export class ChatRuntime {
  private readonly deps: ChatRuntimeDeps;
  private isStreaming = false;
  private cancelController: AbortController | null = null;
  private browserSession: BrowserSession | null = null;
  private browserUnsubscribe: (() => void) | null = null;
  private agentUnsubscribe: (() => void) | null = null;
  private breakerUnsubscribe: (() => void) | null = null;
  /** Timestamp of the last auto-compress (Date.now()). 0 = never. */
  private lastAutoCompressAt = 0;
  // RECOVERY-FIX-3-SECTION
  /**
   * Timestamp of the last chunk / tool_call activity (Date.now()). 0
   * when idle. Read by `HealthWatchdog` to detect runtimes that have
   * been "streaming" without producing output for > N minutes —
   * indicates a hung adapter or a tool that never returned. The watchdog
   * resets `isStreaming` and emits an `error`+`done` frame so the user
   * can continue.
   */
  private lastChunkAt = 0;
  // RECOVERY-FIX-3-SECTION-END

  // PRESENCE-SECTION
  /**
   * Active peers in this session, keyed by `userId`. Updated when a
   * `presence` frame arrives via {@link applyPresence} and pruned by
   * {@link reapStalePresence}. The set is broadcast-fan-out is owned by
   * the WS layer (`src/web/server/ws.ts`) — the runtime is just the
   * canonical store + reaper.
   */
  private readonly peers = new Map<string, PresencePeerInfo>();
  private presenceReapTimer: ReturnType<typeof setInterval> | null = null;
  // PRESENCE-SECTION-END

  constructor(deps: ChatRuntimeDeps) {
    this.deps = deps;
    this.wireToolExecutor();
    this.wireAgentOrchestrator();
    this.wireBreakerRegistry();
    // PRESENCE-SECTION
    this.startPresenceReaper();
    // PRESENCE-SECTION-END
  }

  // PRESENCE-SECTION
  /**
   * Idempotently update the peer entry for `info.userId`. Returns the
   * canonical info AFTER the server stamped `lastSeenMs` so the WS layer
   * can fan out an authoritative copy (clients cannot lie about freshness).
   */
  applyPresence(info: {
    userId: string;
    displayName: string;
    typing: boolean;
  }): PresencePeerInfo {
    const stamped: PresencePeerInfo = {
      userId: info.userId,
      displayName: info.displayName,
      typing: info.typing,
      lastSeenMs: Date.now(),
    };
    this.peers.set(info.userId, stamped);
    return stamped;
  }

  /**
   * Mark a peer as offline (typing=false, lastSeenMs=now) on disconnect.
   * Returns the info so the caller can broadcast it. Returns `null` when
   * the peer was unknown (still safe to call from the WS onClose path).
   */
  markPresenceOffline(userId: string): PresencePeerInfo | null {
    const existing = this.peers.get(userId);
    if (existing === undefined) return null;
    const offline: PresencePeerInfo = {
      userId,
      displayName: existing.displayName,
      typing: false,
      lastSeenMs: Date.now(),
    };
    // Remove the peer immediately on disconnect so subscriberCount-like
    // queries see them as gone. The fan-out frame still flows so other
    // clients can show the "left" state in their UI.
    this.peers.delete(userId);
    return offline;
  }

  /** Snapshot of currently-tracked peers — defensive copy for tests/UI. */
  listPresence(): readonly PresencePeerInfo[] {
    return [...this.peers.values()];
  }

  /**
   * Drop peers whose `lastSeenMs` is older than
   * {@link PRESENCE_REAP_AFTER_MS}. Called by the reaper interval and
   * also explicitly from tests so the time-based behaviour can be
   * driven without `sleep`.
   */
  reapStalePresence(now: number = Date.now()): PresencePeerInfo[] {
    const reaped: PresencePeerInfo[] = [];
    for (const peer of this.peers.values()) {
      if (now - peer.lastSeenMs > PRESENCE_REAP_AFTER_MS) {
        this.peers.delete(peer.userId);
        reaped.push({ ...peer, typing: false, lastSeenMs: now });
      }
    }
    return reaped;
  }

  private startPresenceReaper(): void {
    if (this.presenceReapTimer !== null) return;
    this.presenceReapTimer = setInterval(() => {
      const reaped = this.reapStalePresence();
      for (const peer of reaped) {
        // Best-effort fan-out so passive clients eventually see the
        // peer go away. The bus broadcasts to every subscriber for the
        // session; clients filter out their own userId on receive.
        this.emit({
          type: 'presence',
          sessionId: this.deps.sessionId,
          userId: peer.userId,
          displayName: peer.displayName,
          typing: false,
          lastSeenMs: peer.lastSeenMs,
        });
      }
    }, PRESENCE_REAP_INTERVAL_MS);
    // Don't keep the Bun process alive just for the reaper.
    const unref = (this.presenceReapTimer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(this.presenceReapTimer);
  }

  private stopPresenceReaper(): void {
    if (this.presenceReapTimer !== null) {
      clearInterval(this.presenceReapTimer);
      this.presenceReapTimer = null;
    }
  }
  // PRESENCE-SECTION-END

  /**
   * Subscribe to circuit-breaker registry transitions and forward them
   * as `backend_circuit_state` WS frames. Fires once eagerly with the
   * current snapshot so a UI that connects mid-outage sees the banner
   * immediately rather than waiting for the next transition.
   *
   * TODO(web-frontend): subscribe to `backend_circuit_state` frames in
   * the WS feed and render a banner — when `state === 'open'`, surface
   * `reason` and offer the `/provider` overlay shortcut. The frame is
   * already emitted process-wide; the UI just needs the renderer.
   */
  private wireBreakerRegistry(): void {
    const registry = this.deps.breakerRegistry ?? globalBreakerRegistry;
    const emitSnapshots = (): void => {
      for (const { key, snapshot } of registry.list()) {
        const [backend, ...rest] = key.split('::');
        const baseUrl = rest.join('::');
        if (backend === undefined || baseUrl.length === 0) continue;
        const frame: WSServerMessage = snapshot.nextProbeAt !== null
          ? {
              type: 'backend_circuit_state',
              backend,
              baseUrl,
              state: snapshot.state,
              nextProbeAt: snapshot.nextProbeAt,
            }
          : {
              type: 'backend_circuit_state',
              backend,
              baseUrl,
              state: snapshot.state,
            };
        this.emit(frame);
      }
    };
    // Fire initial snapshot so newly-connected UIs see the current state.
    emitSnapshots();
    this.breakerUnsubscribe = registry.subscribe(emitSnapshots);
  }

  /**
   * Subscribe to orchestrator events scoped to THIS parent session and
   * forward them as `agent_*` WS frames. No-op when no orchestrator is
   * provided.
   */
  private wireAgentOrchestrator(): void {
    const orch = this.deps.agentOrchestrator;
    if (orch === undefined) return;
    this.agentUnsubscribe = orch.subscribe((evt: OrchestratorEvent) => {
      if (evt.sessionId !== this.deps.sessionId) return;
      this.emit(evt);
    });
  }

  /**
   * Currently-bound browser session, if any. Lazy-created on first
   * `browser_*` tool call. Exposed for the WS layer so user-input
   * frames can be forwarded into the live CDP connection.
   */
  getBrowserSession(): BrowserSession | null {
    return this.browserSession;
  }

  /**
   * Forward a user click into the active browser session. Returns
   * `false` (warn-and-ignore) when no session is bound.
   */
  async forwardBrowserClick(x: number, y: number, button?: 'left' | 'right'): Promise<boolean> {
    const session = this.browserSession;
    if (session === null) return false;
    await session.forwardUserClick(x, y, button);
    return true;
  }

  async forwardBrowserKey(
    key: string,
    modifiers?: readonly ('shift' | 'ctrl' | 'alt' | 'meta')[],
  ): Promise<boolean> {
    const session = this.browserSession;
    if (session === null) return false;
    await session.forwardUserKey(key, modifiers);
    return true;
  }

  async forwardBrowserScroll(deltaY: number): Promise<boolean> {
    const session = this.browserSession;
    if (session === null) return false;
    await session.forwardUserScroll(deltaY);
    return true;
  }

  /**
   * Close the live browser session (if any). Emits `browser_state`
   * `closed` and tears down the screencast subscription.
   */
  async closeBrowserSession(): Promise<void> {
    const session = this.browserSession;
    if (session === null) return;
    try {
      this.browserUnsubscribe?.();
    } catch {
      // ignore — best-effort
    }
    this.browserUnsubscribe = null;
    this.browserSession = null;
    try {
      await session.close();
    } catch (err) {
      this.emit({
        type: 'browser_state',
        sessionId: this.deps.sessionId,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.emit({
      type: 'browser_state',
      sessionId: this.deps.sessionId,
      status: 'closed',
    });
  }

  /**
   * Tear down everything owned by this runtime. Called by the
   * `RuntimePool` `onEvict` hook.
   *
   * Cleanup order: cancel in-flight stream → tear down browser session
   * → cancel sub-agents under this parent (their worktrees are removed
   * by the orchestrator) → drop our agent-event subscription.
   */
  async dispose(): Promise<void> {
    this.cancel();
    await this.closeBrowserSession();
    if (this.deps.agentOrchestrator !== undefined) {
      try {
        await this.deps.agentOrchestrator.disposeTeam(this.deps.sessionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ChatRuntime] agent disposeTeam failed for ${this.deps.sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (this.agentUnsubscribe !== null) {
      try {
        this.agentUnsubscribe();
      } catch {
        // ignore
      }
      this.agentUnsubscribe = null;
    }
    if (this.breakerUnsubscribe !== null) {
      try {
        this.breakerUnsubscribe();
      } catch {
        // ignore
      }
      this.breakerUnsubscribe = null;
    }
    // PRESENCE-SECTION
    this.stopPresenceReaper();
    this.peers.clear();
    // PRESENCE-SECTION-END
  }

  /**
   * Lazy-create the per-session BrowserSession the first time a
   * `browser_*` tool call is observed. Subscribe to its events and
   * fan them out as `browser_*` WS frames. Idempotent.
   */
  private ensureBrowserSession(): BrowserSession | null {
    if (this.browserSession !== null) return this.browserSession;
    const factory = this.deps.createBrowserSession;
    if (factory === undefined) return null;
    this.emit({
      type: 'browser_state',
      sessionId: this.deps.sessionId,
      status: 'starting',
    });
    let session: BrowserSession;
    try {
      session = factory();
    } catch (err) {
      this.emit({
        type: 'browser_state',
        sessionId: this.deps.sessionId,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    this.browserSession = session;
    let firstFrame = true;
    this.browserUnsubscribe = session.subscribe({
      onFrame: (frame) => {
        if (firstFrame) {
          firstFrame = false;
          this.emit({
            type: 'browser_state',
            sessionId: this.deps.sessionId,
            status: 'ready',
          });
        }
        this.emit({
          type: 'browser_frame',
          sessionId: this.deps.sessionId,
          frame: {
            jpegBase64: frame.jpegBase64,
            width: frame.width,
            height: frame.height,
            capturedAt: frame.capturedAt,
          },
        });
      },
      onCursor: (cursor) => {
        this.emit({
          type: 'browser_cursor',
          sessionId: this.deps.sessionId,
          fromX: cursor.fromX,
          fromY: cursor.fromY,
          toX: cursor.toX,
          toY: cursor.toY,
          durationMs: cursor.durationMs,
          action: cursor.action,
        });
      },
      onConsole: (entry) => {
        this.emit({
          type: 'browser_console',
          sessionId: this.deps.sessionId,
          level: entry.level,
          text: entry.text,
          ...(entry.source !== undefined ? { source: entry.source } : {}),
          ...(entry.line !== undefined ? { line: entry.line } : {}),
        });
      },
      onError: (err) => {
        this.emit({
          type: 'browser_state',
          sessionId: this.deps.sessionId,
          status: 'error',
          errorMessage: err.message,
        });
      },
    });
    return session;
  }

  /**
   * Inspect a tool call for `browser_*` names; if matched, ensure the
   * BrowserSession is live and emit any state transitions implied by
   * the call (e.g. `navigating` on `browser_navigate`).
   */
  private maybeHandleBrowserTool(call: ToolCall): void {
    if (!call.name.startsWith('browser_')) return;
    this.ensureBrowserSession();
    if (call.name === 'browser_navigate') {
      const url = typeof call.arguments['url'] === 'string' ? call.arguments['url'] : undefined;
      this.emit({
        type: 'browser_state',
        sessionId: this.deps.sessionId,
        status: 'navigating',
        ...(url !== undefined ? { url } : {}),
      });
    }
  }

  /** True iff a stream is currently in flight for this session. */
  get streaming(): boolean {
    return this.isStreaming;
  }

  // RECOVERY-FIX-3-SECTION
  /**
   * Timestamp of the last streaming activity (Date.now()). 0 when the
   * runtime is idle. The watchdog reads this to find runtimes whose
   * `isStreaming === true` but `now - lastActivityAt > staleAfterMs`.
   */
  getLastActivityAt(): number {
    return this.lastChunkAt;
  }

  /**
   * Force-release the stream lock and emit an `error`+`done` frame.
   * Invoked by `HealthWatchdog` when a runtime is judged stuck — the
   * next `sendUserMessage` proceeds normally because the lock is gone.
   * Idempotent: if the runtime isn't streaming, it's a no-op.
   */
  forceResetFromWatchdog(reason: string): boolean {
    if (!this.isStreaming) return false;
    // eslint-disable-next-line no-console
    console.warn(
      `[chat-runtime] watchdog force-reset for ${this.deps.sessionId}: ${reason}`,
    );
    // Abort the in-flight controller in case the adapter ever returns,
    // and prevent further chunks from racing the reset.
    try {
      this.cancelController?.abort();
    } catch {
      // ignore
    }
    this.emit({
      type: 'error',
      sessionId: this.deps.sessionId,
      message: `Stream watchdog: ${reason}`,
    });
    this.emit({
      type: 'done',
      sessionId: this.deps.sessionId,
      clientReqId: 'watchdog',
      error: `Stream watchdog: ${reason}`,
    });
    this.isStreaming = false;
    this.cancelController = null;
    this.lastChunkAt = 0;
    return true;
  }
  // RECOVERY-FIX-3-SECTION-END

  /**
   * Submit a user message: persist it, broadcast `message_committed`,
   * then run the model loop. Concurrent calls (while a previous stream
   * is still running) are rejected with an `error` event so the client
   * surfaces the conflict instead of silently double-streaming.
   */
  async sendUserMessage(text: string, clientReqId: string): Promise<void> {
    if (this.isStreaming) {
      this.emit({
        type: 'error',
        sessionId: this.deps.sessionId,
        message: 'Stream already in progress; cancel first',
      });
      return;
    }

    // Settings-driven UserPromptSubmit hooks. Run BEFORE the message
    // is persisted / added to context. A blocking non-zero exit
    // rejects the submission with an `error` frame followed by a
    // `done` so the client can clear its pending state.
    const hookEngine = this.deps.hookEngine;
    if (hookEngine !== undefined && hookEngine.hasHooksFor('UserPromptSubmit')) {
      try {
        const outcomes = await hookEngine.run({
          trigger: 'UserPromptSubmit',
          userPrompt: text,
          sessionId: this.deps.sessionId,
          projectRoot: this.deps.projectRoot ?? process.cwd(),
        });
        const blocker = outcomes.find((o) => o.blocked);
        if (blocker !== undefined) {
          const stderrTrimmed = blocker.stderr.trim();
          const reason =
            stderrTrimmed.length > 0
              ? stderrTrimmed
              : `UserPromptSubmit hook exit ${blocker.exitCode}`;
          this.emit({
            type: 'error',
            sessionId: this.deps.sessionId,
            message: `Prompt rejected by hook: ${reason}`,
          });
          this.emit({
            type: 'done',
            sessionId: this.deps.sessionId,
            clientReqId,
            error: `Prompt rejected by hook: ${reason}`,
          });
          return;
        }
      } catch (err) {
        // Engine failures don't reject the prompt — surface as a
        // non-fatal error and continue. A broken hook engine should
        // not block the user's chat flow.
        this.emit({
          type: 'error',
          sessionId: this.deps.sessionId,
          message: `UserPromptSubmit hook engine failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }

    const userMsg: Message = {
      id: makeId('user'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    this.deps.contextManager.add(userMsg);
    try {
      this.deps.sessionManager.addMessage(this.deps.sessionId, userMsg);
    } catch (err) {
      // SQLite write failure is fatal for the turn — we cannot stream
      // a reply we can't persist. Surface as `done` with error.
      this.emit({
        type: 'done',
        sessionId: this.deps.sessionId,
        clientReqId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.emit({
      type: 'message_committed',
      sessionId: this.deps.sessionId,
      message: toWire(userMsg),
    });

    this.isStreaming = true;
    this.cancelController = new AbortController();
    // RECOVERY-FIX-3-SECTION — seed activity clock so a runtime that
    // hangs BEFORE the first chunk (e.g. adapter never responds) still
    // gets reaped by the watchdog after `staleAfterMs`.
    this.lastChunkAt = Date.now();
    // RECOVERY-FIX-3-SECTION-END
    // RECOVERY-FIX-2-SECTION
    // Belt-and-braces: even if the loop throws, the client MUST get a
    // terminal `done` frame so its `setSending(false)` runs. Without it
    // the spinner stayed up after a runtime exception and the next user
    // message looked "ignored" (still optimistically queued behind the
    // streaming lock that the frontend hadn't released).
    let loopErr: unknown = null;
    try {
      await this.runStreamLoop(clientReqId);
    } catch (err) {
      loopErr = err;
      // eslint-disable-next-line no-console
      console.warn(
        `[chat-runtime] runStreamLoop threw uncaught in ${this.deps.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.emit({
        type: 'done',
        sessionId: this.deps.sessionId,
        clientReqId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isStreaming = false;
      this.cancelController = null;
      // Reset the watchdog clock — next call starts a fresh window.
      this.lastChunkAt = 0;
    }
    void loopErr; // intentionally captured for future telemetry
    // RECOVERY-FIX-2-SECTION-END
  }

  /** Cancel the in-flight stream (if any). No-op when idle. */
  cancel(): void {
    this.cancelController?.abort();
  }

  /**
   * Inject a self-generated user message (typically fired by the
   * WakeupRegistry's `onFire` callback). If a stream is already in
   * flight the call is dropped silently — the wakeup mechanism is best-
   * effort and the user can re-schedule via `schedule_wakeup` if needed.
   *
   * Uses a fresh `clientReqId` per call so the WS `done` frame routes
   * correctly. Returns the promise from `sendUserMessage` so callers
   * can await completion in tests; the production wakeup callback is
   * fire-and-forget.
   */
  async queueWakeupPrompt(prompt: string): Promise<void> {
    if (this.isStreaming) return;
    const reqId = `wakeup-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    await this.sendUserMessage(prompt, reqId);
  }

  // ---------- internals ----------

  private emit(msg: WSServerMessage): void {
    this.deps.eventBus.emit(this.deps.sessionId, msg);
  }

  /**
   * Wire the tool executor's approval + auto-lint hooks once at
   * construction. The wiring stays bound for the runtime's lifetime —
   * RuntimePool eviction discards the executor along with the runtime.
   */
  private wireToolExecutor(): void {
    const executor = this.deps.toolExecutor as unknown as {
      // The class doesn't currently expose `setApprovalCallback`. We
      // configure it via the constructor in the composition root, so
      // here we only need the auto-check hook (which IS a public
      // setter). The approval callback was passed in via options when
      // the executor was built — see the WS bootstrap in Agent A.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setOnAutoCheckResult?: (fn: (msg: Message) => void) => void;
    };

    // Auto-lint: append synthetic tool message to context AND emit it
    // over the bus so the frontend can render the lint result inline.
    if (typeof executor.setOnAutoCheckResult === 'function') {
      executor.setOnAutoCheckResult((message: Message) => {
        this.deps.contextManager.add(message);
        this.emit({
          type: 'tool_result',
          sessionId: this.deps.sessionId,
          toolCallId: message.toolCallId ?? 'auto-lint',
          ok: true,
          preview: message.content.slice(0, 500),
        });
      });
    }
  }

  /**
   * Predicate-guarded auto-compress dispatch. Mirrors the TUI wiring
   * in `app.tsx` (`maybeAutoCompress`) but uses the simpler
   * `contextManager.maybeSummarize` path — the web runtime doesn't
   * have a programmatic `/compress` exec available without coupling to
   * the TUI command-context, and `maybeSummarize` is a no-op when no
   * `summarizer` is wired into the manager so this stays safe.
   *
   * Best-effort: errors are caught and turned into an `error` event so
   * the user's turn still completes cleanly.
   */
  private async maybeAutoCompress(): Promise<void> {
    try {
      const max = this.deps.maxContextTokens;
      if (!Number.isFinite(max) || max <= 0) return;
      const triggerAtPercent =
        this.deps.autoCompressPercent ??
        DEFAULT_AUTO_COMPRESS_TRIGGER_PERCENT;

      const system = this.deps.buildSystemMessage();
      const sysContent =
        typeof system.content === 'string' ? system.content : '';
      const ctxTokens = estimateContextTokens(
        this.deps.contextManager.getMessages(),
        sysContent,
      );

      if (
        !shouldAutoCompress({
          contextTokens: ctxTokens,
          maxContextTokens: max,
          triggerAtPercent,
        })
      ) {
        return;
      }

      const now = Date.now();
      if (
        !autoCompressCooldownElapsed({
          lastCompressAt: this.lastAutoCompressAt,
          now,
          cooldownMs: DEFAULT_AUTO_COMPRESS_COOLDOWN_MS,
        })
      ) {
        return;
      }

      // PreCompact — let user hooks abort the compress BEFORE we stamp
      // the cooldown. A blocking non-zero exit aborts the compress AND
      // leaves `lastAutoCompressAt` untouched so the next turn re-tries
      // (the cooldown is for actual compress dispatch, not failed-hook
      // attempts). Engine failures degrade to a notice + continue.
      const hookEngine = this.deps.hookEngine;
      if (hookEngine !== undefined && hookEngine.hasHooksFor('PreCompact')) {
        try {
          const outcomes = await hookEngine.run({
            trigger: 'PreCompact',
            projectRoot: this.deps.projectRoot ?? process.cwd(),
            sessionId: this.deps.sessionId,
            contextTokens: ctxTokens,
            maxContextTokens: max,
          });
          const blocker = outcomes.find((o) => o.blocked);
          if (blocker !== undefined) {
            const stderrTrimmed = blocker.stderr.trim();
            const reason =
              stderrTrimmed.length > 0
                ? stderrTrimmed
                : `PreCompact hook exit ${blocker.exitCode}`;
            this.emit({
              type: 'message_committed',
              sessionId: this.deps.sessionId,
              message: toWire({
                id: makeId('sys'),
                role: 'system',
                content: `Auto-compress aborted by hook: ${reason}`,
                createdAt: now,
              }),
            });
            return;
          }
        } catch (err) {
          // Engine failure: surface as `error`, do NOT stamp cooldown,
          // and continue with the compress (a broken hook engine must
          // not permanently block compaction).
          this.emit({
            type: 'error',
            sessionId: this.deps.sessionId,
            message: `PreCompact hook engine failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      }

      // Stamp cooldown AFTER the hook passes so a blocked PreCompact
      // does not consume the 60 s window.
      this.lastAutoCompressAt = now;

      // Best-effort summarise. `maybeSummarize` already guards on
      // threshold + summarizer presence, but calling it here gives the
      // ContextManager a chance to act on the explicit decision the
      // predicate just made (e.g. lower threshold).
      const ran = await this.deps.contextManager.maybeSummarize(max);
      if (ran) {
        this.emit({
          type: 'message_committed',
          sessionId: this.deps.sessionId,
          message: toWire({
            id: makeId('sys'),
            role: 'system',
            content:
              `Auto-compressed context (${Math.round(triggerAtPercent * 100)}% of ${max.toLocaleString()} tokens reached).`,
            createdAt: now,
          }),
        });
      }
    } catch (err) {
      this.emit({
        type: 'error',
        sessionId: this.deps.sessionId,
        message: `Auto-compress failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Iterative model + tool loop (audit M8 — was recursive, long tool
   * chains piled up the call stack). Each iteration is one model turn;
   * after tool calls run we loop instead of self-call. Bounded by
   * {@link MAX_TURNS} so a model that never settles on a final reply
   * surfaces a clear error rather than spinning forever.
   *
   * Cancellation (audit H5):
   *   - the abort signal is checked BEFORE each iteration AND before each
   *     tool call,
   *   - the signal is forwarded to `toolExecutor.execute(call, { signal })`
   *     so cooperative tools (esp. `run_command`) can interrupt their own
   *     subprocesses,
   *   - on abort we emit `done { error: 'cancelled' }` and exit promptly.
   */
  private async runStreamLoop(clientReqId: string): Promise<void> {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      // Audit H5 — cancellation guard at the TOP of every iteration so a
      // signal that fires between turns short-circuits the next model call.
      if (this.cancelController?.signal.aborted) {
        this.emit({
          type: 'done',
          sessionId: this.deps.sessionId,
          clientReqId,
          error: 'cancelled',
        });
        return;
      }

      // Best-effort summarisation before each turn — matches app.tsx.
      try {
        await this.deps.contextManager.maybeSummarize(this.deps.maxContextTokens);
      } catch {
        // swallow — summariser is best-effort
      }

      const system = this.deps.buildSystemMessage();
      // Apply the sliding-window cap before serialising — keeps prompt
      // cost bounded on long vibe-coding sessions (200+ messages). The
      // helper is a pure slice; tool_call ↔ tool pairing across the cut
      // is repaired downstream by `sanitiseToolCallPairing` in the
      // adapter.
      const maxRecent =
        this.deps.maxRecentMessages ?? DEFAULT_MAX_RECENT_MESSAGES;
      const recentHistory = applyRecentWindow(
        this.deps.contextManager.getMessages(),
        maxRecent,
      );
      const wireMessages: Message[] = [system, ...recentHistory];

      // COST-PERSIST-SECTION — snapshot the model + backend at the
      // moment this turn begins. The user may switch model mid-session,
      // so we must label THIS row with the model that actually streamed
      // (mirrors the TUI's `requestModel` capture in app.tsx). Falls
      // back to the session row's model when the lookup fails — the
      // session row stores the model that was active at create time.
      const sessionSnapshot = this.deps.sessionManager.getSession(
        this.deps.sessionId,
      );
      const requestModel: string | undefined =
        sessionSnapshot?.model !== undefined && sessionSnapshot.model.length > 0
          ? sessionSnapshot.model
          : undefined;
      const requestBackend: string | undefined =
        sessionSnapshot?.backend !== undefined &&
        sessionSnapshot.backend.length > 0
          ? sessionSnapshot.backend
          : undefined;
      // COST-PERSIST-SECTION-END

      let assistantText = '';
      let thinkingText = '';
      let pendingToolCalls: ToolCall[] = [];
      let streamError: string | null = null;
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let cachedTokens: number | undefined;
      let freshTokens: number | undefined;
      let cacheCreationTokens: number | undefined;
      let durationMs: number | undefined;

      const signal = this.cancelController?.signal;

      try {
        await this.deps.llm.streamChat({
          messages: wireMessages,
          tools: this.deps.tools,
          ...(signal !== undefined ? { signal } : {}),
          onChunk: (text: string) => {
            assistantText += text;
            // RECOVERY-FIX-3-SECTION — stamp activity so the watchdog
            // sees this runtime as live. Stamped on every adapter
            // callback (chunk, thinking_chunk, tool_calls).
            this.lastChunkAt = Date.now();
            // RECOVERY-FIX-3-SECTION-END
            this.emit({
              type: 'chunk',
              sessionId: this.deps.sessionId,
              text,
            });
          },
          onThinkingChunk: (text: string) => {
            thinkingText += text;
            this.lastChunkAt = Date.now();
            this.emit({
              type: 'thinking_chunk',
              sessionId: this.deps.sessionId,
              text,
            });
          },
          onToolCalls: (calls: ToolCall[]) => {
            pendingToolCalls = [...calls];
            this.lastChunkAt = Date.now();
          },
          onDone: (result) => {
            if (result.error !== undefined) streamError = result.error;
            if (result.usage !== undefined) {
              promptTokens = result.usage.promptTokens;
              completionTokens = result.usage.completionTokens;
              cachedTokens = result.usage.cachedInputTokens;
              freshTokens = result.usage.freshInputTokens;
              cacheCreationTokens = result.usage.cacheCreationTokens;
            }
            if (result.durationMs !== undefined) durationMs = result.durationMs;
          },
        });
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err);
      }

      // Record per-session usage even when the turn errored — partial
      // reports are still informative for the UI footer.
      if (promptTokens !== undefined || completionTokens !== undefined) {
        this.deps.contextManager.recordUsage(promptTokens ?? 0, completionTokens ?? 0);
        const total = (promptTokens ?? 0) + (completionTokens ?? 0);
        this.emit({
          type: 'usage',
          sessionId: this.deps.sessionId,
          tokens: {
            in: promptTokens ?? 0,
            out: completionTokens ?? 0,
            total,
            ...(cachedTokens !== undefined ? { cached: cachedTokens } : {}),
            ...(freshTokens !== undefined ? { fresh: freshTokens } : {}),
            ...(cacheCreationTokens !== undefined
              ? { cacheCreation: cacheCreationTokens }
              : {}),
          },
        });
      }

      if (streamError !== null) {
        this.emit({
          type: 'done',
          sessionId: this.deps.sessionId,
          clientReqId,
          error: streamError,
        });
        return;
      }

      // Commit assistant message (with any text + tool calls). Even an
      // empty-content message is committed when tool calls are present —
      // the model's "speech" for that turn was the tool-call payload.
      const hasToolCalls = pendingToolCalls.length > 0;
      if (assistantText.length > 0 || hasToolCalls || thinkingText.length > 0) {
        const assistantMsg: Message = {
          id: makeId('asst'),
          role: 'assistant',
          content: assistantText,
          ...(hasToolCalls ? { toolCalls: pendingToolCalls } : {}),
          createdAt: Date.now(),
          ...(promptTokens !== undefined ? { tokensInput: promptTokens } : {}),
          ...(completionTokens !== undefined ? { tokensOutput: completionTokens } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          // COST-PERSIST-SECTION — stamp the model the row actually
          // streamed against. The UI prefers this over the global
          // currentModel when rendering the per-message label + cost.
          ...(requestModel !== undefined ? { model: requestModel } : {}),
          ...(cachedTokens !== undefined ? { cachedInputTokens: cachedTokens } : {}),
          ...(cacheCreationTokens !== undefined
            ? { cacheCreationTokens }
            : {}),
          // COST-PERSIST-SECTION-END
        };
        this.deps.contextManager.add(assistantMsg);
        try {
          this.deps.sessionManager.addMessage(this.deps.sessionId, assistantMsg, {
            ...(promptTokens !== undefined ? { tokensInput: promptTokens } : {}),
            ...(completionTokens !== undefined ? { tokensOutput: completionTokens } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            // COST-PERSIST-SECTION — pass model + backend + cache
            // telemetry so SessionManager.addMessage can resolve
            // pricing and persist `cost_usd` + cached/cache-creation
            // counts in a single transaction.
            ...(requestModel !== undefined ? { model: requestModel } : {}),
            ...(requestBackend !== undefined ? { backend: requestBackend } : {}),
            ...(cachedTokens !== undefined ? { cachedInputTokens: cachedTokens } : {}),
            ...(cacheCreationTokens !== undefined
              ? { cacheCreationTokens }
              : {}),
            // COST-PERSIST-SECTION-END
          });
        } catch (err) {
          // Persist failure is non-fatal for the live turn — surface as
          // an `error` event but keep the in-memory state.
          this.emit({
            type: 'error',
            sessionId: this.deps.sessionId,
            message: `Failed to persist assistant message: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
        this.emit({
          type: 'message_committed',
          sessionId: this.deps.sessionId,
          message: toWire(assistantMsg),
        });
      }

      if (!hasToolCalls) {
        // Stop — fires ONLY on the final turn (this branch has no
        // pending tool calls). Carries the usage snapshot for the
        // just-finished turn. Blocking outcomes surface as a synthetic
        // system note via the existing onHookEvent pattern; we never
        // roll back the assistant message the user already saw.
        const stopEngine = this.deps.hookEngine;
        if (
          stopEngine !== undefined &&
          stopEngine.hasHooksFor('Stop')
        ) {
          try {
            const usage: HookUsageSnapshot = {};
            if (promptTokens !== undefined) usage.promptTokens = promptTokens;
            if (completionTokens !== undefined) {
              usage.completionTokens = completionTokens;
            }
            if (cachedTokens !== undefined) {
              usage.cachedInputTokens = cachedTokens;
            }
            const outcomes = await stopEngine.run({
              trigger: 'Stop',
              projectRoot: this.deps.projectRoot ?? process.cwd(),
              sessionId: this.deps.sessionId,
              usage,
            });
            const blocker = outcomes.find((o) => o.blocked);
            if (blocker !== undefined) {
              const stderrTrimmed = blocker.stderr.trim();
              const reason =
                stderrTrimmed.length > 0
                  ? stderrTrimmed
                  : `Stop hook exit ${blocker.exitCode}`;
              this.emit({
                type: 'message_committed',
                sessionId: this.deps.sessionId,
                message: toWire({
                  id: makeId('sys'),
                  role: 'system',
                  content: `Stop hook flagged: ${reason}`,
                  createdAt: Date.now(),
                }),
              });
            }
          } catch (err) {
            this.emit({
              type: 'error',
              sessionId: this.deps.sessionId,
              message: `Stop hook engine failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
        }

        // Final assistant reply for this turn — evaluate auto-compress.
        // Best-effort: any failure is logged and swallowed so the user's
        // turn still completes cleanly.
        await this.maybeAutoCompress();
        this.emit({
          type: 'done',
          sessionId: this.deps.sessionId,
          clientReqId,
        });
        return;
      }

      // Execute each tool call serially. The executor's approvalCallback
      // (wired to ApprovalBridge by the composition root) takes care of
      // pausing for user approval — we just emit `approval_request`
      // events from the wrapper and forward results.
      for (const call of pendingToolCalls) {
        // Audit H5 — abort BEFORE each tool. Prevents wasted work after
        // the user cancelled while a previous tool was running.
        if (this.cancelController?.signal.aborted) {
          this.emit({
            type: 'done',
            sessionId: this.deps.sessionId,
            clientReqId,
            error: 'cancelled',
          });
          return;
        }

        this.emit({
          type: 'tool_call',
          sessionId: this.deps.sessionId,
          call: { id: call.id, name: call.name, arguments: call.arguments },
        });

        // Lazy-init the browser sandbox the first time the model invokes
        // any `browser_*` tool. Emits `browser_state` transitions.
        this.maybeHandleBrowserTool(call);

        // RECOVERY-FIX-1-SECTION
        // Hard guard around every tool dispatch. Although ToolExecutor.execute
        // is supposed to catch handler exceptions and produce a structured
        // ToolResult, third-party paths (MCP transport, plugin wrappers,
        // approval-bridge timeouts surfacing through edge code paths) can
        // still throw out of `execAny`. Pre-fix: an uncaught throw here
        // dropped through `runStreamLoop` → caught by sendUserMessage's
        // finally → isStreaming reset BUT no `done`/`error` frame ever
        // reached the client, so the spinner spun forever and the next
        // user message looked like it was being ignored. Post-fix: we
        // ALWAYS emit a synthetic `tool_result` + continue the loop so
        // the conversation stays alive and the user can send the next
        // message immediately.
        const execAny = this.deps.toolExecutor.execute.bind(
          this.deps.toolExecutor,
        ) as (
          call: ToolCall,
          opts?: { signal?: AbortSignal },
        ) => Promise<Awaited<ReturnType<typeof this.deps.toolExecutor.execute>>>;
        let result: Awaited<ReturnType<typeof this.deps.toolExecutor.execute>>;
        try {
          result = await execAny(
            call,
            signal !== undefined ? { signal } : undefined,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(
            `[chat-runtime] tool ${call.name} threw uncaught in session ${this.deps.sessionId}: ${message}`,
          );
          result = {
            success: false,
            output: '',
            error: `Tool "${call.name}" threw: ${message}`,
          };
        }
        // RECOVERY-FIX-1-SECTION-END
        const ok = result.success;
        const toolMsg: Message = {
          id: makeId('tool'),
          role: 'tool',
          content: formatToolOutput(result.output, result.error),
          toolName: call.name,
          toolCallId: call.id,
          createdAt: Date.now(),
        };
        this.deps.contextManager.add(toolMsg);
        // todo_write — emit todos_updated frame so the frontend TasksPanel
        // can update without polling. Only fires on successful calls.
        if (call.name === 'todo_write' && ok) {
          const freshTodos = this.deps.sessionManager.getTodos(this.deps.sessionId);
          this.emit({
            type: 'todos_updated',
            sessionId: this.deps.sessionId,
            todos: freshTodos,
          });
        }
        try {
          this.deps.sessionManager.addMessage(this.deps.sessionId, toolMsg);
        } catch (err) {
          this.emit({
            type: 'error',
            sessionId: this.deps.sessionId,
            message: `Failed to persist tool message: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }

        const preview = ok
          ? truncate(result.output, 500)
          : truncate(result.output.length > 0 ? result.output : (result.error ?? ''), 500);
        const evt: WSServerMessage = result.error !== undefined
          ? {
              type: 'tool_result',
              sessionId: this.deps.sessionId,
              toolCallId: call.id,
              ok,
              preview,
              error: result.error,
            }
          : {
              type: 'tool_result',
              sessionId: this.deps.sessionId,
              toolCallId: call.id,
              ok,
              preview,
            };
        this.emit(evt);
      }
      // Loop continues — next iteration handles the next model turn.
    }

    // Audit M8 — hit MAX_TURNS without the model settling on a final
    // reply. Surface a clear error so the user knows to refine the
    // request rather than wait indefinitely.
    // AGENT-RELIABILITY-FIX-5-SECTION
    // Mirror the worker-side observability so parent runs that hit the
    // cap leave a trace in dev-server / WS logs. The frontend already
    // gets the error via the `done` frame; this is for engineers
    // debugging "why did my long agent run just stop?"
    // eslint-disable-next-line no-console
    console.warn(
      `[chat-runtime] session ${this.deps.sessionId} hit MAX_TURNS=${MAX_TURNS}; surfacing error to client`,
    );
    // AGENT-RELIABILITY-FIX-5-SECTION-END
    this.emit({
      type: 'done',
      sessionId: this.deps.sessionId,
      clientReqId,
      error: `Max turns reached (${MAX_TURNS}) — model may be looping; ask a more specific question.`,
    });
  }
}

// ---------- helpers ----------

/**
 * Build a `ToolPreviewWire` for an approval request based on the tool
 * name + arguments. Exported so the WS bootstrap (which constructs the
 * `ToolExecutor` with the approval callback) can reuse the same logic
 * — keeps preview shape consistent across runtimes.
 *
 * Falls back to a `generic` summary when the tool isn't specially
 * handled, so the frontend always has something to render.
 */
export function buildPreview(
  toolName: string,
  args: Record<string, unknown>,
): ToolPreviewWire | null {
  if (toolName === 'write_file') {
    const path = stringField(args, 'path');
    const newContent = stringField(args, 'content') ?? '';
    if (path !== null) {
      return {
        kind: 'diff',
        path,
        oldContent: '',
        newContent,
      };
    }
  }
  if (toolName === 'edit_file') {
    const path = stringField(args, 'path');
    if (path !== null) {
      const oldStr = stringField(args, 'old_string') ?? '';
      const newStr = stringField(args, 'new_string') ?? '';
      return {
        kind: 'diff',
        path,
        oldContent: oldStr,
        newContent: newStr,
      };
    }
  }
  if (toolName === 'run_command') {
    const command = stringField(args, 'command');
    if (command !== null) {
      return {
        kind: 'command',
        command,
        cwd: stringField(args, 'cwd') ?? '',
      };
    }
  }
  if (toolName === 'fetch_image') {
    const url = stringField(args, 'url');
    if (url !== null) {
      return { kind: 'fetch_image', url };
    }
  }
  return {
    kind: 'generic',
    summary: `${toolName}(${summariseArgs(args)})`,
  };
}

/**
 * Strip server-only fields and produce the wire shape for a `Message`.
 * Right now the wire shape is a strict subset, so this is a copy with
 * conditional fields preserved. Kept as a function so future schema
 * drift has one place to update.
 */
export function toWire(m: Message): WireChatMessage {
  const out: WireChatMessage = {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  };
  if (m.toolCalls !== undefined) out.toolCalls = m.toolCalls;
  if (m.toolCallId !== undefined) out.toolCallId = m.toolCallId;
  if (m.toolName !== undefined) out.toolName = m.toolName;
  if (m.tokensInput !== undefined) out.tokensInput = m.tokensInput;
  if (m.tokensOutput !== undefined) out.tokensOutput = m.tokensOutput;
  if (m.durationMs !== undefined) out.durationMs = m.durationMs;
  if (m.model !== undefined) out.model = m.model;
  // MESSAGE-COST-CHIP-SECTION — forward persisted cost + cache telemetry
  // so the SPA's per-message chip renders without a second round-trip.
  if (m.cost !== undefined) out.cost = m.cost;
  if (m.cachedInputTokens !== undefined) {
    out.cachedInputTokens = m.cachedInputTokens;
  }
  if (m.cacheCreationTokens !== undefined) {
    out.cacheCreationTokens = m.cacheCreationTokens;
  }
  // MESSAGE-COST-CHIP-SECTION-END
  return out;
}

function stringField(args: Record<string, unknown>, key: string): string | null {
  const raw = args[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function summariseArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  return keys
    .slice(0, 3)
    .map((k) => {
      const v = args[k];
      if (typeof v === 'string') {
        return `${k}: ${truncate(v, 40)}`;
      }
      return `${k}: ${typeof v}`;
    })
    .join(', ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatToolOutput(output: string, error: string | undefined): string {
  if (error !== undefined && error.length > 0) {
    return output.length > 0 ? `${output}\n\n[error] ${error}` : `[error] ${error}`;
  }
  return output;
}

function makeId(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return `${prefix}-${c.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
