/**
 * ChatView — main chat surface.
 *
 * Composes:
 *   - Scrollable interleaved message list (assistant / user / tool-call cards).
 *   - Streaming chunks render LIVE — appended to a "current" assistant
 *     message until `done` arrives.
 *   - ApprovalDialog renders when an `approval_request` is pending.
 *   - Composer at the bottom (sticky).
 *   - FileBrowser as an absolutely-positioned slide-in (toggled by store).
 *
 * Wire to WSClient via the parent (App.tsx). The parent passes:
 *   - `wsSend(msg)` — to forward outbound WS messages.
 *   - `restClient` (subset) — for setProvider / setModel / file APIs.
 *   - `subscribeFeed(handler)` — register an inbound listener; the
 *     parent owns the WSClient lifetime.
 *
 * State held locally:
 *   - `messages`: persisted history merged with live streamed deltas.
 *   - `streamingId`: id of the currently-streaming assistant placeholder.
 *   - `pendingApproval`: most recent `approval_request` not yet answered.
 *   - `toolCalls`: map keyed by toolCallId for status/preview/result.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import type {
  ToolCallWire,
  ToolPreviewWire,
  WireChatMessage,
  WSClientMessage,
  WSServerMessage,
} from '../../../src/web/protocol/messages.js';
import type {
  FileReadResponse,
  FileTreeResponse,
  ListMessagesResponse,
  SetProviderRequest,
  SetProviderResponse,
} from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
import { MessageSquare } from '../icons';
import { useStore } from '../state/store';
// RESPONSIVE-SECTION
import { useViewport } from '../util/use-viewport';
// /RESPONSIVE-SECTION

import { ApprovalDialog } from './ApprovalDialog';
import { AssistantMessage } from './AssistantMessage';
import { Composer } from './Composer';
import { UsageFooter } from './UsageFooter';
import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { FileBrowser } from './FileBrowser';
import { QueueErrorBanner } from './QueueErrorBanner';
import { QueueIndicator } from './QueueIndicator';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolCallCard, type ToolStatus } from './ToolCallCard';
import { UserBubble } from './UserBubble';

import styles from './ChatView.module.css';

// ---------- Public props ----------

export interface ChatViewProps {
  /** Send a frame over the active WebSocket. */
  wsSend: (msg: WSClientMessage) => void;
  /**
   * Subscribe to inbound WS frames. Returns an unsubscriber. The parent
   * owns the socket; this view is a passive consumer.
   */
  subscribeFeed: (handler: (msg: WSServerMessage) => void) => () => void;
  /** REST: switch provider. */
  setProvider: (req: SetProviderRequest) => Promise<SetProviderResponse>;
  /** REST: file tree. Optional — when absent the browser is hidden. */
  fetchFileTree?: (path?: string) => Promise<FileTreeResponse>;
  /** REST: file read. */
  fetchFile?: (path: string) => Promise<FileReadResponse>;
  /** REST: list session messages. Used to hydrate on session switch. */
  fetchMessages?: (sessionId: string) => Promise<ListMessagesResponse>;
  /** Display label for the current backend, e.g. "openai @ api.openai.com". */
  backendLabel?: string | null;
}

// ---------- Virtualization tuning ----------

/**
 * Above this row count we stop rendering the entire history — only the
 * tail window stays in the DOM and earlier rows hide behind a
 * "Load more" button. Picked at 80 to match the typical viewport size
 * (ten messages above-fold, tens below). Sessions at or under the
 * threshold render verbatim with zero virtualization overhead.
 */
const VIRTUALIZE_THRESHOLD = 80;
/** Each "Load more" click reveals this many additional earlier rows. */
const VIRTUALIZE_PAGE = 80;
/**
 * Pixel slack tolerated before we treat the user as "scrolled back to
 * the bottom" — when the gap drops below this and the loaded window
 * has grown past the base page, we unmount the extra earlier rows so
 * the DOM size stops growing monotonically. Slightly larger than the
 * `nearBottom` threshold used by `stickToBottom` so the auto-stick
 * still has room to engage before the shrink kicks in.
 */
const VIRTUALIZE_SHRINK_NEAR_BOTTOM_PX = 120;
/**
 * Estimated row height (px) used for the spacer that stands in for
 * earlier rows trimmed out of the DOM. The value need not be exact —
 * the spacer only feeds `scrollHeight`/`scrollTop` math so the
 * scrollbar reads honestly; the "Load more" interaction explicitly
 * re-anchors scroll position around the actual row heights at commit
 * time. Picked from an empirical median of mixed user/assistant rows.
 */
const VIRTUALIZE_ROW_ESTIMATE_PX = 80;

// ---------- Internal state types ----------

