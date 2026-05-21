/**
 * Wire protocol — WebSocket tagged-union messages between the browser SPA
 * and the local `--web` server.
 *
 * This module is intentionally pure TypeScript: no React, no Bun-specific
 * APIs. Both halves of the system import from here, and so does the
 * frontend (via a path the Vite config sets up later).
 *
 * Domain types (`Message`, `ToolCall`) are re-exported from
 * `@/types/global`. Wire-only types strip server-internal fields and
 * never reference SQLite row shapes.
 *
 * Each `WSServerMessage` / `WSClientMessage` variant has a corresponding
 * Zod schema for runtime validation on receive. The schemas exist as a
 * defensive layer — they catch protocol drift between agents without
 * crashing the WS connection. Anything that doesn't validate is reported
 * via `onConnectionChange('closed')` on the client.
 */

import { z } from 'zod';

import type { Backend, Message, ToolCall } from '../../types/global.js';

// Re-export the domain types that flow over the wire unchanged.
export type { Backend, Message, ToolCall };
export type { Skill } from '../../types/global.js';

/** All known backend identifiers. Kept in sync with the `Backend` union. */
const BACKEND_VALUES = [
  'ollama',
  'lmstudio',
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'custom',
] as const satisfies readonly Backend[];

/** Reusable Zod schema for the `Backend` union. Exported for reuse in `rest-types`. */
export const BackendSchema: z.ZodType<Backend> = z.enum(BACKEND_VALUES);

// ---------- Wire-only shapes ----------

/**
 * Message shape sent over the wire. Mirrors the persisted `Message` but:
 *   - drops `tokensInput` / `tokensOutput` / `durationMs` from rows where
 *     the server doesn't want to ship telemetry.
 *   - keeps `toolCalls` and `toolCallId` so the UI can correlate.
 *
 * Distinct from `WireMessage` in `@/types/message`, which is the
 * OpenAI-compatible *LLM* wire shape. This type is the *protocol* wire
 * shape: server↔browser, not adapter↔backend.
 */
export interface WireChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  /**
   * Name of the model that generated this assistant message. Optional
   * for legacy rows persisted before the column existed; the frontend
   * falls back to the session's active model name for those.
   */
  model?: string;
  // MESSAGE-COST-CHIP-SECTION
  /**
   * Per-message USD cost as persisted by SessionManager.addMessage.
   * Surfaced on the wire so the chat-view per-message chip can render
   * without re-resolving prices client-side.
   */
  cost?: number;
  /** Prompt tokens served from the provider's prefix cache. */
  cachedInputTokens?: number;
  /** Anthropic-only: tokens written into the cache this turn. */
  cacheCreationTokens?: number;
  // MESSAGE-COST-CHIP-SECTION-END
}

/**
 * Tool-call info as broadcast by the server. Matches `ToolCall` from the
 * domain layer one-to-one for now, but kept as its own export so the
 * wire shape can diverge without churning every consumer.
 */
