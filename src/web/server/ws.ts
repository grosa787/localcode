/**
 * WebSocket upgrade + per-socket frame router.
 *
 * Lifecycle:
 *   1. `upgrade(req, server)` — invoked from the HTTP router on `/ws`.
 *      Validates the request (origin / TLS) is the router's job; we
 *      just call `server.upgrade()` with a fresh `SocketContext`.
 *   2. `onOpen` — sets up the context. Nothing is sent yet; the client
 *      must say `hello` (with the matching CSRF token) before any
 *      other frame type is accepted.
 *   3. `onMessage` — JSON.parse → Zod validation → dispatch table.
 *      The first non-hello frame from an un-helloed socket closes the
 *      connection with code `1008` (policy violation).
 *   4. `onClose` — drops every event-bus subscription this socket
 *      held so the bus doesn't keep dispatching to a dead callback.
 *
 * Approval reattachment: when a tab subscribes to a session, every
 * pending approval for that session is re-emitted to the new tab so
 * it can render the dialog without missing the original event.
 */

import type { Server, ServerWebSocket } from 'bun';
import { timingSafeEqual } from 'node:crypto';

import {
  WSClientMessageSchema,
  type WireChatMessage,
  type WSServerMessage,
} from '@/web/protocol/messages';
import type { ConfigManager } from '@/config/config-manager';
import type { SessionManager } from '@/sessions/session-manager';
import type { WorkspaceRegistry } from '@/web/workspace/workspace-registry';
import type {
  SetProviderRequest,
  SetProviderResponse,
} from '@/web/protocol/rest-types';

import type { ApprovalBridge } from '../runtime/approval-bridge';
import type { ChatRuntime } from '../runtime/chat-runtime';
import { toWire } from '../runtime/chat-runtime';
import type { SessionEventBus } from '../runtime/event-bus';
import type { RuntimePool } from '../runtime/runtime-pool';
// AGENT-LIFECYCLE-SECTION
import type { AgentOrchestrator } from '@/agents/orchestrator';
// /AGENT-LIFECYCLE-SECTION

/** Per-socket state; stored under `ws.data`. */
export interface SocketContext {
  csrfHelloed: boolean;
  clientId: string | null;
  /** Sessions this socket has actively subscribed to (for cleanup). */
  subscribedSessions: Set<string>;
  /** Unsubscribe callbacks keyed by sessionId. */
  unsubscribeFns: Map<string, () => void>;
}

/**
 * Construction-time dependencies. Threaded by the server bootstrap
 * (Agent A) so the router stays pure / testable.
 */
export interface WsDeps {
  csrfToken: string;
  serverVersion: string;
  workspaceRegistry: WorkspaceRegistry;
  sessionManager: SessionManager;
  configManager: ConfigManager;
  eventBus: SessionEventBus;
  approvalBridge: ApprovalBridge;
  runtimePool: RuntimePool;
  /** Build / fetch the runtime for a session. The pool's `getOrCreate`
   *  factory should call into here to construct a fresh runtime when
   *  the session isn't resident. */
  createRuntimeForSession: (sessionId: string) => ChatRuntime;
  /** Persist a provider switch and return the updated state. */
  applyProviderChange: (req: SetProviderRequest) => Promise<SetProviderResponse>;
  // AGENT-LIFECYCLE-SECTION
  /**
   * Multi-agent orchestrator. Optional so a stripped-down server
   * configuration (or a test harness) can omit it; the
   * `relay_to_agent` WS handler short-circuits with an `error` frame
   * when it's missing.
   */
  agentOrchestrator?: AgentOrchestrator;
  // /AGENT-LIFECYCLE-SECTION
}

export interface WsHandlers {
  upgrade: (req: Request, server: Server<SocketContext>) => Response | 'upgraded';
  onOpen: (ws: ServerWebSocket<SocketContext>) => void;
  onMessage: (
    ws: ServerWebSocket<SocketContext>,
    data: string | ArrayBuffer | Uint8Array,
  ) => Promise<void>;
  onClose: (ws: ServerWebSocket<SocketContext>) => void;
}

/** Build a fresh `SocketContext`. Called from `upgrade` and tests. */
export function createSocketContext(): SocketContext {
  return {
    csrfHelloed: false,
    clientId: null,
    subscribedSessions: new Set(),
    unsubscribeFns: new Map(),
  };
}