interface ToolCallState {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  preview?: string;
  error?: string;
  diff?: { path: string; oldContent: string; newContent: string };
  command?: { command: string; cwd: string };
  startedAt: number;
  finishedAt?: number;
}

interface PendingApprovalState {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  preview?: ToolPreviewWire;
}

// Internal "rendered row" union — the message list is a flat sequence
// of these and we render in order.
type Row =
  | { kind: 'user'; id: string; content: string; createdAt?: number }
  | {
      kind: 'assistant';
      id: string;
      content: string;
      model?: string | null;
      streaming: boolean;
      // MESSAGE-COST-CHIP-SECTION — per-turn telemetry sourced from
      // WireChatMessage so AssistantMessage can render the cost chip
      // without consulting the global usage store.
      cost?: number;
      tokensInput?: number;
      tokensOutput?: number;
      durationMs?: number;
      // MESSAGE-COST-CHIP-SECTION-END
    }
  | { kind: 'tool'; toolCallId: string };

// ---------- Component ----------

export function ChatView(props: ChatViewProps): JSX.Element {
  const t = useT();
  // RESPONSIVE-SECTION
  // Surface the breakpoint to CSS via data-viewport on the chat root
  // so component-local rules (e.g. tighter padding on mobile) work
  // without consuming a hook in every nested module.
  const chatViewport = useViewport();
  // /RESPONSIVE-SECTION
  const sessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const fileBrowserOpen = useStore((s) => s.fileBrowserOpen);
  const toggleFileBrowser = useStore((s) => s.toggleFileBrowser);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const pushToast = useStore((s) => s.pushToast);
  const pendingQueue = useStore((s) => s.pendingQueue);
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const clearPendingQueue = useStore((s) => s.clearPendingQueue);
  const setSessionMessages = useStore((s) => s.setSessionMessages);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === sessionId) ?? null,
    [sessions, sessionId],
  );
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  // Persisted/streaming messages — flat ordered sequence by `createdAt`.
  const [messages, setMessages] = useState<WireChatMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<Record<string, ToolCallState>>({});
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState | null>(null);
  const [sending, setSending] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  // `latestUsage` lives in the global store so the ProjectBar's
  // ContextUsageRing can read the same numbers without prop-drilling
  // through App.tsx. Locally we still drive the UsageFooter from this
  // slice — the store is the single source of truth.
  const latestUsage = useStore((s) => s.latestUsage);
  const setLatestUsage = useStore((s) => s.setLatestUsage);
  // Tracks when the user kicked off the most recent send. Cleared once
  // visible (non-thinking) chunks start arriving, the assistant message
  // commits, the stream signals `done`, or an error is surfaced.
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  /**
   * Fix 2 (type-ahead error gate, web).
   *
   * When the most recent stream's `done` frame carries an error, hold
   * the error string locally so the auto-flush of `pendingQueue` is
   * skipped — otherwise a single transient outage fans into a toast
   * spam as each queued message immediately fires another doomed
   * request. Cleared on `sendMessage()` (the user explicitly retried)
   * and via the Retry / Discard buttons on the error banner.
   *
   * Local component state on purpose: the Zustand store is owned by a
   * different agent in this round, so we keep the gate co-located with
   * the WS handler that observes the failure.
   */
  const [lastTurnError, setLastTurnError] = useState<string | null>(null);
  // ERROR-BANNER-SECTION — track the most recent user message text so
  // the recovery banner's "Retry last" can re-fire it. Captured on every
  // `sendMessage()` call. Cleared only when explicitly dismissed.
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);
  // /ERROR-BANNER-SECTION

  // Refs that must stay current inside the WS handler closure.
  const sessionRef = useRef(sessionId);
  useEffect(() => { sessionRef.current = sessionId; }, [sessionId]);

  // Subscribe to feed when session changes.
  useEffect(() => {
    if (sessionId === null) {
      setMessages([]);
      setToolCalls({});
      setStreamingId(null);
      setPendingApproval(null);
      setLatestUsage(null);
      clearPendingQueue();
      return;
    }
    // Read cached messages from store FIRST so the chat surface
    // populates synchronously when the user switches sessions. The WS
    // `subscribed` frame and the REST fallback below will reconcile —
    // server message wins on conflict (handled by `setMessages([...])`
    // overwrite in the `subscribed` case branch).
    const cached = useStore.getState().sessionMessages[sessionId];
    const hasCache = cached !== undefined && cached.length > 0;
    setHydrating(!hasCache);
    setMessages(hasCache ? [...cached] : []);
    setToolCalls({});
    setStreamingId(null);
    setPendingApproval(null);
    setLatestUsage(null);
    setThinkingStartedAt(null);
    // Discard any messages queued under the previous session — queue
    // is per-session and must not leak across switches.
    clearPendingQueue();

    props.wsSend({ type: 'subscribe_session', sessionId });

    // Belt-and-braces: also fetch messages via REST in case the WS
    // `subscribed` frame is delayed or the socket is reconnecting.
    let cancelled = false;
    const fetchMessages = props.fetchMessages;
    if (fetchMessages !== undefined) {
      void fetchMessages(sessionId)
        .then((res) => {
          if (cancelled) return;
          if (sessionRef.current !== sessionId) return;
          // If we rehydrated from cache, only overwrite when REST returns
          // strictly more messages than we already have (server wins, but
          // we don't blow away optimistic local-${reqId} bubbles or an
          // in-flight streaming placeholder).
          setMessages((prev) => {
            if (prev.length === 0) return [...res.messages];
            if (res.messages.length > prev.length) return [...res.messages];
            return prev;
          });
          setHydrating(false);
        })
        .catch(() => {
          // Non-fatal — the WS subscribe will deliver a `subscribed`
          // frame that hydrates the list. The user may briefly see the
          // loading state.
        });
    }

    const unsub = props.subscribeFeed((msg) => handleWSMessage(msg));
    return () => {
      cancelled = true;
      unsub();
      // Intentionally NOT sending `unsubscribe_session` — parallel
      // sessions need to keep streaming in the background so the
      // sidebar status indicator updates while the user views another
      // chat. The subscription is torn down only on session delete or
      // page unload (handled by ws.onClose).
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ---- Inbound WS handling ----

  const handleWSMessage = useCallback((msg: WSServerMessage): void => {
    if ('sessionId' in msg && msg.sessionId !== sessionRef.current) {
      // Frame is for some other session — ignore.
      return;
    }
    switch (msg.type) {
      case 'subscribed': {
        setMessages([...msg.messages]);
        setHydrating(false);
        break;
      }
      case 'chunk': {
        // First visible (non-thinking) chunk → hide the thinking
        // indicator; the streaming bubble itself takes over.
        setThinkingStartedAt(null);
        appendChunk(msg.text, false);
        break;
      }
      case 'thinking_chunk': {
        // Thinking chunks are surfaced as italic, faint text inside
        // the streaming assistant placeholder. We tag with a soft cue.
        // Indicator stays visible — model is still in its think phase.
        appendChunk(msg.text, true);
        break;
      }
      case 'tool_call': {
        upsertToolCall(msg.call, 'running');
        break;
      }
      case 'tool_result': {
        finaliseToolCall(msg.toolCallId, msg.ok, msg.preview, msg.error);
        break;
      }
      case 'approval_request': {
        setPendingApproval({
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          args: msg.args,
          preview: msg.preview,
        });
        // Also flag the tool card as awaiting approval.
        setToolCalls((prev) => {
          const existing = prev[msg.toolCallId];
          if (existing === undefined) {
            const args = isRecord(msg.args) ? msg.args : {};
            return {
              ...prev,
              [msg.toolCallId]: {
                id: msg.toolCallId,
                name: msg.toolName,
                args,
                status: 'awaiting_approval',
                startedAt: Date.now(),
                ...(msg.preview?.kind === 'diff' ? {
                  diff: {
                    path: msg.preview.path,
                    oldContent: msg.preview.oldContent,
                    newContent: msg.preview.newContent,
                  },
                } : {}),
                ...(msg.preview?.kind === 'command' ? {
                  command: { command: msg.preview.command, cwd: msg.preview.cwd },
                } : {}),
              },
            };
          }
          return {
            ...prev,
            [msg.toolCallId]: { ...existing, status: 'awaiting_approval' },
          };
        });
        break;
      }
      case 'message_committed': {
        // Replace the streaming placeholder (assistant) or the optimistic
        // local bubble (user) with the canonical record. Without this the
        // user message is rendered twice: once from the local-${reqId}
        // optimistic insert in sendMessage(), once from this commit frame.
        setMessages((prev) => {
          if (msg.message.role === 'assistant' && streamingIdRef.current !== null) {
            const filtered = prev.filter((m) => m.id !== streamingIdRef.current);
            return [...filtered, msg.message];
          }
          if (msg.message.role === 'user') {
            const committedContent = msg.message.content;
            const filtered = prev.filter((m) => {
              if (!m.id.startsWith('local-')) return true;
              if (m.role !== 'user') return true;
              return m.content !== committedContent;
            });
            if (filtered.some((m) => m.id === msg.message.id)) return filtered;
            return [...filtered, msg.message];
          }
          if (prev.some((m) => m.id === msg.message.id)) return prev;
          return [...prev, msg.message];
        });
        if (msg.message.role === 'assistant') {
          // Only clear streaming state if this is the FINAL assistant
          // reply (no tool_calls). When the assistant emits tool_calls,
          // the runtime continues with tool execution + another stream
          // iteration — the turn isn't done yet. Clearing here would
          // unlock the Composer and let the user send a message that
          // wedges between assistant.tool_calls and the tool reply,
          // poisoning the conversation history (DeepSeek then rejects
          // every subsequent request with "insufficient tool messages
          // following tool_calls message").
          const hasToolCalls = Array.isArray(msg.message.toolCalls)
            && msg.message.toolCalls.length > 0;
          if (!hasToolCalls) {
            setStreamingId(null);
            setThinkingStartedAt(null);
          }
        }
        break;
      }
      case 'usage': {
        setLatestUsage({
          tokensIn: msg.tokens.in,
          tokensOut: msg.tokens.out,
          ...(msg.tokens.cached !== undefined ? { cachedTokens: msg.tokens.cached } : {}),
          ...(msg.tokens.fresh !== undefined ? { freshTokens: msg.tokens.fresh } : {}),
          ...(msg.tokens.cacheCreation !== undefined
            ? { cacheCreationTokens: msg.tokens.cacheCreation }
            : {}),
        });
        break;
      }
      case 'done': {
        setStreamingId(null);
        setSending(false);
        setThinkingStartedAt(null);
        if (msg.error !== undefined) {
          pushToast({ level: 'error', message: msg.error });
          // Fix 2 (type-ahead error gate): pause auto-flush so a
          // single transient upstream failure doesn't fan into toast
          // spam. The Retry button (banner below) clears this; a
          // fresh `sendMessage()` also clears it as a side effect.
          setLastTurnError(msg.error);
          break;
        }
        // Successful turn — drop any prior pause.
        setLastTurnError(null);
        // QUEUE-AUTODRAIN-SECTION — start
        // Flush any user messages typed while streaming. Read directly
        // from the store so we always see the latest queue (the closure
        // around handleWSMessage is stable). Idempotent: a duplicate
        // `done` finds an empty queue and is a no-op.
        //
        // `drainPendingQueue()` pops the entire queue atomically and
        // returns the prior contents — order preserved (FIFO), per
        // user request "auto-sent the moment the current turn finishes".
        const drained = useStore.getState().drainPendingQueue();
        if (drained.length > 0) {
          const combined = drained.map((it) => it.content).join('\n\n');
          // Defer to next tick so the `streaming` guard in the
          // Composer/sendMessage path observes the cleared state.
          queueMicrotask(() => {
            const send = sendMessageRef.current;
            if (send !== null) void send(combined);
          });
        }
        // QUEUE-AUTODRAIN-SECTION — end
        break;
      }
      case 'error': {
        pushToast({
          level: 'error',
          message: msg.message,
        });
        setSending(false);
        setStreamingId(null);
        setThinkingStartedAt(null);
        break;
      }
      case 'provider_changed':
      case 'hello_ok':
      case 'pong':
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write-through cache: every time the local `messages` array changes,
  // mirror it into the store under the active session id. Switching to a
  // different session and back rehydrates synchronously from this slice.
  useEffect(() => {
    if (sessionId === null) return;
    setSessionMessages(sessionId, messages);
  }, [sessionId, messages, setSessionMessages]);

  // Mirror streamingId into a ref so the closure inside `message_committed`
  // sees the latest value without re-running the handler.
  const streamingIdRef = useRef<string | null>(null);
  useEffect(() => { streamingIdRef.current = streamingId; }, [streamingId]);

  // Mirror sendMessage into a ref so the stable WS handler can call it
  // when flushing the queued messages on `done`.
  const sendMessageRef = useRef<((text: string) => Promise<void>) | null>(null);

  const appendChunk = useCallback((text: string, thinking: boolean): void => {
    setMessages((prev) => {
      const id = streamingIdRef.current;
      if (id === null) {
        // Begin a new streaming assistant placeholder.
        const newId = `streaming-${Date.now()}`;
        streamingIdRef.current = newId;
        setStreamingId(newId);
        const placeholder: WireChatMessage = {
          id: newId,
          role: 'assistant',
          content: thinking ? `_${text}_` : text,
          createdAt: Date.now(),
        };
        return [...prev, placeholder];
      }
      return prev.map((m) =>
        m.id === id
          ? { ...m, content: m.content + (thinking ? `_${text}_` : text) }
          : m,
      );
    });
  }, []);

  const upsertToolCall = useCallback(
    (call: ToolCallWire, status: ToolStatus): void => {
      setToolCalls((prev) => {
        const existing = prev[call.id];
        if (existing !== undefined) {
          return { ...prev, [call.id]: { ...existing, status } };
        }
        return {
          ...prev,
          [call.id]: {
            id: call.id,
            name: call.name,
            args: call.arguments,
            status,
            startedAt: Date.now(),
          },
        };
      });
      // Also push a tool-row marker into the message list so ordering is preserved.
      setMessages((prev) => {
        if (prev.some((m) => m.id === `tool-${call.id}`)) return prev;
        return [
          ...prev,
          {
            id: `tool-${call.id}`,
            role: 'tool',
            content: '',
            toolCallId: call.id,
            toolName: call.name,
            createdAt: Date.now(),
          },
        ];
      });
    },
    [],
  );

  const finaliseToolCall = useCallback(
    (toolCallId: string, ok: boolean, preview: string | undefined, error: string | undefined): void => {
      setToolCalls((prev) => {
        const existing = prev[toolCallId];
        if (existing === undefined) return prev;
        return {
          ...prev,
          [toolCallId]: {
            ...existing,
            status: ok ? 'ok' : 'error',
            ...(preview !== undefined ? { preview } : {}),
            ...(error !== undefined ? { error } : {}),
            finishedAt: Date.now(),
          },
        };
      });
    },
    [],
  );

  // ---- Outbound actions ----

  const sendMessage = useCallback(
    async (text: string) => {
      if (sessionId === null) return;
      // Fix 2: any explicit send clears the error pause — the user has
      // chosen to retry, so the queue is allowed to drain after the
      // next `done`.
      setLastTurnError(null);
      // ERROR-BANNER-SECTION — remember what we just sent so the
      // recovery banner's "Retry last" can resend it verbatim.
      setLastUserMessage(text);
      // /ERROR-BANNER-SECTION
      setSending(true);
      setThinkingStartedAt(Date.now());
      const clientReqId = makeClientReqId();
      // Optimistic user bubble.
      const optimistic: WireChatMessage = {
        id: `local-${clientReqId}`,
        role: 'user',
        content: text,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, optimistic]);
      props.wsSend({
        type: 'send_message',
        sessionId,
        text,
        clientReqId,
      });
    },
    [sessionId, props],
  );

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const onQueueMessage = useCallback(
    (text: string): void => {
      enqueueMessage(text);
      pushToast({ level: 'info', message: t('chat.queuedForNext') });
    },
    [enqueueMessage, pushToast, t],
  );

  // ESC-CANCEL-SECTION — start
  // Wired to Composer.onCancel + the Cancel button. The Composer's Esc
  // handler invokes this while streaming; the server replies with a
  // `done` frame which flips `streamingId` back to null and lets the
  // user submit a new turn immediately. The runtime stays healthy
  // (see X5 disconnect-recovery), so no extra reset is required here.
  const cancelStream = useCallback(() => {
    if (sessionId === null) return;
    props.wsSend({ type: 'cancel_stream', sessionId });
  }, [sessionId, props]);
  // ESC-CANCEL-SECTION — end

  // AGENT-REPLY-SECTION
  // Composer reply-mode binding. When `agentReplyTarget` is set in the
  // store, we hand the Composer a small callback bundle so its Enter
  // routes through `relay_to_agent` instead of `send_message`. The
  // server posts the text on the orchestrator's TeamBus → the worker
  // runner picks it up at the next turn boundary.
  const agentReplyTarget = useStore((s) => s.agentReplyTarget);
  const exitAgentReply = useStore((s) => s.exitAgentReply);
  const agentReplyComposerProps = useMemo<
    | {
        target: { agentId: string; label: string; parentSessionId: string };
        onAgentReply: (text: string) => void;
        onExitReply: () => void;
      }
    | null
  >(() => {
    if (agentReplyTarget === null) return null;
    return {
      target: {
        agentId: agentReplyTarget.agentId,
        label: agentReplyTarget.label,
        parentSessionId: agentReplyTarget.parentSessionId,
      },
      onAgentReply: (text: string) => {
        props.wsSend({
          type: 'relay_to_agent',
          sessionId: agentReplyTarget.parentSessionId,
          agentId: agentReplyTarget.agentId,
          text,
        });
        pushToast({
          level: 'success',
          message: t('chat.queuedForNext'),
        });
      },
      onExitReply: exitAgentReply,
    };
  }, [agentReplyTarget, exitAgentReply, props, pushToast, t]);
  // /AGENT-REPLY-SECTION

  const onApprove = useCallback(
    async (toolCallId: string) => {
      props.wsSend({ type: 'approval_response', toolCallId, approved: true });
      setPendingApproval(null);
      setToolCalls((prev) => {
        const existing = prev[toolCallId];
        return existing === undefined
          ? prev
          : { ...prev, [toolCallId]: { ...existing, status: 'running' } };
      });
    },
    [props],
  );

  const onReject = useCallback(
    async (toolCallId: string) => {
      props.wsSend({ type: 'approval_response', toolCallId, approved: false });
      setPendingApproval(null);
      setToolCalls((prev) => {
        const existing = prev[toolCallId];
        return existing === undefined
          ? prev
          : {
              ...prev,
              [toolCallId]: {
                ...existing,
                status: 'error',
                error: 'Rejected by user',
              },
            };
      });
    },
    [props],
  );

  const onSwitchModel = useCallback(
    async (model: string) => {
      if (sessionId === null) return;
      props.wsSend({ type: 'set_model', sessionId, model });
    },
    [sessionId, props],
  );

  // ---- Auto-scroll ----

  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, toolCalls]);

  // ---- Render ----

  const allRows = useMemo<Row[]>(
    () => buildRows(messages, streamingId, activeSession?.model ?? null),
    [messages, streamingId, activeSession?.model],
  );

  // ---- Homemade virtualization (windowed tail) ----
  //
  // For sessions with > VIRTUALIZE_THRESHOLD messages we only mount the
  // tail (last `visibleCount` rows). "Load more" grows the window
  // upward in VIRTUALIZE_PAGE-sized batches and the older rows are
  // replaced by a single spacer <div> whose height stands in for the
  // unmounted block so scroll position stays honest.
  //
  // Equally important — and the reason this implementation exists at
  // all — we also UNMOUNT downward: once the user has scrolled back
  // near the bottom (so the freshly mounted older rows are no longer
  // in the viewport), the window shrinks back to VIRTUALIZE_PAGE.
  // Without that shrink the DOM grows monotonically every time the
  // user clicks "Load more", which is exactly the bug the old
  // pagination-only implementation suffered from (a 500-message
  // session that has been load-more'd to the top ends up with 5000+
  // DOM nodes hanging around even after the user returns to the
  // tail).
  //
  // The window resets to VIRTUALIZE_PAGE on session switch — the new
  // session's tail might be tiny, no point keeping the previous count
  // around.
  const [visibleCount, setVisibleCount] = useState<number>(VIRTUALIZE_PAGE);
  useEffect(() => {
    setVisibleCount(VIRTUALIZE_PAGE);
  }, [sessionId]);

  // When the row count grows (streaming, new user message, …), bump
  // `visibleCount` so the newly appended rows always land inside the
  // active window. Clamped so we never exceed `allRows.length`.
  useEffect(() => {
    setVisibleCount((c) => (allRows.length > c ? Math.min(allRows.length, c + 1) : c));
  }, [allRows.length]);

  const virtualize = allRows.length > VIRTUALIZE_THRESHOLD;
  const hiddenCount = virtualize ? Math.max(0, allRows.length - visibleCount) : 0;
  const visibleRows = virtualize ? allRows.slice(allRows.length - visibleCount) : allRows;
  // Height of the spacer that replaces the unmounted earlier rows.
  // Conservative estimate — enough for the scrollbar to feel
  // proportional without each row having to be measured. `0` when no
  // rows are hidden so the spacer collapses out of the layout.
  const topSpacerHeight = hiddenCount * VIRTUALIZE_ROW_ESTIMATE_PX;

  // "Load more" grows the window upward. We anchor the scroll position
  // around the current bottom-distance so the viewport doesn't jump:
  // capture `scrollHeight - scrollTop` before the commit, then restore
  // the same distance after layout — newly mounted rows scroll into
  // view above the current row, not by yanking the existing rows
  // down.
  const pendingScrollAnchorRef = useRef<number | null>(null);
  // When `true`, the next visibleCount change is a shrink (downward
  // unmount): we deliberately want to stay glued to the bottom so the
  // anchor effect is skipped — `stickToBottomRef` already does the
  // right thing in the layout effect that reacts to messages.
  const pendingShrinkRef = useRef<boolean>(false);
  const loadMore = useCallback(() => {
    const el = scrollerRef.current;
    pendingScrollAnchorRef.current = el !== null ? el.scrollHeight - el.scrollTop : null;
    // Pause the auto-stick — we are explicitly staying put.
    stickToBottomRef.current = false;
    setVisibleCount((c) => Math.min(allRows.length, c + VIRTUALIZE_PAGE));
  }, [allRows.length]);

  useLayoutEffect(() => {
    // Downward unmount: skip the anchor restore. The
    // `messages`/`toolCalls` layout effect already snaps to bottom via
    // `stickToBottomRef`, so we just consume the pending shrink flag.
    if (pendingShrinkRef.current) {
      pendingShrinkRef.current = false;
      pendingScrollAnchorRef.current = null;
      return;
    }
    const anchor = pendingScrollAnchorRef.current;
    if (anchor === null) return;
    const el = scrollerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight - anchor;
    pendingScrollAnchorRef.current = null;
  }, [visibleCount]);

  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    stickToBottomRef.current = nearBottom;
    // Auto-grow the window when the user scrolls to the very top and
    // there is more history to reveal. The "Load more" button is the
    // primary affordance, but supporting scroll-up keeps the chat
    // feeling continuous.
    if (el.scrollTop < 4 && hiddenCount > 0 && pendingScrollAnchorRef.current === null) {
      loadMore();
      return;
    }
    // Downward unmount: when the user has scrolled back near the
    // bottom and the window has been grown past the base page, shrink
    // it. This is the half of the windowed virtualization that
    // actually unmounts DOM — without it, every "Load more" click
    // ratchets the DOM size up forever.
    if (
      virtualize
      && distanceFromBottom < VIRTUALIZE_SHRINK_NEAR_BOTTOM_PX
      && visibleCount > VIRTUALIZE_PAGE
      && pendingScrollAnchorRef.current === null
    ) {
      pendingShrinkRef.current = true;
      stickToBottomRef.current = true;
      setVisibleCount(VIRTUALIZE_PAGE);
    }
  };

  return (
    <div
      className={styles.root}
      /* RESPONSIVE-SECTION — exposes the active breakpoint for CSS. */
      data-viewport={chatViewport.breakpoint}
    >
      <div
        className={styles.scroller}
        ref={scrollerRef}
        onScroll={onScroll}
        aria-live="polite"
        aria-busy={hydrating}
      >
        {hydrating ? (
          <div className={styles.hydrating}>{t('chat.loading')}</div>
        ) : allRows.length === 0 ? (
          <div className={styles.empty}>
            <EmptyState
              icon={MessageSquare}
              title={
                sessionId === null
                  ? t('chat.empty.noSession')
                  : t('chat.empty.firstMessage')
              }
              description={
                sessionId === null
                  ? t('chat.empty.noSession.desc')
                  : t('chat.empty.firstMessage.desc')
              }
            />
          </div>
        ) : (
          <>
            {hiddenCount > 0 ? (
              <button
                type="button"
                className={styles.loadMore}
                onClick={loadMore}
                aria-label={t('chat.loadMore.aria', { count: hiddenCount })}
              >
                {t('chat.loadMore', { count: hiddenCount })}
              </button>
            ) : null}
            {topSpacerHeight > 0 ? (
              <div
                className={styles.spacer}
                style={{ height: topSpacerHeight }}
                aria-hidden="true"
              />
            ) : null}
            {visibleRows.map((row) => renderRow(row, toolCalls))}
            {thinkingStartedAt !== null ? (
              <ThinkingIndicator startedAt={thinkingStartedAt} />
            ) : null}
          </>
        )}
      </div>

      {/* Fix 2 (type-ahead error gate): banner sits above the queue
          indicator. Retry clears the error and lets the next `done`
          drain the queue; Discard clears both the queue and the
          error. Slash commands and bash inputs always bypass the
          queue, so /model and /provider keep working from here.
          Styling lives in QueueErrorBanner.module.css so the banner
          honors the light theme via design tokens. */}
      {lastTurnError !== null && pendingQueue.length > 0 ? (
        <QueueErrorBanner
          onRetry={(): void => {
            setLastTurnError(null);
            // Re-fire the flush logic by reading the current queue
            // and clearing it; the Composer's send guard observes
            // the cleared error state on next render.
            const drained = useStore.getState().drainPendingQueue();
            if (drained.length > 0) {
              const combined = drained.map((it) => it.content).join('\n\n');
              queueMicrotask(() => {
                const send = sendMessageRef.current;
                if (send !== null) void send(combined);
              });
            }
          }}
          onDiscard={(): void => {
            clearPendingQueue();
            setLastTurnError(null);
          }}
        />
      ) : null}

      {/* ERROR-BANNER-SECTION
          Single source of truth for stream errors when the queue is
          empty. Adapter throws, watchdog force-resets, and tool
          dispatch failures all surface here via the same `lastTurnError`
          state. Retry resends the most recent user message verbatim
          (captured on sendMessage); Dismiss clears the banner without
          resending. When `pendingQueue.length > 0` the QueueErrorBanner
          above handles it instead so the two banners never overlap.
          /ERROR-BANNER-SECTION */}
      {lastTurnError !== null && pendingQueue.length === 0 ? (
        <ErrorBanner
          message={lastTurnError}
          onRetry={
            lastUserMessage !== null
              ? (): void => {
                  setLastTurnError(null);
                  const text = lastUserMessage;
                  queueMicrotask(() => {
                    const send = sendMessageRef.current;
                    if (send !== null) void send(text);
                  });
                }
              : null
          }
          onDismiss={(): void => {
            setLastTurnError(null);
          }}
        />
      ) : null}

      <QueueIndicator count={pendingQueue.length} />

      <Composer
        streaming={streamingId !== null}
        sending={sending}
        disabled={sessionId === null}
        onSend={sendMessage}
        onQueue={onQueueMessage}
        onCancel={cancelStream}
        onSwitchProvider={props.setProvider}
        onSwitchModel={onSwitchModel}
        backendLabel={props.backendLabel ?? null}
        // AGENT-REPLY-SECTION — when a reply target is set, the Composer
        // routes typed text via `relay_to_agent` instead of `send_message`.
        agentReply={agentReplyComposerProps}
        // /AGENT-REPLY-SECTION
      />

      {/* Token-usage caption strip — sits at the very bottom of the chat
          surface, below the Composer. Hides itself when there is no
          usage signal yet. */}
      {latestUsage !== null ? <UsageFooter {...latestUsage} /> : null}

      {pendingApproval !== null ? (
        <ApprovalDialog
          toolCallId={pendingApproval.toolCallId}
          toolName={pendingApproval.toolName}
          args={pendingApproval.args}
          preview={pendingApproval.preview}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : null}

      {fileBrowserOpen &&
       props.fetchFileTree !== undefined &&
       props.fetchFile !== undefined &&
       activeProject !== null ? (
        <FileBrowser
          rootPath={activeProject.root}
          projectId={activeProject.id}
          fetchTree={props.fetchFileTree}
          fetchFile={props.fetchFile}
          onClose={toggleFileBrowser}
        />
      ) : null}
    </div>
  );
}

// ---------- Helpers ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function makeClientReqId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function buildRows(
  messages: readonly WireChatMessage[],
  streamingId: string | null,
  fallbackModel: string | null,
): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      rows.push({ kind: 'user', id: m.id, content: m.content, createdAt: m.createdAt });
      continue;
    }
    if (m.role === 'assistant') {
      // MESSAGE-COST-CHIP-SECTION — prefer the per-row model the server
      // captured at streamChat time over the session-wide active model
      // (matches the persisted shape, so switching models mid-session
      // never retroactively relabels old rows).
      const rowModel = m.model ?? fallbackModel;
      rows.push({
        kind: 'assistant',
        id: m.id,
        content: m.content,
        model: rowModel,
        streaming: streamingId === m.id,
        ...(m.cost !== undefined ? { cost: m.cost } : {}),
        ...(m.tokensInput !== undefined ? { tokensInput: m.tokensInput } : {}),
        ...(m.tokensOutput !== undefined
          ? { tokensOutput: m.tokensOutput }
          : {}),
        ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
      });
      // MESSAGE-COST-CHIP-SECTION-END
      continue;
    }
    if (m.role === 'tool' && m.toolCallId !== undefined) {
      rows.push({ kind: 'tool', toolCallId: m.toolCallId });
      continue;
    }
    // 'system' role: not rendered.
  }
  return rows;
}