export interface ToolCallWire {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A single todo item broadcast over the wire. Matches the `Todo` shape
 * in `session-manager.ts` one-to-one. Kept as a distinct export so the
 * wire shape can evolve without touching the DB layer.
 */
export interface TodoWire {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

/**
 * A single wakeup entry broadcast over the wire. Mirrors
 * `ScheduledWakeup` from `@/scheduling/types`. `fireAt` is the absolute
 * epoch-ms timestamp; the frontend can derive "fires in N seconds"
 * client-side without polling.
 */
export interface WakeupWire {
  id: string;
  sessionId: string;
  prompt: string;
  reason: string;
  createdAt: number;
  fireAt: number;
}

/**
 * Preview payload for an `approval_request`. Discriminated by `kind`:
 *   - `diff`         — `write_file` / `edit_file` (old vs new).
 *   - `command`      — `run_command` (the command + cwd).
 *   - `fetch_image`  — `fetch_image` (URL only).
 *   - `generic`      — fallback for anything else.
 *
 * The server picks the most specific variant possible. Frontend code
 * pattern-matches on `kind` to render the appropriate component.
 */
export type ToolPreviewWire =
  | { kind: 'diff'; path: string; oldContent: string; newContent: string }
  | { kind: 'command'; command: string; cwd: string }
  | { kind: 'fetch_image'; url: string }
  | { kind: 'generic'; summary: string };

/**
 * Sidebar summary row for a session. Server pre-computes `messageCount`
 * so the SPA can render the list without a second fetch.
 */
export interface SessionSummaryWire {
  id: string;
  projectId: string;
  title: string | null;
  summary: string | null;
  model: string;
  backend: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ---------- Connection-state union (client-side helper) ----------

/**
 * Public state the WS client surfaces to its consumer. Matches the
 * states the typed client transitions through.
 */
export type WSConnectionState =
  | 'connecting'
  | 'open'
  | 'closed'
  | 'reconnecting';

// ---------- Tagged unions: client → server ----------

export type WSClientMessage =
  | { type: 'hello'; csrf: string; clientId: string }
  | { type: 'subscribe_session'; sessionId: string }
  | { type: 'unsubscribe_session'; sessionId: string }
  | {
      type: 'send_message';
      sessionId: string;
      text: string;
      clientReqId: string;
    }
  | { type: 'cancel_stream'; sessionId: string }
  // APPROVAL-MODIFIED-ARGS-SECTION
  // `modifiedArgs` lets the SPA send a Monaco-edited version of the
  // tool's arguments back with the approval; the ChatRuntime applies
  // them before `commit()` runs. Schema-validated below.
  | {
      type: 'approval_response';
      toolCallId: string;
      approved: boolean;
      modifiedArgs?: Record<string, unknown>;
    }
  // APPROVAL-MODIFIED-ARGS-SECTION-END
  | { type: 'set_model'; sessionId: string; model: string }
  | {
      type: 'set_provider';
      backend: Backend;
      baseUrl?: string;
      apiKey?: string;
      clientReqId?: string;
    }
  | { type: 'browser_user_click'; sessionId: string; x: number; y: number; button?: 'left' | 'right' }
  | {
      type: 'browser_user_key';
      sessionId: string;
      key: string;
      modifiers?: readonly ('shift' | 'ctrl' | 'alt' | 'meta')[];
    }
  | { type: 'browser_user_scroll'; sessionId: string; deltaY: number }
  | { type: 'browser_close_panel'; sessionId: string }
  // AGENT-LIFECYCLE-SECTION
  // Relay a user message to a specific sub-agent under the named
  // parent session. Server posts the envelope onto the
  // `AgentOrchestrator` team-bus as `lead → agentId`; the worker's
  // runner picks it up and injects it as a user message into its next
  // turn (see runner-factory's AGENT-INBOUND-MSG-SECTION). The
  // canonical fan-out arrives back as the normal
  // `agent_team_message` server frame, so subscribed UIs see the
  // routed message in the team-chat log without a special-case.
  | {
      type: 'relay_to_agent';
      sessionId: string;
      agentId: string;
      text: string;
    }
  // /AGENT-LIFECYCLE-SECTION
  | { type: 'ping' };

// ---------- Tagged unions: server → client ----------

export type WSServerMessage =
  | { type: 'hello_ok'; serverVersion: string; capabilities: readonly string[] }
  | {
      type: 'subscribed';
      sessionId: string;
      messages: readonly WireChatMessage[];
    }
  | { type: 'chunk'; sessionId: string; text: string }
  | { type: 'thinking_chunk'; sessionId: string; text: string }
  | { type: 'tool_call'; sessionId: string; call: ToolCallWire }
  | {
      type: 'tool_result';
      sessionId: string;
      toolCallId: string;
      ok: boolean;
      preview?: string;
      error?: string;
    }
  | {
      type: 'approval_request';
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args?: unknown;
      preview?: ToolPreviewWire;
    }
  | { type: 'message_committed'; sessionId: string; message: WireChatMessage }
  | {
      type: 'usage';
      sessionId: string;
      tokens: {
        in: number;
        out: number;
        total: number;
        /** Prompt tokens served from the provider's prefix cache. */
        cached?: number;
        /** Prompt tokens processed fresh (non-cached). */
        fresh?: number;
        /** Anthropic-only: tokens written into the cache by this turn. */
        cacheCreation?: number;
      };
    }
  | {
      type: 'done';
      sessionId: string;
      clientReqId?: string;
      error?: string;
    }
  | { type: 'error'; sessionId?: string; message: string }
  | {
      type: 'provider_changed';
      backend: Backend;
      baseUrl: string;
      models: readonly string[];
      currentModel: string;
      clientReqId?: string;
    }
  | {
      type: 'browser_frame';
      sessionId: string;
      frame: { jpegBase64: string; width: number; height: number; capturedAt: number };
    }
  | {
      type: 'browser_cursor';
      sessionId: string;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs: number;
      action: 'click' | 'hover' | 'type';
    }
  | {
      type: 'browser_console';
      sessionId: string;
      level: 'log' | 'info' | 'warn' | 'error' | 'debug';
      text: string;
      source?: string;
      line?: number;
    }
  | {
      type: 'browser_state';
      sessionId: string;
      status: 'idle' | 'starting' | 'ready' | 'navigating' | 'closed' | 'error';
      url?: string;
      title?: string;
      errorMessage?: string;
    }
  | {
      type: 'agent_spawned';
      sessionId: string;
      agentId: string;
      parentAgentId: string;
      model: string;
      task: string;
      ownedFiles: readonly string[];
      worktreePath?: string;
      startedAt: number;
    }
  | {
      type: 'agent_status';
      sessionId: string;
      agentId: string;
      status: 'running' | 'done' | 'failed' | 'cancelled';
      lastMessage?: string;
      error?: string;
    }
  | {
      type: 'agent_team_message';
      sessionId: string;
      from: string;
      to: string;
      message: string;
      at: number;
    }
  | {
      type: 'agent_completed';
      sessionId: string;
      agentId: string;
      summary: string;
      diff?: string;
      durationMs: number;
    }
  // AGENT-LIFECYCLE-SECTION
  // Mirrors the orchestrator `agent_removed` event: emitted once per
  // agent after it terminates AND has been moved from the active list
  // into history. SPA panels drop the row from the "currently running"
  // view; the entry remains reachable via the agent-team history
  // toggle. `status` carries the terminal disposition for the
  // historical chrome (done/failed/cancelled). Fan-out path:
  // orchestrator → ChatRuntime.wireAgentOrchestrator → ws emit.
  | {
      type: 'agent_removed';
      sessionId: string;
      agentId: string;
      status: 'running' | 'done' | 'failed' | 'cancelled';
      removedAt: number;
    }
  // /AGENT-LIFECYCLE-SECTION
  | {
      /**
       * Process-wide LLM-backend circuit breaker state. Fired by every
       * subscribed ChatRuntime whenever a breaker transitions, plus once
       * on subscription so the UI sees the initial state without waiting
       * for a transition. UI banner should react to `state === 'open'`
       * (or `'half-open'`) with the suggested resume time.
       *
       * NOTE: emitted to ALL subscribed sessions — the breaker is a
       * process-wide signal, not per-session. The UI is responsible for
       * filtering by `backend` / `baseUrl` if it cares (e.g. don't show
       * an OpenRouter banner on an Ollama session).
       */
      type: 'backend_circuit_state';
      backend: string;
      baseUrl: string;
      state: 'closed' | 'open' | 'half-open';
      nextProbeAt?: number;
      reason?: string;
    }
  | {
      /**
       * Emitted by ChatRuntime immediately after a successful `todo_write`
       * tool call. Carries the full replacement list so the frontend can
       * update the TasksPanel in a single frame without a round-trip.
       */
      type: 'todos_updated';
      sessionId: string;
      todos: readonly TodoWire[];
    }
  | {
      /**
       * Emitted whenever the pending-wakeups list changes for a given
       * session (schedule, cancel, fire). Carries the full snapshot so
       * the WakeupBadge can render without round-tripping back to REST.
       */
      type: 'wakeups_updated';
      sessionId: string;
      wakeups: readonly WakeupWire[];
    }
  | { type: 'pong' };

// ---------- Zod schemas (runtime validation) ----------

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
});

const WireChatMessageSchema: z.ZodType<WireChatMessage> = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  createdAt: z.number(),
  tokensInput: z.number().optional(),
  tokensOutput: z.number().optional(),
  durationMs: z.number().optional(),
  model: z.string().optional(),
});

