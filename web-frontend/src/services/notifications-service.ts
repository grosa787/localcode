/**
 * notifications-service — listens to inbound WS frames and converts
 * relevant events into entries in the notifications slice of the
 * zustand store. Optionally fires a browser-level `Notification` for
 * off-tab visibility when the user has explicitly opted in.
 *
 * Wired in App.tsx via `createNotificationsService(subscribeFeed)`. The
 * service has no React surface — it returns a `dispose()` cleanup that
 * App.tsx calls on unmount.
 *
 * Browser-notification permission is NOT requested at boot. It must be
 * triggered by an explicit user gesture (the toggle in
 * NotificationCenter) — see `requestBrowserNotificationPermission`.
 */

import type { WSServerMessage } from '../../../src/web/protocol/messages.js';
import type {
  AppState,
  Notification as NotificationEntry,
  NotificationType,
} from '../state/store';

/**
 * Threshold above which a `done` frame produces a `stream_completed`
 * notification. The product spec calls out 30s — anything shorter is
 * normal-feel and would just be noise.
 */
export const STREAM_COMPLETED_THRESHOLD_MS = 30_000;

/**
 * Narrow store surface the service depends on. Keeping it minimal lets
 * tests inject a fake without instantiating zustand.
 */
export interface NotificationsStoreSlice {
  pushNotification: AppState['pushNotification'];
  /** Read-only access — used to gate browser-fire on the opt-in flag. */
  getBrowserNotificationsEnabled: () => boolean;
  /** Read-only access — used to skip on-tab `approval_required` toasts. */
  getActiveSessionId: () => string | null;
}

/**
 * Map a notification type to its UI-default icon literal. Kept on the
 * service side so callers passing a raw `Notification` don't need to
 * compute it twice.
 */
const TYPE_LABEL: Record<NotificationType, string> = {
  agent_completed: 'Agent completed',
  agent_errored: 'Agent failed',
  wakeup_fired: 'Wakeup fired',
  approval_required: 'Approval required',
  stream_completed: 'Response finished',
  circuit_open: 'Backend unavailable',
  hook_blocked: 'Hook blocked a tool',
};

export function labelForType(t: NotificationType): string {
  return TYPE_LABEL[t];
}

/** Stream-duration tracking — keyed by sessionId. */
interface StreamStartRecord {
  startedAt: number;
}

/**
 * Pure mapping function from a WS frame → optional notification (or
 * notifications — `done` may emit zero or one). Exported for unit
 * tests; the runtime wrapper handles side effects (push to store, fire
 * browser Notification, track stream durations).
 */
export interface MapContext {
  /** Active session id at the moment the frame arrives — used to skip
   * approval-required notifications for the session the user is
   * actively looking at. Pass `null` to always notify. */
  activeSessionId: string | null;
  /** Stream-start times tracked across frames. The mapper reads + mutates this map. */
  streamStarts: Map<string, StreamStartRecord>;
  /** Optional clock override for tests. */
  now?: () => number;
}

export interface MappedNotification {
  type: NotificationType;
  title: string;
  body?: string;
  sessionId?: string;
}