function renderRow(row: Row, toolCalls: Record<string, ToolCallState>): JSX.Element {
  switch (row.kind) {
    case 'user':
      return <UserBubble key={row.id} content={row.content} createdAt={row.createdAt} />;
    case 'assistant':
      return (
        <AssistantMessage
          key={row.id}
          content={row.content}
          model={row.model ?? null}
          streaming={row.streaming}
          // MESSAGE-COST-CHIP-SECTION — forward per-turn telemetry so
          // the cost chip renders below the body when defined.
          {...(row.cost !== undefined ? { cost: row.cost } : {})}
          {...(row.tokensInput !== undefined
            ? { tokensInput: row.tokensInput }
            : {})}
          {...(row.tokensOutput !== undefined
            ? { tokensOutput: row.tokensOutput }
            : {})}
          {...(row.durationMs !== undefined
            ? { durationMs: row.durationMs }
            : {})}
          // MESSAGE-COST-CHIP-SECTION-END
        />
      );
    case 'tool': {
      const tc = toolCalls[row.toolCallId];
      if (tc === undefined) return <span key={row.toolCallId} />;
      return (
        <ToolCallCard
          key={row.toolCallId}
          name={tc.name}
          args={tc.args}
          status={tc.status}
          durationMs={tc.finishedAt !== undefined ? tc.finishedAt - tc.startedAt : undefined}
          {...(tc.preview !== undefined ? { preview: tc.preview } : {})}
          {...(tc.error !== undefined ? { error: tc.error } : {})}
          {...(tc.diff !== undefined ? { diff: tc.diff } : {})}
          {...(tc.command !== undefined ? { command: tc.command } : {})}
        />
      );
    }
  }
}