const ToolPreviewWireSchema: z.ZodType<ToolPreviewWire> = z.union([
  z.object({
    kind: z.literal('diff'),
    path: z.string(),
    oldContent: z.string(),
    newContent: z.string(),
  }),
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string(),
  }),
  z.object({
    kind: z.literal('fetch_image'),
    url: z.string(),
  }),
  z.object({
    kind: z.literal('generic'),
    summary: z.string(),
  }),
]);

export const WSClientMessageSchema: z.ZodType<WSClientMessage> = z.union([
  z.object({
    type: z.literal('hello'),
    csrf: z.string(),
    clientId: z.string(),
  }),
  z.object({
    type: z.literal('subscribe_session'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('unsubscribe_session'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('send_message'),
    sessionId: z.string(),
    text: z.string(),
    clientReqId: z.string(),
  }),
  z.object({
    type: z.literal('cancel_stream'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('approval_response'),
    toolCallId: z.string(),
    approved: z.boolean(),
    // APPROVAL-MODIFIED-ARGS-SECTION
    modifiedArgs: z.record(z.unknown()).optional(),
    // APPROVAL-MODIFIED-ARGS-SECTION-END
  }),
  z.object({
    type: z.literal('set_model'),
    sessionId: z.string(),
    model: z.string(),
  }),
  z.object({
    type: z.literal('set_provider'),
    backend: BackendSchema,
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    clientReqId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser_user_click'),
    sessionId: z.string(),
    x: z.number(),
    y: z.number(),
    button: z.enum(['left', 'right']).optional(),
  }),
  z.object({
    type: z.literal('browser_user_key'),
    sessionId: z.string(),
    key: z.string(),
    modifiers: z
      .array(z.enum(['shift', 'ctrl', 'alt', 'meta']))
      .readonly()
      .optional(),
  }),
  z.object({
    type: z.literal('browser_user_scroll'),
    sessionId: z.string(),
    deltaY: z.number(),
  }),
  z.object({
    type: z.literal('browser_close_panel'),
    sessionId: z.string(),
  }),
  // AGENT-LIFECYCLE-SECTION
  z.object({
    type: z.literal('relay_to_agent'),
    sessionId: z.string(),
    agentId: z.string(),
    text: z.string(),
  }),
  // /AGENT-LIFECYCLE-SECTION
  z.object({
    type: z.literal('ping'),
  }),
]);

export const WSServerMessageSchema: z.ZodType<WSServerMessage> = z.union([
  z.object({
    type: z.literal('hello_ok'),
    serverVersion: z.string(),
    capabilities: z.array(z.string()).readonly(),
  }),
  z.object({
    type: z.literal('subscribed'),
    sessionId: z.string(),
    messages: z.array(WireChatMessageSchema).readonly(),
  }),
  z.object({
    type: z.literal('chunk'),
    sessionId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('thinking_chunk'),
    sessionId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_call'),
    sessionId: z.string(),
    call: ToolCallSchema,
  }),
  z.object({
    type: z.literal('tool_result'),
    sessionId: z.string(),
    toolCallId: z.string(),
    ok: z.boolean(),
    preview: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval_request'),
    sessionId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    preview: ToolPreviewWireSchema.optional(),
  }),
  z.object({
    type: z.literal('message_committed'),
    sessionId: z.string(),
    message: WireChatMessageSchema,
  }),
  z.object({
    type: z.literal('usage'),
    sessionId: z.string(),
    tokens: z.object({
      in: z.number(),
      out: z.number(),
      total: z.number(),
      cached: z.number().optional(),
      fresh: z.number().optional(),
      cacheCreation: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal('done'),
    sessionId: z.string(),
    clientReqId: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    sessionId: z.string().optional(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('provider_changed'),
    backend: BackendSchema,
    baseUrl: z.string(),
    models: z.array(z.string()).readonly(),
    currentModel: z.string(),
    clientReqId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser_frame'),
    sessionId: z.string(),
    frame: z.object({
      jpegBase64: z.string(),
      width: z.number(),
      height: z.number(),
      capturedAt: z.number(),
    }),
  }),
  z.object({
    type: z.literal('browser_cursor'),
    sessionId: z.string(),
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    durationMs: z.number(),
    action: z.enum(['click', 'hover', 'type']),
  }),
  z.object({
    type: z.literal('browser_console'),
    sessionId: z.string(),
    level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
    text: z.string(),
    source: z.string().optional(),
    line: z.number().optional(),
  }),
  z.object({
    type: z.literal('browser_state'),
    sessionId: z.string(),
    status: z.enum(['idle', 'starting', 'ready', 'navigating', 'closed', 'error']),
    url: z.string().optional(),
    title: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
  z.object({
    type: z.literal('agent_spawned'),
    sessionId: z.string(),
    agentId: z.string(),
    parentAgentId: z.string(),
    model: z.string(),
    task: z.string(),
    ownedFiles: z.array(z.string()).readonly(),
    worktreePath: z.string().optional(),
    startedAt: z.number(),
  }),
  z.object({
    type: z.literal('agent_status'),
    sessionId: z.string(),
    agentId: z.string(),
    status: z.enum(['running', 'done', 'failed', 'cancelled']),
    lastMessage: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('agent_team_message'),
    sessionId: z.string(),
    from: z.string(),
    to: z.string(),
    message: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('agent_completed'),
    sessionId: z.string(),
    agentId: z.string(),
    summary: z.string(),
    diff: z.string().optional(),
    durationMs: z.number(),
  }),
  // AGENT-LIFECYCLE-SECTION
  z.object({
    type: z.literal('agent_removed'),
    sessionId: z.string(),
    agentId: z.string(),
    status: z.enum(['running', 'done', 'failed', 'cancelled']),
    removedAt: z.number(),
  }),
  // /AGENT-LIFECYCLE-SECTION
  z.object({
    type: z.literal('backend_circuit_state'),
    backend: z.string(),
    baseUrl: z.string(),
    state: z.enum(['closed', 'open', 'half-open']),
    nextProbeAt: z.number().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('pong'),
  }),
  z.object({
    type: z.literal('todos_updated'),
    sessionId: z.string(),
    todos: z.array(
      z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
        activeForm: z.string(),
      }),
    ),
  }),
  z.object({
    type: z.literal('wakeups_updated'),
    sessionId: z.string(),
    wakeups: z.array(
      z.object({
        id: z.string(),
        sessionId: z.string(),
        prompt: z.string(),
        reason: z.string(),
        createdAt: z.number(),
        fireAt: z.number(),
      }),
    ),
  }),
]);

// Schemas for the wire-only sub-shapes. Exported so REST handlers and
// tests can reuse them without redeclaring.
export {
  ToolCallSchema,
  ToolPreviewWireSchema,
  WireChatMessageSchema,
};