export function mapFrameToNotification(
  msg: WSServerMessage,
  ctx: MapContext,
): MappedNotification | null {
  const now = ctx.now ?? (() => Date.now());
  switch (msg.type) {
    case 'agent_completed': {
      const out: MappedNotification = {
        type: 'agent_completed',
        title: 'Sub-agent completed',
        sessionId: msg.sessionId,
      };
      if (msg.summary !== undefined && msg.summary.length > 0) {
        out.body = msg.summary;
      }
      return out;
    }
    case 'agent_status': {
      // Only surface the failure terminal state. Running/done flows
      // are already visible in the AgentTeamPanel.
      if (msg.status !== 'failed') return null;
      const out: MappedNotification = {
        type: 'agent_errored',
        title: 'Sub-agent failed',
        sessionId: msg.sessionId,
      };
      if (msg.error !== undefined && msg.error.length > 0) {
        out.body = msg.error;
      } else if (msg.lastMessage !== undefined && msg.lastMessage.length > 0) {
        out.body = msg.lastMessage;
      }
      return out;
    }
    case 'wakeups_updated': {
      // `wakeups_updated` is delta-style — it carries the full snapshot
      // each time. We only emit a notification when the snapshot is
      // empty (i.e. the previously-pending wakeup just fired); the
      // backend re-broadcasts when a wakeup is scheduled too, but those
      // don't need a bell entry.
      //
      // NOTE: this heuristic is intentionally simple — if the user
      // schedules + cancels in quick succession we might miss the
      // wakeup_fired signal. The wake-up payload itself is the truth
      // source; the bell entry is a convenience.
      if (msg.wakeups.length > 0) return null;
      return {
        type: 'wakeup_fired',
        title: 'Wakeup fired',
        sessionId: msg.sessionId,
      };
    }
    case 'approval_request': {
      // Skip the notification if the user is already looking at this
      // session — the ApprovalDialog is already mounted.
      if (msg.sessionId === ctx.activeSessionId) return null;
      const out: MappedNotification = {
        type: 'approval_required',
        title: 'Approval required',
        body: msg.toolName,
        sessionId: msg.sessionId,
      };
      return out;
    }
    case 'chunk':
    case 'thinking_chunk':
    case 'tool_call': {
      // First chunk in a stream — record the start time.
      if (!ctx.streamStarts.has(msg.sessionId)) {
        ctx.streamStarts.set(msg.sessionId, { startedAt: now() });
      }
      return null;
    }
    case 'done': {
      const rec = ctx.streamStarts.get(msg.sessionId);
      ctx.streamStarts.delete(msg.sessionId);
      if (rec === undefined) return null;
      const durationMs = now() - rec.startedAt;
      if (durationMs < STREAM_COMPLETED_THRESHOLD_MS) return null;
      const out: MappedNotification = {
        type: 'stream_completed',
        title: 'Response finished',
        body: `Took ${Math.round(durationMs / 1000)}s`,
        sessionId: msg.sessionId,
      };
      return out;
    }
    case 'error': {
      // Treat error frames as stream completions for tracking purposes
      // but do not produce a stream_completed entry — errors are
      // already surfaced as toasts upstream.
      if (msg.sessionId !== undefined) {
        ctx.streamStarts.delete(msg.sessionId);
      }
      return null;
    }
    case 'backend_circuit_state': {
      if (msg.state !== 'open') return null;
      const out: MappedNotification = {
        type: 'circuit_open',
        title: 'Backend unavailable',
        body: msg.reason ?? `${msg.backend} circuit tripped`,
      };
      return out;
    }
    case 'tool_result': {
      // Tool failures with the synthetic "blocked by hook" stderr land
      // here. The protocol does not (yet) carry a structured "blocked"
      // flag, so we sniff the preview/error string. Be conservative —
      // false positives are noisier than missed entries.
      if (msg.ok === false) {
        const err = msg.error ?? '';
        if (
          err.toLowerCase().includes('hook blocked') ||
          err.toLowerCase().includes('blocked by hook')
        ) {
          const out: MappedNotification = {
            type: 'hook_blocked',
            title: 'Hook blocked a tool call',
            body: err,
            sessionId: msg.sessionId,
          };
          return out;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Fire a browser-level `Notification`. Bails silently when the browser
 * API is unavailable (jsdom, older browsers) or the permission has not
 * been granted. The store flag is the user opt-in — the permission is
 * the OS-level gate.
 */
function fireBrowser(entry: NotificationEntry): void {
  if (typeof window === 'undefined') return;
  const Ctor = (window as unknown as { Notification?: typeof Notification })
    .Notification;
  if (Ctor === undefined) return;
  // The static `permission` property is the canonical gate per MDN.
  // Tests can stub by overriding Notification.permission.
  const perm = (Ctor as unknown as { permission?: NotificationPermission })
    .permission;
  if (perm !== 'granted') return;
  try {
    const opts: NotificationOptions = {};
    if (entry.body !== undefined) opts.body = entry.body;
    // Tag deduplicates same-type notifications in the OS tray.
    (opts as NotificationOptions & { tag?: string }).tag =
      `localcode:${entry.type}`;
    new Ctor(entry.title, opts);
  } catch {
    /* swallow — browsers throw on cross-origin / SecurityError */
  }
}

/**
 * Request browser-level permission. MUST be called from a user-gesture
 * handler (click). Returns the resulting permission state, or `null`
 * when the API is unavailable.
 */
export async function requestBrowserNotificationPermission():
  Promise<NotificationPermission | null> {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as unknown as { Notification?: typeof Notification })
    .Notification;
  if (Ctor === undefined) return null;
  try {
    const req = (Ctor as unknown as {
      requestPermission?: () => Promise<NotificationPermission>;
    }).requestPermission;
    if (typeof req !== 'function') return null;
    return await req.call(Ctor);
  } catch {
    return null;
  }
}

export interface NotificationsService {
  /** Manually inject a frame (testing convenience). */
  handle(msg: WSServerMessage): void;
  /** Tear down: unsubscribe from the feed. */
  dispose(): void;
}

export interface CreateOptions {
  subscribeFeed: (handler: (msg: WSServerMessage) => void) => () => void;
  store: NotificationsStoreSlice;
  /**
   * Hook used by tests to assert browser-fire behaviour without
   * instantiating an actual `Notification`. Defaults to the real
   * implementation.
   */
  fire?: (entry: NotificationEntry) => void;
  now?: () => number;
}

/**
 * Construct the service. Subscribes to the WS feed on creation; the
 * caller MUST invoke `dispose()` to unsubscribe.
 */
export function createNotificationsService(
  opts: CreateOptions,
): NotificationsService {
  const fire = opts.fire ?? fireBrowser;
  const ctx: MapContext = {
    activeSessionId: opts.store.getActiveSessionId(),
    streamStarts: new Map<string, StreamStartRecord>(),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
  const handle = (msg: WSServerMessage): void => {
    // Refresh active session every frame — cheap and avoids subscribing
    // the service to store changes directly.
    ctx.activeSessionId = opts.store.getActiveSessionId();
    const mapped = mapFrameToNotification(msg, ctx);
    if (mapped === null) return;
    const payload: Parameters<AppState['pushNotification']>[0] = {
      type: mapped.type,
      title: mapped.title,
    };
    if (mapped.body !== undefined) payload.body = mapped.body;
    if (mapped.sessionId !== undefined) payload.sessionId = mapped.sessionId;
    opts.store.pushNotification(payload);

    if (opts.store.getBrowserNotificationsEnabled()) {
      // Reconstruct a "looks like a stored entry" object for the fire
      // callback. The id/timestamp are placeholders — the OS tray only
      // cares about title/body/tag.
      const entry: NotificationEntry = {
        id: 'transient',
        type: mapped.type,
        title: mapped.title,
        timestamp: ctx.now !== undefined ? ctx.now() : Date.now(),
        read: false,
        ...(mapped.body !== undefined ? { body: mapped.body } : {}),
        ...(mapped.sessionId !== undefined
          ? { sessionId: mapped.sessionId }
          : {}),
      };
      fire(entry);
    }
  };
  const unsubscribe = opts.subscribeFeed(handle);
  return {
    handle,
    dispose: unsubscribe,
  };
}