export function createWsHandlers(deps: WsDeps): WsHandlers {
  return {
    upgrade(req, server) {
      const ok = server.upgrade(req, { data: createSocketContext() });
      if (ok) return 'upgraded';
      return new Response('Upgrade required', { status: 400 });
    },

    onOpen(_ws) {
      // Wait for the `hello` frame. Nothing to send proactively —
      // anything we emit before CSRF validation would be a tiny info
      // leak about the server's state.
    },

    async onMessage(ws, data) {
      let parsed: unknown;
      try {
        const text = typeof data === 'string' ? data : decodeBytes(data);
        parsed = JSON.parse(text);
      } catch {
        sendJson(ws, { type: 'error', message: 'invalid_json' });
        return;
      }
      const validated = WSClientMessageSchema.safeParse(parsed);
      if (!validated.success) {
        sendJson(ws, { type: 'error', message: 'schema_invalid' });
        return;
      }
      const msg = validated.data;
      const ctx = ws.data;

      // Hello gate — first frame must be a valid `hello`.
      if (!ctx.csrfHelloed) {
        if (msg.type !== 'hello') {
          ws.close(1008, 'expected_hello_first');
          return;
        }
        // Constant-time CSRF comparison (audit H1). Branching on length
        // doesn't leak useful timing: the secret length is a fixed
        // public constant. `timingSafeEqual` throws on length mismatch,
        // so the short-circuit must come first.
        if (!constantTimeEqualString(msg.csrf, deps.csrfToken)) {
          ws.close(1008, 'csrf_invalid');
          return;
        }
        ctx.csrfHelloed = true;
        ctx.clientId = msg.clientId;
        sendJson(ws, {
          type: 'hello_ok',
          serverVersion: deps.serverVersion,
          capabilities: [],
        });
        return;
      }

      // Dispatch table — every branch is exhaustive over the
      // post-hello variant set. `hello` arriving twice is a protocol
      // error; ignore silently rather than re-rotating the CSRF.
      switch (msg.type) {
        case 'hello': {
          // Already helloed — dropping silently is the safest choice.
          return;
        }
        case 'subscribe_session': {
          await handleSubscribe(ws, ctx, msg.sessionId, deps);
          return;
        }
        case 'unsubscribe_session': {
          handleUnsubscribe(ctx, msg.sessionId);
          return;
        }
        case 'send_message': {
          let runtime: ChatRuntime;
          try {
            runtime = deps.runtimePool.getOrCreate(msg.sessionId, () =>
              deps.createRuntimeForSession(msg.sessionId),
            );
          } catch (err) {
            // Audit H3 — concurrent-session cap hit. Surface to client.
            sendJson(ws, {
              type: 'error',
              sessionId: msg.sessionId,
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          // Fire-and-forget — the runtime emits its own progress
          // events. Awaiting here would block the socket from
          // processing further frames (e.g. cancel_stream). Audit H1 —
          // attach a catch so a synchronous throw inside the loop (adapter
          // init, executor crash) surfaces as a `done` error instead of
          // an unhandled rejection that crashes the process.
          const sid = msg.sessionId;
          const reqId = msg.clientReqId;
          runtime.sendUserMessage(msg.text, reqId).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.warn(
              `[ws] send_message runtime threw for ${sid}: ${message}`,
            );
            sendJson(ws, {
              type: 'done',
              sessionId: sid,
              clientReqId: reqId,
              error: message,
            });
          });
          return;
        }
        case 'cancel_stream': {
          const runtime = deps.runtimePool.get(msg.sessionId);
          runtime?.cancel();
          return;
        }
        case 'approval_response': {
          // APPROVAL-MODIFIED-ARGS-SECTION — pass through any Monaco-
          // edited args from the SPA. The bridge applies them via the
          // approval callback inside ChatRuntime's executor wiring.
          deps.approvalBridge.resolve(
            msg.toolCallId,
            msg.approved,
            msg.modifiedArgs,
          );
          // APPROVAL-MODIFIED-ARGS-SECTION-END
          return;
        }
        case 'set_provider': {
          try {
            const req: SetProviderRequest =
              msg.baseUrl !== undefined && msg.apiKey !== undefined
                ? { type: msg.backend, baseUrl: msg.baseUrl, apiKey: msg.apiKey }
                : msg.baseUrl !== undefined
                  ? { type: msg.backend, baseUrl: msg.baseUrl }
                  : msg.apiKey !== undefined
                    ? { type: msg.backend, apiKey: msg.apiKey }
                    : { type: msg.backend };
            const resp = await deps.applyProviderChange(req);
            sendJson(ws, {
              type: 'provider_changed',
              backend: resp.backend,
              baseUrl: resp.baseUrl,
              models: resp.models,
              currentModel: resp.currentModel,
              ...(msg.clientReqId !== undefined ? { clientReqId: msg.clientReqId } : {}),
            });
          } catch (err) {
            sendJson(ws, {
              type: 'error',
              message: `set_provider_failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
          return;
        }
        case 'set_model': {
          try {
            deps.configManager.update({ model: { current: msg.model } });
          } catch (err) {
            sendJson(ws, {
              type: 'error',
              message: `set_model_failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
          return;
        }
        case 'browser_user_click': {
          await forwardBrowserInput(ws, deps, msg.sessionId, async (rt) => {
            const ok = await rt.forwardBrowserClick(msg.x, msg.y, msg.button);
            return ok;
          }, 'click');
          return;
        }
        case 'browser_user_key': {
          await forwardBrowserInput(ws, deps, msg.sessionId, async (rt) => {
            const ok = await rt.forwardBrowserKey(msg.key, msg.modifiers);
            return ok;
          }, 'key');
          return;
        }
        case 'browser_user_scroll': {
          await forwardBrowserInput(ws, deps, msg.sessionId, async (rt) => {
            const ok = await rt.forwardBrowserScroll(msg.deltaY);
            return ok;
          }, 'scroll');
          return;
        }
        case 'browser_close_panel': {
          const runtime = deps.runtimePool.get(msg.sessionId);
          if (runtime !== undefined) {
            await runtime.closeBrowserSession();
          }
          return;
        }
        // AGENT-LIFECYCLE-SECTION
        case 'relay_to_agent': {
          // Forward a user message to a specific sub-agent via the
          // orchestrator's TeamBus. The worker's runner subscribes to
          // bus messages addressed to it (lead → agentId) and injects
          // them as user messages on the next turn boundary (see
          // runner-factory's AGENT-INBOUND-MSG-SECTION). The bus emits
          // an `agent_team_message` event back to subscribers so the
          // SPA's team-chat log records the routed message.
          //
          // We tolerate a missing orchestrator OR an unknown
          // agent/session gracefully — the panel won't enable the
          // reply button when the agent isn't running, but a race
          // between the user clicking and the agent terminating must
          // not crash the WS.
          const orch = deps.agentOrchestrator;
          if (orch === undefined) {
            sendJson(ws, {
              type: 'error',
              sessionId: msg.sessionId,
              message: 'relay_to_agent: orchestrator unavailable',
            });
            return;
          }
          const text = msg.text.trim();
          if (text.length === 0) return;
          try {
            orch.postTeamMessage(msg.sessionId, 'lead', msg.agentId, text);
          } catch (err) {
            sendJson(ws, {
              type: 'error',
              sessionId: msg.sessionId,
              message: `relay_to_agent: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
          return;
        }
        // /AGENT-LIFECYCLE-SECTION
        case 'ping': {
          sendJson(ws, { type: 'pong' });
          return;
        }
      }
    },

    onClose(ws) {
      const ctx = ws.data;
      for (const unsub of ctx.unsubscribeFns.values()) {
        try {
          unsub();
        } catch {
          // ignore — bus already coped with subscriber failure
        }
      }
      ctx.unsubscribeFns.clear();
      ctx.subscribedSessions.clear();
    },
  };
}

// ---------- helpers ----------

async function handleSubscribe(
  ws: ServerWebSocket<SocketContext>,
  ctx: SocketContext,
  sessionId: string,
  deps: WsDeps,
): Promise<void> {
  if (ctx.subscribedSessions.has(sessionId)) return;

  // Hydrate recent history before installing the live subscription.
  // Using `getMessages` (default pagination = 100 most-recent) keeps
  // the initial frame size predictable on long sessions.
  let messages: WireChatMessage[] = [];
  try {
    messages = deps.sessionManager.getMessages(sessionId).map((m) => toWire(m));
  } catch (err) {
    sendJson(ws, {
      type: 'error',
      sessionId,
      message: `history_unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }
  sendJson(ws, { type: 'subscribed', sessionId, messages });

  // Catch-up: re-emit any pending approvals for THIS session so a
  // freshly-opened tab sees the dialog it would otherwise have missed.
  for (const pending of deps.approvalBridge.listPending()) {
    if (pending.sessionId !== sessionId) continue;
    const evt: WSServerMessage =
      pending.preview !== null
        ? {
            type: 'approval_request',
            sessionId,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            args: pending.args,
            preview: pending.preview,
          }
        : {
            type: 'approval_request',
            sessionId,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            args: pending.args,
          };
    sendJson(ws, evt);
  }

  // Live subscription. Bus errors are swallowed inside emit().
  const unsub = deps.eventBus.subscribe(sessionId, (event) => {
    sendJson(ws, event);
  });
  ctx.subscribedSessions.add(sessionId);
  ctx.unsubscribeFns.set(sessionId, unsub);

  // Use of `await` is reserved for future history-pagination work
  // (load older messages on demand). Currently synchronous.
  await Promise.resolve();
}

function handleUnsubscribe(ctx: SocketContext, sessionId: string): void {
  const unsub = ctx.unsubscribeFns.get(sessionId);
  if (unsub !== undefined) {
    try {
      unsub();
    } catch {
      // ignore
    }
  }
  ctx.unsubscribeFns.delete(sessionId);
  ctx.subscribedSessions.delete(sessionId);
}

/**
 * Maximum WS buffered bytes before we start shedding recoverable frames
 * (audit M4). Browser WS implementations buffer reliably up to ~1 MB; past
 * that, slow clients lag and the runtime grows the buffer unbounded.
 */
const SEND_BACKPRESSURE_THRESHOLD_BYTES = 1_000_000;

/**
 * Frame types that are SAFE to drop under backpressure. Streaming chunks
 * are recoverable — the canonical `message_committed` arrives at the end
 * of the turn with the full text. Everything else is "critical" and must
 * not be silently dropped.
 */
const DROPPABLE_UNDER_BACKPRESSURE: ReadonlySet<string> = new Set([
  'chunk',
  'thinking_chunk',
  'browser_frame',
  'browser_cursor',
]);

function sendJson(
  ws: ServerWebSocket<SocketContext>,
  payload: WSServerMessage | { type: 'error'; message: string; sessionId?: string },
): void {
  // Audit M4 — backpressure. Bun's ServerWebSocket exposes
  // `getBufferedAmount()`; when the client is slow this grows unbounded
  // under fast streams. Drop only recoverable frames; preserve critical
  // ones (done, message_committed, error, tool_call, approval_request).
  const bufferedFn = (ws as { getBufferedAmount?: () => number }).getBufferedAmount;
  if (typeof bufferedFn === 'function') {
    let buffered = 0;
    try {
      buffered = bufferedFn.call(ws);
    } catch {
      buffered = 0;
    }
    if (
      buffered > SEND_BACKPRESSURE_THRESHOLD_BYTES &&
      DROPPABLE_UNDER_BACKPRESSURE.has(payload.type)
    ) {
      // Drop silently — the next `message_committed` for this turn
      // carries the full assistant text, so the user lands on the
      // correct state once the buffer drains.
      return;
    }
  }
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ws] send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Forward a browser-input WS frame into the live BrowserSession owned
 * by the session's runtime. If no runtime/session is bound, log a
 * warning and silently drop the frame — the user's tab may have lost
 * sync with the agent state, but we don't want to spam errors.
 */
async function forwardBrowserInput(
  ws: ServerWebSocket<SocketContext>,
  deps: WsDeps,
  sessionId: string,
  fn: (rt: ChatRuntime) => Promise<boolean>,
  label: string,
): Promise<void> {
  const runtime = deps.runtimePool.get(sessionId);
  if (runtime === undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[ws] browser_user_${label} dropped — no runtime for ${sessionId}`);
    return;
  }
  try {
    const ok = await fn(runtime);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ws] browser_user_${label} dropped — no browser session bound to ${sessionId}`,
      );
    }
  } catch (err) {
    sendJson(ws, {
      type: 'error',
      sessionId,
      message: `browser_user_${label}_failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

function decodeBytes(data: ArrayBuffer | Uint8Array): string {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new TextDecoder('utf-8').decode(view);
}

/**
 * Constant-time string comparison via `crypto.timingSafeEqual` (audit
 * H1). Distinct-length inputs short-circuit before the buffer compare
 * so the underlying call never throws — the length of the per-boot
 * CSRF token is a fixed public constant, so leaking length is not a
 * realistic vector.
 */
function constantTimeEqualString(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
