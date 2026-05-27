/**
 * Zustand store — global UI state for the LocalCode SPA.
 *
 * Mirrors Agent E's wire types (`SessionSummaryWire`, `WorkspaceRecord`,
 * `Backend`). Per-message state lives in component memory; the store
 * holds list/connection/UI shells.
 */

import { create } from 'zustand';

import type { Backend, WireChatMessage } from '../../../src/web/protocol/messages.js';
import type {
  AgentsConfigSnapshot,
  PerProviderConfig,
  PermissionProfile,
  PluginSummary,
  SessionSummaryWire,
  SkillSummary,
  WorkspaceRecord,
} from '../../../src/web/protocol/rest-types.js';

export type { PermissionProfile } from '../../../src/web/protocol/rest-types.js';

export type OutputStyle = 'concise' | 'explanatory' | 'verbose';

// QUEUE-NEXT-STORE-SECTION — start
/**
 * A single user message waiting to be sent after the current turn
 * finishes streaming. Items are appended via `enqueueMessage`, removed
 * individually via `dequeueMessage(id)`, and flushed in bulk via
 * `drainPendingQueue()` (returns + clears the queue).
 */
export interface PendingQueueItem {
  readonly id: string;
  readonly content: string;
  readonly createdAt: number;
}
// QUEUE-NEXT-STORE-SECTION — end

export type { AgentsConfigSnapshot } from '../../../src/web/protocol/rest-types.js';

// PRESENCE-SECTION
/**
 * Per-peer state mirrored from server `presence` frames. Keyed by
 * `userId` (stable per-tab from localStorage). `lastSeenMs` is the
 * server-stamped timestamp; the UI ages out peers after
 * {@link PRESENCE_VISIBLE_WINDOW_MS} so a disconnected tab disappears
 * even if the server's reaper hasn't fired yet.
 */
export interface PeerInfo {
  userId: string;
  displayName: string;
  typing: boolean;
  lastSeenMs: number;
}

/** Window after which a peer with no fresh heartbeat is dropped from the UI. */
export const PRESENCE_VISIBLE_WINDOW_MS = 30_000;

/** localStorage key for this tab's stable userId. */
export const PRESENCE_USER_ID_KEY = 'localcode.web.presence.userId';
/** localStorage key for the user-chosen displayName. */
export const PRESENCE_DISPLAY_NAME_KEY = 'localcode.web.presence.displayName';

/**
 * Generate (or read) a stable per-tab userId. Persisted in localStorage so
 * the same identity survives full reloads — exactly the multi-user
 * collaboration semantics the spec calls for.
 */
export function getOrCreatePresenceUserId(): string {
  if (typeof window === 'undefined') {
    return `user-${Math.random().toString(36).slice(2, 6)}`;
  }
  try {
    const existing = window.localStorage.getItem(PRESENCE_USER_ID_KEY);
    if (existing !== null && existing.length > 0) return existing;
  } catch {
    /* ignored */
  }
  let fresh: string;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    fresh = crypto.randomUUID();
  } else {
    fresh = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  try {
    window.localStorage.setItem(PRESENCE_USER_ID_KEY, fresh);
  } catch {
    /* ignored */
  }
  return fresh;
}

/**
 * Generate (or read) the displayName for this tab. Defaults to
 * `user-XXXX` where XXXX is the first 4 chars of the userId, so two
 * tabs that share a userId render the same label without coordination.
 */
export function getOrCreatePresenceDisplayName(userId: string): string {
  if (typeof window === 'undefined') {
    return `user-${userId.slice(0, 4)}`;
  }
  try {
    const existing = window.localStorage.getItem(PRESENCE_DISPLAY_NAME_KEY);
    if (existing !== null && existing.length > 0) return existing;
  } catch {
    /* ignored */
  }
  return `user-${userId.slice(0, 4)}`;
}
// PRESENCE-SECTION-END

export type { PerProviderConfig, PluginSummary, SkillSummary } from '../../../src/web/protocol/rest-types.js';

export interface ConnectionState {
  status: 'connecting' | 'open' | 'closed' | 'reconnecting';
  lastError: string | null;
}

/**
 * Auth-failure state. Surfaced when the server rejects our CSRF token —
 * either via REST 401/403 on bootstrap or via the WS upgrade close
 * (`csrf_invalid`). The most common cause is a fresh `localcode --web`
 * boot that rotated the per-server token while the browser tab kept
 * the stale value in `sessionStorage`.
 */
export interface AuthErrorState {
  /** Tag used for future error variants. Today only `stale_token`. */
  kind: 'stale_token';
  message: string;
}

/**
 * Lightweight summary of a slash command suitable for autocomplete /
 * browser. Defined locally — the REST shape may evolve in
 * `rest-types.ts`.
 */
export interface CommandSummary {
  name: string;
  description: string;
  usage?: string;
}

export type Theme = 'dark' | 'light';

export type Locale = 'en' | 'ru';

export type SidebarGroupBy = 'project' | 'recent' | 'active';

const THEME_STORAGE_KEY = 'localcode.theme';
const LOCALE_STORAGE_KEY = 'localcode.locale';
const SIDEBAR_HIDDEN_STORAGE_KEY = 'localcode.sidebar.hidden';
const SIDEBAR_GROUPBY_STORAGE_KEY = 'localcode.sidebar.groupBy';

// QUEUE-NEXT-STORE-SECTION — start
function makePendingId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pending-${crypto.randomUUID()}`;
  }
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
// QUEUE-NEXT-STORE-SECTION — end

function readInitialHidden(): string[] {
  // Hide-project feature was removed (no UI to restore). On boot, purge
  // any legacy localStorage entry so previously-hidden projects come
  // back automatically. The state slice and `hideProject` action are
  // kept for source compatibility with the existing tests, but no UI
  // path triggers them anymore.
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(SIDEBAR_HIDDEN_STORAGE_KEY);
    } catch {
      /* ignored */
    }
  }
  return [];
}

function readInitialGroupBy(): SidebarGroupBy {
  if (typeof window === 'undefined') return 'project';
  try {
    const raw = window.localStorage.getItem(SIDEBAR_GROUPBY_STORAGE_KEY);
    if (raw === 'project' || raw === 'recent' || raw === 'active') return raw;
  } catch {
    /* ignored */
  }
  return 'project';
}

function persistHidden(hidden: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      SIDEBAR_HIDDEN_STORAGE_KEY,
      JSON.stringify(hidden),
    );
  } catch {
    /* ignored */
  }
}

function persistGroupBy(mode: SidebarGroupBy): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_GROUPBY_STORAGE_KEY, mode);
  } catch {
    /* ignored */
  }
}

// ---- NOTIFICATIONS-SECTION: localStorage helper ----
const BROWSER_NOTIFY_STORAGE_KEY = 'localcode.notifications.browser';

function readInitialBrowserNotifications(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(BROWSER_NOTIFY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistBrowserNotifications(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BROWSER_NOTIFY_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* ignored */
  }
}
// ---- /NOTIFICATIONS-SECTION ----

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* ignored */
  }
  try {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
    ) {
      return 'light';
    }
  } catch {
    /* ignored */
  }
  return 'dark';
}

function readInitialLocale(): Locale {
  // SSR-safe: persisted choice wins; otherwise sniff `navigator.language`
  // for a Russian-speaking user. Anything that isn't ru-* falls back to
  // English.
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === 'en' || stored === 'ru') return stored;
  } catch {
    /* ignored */
  }
  try {
    const lang = navigator.language;
    if (typeof lang === 'string' && lang.toLowerCase().startsWith('ru')) {
      return 'ru';
    }
  } catch {
    /* ignored */
  }
  return 'en';
}

// ---- TODO-WRITE-SECTION: Task tracker store slice ----

/**
 * A single task item from the model's todo_write tool. Mirrors `TodoWire`
 * from the wire protocol; kept local so the store stays decoupled from
 * the server protocol module.
 */
export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

// ---- /TODO-WRITE-SECTION ----

/**
 * A single scheduled wakeup mirrored from the WS `wakeups_updated` frame.
 * Shape matches `WakeupWire` in `src/web/protocol/messages.ts`.
 */
export interface ScheduledWakeupWire {
  id: string;
  sessionId: string;
  prompt: string;
  reason: string;
  createdAt: number;
  fireAt: number;
}

export interface BrowserFrame {
  jpegBase64: string;
  width: number;
  height: number;
  capturedAt: number;
}

export type BrowserStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'navigating'
  | 'closed'
  | 'error';

export interface BrowserConsoleEntry {
  id: string;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  source?: string;
  line?: number;
  receivedAt: number;
}

export interface BrowserCursorEvent {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs: number;
  action: 'click' | 'hover' | 'type';
}

export interface BrowserSlice {
  open: boolean;
  status: BrowserStatus;
  url?: string;
  title?: string;
  errorMessage?: string;
  latestFrame: BrowserFrame | null;
  console: BrowserConsoleEntry[];
  cursorQueue: BrowserCursorEvent[];
}

const BROWSER_CONSOLE_CAP = 200;

/**
 * Most recent token-usage snapshot for the active session. Lifted from
 * ChatView's local state so the ProjectBar's ContextUsageRing can read
 * the same numbers without a prop drill. Cleared on session switch
 * and on `done` errors — see ChatView's WS handler.
 */
export interface UsageSnapshot {
  tokensIn?: number;
  tokensOut?: number;
  cachedTokens?: number;
  freshTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * File-browser slice — drives the slide-in panel that renders the
 * project tree. Kept in the global store (rather than local component
 * state) so closing + reopening the panel preserves the user's
 * expansion state and selected preview without a full refetch.
 *
 * `treeCache` is keyed by `${projectId}:${subpath}` so multiple
 * projects can coexist in memory; `clearFileBrowserCache(projectId)`
 * wipes one project's slice when the active project changes or the
 * user hits Refresh in the panel toolbar.
 */
export interface FileEntryWire {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  mtime?: number;
}

export interface FileBrowserState {
  /**
   * Subpaths that are currently expanded in the tree. Keys are
   * `${projectId}:${relativePath}` — empty `relativePath` represents
   * the root. We use a record-of-true rather than a Set so the value
   * is JSON-serialisable and React-rerender friendly.
   */
  expandedPaths: Record<string, true>;
  /** `${projectId}:${relativePath}` of the file currently being previewed. */
  selectedKey: string | null;
  /** Whether dotfiles + build dirs are surfaced in the tree. */
  showHidden: boolean;
  /** Debounced search filter applied to the visible tree rows. */
  searchQuery: string;
  /** Cached listings keyed by `${projectId}:${relativePath}`. */
  treeCache: Record<string, FileEntryWire[]>;
  /** In-flight lazy-load keys (for spinner rendering). */
  loadingPaths: Record<string, true>;
  /** Last error keyed by `${projectId}:${relativePath}`. */
  errorByPath: Record<string, string>;
}

export type SessionRunStatus = 'idle' | 'streaming' | 'recently-finished';

export interface SessionStatusEntry {
  status: SessionRunStatus;
  finishedAt?: number;
}

/** Recently-finished decay window (ms). */
export const SESSION_STATUS_RECENT_MS = 10_000;

export type AgentRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface AgentNode {
  agentId: string;
  parentAgentId: string | null;
  parentSessionId: string;
  model: string;
  task: string;
  ownedFiles: string[];
  worktreePath?: string;
  startedAt: number;
  status: AgentRunStatus;
  lastMessage?: string;
  error?: string;
  summary?: string;
  diff?: string;
  completedAt?: number;
}

export interface TeamMessage {
  id: string;
  sessionId: string;
  from: string;
  to: string;
  message: string;
  at: number;
}

// AGENT-LIFECYCLE-SECTION
/**
 * Active reply-mode target. When set, the Composer routes typed
 * messages to this agent via TeamBus instead of starting a new
 * assistant turn on the parent session. Cleared with `exitAgentReply`
 * (× button in the Composer header, or when the agent terminates).
 */
export interface AgentReplyTarget {
  parentSessionId: string;
  agentId: string;
  /** Short display label (e.g. agent id prefix) — shown in the header. */
  label: string;
}
// /AGENT-LIFECYCLE-SECTION

export const TEAM_MESSAGE_CAP = 200;

/**
 * LRU bound for the per-session message cache. Switching across many
 * sessions in a single tab session previously kept every visited
 * session's full message history in memory forever — for a heavy
 * 200-message session that's >100KB per entry, and the leak compounded
 * across the tab's lifetime.
 *
 * Five slots is enough to cover "the user is bouncing between a
 * handful of recent chats", which is the only access pattern the
 * synchronous-rehydrate optimisation actually targets. Anything older
 * falls back to the WS `subscribed` frame / REST fetch.
 *
 * Exported so tests can assert the eviction threshold without
 * recompiling.
 */
export const SESSION_CACHE_MAX = 5;

export interface UIToast {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  createdAt: number;
  /**
   * Optional per-toast auto-dismiss duration in milliseconds. When set,
   * overrides the level-based default (`Toast.tsx`). Pass `0` to render
   * a sticky toast that only dismisses on user click.
   */
  duration?: number;
}

// ---- NOTIFICATIONS-SECTION ----

/**
 * Categorical event types surfaced through the notification center.
 * Keep the union explicit so the UI can map type → icon + severity
 * statically.
 */
// UPDATE-MODAL-STORE-SECTION
/**
 * Snapshot of the most recent `update_available` WS frame. Mirrors the
 * `update_available` shape in `src/web/protocol/messages.ts`. Kept as a
 * narrow interface so the UpdateModal can render without re-resolving
 * the wire shape.
 */
export interface UpdateAvailableInfo {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly releaseUrl: string;
  readonly releaseName: string;
  readonly body: string;
  readonly publishedAt: number;
  /**
   * Concatenated release notes spanning every release between current
   * → latest. Optional — present on the SECOND `update_available` WS
   * frame after the server fetched delta notes; absent on the first
   * frame. When present, the modal renders this instead of `body`.
   */
  readonly deltaNotes?: string;
}
// UPDATE-MODAL-STORE-SECTION-END

export type NotificationType =
  | 'agent_completed'
  | 'agent_errored'
  | 'wakeup_fired'
  | 'approval_required'
  | 'stream_completed'
  | 'circuit_open'
  | 'hook_blocked';

/**
 * A single notification entry rendered in the bell popover. `sessionId`
 * is optional — global events (e.g. `circuit_open`) carry none.
 */
export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body?: string;
  sessionId?: string;
  timestamp: number;
  read: boolean;
}

/**
 * FIFO cap on the in-memory notification list. Older entries are
 * evicted from the head when the list grows past this.
 */
export const NOTIFICATION_CAP = 100;

// ---- /NOTIFICATIONS-SECTION ----

// EXCLUSIVE-OVERLAY-SECTION
/**
 * Discriminated union representing exactly one (or zero) open overlays.
 *
 * Why: previously each overlay had an independent boolean slice
 * (`settingsOpen`, `usageDashboardOpen`, …) which let multiple overlays
 * stack on top of each other when opened in sequence from the top-right
 * dock. This union enforces single-active-overlay semantics by
 * construction. Existing boolean slices are kept as derived mirrors so
 * legacy call sites keep working — they are flipped to `false` by
 * `openOverlay` whenever a peer takes the slot.
 */
export type OpenOverlay =
  | { kind: 'none' }
  | { kind: 'settings' }
  | { kind: 'notifications' }
  | { kind: 'usage' }
  | { kind: 'cost' }
  | { kind: 'agents-config' }
  | { kind: 'memory' }
  | { kind: 'hooks' }
  | { kind: 'tasks' }
  | { kind: 'browser' }
  | { kind: 'files' }
  | { kind: 'profile' }
  | { kind: 'style' }
  | { kind: 'wakeups' }
  | { kind: 'plugins' }
  | { kind: 'skills' }
  | { kind: 'backend-server' }
  | { kind: 'session-search' }
  | { kind: 'slash-commands' }
  | { kind: 'add-skill' }
  | { kind: 'add-project' };

/**
 * Snapshot of every legacy boolean slice that the exclusive-overlay
 * machinery toggles. Used internally by `openOverlay()` / `closeOverlay()`
 * to flip peers off in a single `set()` call.
 */
const OVERLAY_RESET_PATCH = {
  settingsOpen: false,
  backendServerOpen: false,
  addProjectOpen: false,
  sessionSearchOpen: false,
  slashCommandsOpen: false,
  skillsOverlayOpen: false,
  pluginsOverlayOpen: false,
  addSkillOpen: false,
  agentsConfigOverlayOpen: false,
  usageDashboardOpen: false,
  hooksOverlayOpen: false,
  memoryOverlayOpen: false,
} as const;

type OverlayBooleanPatch = Partial<Record<keyof typeof OVERLAY_RESET_PATCH, boolean>>;

/** Maps an `OpenOverlay.kind` to the matching legacy boolean (if any). */
function legacyBooleanPatchForKind(kind: OpenOverlay['kind']): OverlayBooleanPatch {
  switch (kind) {
    case 'settings':
      return { settingsOpen: true };
    case 'backend-server':
      return { backendServerOpen: true };
    case 'add-project':
      return { addProjectOpen: true };
    case 'session-search':
      return { sessionSearchOpen: true };
    case 'slash-commands':
      return { slashCommandsOpen: true };
    case 'skills':
      return { skillsOverlayOpen: true };
    case 'plugins':
      return { pluginsOverlayOpen: true };
    case 'add-skill':
      return { addSkillOpen: true };
    case 'agents-config':
      return { agentsConfigOverlayOpen: true };
    case 'usage':
      return { usageDashboardOpen: true };
    case 'hooks':
      return { hooksOverlayOpen: true };
    case 'memory':
      return { memoryOverlayOpen: true };
    default:
      return {};
  }
}
// /EXCLUSIVE-OVERLAY-SECTION

export interface AppState {
  // Connection
  connection: ConnectionState;
  csrfToken: string | null;
  /**
   * Set when the server rejects the CSRF token. Drives the
   * `<StaleTokenBanner>` overlay and hides normal UI to draw focus.
   * `null` means "no auth problem detected".
   */
  authError: AuthErrorState | null;

  // Workspaces
  projects: WorkspaceRecord[];
  activeProjectId: string | null;

  // Sessions
  sessions: SessionSummaryWire[];
  activeSessionId: string | null;
  /** Per-session run status for sidebar indicators (parallel sessions). */
  sessionStatus: Record<string, SessionStatusEntry>;

  // Models / providers
  activeBackend: Backend | null;
  baseUrl: string | null;
  models: string[];
  currentModel: string | null;

  /**
   * Active permission profile mirrored from `/api/config` on bootstrap
   * and from `setProfile` mutations afterwards. Drives the
   * ProfileBanner + ProfileChip surfaces. `null` until the first config
   * snapshot lands.
   */
  permissionProfile: PermissionProfile | null;

  /**
   * Active output style mirrored from `/api/config` on bootstrap and
   * from `setOutputStyle` mutations afterwards. Drives the StyleChip
   * label + dropdown selection. `null` until the first config snapshot
   * lands.
   */
  outputStyle: OutputStyle | null;

  /**
   * Latest usage event from the WS feed for the active session. Reset to
   * null on session switch / first turn / explicit error. ProjectBar
   * reads this to drive the ContextUsageRing.
   */
  latestUsage: UsageSnapshot | null;

  /**
   * `cfg.context.maxTokens` mirrored from the bootstrap REST payload —
   * used as the fallback when the active model is missing from the
   * known-models lookup table. Null until the first config snapshot
   * arrives.
   */
  currentMaxContextTokens: number | null;

  // EXCLUSIVE-OVERLAY-SECTION
  /**
   * Single source of truth for which overlay (if any) is currently
   * mounted. Replaces the previous "many independent booleans" pattern
   * to stop overlays stacking on top of each other. Legacy booleans
   * remain in this state shape and stay in sync via `openOverlay()`.
   */
  activeOverlay: OpenOverlay;
  // /EXCLUSIVE-OVERLAY-SECTION

  // UI
  toasts: UIToast[];
  fileBrowserOpen: boolean;
  fileBrowser: FileBrowserState;
  sidebarCollapsed: boolean;
  /** Project IDs whose folder group is expanded in the sidebar tree. */
  expandedFolders: Record<string, boolean>;
  /** Project tree expansion state — keyed by projectId. Per-tab in memory only. */
  sidebarExpanded: Record<string, boolean>;
  /** Project IDs hidden from the sidebar (persisted to localStorage). */
  sidebarHidden: string[];
  /** Sidebar grouping mode (persisted to localStorage). */
  sidebarGroupBy: SidebarGroupBy;
  /** Filter-menu popover open state. */
  sidebarFilterOpen: boolean;
  settingsOpen: boolean;
  backendServerOpen: boolean;
  providersConfig: PerProviderConfig | null;
  projectSwitcherOpen: boolean;
  addProjectOpen: boolean;
  /** Cross-session FTS overlay (Cmd+K / sidebar filter menu entry). */
  sessionSearchOpen: boolean;
  /**
   * Registered by App.tsx; SessionRow invokes it for deletion.
   *
   * L11 follow-up: this should move to a React Context (or a small
   * event bus) so deeply-nested SessionRow renders don't subscribe to
   * a store slice that mutates outside their lifecycle. Deferred — the
   * call sites (`App.tsx`, `SessionRow.tsx`) live outside this slice's
   * exclusive-ownership boundary in the current refactor round.
   */
  deleteSessionHandler: ((sessionId: string) => void) | null;

  // Skills + Plugins
  skills: SkillSummary[];
  plugins: PluginSummary[];
  skillsOverlayOpen: boolean;
  pluginsOverlayOpen: boolean;
  addSkillOpen: boolean;
  plusMenuOpen: boolean;

  // Browser viewer
  browser: BrowserSlice;

  // Agent team / multi-agent orchestration
  agentTree: Record<string, AgentNode[]>;
  teamMessages: Record<string, TeamMessage[]>;
  agentTeamPanelOpen: boolean;
  /** Parent session ids for which we have already auto-opened the panel. */
  agentTeamAutoOpenedFor: string[];
  // AGENT-LIFECYCLE-SECTION
  /**
   * When non-null the Composer is in agent-reply mode — typed messages
   * route to this agent via TeamBus instead of starting a new assistant
   * turn on the parent session. Set by `enterAgentReply`, cleared by
   * `exitAgentReply` (× button, or when the agent terminates via
   * `agent_removed`).
   */
  agentReplyTarget: AgentReplyTarget | null;
  // /AGENT-LIFECYCLE-SECTION

  // Agents settings overlay
  agentsConfigOverlayOpen: boolean;
  agentsConfig: AgentsConfigSnapshot | null;

  // Usage dashboard
  usageDashboardOpen: boolean;

  // Hooks settings overlay (read-only viewer)
  hooksOverlayOpen: boolean;

  // Memory overlay
  memoryOverlayOpen: boolean;

  /**
   * Pending wakeups per session keyed by sessionId. Updated via the
   * `wakeups_updated` WS frame. Empty array means "no pending wakeups
   * for this session" (the badge hides itself).
   */
  pendingWakeups: Record<string, ScheduledWakeupWire[]>;

  // TODO-WRITE-SECTION: per-session todos + panel state
  /** Per-session todo lists keyed by sessionId. Updated via `todos_updated` WS frames. */
  sessionTodos: Record<string, Todo[]>;
  /** Whether the TasksPanel is currently visible. Auto-opens on first todos_updated. */
  tasksPanelOpen: boolean;
  /** Session IDs for which the tasks panel was already auto-opened (prevents re-opening on navigate back). */
  tasksPanelAutoOpenedFor: string[];
  // /TODO-WRITE-SECTION

  // UPDATE-MODAL-STORE-SECTION
  /** Latest update-available payload from the server (null when none). */
  updateAvailable: UpdateAvailableInfo | null;
  /** Whether the polished update modal is currently open. */
  updateModalOpen: boolean;
  /** Set when the staged binary has finished downloading. */
  updateDownloadedVersion: string | null;
  // UPDATE-MODAL-STORE-SECTION-END

  // NOTIFICATIONS-SECTION: bell + center state
  /** Append-only event log, capped at NOTIFICATION_CAP via FIFO eviction. */
  notifications: Notification[];
  /** Whether the bell popover is currently open. */
  notificationsOpen: boolean;
  /**
   * User opt-in for browser notifications. Mirrored to localStorage so the
   * preference survives reloads. The actual `Notification.permission`
   * gate is enforced at fire-time by the service.
   */
  browserNotificationsEnabled: boolean;
  // /NOTIFICATIONS-SECTION

  // Theme
  theme: Theme;

  // Locale (i18n)
  locale: Locale;

  /**
   * Per-session message cache. Populated by ChatView's write-through on
   * every message-state mutation, so when the user switches sessions we
   * can rehydrate the chat surface synchronously (no flash of "Loading
   * conversation…") and let the WS `subscribed` frame reconcile in the
   * background. Server message wins on conflict — see ChatView's
   * subscribe effect.
   *
   * Bounded by `SESSION_CACHE_MAX` (LRU eviction on every set/append).
   * MRU ordering is tracked in `sessionMessagesOrder` — the head is the
   * oldest, the tail is the most recently touched.
   */
  sessionMessages: Record<string, WireChatMessage[]>;
  /**
   * Parallel id-set per session for O(1) duplicate detection in
   * `appendSessionMessage`. Kept in sync with `sessionMessages`.
   * Not part of the public selector surface — internal only.
   */
  sessionMessageIds: Record<string, Set<string>>;
  /**
   * MRU order for `sessionMessages` — oldest first. Updated on every
   * `setSessionMessages` / `appendSessionMessage`. When length exceeds
   * `SESSION_CACHE_MAX` the head is evicted from all three maps.
   */
  sessionMessagesOrder: string[];

  // PRESENCE-SECTION
  /**
   * Per-session map of active peers keyed by `userId`. Updated by the
   * inbound WS `presence` handler in App.tsx. Aged out by a 5s tick
   * effect on the host component (ChatView) so peers whose heartbeats
   * stop are dropped from the UI within {@link PRESENCE_VISIBLE_WINDOW_MS}.
   */
  peers: Record<string, Record<string, PeerInfo>>;
  /** Stable per-tab userId derived from localStorage. */
  myPresenceUserId: string;
  /** User-editable displayName for THIS tab. */
  myPresenceDisplayName: string;
  // PRESENCE-SECTION-END

  // QUEUE-NEXT-STORE-SECTION — start
  // Queued user messages (typed while a turn is streaming).
  // Per-tab in-memory only; oldest-first (FIFO).
  //
  // Items carry stable ids so the QueueIndicator dropdown can render
  // per-item delete affordances; `createdAt` lets the UI show "queued
  // 5s ago" hints in future iterations. The shape is intentionally
  // narrow — only what's needed to round-trip a user message text.
  pendingQueue: PendingQueueItem[];
  // QUEUE-NEXT-STORE-SECTION — end

  // Slash commands
  slashCommands: CommandSummary[];
  slashCommandsOpen: boolean;
  /**
   * Seed string the SlashCommandsOverlay (or other UIs) push into the
   * Composer. Composer reads it on change, copies into local state,
   * then clears it via `setComposerDraft('')`.
   */
  composerDraft: string;

  // Actions
  setConnection: (state: Partial<ConnectionState>) => void;
  setCsrfToken: (token: string | null) => void;
  setAuthError: (err: AuthErrorState | null) => void;
  setProjects: (projects: WorkspaceRecord[]) => void;
  setActiveProject: (id: string | null) => void;
  setSessions: (sessions: SessionSummaryWire[]) => void;
  setActiveSession: (id: string | null) => void;
  setSessionStreaming: (sessionId: string) => void;
  setSessionFinished: (sessionId: string) => void;
  clearSessionStatus: (sessionId: string) => void;
  tickSessionStatus: () => void;
  setProviderInfo: (info: {
    backend: Backend;
    baseUrl: string;
    models: readonly string[];
    currentModel: string;
  }) => void;
  /**
   * Update the active permission profile in the store. The HTTP call
   * is the caller's responsibility — this action only mutates the
   * client-side mirror.
   */
  setPermissionProfile: (profile: PermissionProfile | null) => void;
  /**
   * Update the active output style in the store. The HTTP call is the
   * caller's responsibility — this action only mutates the client mirror.
   */
  setOutputStyle: (style: OutputStyle | null) => void;
  setLatestUsage: (usage: UsageSnapshot | null) => void;
  setCurrentMaxContextTokens: (n: number | null) => void;
  pushToast: (toast: Omit<UIToast, 'id' | 'createdAt'>) => void;
  dismissToast: (id: string) => void;
  toggleSidebar: () => void;
  toggleFileBrowser: () => void;
  // File-browser actions
  toggleFileBrowserExpanded: (key: string) => void;
  setFileBrowserExpanded: (key: string, expanded: boolean) => void;
  setFileBrowserSelected: (key: string | null) => void;
  setFileBrowserShowHidden: (v: boolean) => void;
  setFileBrowserSearch: (q: string) => void;
  setFileBrowserTreeCache: (key: string, entries: readonly FileEntryWire[]) => void;
  setFileBrowserLoading: (key: string, loading: boolean) => void;
  setFileBrowserError: (key: string, err: string | null) => void;
  clearFileBrowserCache: (projectId?: string) => void;
  toggleFolder: (projectId: string) => void;
  setFolderExpanded: (projectId: string, expanded: boolean) => void;
  toggleProjectExpanded: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  hideProject: (projectId: string) => void;
  restoreHiddenProjects: () => void;
  setSidebarGroupBy: (mode: SidebarGroupBy) => void;
  // EXCLUSIVE-OVERLAY-SECTION
  /**
   * Open a specific overlay, closing any other open overlay in the same
   * `set()` call. This is the preferred entry point for new code; legacy
   * `openX` / `closeX` actions still work and stay synchronised.
   */
  openOverlay: (next: OpenOverlay) => void;
  /** Closes whichever overlay is open. No-op if `activeOverlay.kind === 'none'`. */
  closeOverlay: () => void;
  // /EXCLUSIVE-OVERLAY-SECTION
  openSidebarFilter: () => void;
  closeSidebarFilter: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openBackendServer: () => void;
  closeBackendServer: () => void;
  setProvidersConfig: (c: PerProviderConfig) => void;
  openProjectSwitcher: () => void;
  closeProjectSwitcher: () => void;
  openAddProject: () => void;
  closeAddProject: () => void;
  openSessionSearch: () => void;
  closeSessionSearch: () => void;
  setDeleteSessionHandler: (
    handler: ((sessionId: string) => void) | null,
  ) => void;
  setSlashCommands: (list: CommandSummary[]) => void;
  openSlashCommands: () => void;
  closeSlashCommands: () => void;
  // UPDATE-MODAL-STORE-SECTION
  /** Record an incoming `update_available` payload and open the modal. */
  setUpdateAvailable: (info: UpdateAvailableInfo) => void;
  /** Record that the staged binary is ready. */
  setUpdateDownloaded: (version: string) => void;
  /** Close the update modal without changing the underlying payload. */
  closeUpdateModal: () => void;
  // UPDATE-MODAL-STORE-SECTION-END
  setComposerDraft: (text: string) => void;
  // QUEUE-NEXT-STORE-SECTION — start
  /**
   * Append a trimmed-non-empty user message to the pending queue.
   * Generates a stable id + timestamp. No-op for whitespace-only input.
   * Renamed from the legacy `enqueuePending(text)` for clarity; the new
   * signature returns the assigned id so callers can correlate later
   * `dequeueMessage` removals or toast updates.
   */
  enqueueMessage: (content: string) => string | null;
  /**
   * Remove a single queued item by id. Silent no-op if id is unknown
   * (e.g. the item already drained between render and click).
   */
  dequeueMessage: (id: string) => void;
  /**
   * Pop the entire queue atomically and return the prior contents.
   * Used by the auto-drain effect on `done` to combine items into a
   * single follow-up message. Order is preserved (FIFO).
   */
  drainPendingQueue: () => readonly PendingQueueItem[];
  /** Clear without returning — bound to the QueueIndicator "Clear" button. */
  clearPendingQueue: () => void;
  // QUEUE-NEXT-STORE-SECTION — end
  // PRESENCE-SECTION
  /**
   * Upsert a peer entry under `sessionId`. Used by App.tsx's inbound WS
   * handler whenever a `presence` frame arrives. Filters out OUR own
   * userId so we never show ourselves in the peer list.
   */
  upsertPeer: (sessionId: string, peer: PeerInfo) => void;
  /**
   * Drop a peer entirely (e.g. after the disconnect "left" frame or the
   * local age-out tick). Silent no-op when unknown.
   */
  removePeer: (sessionId: string, userId: string) => void;
  /**
   * Sweep peers older than {@link PRESENCE_VISIBLE_WINDOW_MS}. Run on a
   * short interval by the host component so stale entries vanish even
   * if their disconnect frame was lost.
   */
  sweepStalePeers: (now?: number) => void;
  /** Change the displayName for THIS tab and persist to localStorage. */
  setPresenceDisplayName: (name: string) => void;
  // PRESENCE-SECTION-END
  setSessionMessages: (sessionId: string, msgs: readonly WireChatMessage[]) => void;
  /**
   * Reference-stable variant. If `msgs` is the exact same array (by
   * identity) as the currently-cached value for `sessionId`, this is a
   * no-op — no store mutation, no subscriber re-render. ChatView's
   * write-through can call this from a debounced effect without
   * worrying about redundant store updates.
   */
  setSessionMessagesIfChanged: (
    sessionId: string,
    msgs: readonly WireChatMessage[],
  ) => void;
  appendSessionMessage: (sessionId: string, msg: WireChatMessage) => void;
  clearSessionMessages: (sessionId: string) => void;
  setTheme: (theme: Theme) => void;
  setLocale: (locale: Locale) => void;

  // Skills + plugins actions
  setSkills: (skills: SkillSummary[]) => void;
  setPlugins: (plugins: PluginSummary[]) => void;
  toggleSkillLocal: (id: string) => void;
  openSkillsOverlay: () => void;
  closeSkillsOverlay: () => void;
  openPluginsOverlay: () => void;
  closePluginsOverlay: () => void;
  openAddSkill: () => void;
  closeAddSkill: () => void;
  openPlusMenu: () => void;
  closePlusMenu: () => void;

  // Browser viewer actions
  openBrowserPanel: () => void;
  closeBrowserPanel: () => void;
  toggleBrowserPanel: () => void;
  setBrowserState: (s: {
    status: BrowserStatus;
    url?: string;
    title?: string;
    errorMessage?: string;
  }) => void;
  appendBrowserFrame: (frame: BrowserFrame) => void;
  appendBrowserConsole: (
    entry: Omit<BrowserConsoleEntry, 'id' | 'receivedAt'>,
  ) => void;
  enqueueBrowserCursor: (
    event: Omit<BrowserCursorEvent, 'id'>,
  ) => void;
  dequeueBrowserCursor: (id: string) => void;
  clearBrowserState: () => void;

  // Agent team actions
  upsertAgent: (node: AgentNode) => void;
  updateAgentStatus: (
    parentSessionId: string,
    agentId: string,
    partial: Partial<Omit<AgentNode, 'agentId' | 'parentSessionId' | 'parentAgentId'>>,
  ) => void;
  appendTeamMessage: (msg: TeamMessage) => void;
  clearAgentTeam: (parentSessionId: string) => void;
  toggleAgentTeamPanel: () => void;
  openAgentTeamPanel: () => void;
  closeAgentTeamPanel: () => void;
  // AGENT-LIFECYCLE-SECTION
  /**
   * Enter reply-mode for `target`. Subsequent Composer sends route to
   * the agent via TeamBus (`lead → target.agentId` unicast). No-op when
   * the target is already active.
   */
  enterAgentReply: (target: AgentReplyTarget) => void;
  /** Exit reply-mode. Subsequent Composer sends go back to the lead. */
  exitAgentReply: () => void;
  // /AGENT-LIFECYCLE-SECTION

  // Agents settings overlay
  openAgentsConfig: () => void;
  closeAgentsConfig: () => void;
  setAgentsConfig: (c: AgentsConfigSnapshot) => void;

  // Usage dashboard
  openUsageDashboard: () => void;
  closeUsageDashboard: () => void;
  toggleUsageDashboard: () => void;

  // Hooks settings overlay
  openHooksOverlay: () => void;
  closeHooksOverlay: () => void;

  // Memory overlay
  openMemoryOverlay: () => void;
  closeMemoryOverlay: () => void;

  /**
   * Replace the pending-wakeups list for a session. Called by the WS
   * frame handler on every `wakeups_updated`.
   */
  setPendingWakeups: (
    sessionId: string,
    wakeups: readonly ScheduledWakeupWire[],
  ) => void;

  // TODO-WRITE-SECTION: task panel actions
  setSessionTodos: (sessionId: string, todos: readonly Todo[]) => void;
  openTasksPanel: () => void;
  closeTasksPanel: () => void;
  toggleTasksPanel: () => void;
  // /TODO-WRITE-SECTION

  // TABS-DOCK-SECTION: tab system + dock manager + resizer state
  openTabs: string[];
  activeTab: string | null;
  panelLayout: PanelLayout;
  resizers: Record<string, number>;
  // DEPRECATED — RightDock removed Wave 8B; slice retained for backward-compat with tests.
  rightDockTabOrder: DockPanelId[];
  rightDockCollapsed: boolean;
  activeRightDockTab: DockPanelId;
  openTab: (sessionId: string) => void;
  closeTab: (sessionId: string) => void;
  setActiveTab: (sessionId: string | null) => void;
  switchTabByIndex: (index: number) => void;
  reorderTabs: (next: readonly string[]) => void;
  movePanel: (id: DockPanelId, position: PanelPosition) => void;
  togglePanelVisibility: (id: DockPanelId) => void;
  resetDockLayout: () => void;
  setResizerValue: (key: string, value: number) => void;
  setRightDockTabOrder: (next: readonly DockPanelId[]) => void;
  setActiveRightDockTab: (id: DockPanelId) => void;
  toggleRightDockCollapsed: () => void;
  // /TABS-DOCK-SECTION

  // NOTIFICATIONS-SECTION: actions
  /**
   * Append a notification. `id`, `timestamp` and `read=false` are filled
   * in here so call sites can pass the minimum payload. Triggers FIFO
   * eviction when the list exceeds NOTIFICATION_CAP.
   */
  pushNotification: (
    n: Omit<Notification, 'id' | 'timestamp' | 'read'> & {
      id?: string;
      timestamp?: number;
    },
  ) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  toggleNotificationCenter: () => void;
  openNotificationCenter: () => void;
  closeNotificationCenter: () => void;
  setBrowserNotificationsEnabled: (v: boolean) => void;
  // /NOTIFICATIONS-SECTION

  // WHITEBOARD-SECTION — drawing surface owned by the web frontend.
  // `whiteboardOpen` mirrors the right-dock 'whiteboard' tab so the slash
  // command + hotkey can drive it from anywhere without poking the dock
  // internals.
  // `whiteboardPendingImage` is consumed by Composer: when the user
  // clicks "Send to chat" inside the Whiteboard, the exported PNG lands
  // here and Composer picks it up + clears the slot.
  whiteboardOpen: boolean;
  whiteboardPendingImage: WhiteboardPendingImage | null;
  openWhiteboard: () => void;
  closeWhiteboard: () => void;
  toggleWhiteboard: () => void;
  setWhiteboardPendingImage: (img: WhiteboardPendingImage | null) => void;
  // /WHITEBOARD-SECTION
}

// WHITEBOARD-SECTION
/**
 * Inflight whiteboard export waiting to be inlined into the next Composer
 * turn as an image attachment. `base64` is the raw PNG payload (no
 * `data:` prefix) so it slots into the existing `ComposerImageAttachment`
 * shape without copying.
 */
export interface WhiteboardPendingImage {
  base64: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  sizeBytes: number;
  name: string;
}
// /WHITEBOARD-SECTION

// TABS-DOCK-SECTION: types + storage helpers
export type PanelPosition = 'left' | 'right' | 'bottom' | 'hidden';

export type DockPanelId =
  | 'tasks'
  | 'agents'
  | 'browser'
  | 'logs'
  | 'files'
  | 'memory'
  | 'usage'
  // WHITEBOARD-SECTION — `whiteboard` dock panel id is owned by the web
  // whiteboard feature; the slice + persistence helpers below also live
  // inside marker fences for predictable patching.
  | 'whiteboard';
// /WHITEBOARD-SECTION

export interface PanelLayoutEntry {
  id: DockPanelId;
  position: PanelPosition;
  size: number;
}

export interface PanelLayout {
  panels: PanelLayoutEntry[];
}

const TABS_STORAGE_KEY = 'localcode.web.tabs';
const DOCK_STORAGE_KEY = 'localcode.web.dock';
const RESIZER_STORAGE_KEY = 'localcode.web.resizers';
const RIGHT_DOCK_ORDER_KEY = 'localcode.web.rightDock.order';
const RIGHT_DOCK_COLLAPSED_KEY = 'localcode.web.rightDock.collapsed';
const RIGHT_DOCK_ACTIVE_KEY = 'localcode.web.rightDock.active';

export const DEFAULT_DOCK_PANEL_IDS: readonly DockPanelId[] = [
  'tasks',
  'agents',
  'browser',
  'logs',
  'files',
  'memory',
  'usage',
  // WHITEBOARD-SECTION
  'whiteboard',
  // /WHITEBOARD-SECTION
];

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  panels: [
    { id: 'tasks', position: 'right', size: 0.5 },
    { id: 'agents', position: 'right', size: 0.5 },
    { id: 'browser', position: 'right', size: 0.5 },
    { id: 'logs', position: 'bottom', size: 0.25 },
    { id: 'files', position: 'left', size: 240 },
    { id: 'memory', position: 'right', size: 0.5 },
    { id: 'usage', position: 'right', size: 0.5 },
    // WHITEBOARD-SECTION
    { id: 'whiteboard', position: 'right', size: 0.6 },
    // /WHITEBOARD-SECTION
  ],
};

const DEFAULT_RIGHT_DOCK_ORDER: readonly DockPanelId[] = [
  'tasks',
  'agents',
  'browser',
  'files',
  'memory',
  'usage',
  'logs',
  // WHITEBOARD-SECTION
  'whiteboard',
  // /WHITEBOARD-SECTION
];

interface TabsPersisted {
  openTabs: string[];
  activeTab: string | null;
}

function safeReadJson<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (validate(parsed)) return parsed;
  } catch {
    /* ignored */
  }
  return fallback;
}

function safeWriteJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignored */
  }
}

function isTabsPersisted(v: unknown): v is TabsPersisted {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { openTabs?: unknown; activeTab?: unknown };
  if (!Array.isArray(o.openTabs)) return false;
  if (!o.openTabs.every((t) => typeof t === 'string')) return false;
  if (o.activeTab !== null && typeof o.activeTab !== 'string') return false;
  return true;
}

function isPanelLayout(v: unknown): v is PanelLayout {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { panels?: unknown };
  if (!Array.isArray(o.panels)) return false;
  const ids = new Set<DockPanelId>(DEFAULT_DOCK_PANEL_IDS);
  const positions: PanelPosition[] = ['left', 'right', 'bottom', 'hidden'];
  for (const p of o.panels) {
    if (p === null || typeof p !== 'object') return false;
    const e = p as { id?: unknown; position?: unknown; size?: unknown };
    if (typeof e.id !== 'string') return false;
    if (!ids.has(e.id as DockPanelId)) return false;
    if (typeof e.position !== 'string') return false;
    if (!positions.includes(e.position as PanelPosition)) return false;
    if (typeof e.size !== 'number' || !Number.isFinite(e.size)) return false;
  }
  return true;
}

function isResizers(v: unknown): v is Record<string, number> {
  if (v === null || typeof v !== 'object') return false;
  for (const [, val] of Object.entries(v)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return false;
  }
  return true;
}

function isRightDockOrder(v: unknown): v is DockPanelId[] {
  if (!Array.isArray(v)) return false;
  const ids = new Set<DockPanelId>(DEFAULT_DOCK_PANEL_IDS);
  return v.every((x) => typeof x === 'string' && ids.has(x as DockPanelId));
}

function readInitialTabs(): TabsPersisted {
  return safeReadJson<TabsPersisted>(
    TABS_STORAGE_KEY,
    { openTabs: [], activeTab: null },
    isTabsPersisted,
  );
}

function readInitialPanelLayout(): PanelLayout {
  const stored = safeReadJson<PanelLayout>(
    DOCK_STORAGE_KEY,
    DEFAULT_PANEL_LAYOUT,
    isPanelLayout,
  );
  // Make sure every known panel is represented — older persisted layouts
  // may predate a panel id, in which case we splice in the default entry.
  const known = new Set(stored.panels.map((p) => p.id));
  const merged: PanelLayoutEntry[] = [...stored.panels];
  for (const def of DEFAULT_PANEL_LAYOUT.panels) {
    if (!known.has(def.id)) merged.push({ ...def });
  }
  return { panels: merged };
}

function readInitialResizers(): Record<string, number> {
  return safeReadJson<Record<string, number>>(
    RESIZER_STORAGE_KEY,
    {},
    isResizers,
  );
}

function readInitialRightDockOrder(): DockPanelId[] {
  const stored = safeReadJson<DockPanelId[]>(
    RIGHT_DOCK_ORDER_KEY,
    [...DEFAULT_RIGHT_DOCK_ORDER],
    isRightDockOrder,
  );
  const merged: DockPanelId[] = [...stored];
  for (const id of DEFAULT_RIGHT_DOCK_ORDER) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

function readInitialRightDockCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(RIGHT_DOCK_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function readInitialActiveRightDockTab(): DockPanelId {
  if (typeof window === 'undefined') return 'tasks';
  try {
    const raw = window.localStorage.getItem(RIGHT_DOCK_ACTIVE_KEY);
    if (raw !== null && (DEFAULT_DOCK_PANEL_IDS as readonly string[]).includes(raw)) {
      return raw as DockPanelId;
    }
  } catch {
    /* ignored */
  }
  return 'tasks';
}

function persistTabs(tabs: readonly string[], active: string | null): void {
  safeWriteJson(TABS_STORAGE_KEY, { openTabs: tabs, activeTab: active });
}

function persistPanelLayout(layout: PanelLayout): void {
  safeWriteJson(DOCK_STORAGE_KEY, layout);
}

function persistResizers(r: Record<string, number>): void {
  safeWriteJson(RESIZER_STORAGE_KEY, r);
}

function persistRightDockOrder(order: readonly DockPanelId[]): void {
  safeWriteJson(RIGHT_DOCK_ORDER_KEY, order);
}

function persistRightDockCollapsed(v: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RIGHT_DOCK_COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    /* ignored */
  }
}

function persistActiveRightDockTab(id: DockPanelId): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RIGHT_DOCK_ACTIVE_KEY, id);
  } catch {
    /* ignored */
  }
}
// /TABS-DOCK-SECTION

const INITIAL_BROWSER: BrowserSlice = {
  open: false,
  status: 'idle',
  latestFrame: null,
  console: [],
  cursorQueue: [],
};

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

/**
 * Slice of `AppState` that the cache helpers update. Keeps the helper
 * signatures narrow so they can be unit-tested in isolation without
 * dragging in the whole store interface.
 */
type SessionMessagesSlice = {
  sessionMessages: Record<string, WireChatMessage[]>;
  sessionMessageIds: Record<string, Set<string>>;
  sessionMessagesOrder: string[];
};

/**
 * Core cache-slot writer. Stores `msgs` + `ids` under `sessionId`,
 * promotes the slot to MRU tail, and evicts the LRU head if the order
 * array exceeds `SESSION_CACHE_MAX`.
 *
 * Both `msgs` and `ids` are written by reference — callers own copy
 * semantics. We only shallow-copy the outer maps when the slot
 * identity actually changes, so steady-state writes touch O(1) refs in
 * each map (plus an array filter on the order slice).
 */
function applyCacheSlot(
  st: SessionMessagesSlice,
  sessionId: string,
  msgs: WireChatMessage[],
  ids: Set<string>,
): SessionMessagesSlice {
  const nextMessages: Record<string, WireChatMessage[]> = {
    ...st.sessionMessages,
    [sessionId]: msgs,
  };
  const nextIds: Record<string, Set<string>> = {
    ...st.sessionMessageIds,
    [sessionId]: ids,
  };
  // Move sessionId to the MRU tail.
  const nextOrder = st.sessionMessagesOrder.filter((id) => id !== sessionId);
  nextOrder.push(sessionId);
  // Evict from the LRU head until we're within budget.
  while (nextOrder.length > SESSION_CACHE_MAX) {
    const victim = nextOrder.shift();
    if (victim === undefined) break;
    delete nextMessages[victim];
    delete nextIds[victim];
  }
  return {
    sessionMessages: nextMessages,
    sessionMessageIds: nextIds,
    sessionMessagesOrder: nextOrder,
  };
}

/**
 * `setSessionMessages` body — rebuilds the id-set from `msgs` and
 * defers slot writing + eviction to `applyCacheSlot`.
 */
function applySetSessionMessages(
  st: SessionMessagesSlice,
  sessionId: string,
  msgs: readonly WireChatMessage[],
): SessionMessagesSlice {
  const copied = [...msgs];
  const ids = new Set<string>();
  for (const m of copied) ids.add(m.id);
  return applyCacheSlot(st, sessionId, copied, ids);
}

export const useStore = create<AppState>((set) => ({
  // UPDATE-MODAL-STORE-SECTION: initial state
  updateAvailable: null,
  updateModalOpen: false,
  updateDownloadedVersion: null,
  // UPDATE-MODAL-STORE-SECTION-END

  // NOTIFICATIONS-SECTION: initial state
  notifications: [],
  notificationsOpen: false,
  browserNotificationsEnabled: readInitialBrowserNotifications(),
  // /NOTIFICATIONS-SECTION
  connection: { status: 'connecting', lastError: null },
  csrfToken: null,
  authError: null,
  projects: [],
  activeProjectId: null,
  sessions: [],
  activeSessionId: null,
  sessionStatus: {},
  activeBackend: null,
  baseUrl: null,
  models: [],
  currentModel: null,
  permissionProfile: null,
  outputStyle: null,
  latestUsage: null,
  currentMaxContextTokens: null,
  toasts: [],
  fileBrowserOpen: false,
  fileBrowser: {
    expandedPaths: {},
    selectedKey: null,
    showHidden: false,
    searchQuery: '',
    treeCache: {},
    loadingPaths: {},
    errorByPath: {},
  },
  sidebarCollapsed: false,
  expandedFolders: {},
  sidebarExpanded: {},
  sidebarHidden: readInitialHidden(),
  sidebarGroupBy: readInitialGroupBy(),
  sidebarFilterOpen: false,
  // EXCLUSIVE-OVERLAY-SECTION
  activeOverlay: { kind: 'none' },
  // /EXCLUSIVE-OVERLAY-SECTION
  settingsOpen: false,
  backendServerOpen: false,
  providersConfig: null,
  projectSwitcherOpen: false,
  addProjectOpen: false,
  sessionSearchOpen: false,
  deleteSessionHandler: null,
  pendingQueue: [],
  // PRESENCE-SECTION
  peers: {},
  myPresenceUserId: getOrCreatePresenceUserId(),
  myPresenceDisplayName: (() => {
    const uid = getOrCreatePresenceUserId();
    return getOrCreatePresenceDisplayName(uid);
  })(),
  // PRESENCE-SECTION-END
  sessionMessages: {},
  sessionMessageIds: {},
  sessionMessagesOrder: [],
  slashCommands: [],
  slashCommandsOpen: false,
  composerDraft: '',
  skills: [],
  plugins: [],
  skillsOverlayOpen: false,
  pluginsOverlayOpen: false,
  addSkillOpen: false,
  plusMenuOpen: false,
  theme: readInitialTheme(),
  locale: readInitialLocale(),
  browser: INITIAL_BROWSER,
  agentTree: {},
  teamMessages: {},
  // AGENT-LIFECYCLE-SECTION
  agentReplyTarget: null,
  // /AGENT-LIFECYCLE-SECTION
  agentTeamPanelOpen: false,
  agentTeamAutoOpenedFor: [],
  agentsConfigOverlayOpen: false,
  agentsConfig: null,
  usageDashboardOpen: false,
  hooksOverlayOpen: false,
  memoryOverlayOpen: false,
  // TODO-WRITE-SECTION initial state
  sessionTodos: {},
  tasksPanelOpen: false,
  tasksPanelAutoOpenedFor: [],
  // /TODO-WRITE-SECTION
  pendingWakeups: {},

  // TABS-DOCK-SECTION initial state
  openTabs: readInitialTabs().openTabs,
  activeTab: readInitialTabs().activeTab,
  panelLayout: readInitialPanelLayout(),
  resizers: readInitialResizers(),
  rightDockTabOrder: readInitialRightDockOrder(),
  rightDockCollapsed: readInitialRightDockCollapsed(),
  activeRightDockTab: readInitialActiveRightDockTab(),
  // /TABS-DOCK-SECTION

  // WHITEBOARD-SECTION initial state
  whiteboardOpen: false,
  whiteboardPendingImage: null,
  // /WHITEBOARD-SECTION

  setConnection: (s) =>
    set((st) => ({ connection: { ...st.connection, ...s } })),
  setCsrfToken: (token) => set({ csrfToken: token }),
  setAuthError: (err) => set({ authError: err }),
  setProjects: (projects) => set({ projects }),
  setActiveProject: (id) => set({ activeProjectId: id }),
  setSessions: (sessions) => set({ sessions }),
  // TABS-DOCK-SECTION: setActiveSession side-channels into the tab
  // system so the chosen session auto-opens as a tab and is marked
  // active. The original `set({ activeSessionId: id })` shape is
  // preserved as the null-case fallthrough; non-null adds an `openTabs`
  // + `activeTab` write so the SessionTabs bar stays in sync.
  setActiveSession: (id) =>
    set((st) => {
      if (id === null) return { activeSessionId: null };
      const openTabs = st.openTabs.includes(id)
        ? st.openTabs
        : [...st.openTabs, id];
      persistTabs(openTabs, id);
      return {
        activeSessionId: id,
        openTabs,
        activeTab: id,
      };
    }),
  // /TABS-DOCK-SECTION
  setSessionStreaming: (sessionId) =>
    set((st) => {
      const cur = st.sessionStatus[sessionId];
      if (cur !== undefined && cur.status === 'streaming') return st;
      return {
        sessionStatus: {
          ...st.sessionStatus,
          [sessionId]: { status: 'streaming' },
        },
      };
    }),
  setSessionFinished: (sessionId) =>
    set((st) => ({
      sessionStatus: {
        ...st.sessionStatus,
        [sessionId]: { status: 'recently-finished', finishedAt: Date.now() },
      },
    })),
  clearSessionStatus: (sessionId) =>
    set((st) => {
      if (st.sessionStatus[sessionId] === undefined) return st;
      const next = { ...st.sessionStatus };
      delete next[sessionId];
      return { sessionStatus: next };
    }),
  tickSessionStatus: () =>
    set((st) => {
      const now = Date.now();
      let mutated = false;
      const next: Record<string, SessionStatusEntry> = {};
      for (const [id, entry] of Object.entries(st.sessionStatus)) {
        if (
          entry.status === 'recently-finished' &&
          entry.finishedAt !== undefined &&
          now - entry.finishedAt >= SESSION_STATUS_RECENT_MS
        ) {
          mutated = true;
          continue; // drop → idle
        }
        next[id] = entry;
      }
      if (!mutated) return st;
      return { sessionStatus: next };
    }),
  setProviderInfo: ({ backend, baseUrl, models, currentModel }) =>
    set({
      activeBackend: backend,
      baseUrl,
      models: [...models],
      currentModel,
    }),
  setPermissionProfile: (profile) => set({ permissionProfile: profile }),
  setOutputStyle: (style) => set({ outputStyle: style }),
  setLatestUsage: (usage) => set({ latestUsage: usage }),
  setCurrentMaxContextTokens: (n) => set({ currentMaxContextTokens: n }),
  pushToast: (t) =>
    set((st) => ({
      toasts: [
        ...st.toasts,
        { ...t, id: makeId(), createdAt: Date.now() },
      ],
    })),
  dismissToast: (id) =>
    set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
  toggleSidebar: () =>
    set((st) => ({ sidebarCollapsed: !st.sidebarCollapsed })),
  toggleFileBrowser: () =>
    set((st) => ({ fileBrowserOpen: !st.fileBrowserOpen })),
  toggleFileBrowserExpanded: (key) =>
    set((st) => {
      const next = { ...st.fileBrowser.expandedPaths };
      if (next[key] === true) {
        delete next[key];
      } else {
        next[key] = true;
      }
      return { fileBrowser: { ...st.fileBrowser, expandedPaths: next } };
    }),
  setFileBrowserExpanded: (key, expanded) =>
    set((st) => {
      const cur = st.fileBrowser.expandedPaths[key] === true;
      if (cur === expanded) return st;
      const next = { ...st.fileBrowser.expandedPaths };
      if (expanded) {
        next[key] = true;
      } else {
        delete next[key];
      }
      return { fileBrowser: { ...st.fileBrowser, expandedPaths: next } };
    }),
  setFileBrowserSelected: (key) =>
    set((st) => ({
      fileBrowser: { ...st.fileBrowser, selectedKey: key },
    })),
  setFileBrowserShowHidden: (v) =>
    set((st) => ({
      // Toggling the filter invalidates cached listings (they may not
      // include dotfiles); drop the cache so the next expand triggers a
      // fresh fetch. Keep expansion state — folders the user opened
      // before are still meaningful.
      fileBrowser: {
        ...st.fileBrowser,
        showHidden: v,
        treeCache: {},
        errorByPath: {},
      },
    })),
  setFileBrowserSearch: (q) =>
    set((st) => ({
      fileBrowser: { ...st.fileBrowser, searchQuery: q },
    })),
  setFileBrowserTreeCache: (key, entries) =>
    set((st) => {
      const cache = { ...st.fileBrowser.treeCache, [key]: [...entries] };
      const errs = { ...st.fileBrowser.errorByPath };
      delete errs[key];
      return {
        fileBrowser: { ...st.fileBrowser, treeCache: cache, errorByPath: errs },
      };
    }),
  setFileBrowserLoading: (key, loading) =>
    set((st) => {
      const next = { ...st.fileBrowser.loadingPaths };
      if (loading) {
        next[key] = true;
      } else {
        delete next[key];
      }
      return { fileBrowser: { ...st.fileBrowser, loadingPaths: next } };
    }),
  setFileBrowserError: (key, err) =>
    set((st) => {
      const next = { ...st.fileBrowser.errorByPath };
      if (err === null) {
        delete next[key];
      } else {
        next[key] = err;
      }
      return { fileBrowser: { ...st.fileBrowser, errorByPath: next } };
    }),
  clearFileBrowserCache: (projectId) =>
    set((st) => {
      if (projectId === undefined) {
        return {
          fileBrowser: {
            ...st.fileBrowser,
            treeCache: {},
            loadingPaths: {},
            errorByPath: {},
          },
        };
      }
      // Drop only entries that belong to the specified project. Keys
      // are `${projectId}:${relativePath}`.
      const prefix = `${projectId}:`;
      const filter = <T,>(obj: Record<string, T>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (!k.startsWith(prefix)) out[k] = v;
        }
        return out;
      };
      return {
        fileBrowser: {
          ...st.fileBrowser,
          treeCache: filter(st.fileBrowser.treeCache),
          loadingPaths: filter(st.fileBrowser.loadingPaths),
          errorByPath: filter(st.fileBrowser.errorByPath),
        },
      };
    }),
  toggleFolder: (projectId) =>
    set((st) => ({
      expandedFolders: {
        ...st.expandedFolders,
        [projectId]: !(st.expandedFolders[projectId] ?? true),
      },
    })),
  setFolderExpanded: (projectId, expanded) =>
    set((st) => ({
      expandedFolders: { ...st.expandedFolders, [projectId]: expanded },
    })),
  toggleProjectExpanded: (projectId) =>
    set((st) => ({
      sidebarExpanded: {
        ...st.sidebarExpanded,
        [projectId]: !(st.sidebarExpanded[projectId] ?? true),
      },
    })),
  setProjectExpanded: (projectId, expanded) =>
    set((st) => ({
      sidebarExpanded: { ...st.sidebarExpanded, [projectId]: expanded },
    })),
  hideProject: (projectId) =>
    set((st) => {
      if (st.sidebarHidden.includes(projectId)) return st;
      const next = [...st.sidebarHidden, projectId];
      persistHidden(next);
      return { sidebarHidden: next };
    }),
  restoreHiddenProjects: () =>
    set(() => {
      persistHidden([]);
      return { sidebarHidden: [] };
    }),
  setSidebarGroupBy: (mode) => {
    persistGroupBy(mode);
    set({ sidebarGroupBy: mode, sidebarFilterOpen: false });
  },
  openSidebarFilter: () => set({ sidebarFilterOpen: true }),
  closeSidebarFilter: () => set({ sidebarFilterOpen: false }),
  // EXCLUSIVE-OVERLAY-SECTION
  openOverlay: (next) =>
    set(() => ({
      activeOverlay: next,
      ...OVERLAY_RESET_PATCH,
      ...legacyBooleanPatchForKind(next.kind),
    })),
  closeOverlay: () =>
    set(() => ({
      activeOverlay: { kind: 'none' },
      ...OVERLAY_RESET_PATCH,
    })),
  // /EXCLUSIVE-OVERLAY-SECTION
  openSettings: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'settings' },
      settingsOpen: true,
    })),
  closeSettings: () =>
    set((st) => ({
      settingsOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'settings' ? { kind: 'none' } : st.activeOverlay,
    })),
  openBackendServer: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'backend-server' },
      backendServerOpen: true,
    })),
  closeBackendServer: () =>
    set((st) => ({
      backendServerOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'backend-server' ? { kind: 'none' } : st.activeOverlay,
    })),
  setProvidersConfig: (c) => set({ providersConfig: c }),
  openProjectSwitcher: () => set({ projectSwitcherOpen: true }),
  closeProjectSwitcher: () => set({ projectSwitcherOpen: false }),
  openAddProject: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'add-project' },
      addProjectOpen: true,
    })),
  closeAddProject: () =>
    set((st) => ({
      addProjectOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'add-project' ? { kind: 'none' } : st.activeOverlay,
    })),
  // Cmd+K and sidebar filter both open the cross-session search overlay.
  // The sidebar filter popover is dismissed alongside so the user sees a
  // single dialog rather than a stacked popover + modal.
  openSessionSearch: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'session-search' },
      sessionSearchOpen: true,
      sidebarFilterOpen: false,
    })),
  closeSessionSearch: () =>
    set((st) => ({
      sessionSearchOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'session-search' ? { kind: 'none' } : st.activeOverlay,
    })),
  setDeleteSessionHandler: (handler) => set({ deleteSessionHandler: handler }),
  setSlashCommands: (list) => set({ slashCommands: list }),
  openSlashCommands: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'slash-commands' },
      slashCommandsOpen: true,
    })),
  closeSlashCommands: () =>
    set((st) => ({
      slashCommandsOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'slash-commands' ? { kind: 'none' } : st.activeOverlay,
    })),
  // UPDATE-MODAL-STORE-SECTION
  setUpdateAvailable: (info) =>
    set({ updateAvailable: info, updateModalOpen: true }),
  setUpdateDownloaded: (version) =>
    set({ updateDownloadedVersion: version }),
  closeUpdateModal: () => set({ updateModalOpen: false }),
  // UPDATE-MODAL-STORE-SECTION-END
  setComposerDraft: (text) => set({ composerDraft: text }),
  // QUEUE-NEXT-STORE-SECTION — start
  enqueueMessage: (content) => {
    const trimmed = content.trim();
    if (trimmed.length === 0) return null;
    const id = makePendingId();
    const item: PendingQueueItem = {
      id,
      content,
      createdAt: Date.now(),
    };
    set((st) => ({ pendingQueue: [...st.pendingQueue, item] }));
    return id;
  },
  dequeueMessage: (id) =>
    set((st) => {
      const next = st.pendingQueue.filter((it) => it.id !== id);
      // Identity short-circuit so unknown-id calls don't trigger
      // store-subscriber re-renders.
      if (next.length === st.pendingQueue.length) return st;
      return { pendingQueue: next };
    }),
  drainPendingQueue: (): readonly PendingQueueItem[] => {
    // Read-then-clear pattern. Inlined via `set` with a synchronous
    // mutation cycle so we don't reach into `useStore.getState()` —
    // that recursive reference defeats type inference on `create<>`
    // and cascaded to ~370 errors across the app.
    let prior: readonly PendingQueueItem[] = [];
    set((st) => {
      prior = st.pendingQueue;
      if (prior.length === 0) return st;
      return { pendingQueue: [] };
    });
    return prior;
  },
  clearPendingQueue: () => set({ pendingQueue: [] }),
  // QUEUE-NEXT-STORE-SECTION — end
  // PRESENCE-SECTION
  upsertPeer: (sessionId, peer) =>
    set((st) => {
      // Never store our own userId — we know who we are. Defense in
      // depth: the server is supposed to skip us in fanout already.
      if (peer.userId === st.myPresenceUserId) return st;
      const existing = st.peers[sessionId] ?? {};
      const current = existing[peer.userId];
      // Identity short-circuit when nothing actually changed (typing
      // hasn't flipped and the heartbeat is within 250 ms — protects
      // against subscriber re-renders on every keystroke from a chatty
      // peer).
      if (
        current !== undefined &&
        current.typing === peer.typing &&
        current.displayName === peer.displayName &&
        peer.lastSeenMs - current.lastSeenMs < 250
      ) {
        return st;
      }
      return {
        peers: {
          ...st.peers,
          [sessionId]: { ...existing, [peer.userId]: peer },
        },
      };
    }),
  removePeer: (sessionId, userId) =>
    set((st) => {
      const existing = st.peers[sessionId];
      if (existing === undefined || existing[userId] === undefined) return st;
      const nextBucket: Record<string, PeerInfo> = {};
      for (const [k, v] of Object.entries(existing)) {
        if (k === userId) continue;
        nextBucket[k] = v;
      }
      return {
        peers: { ...st.peers, [sessionId]: nextBucket },
      };
    }),
  sweepStalePeers: (now) =>
    set((st) => {
      const cutoff = (now ?? Date.now()) - PRESENCE_VISIBLE_WINDOW_MS;
      let mutated = false;
      const nextPeers: Record<string, Record<string, PeerInfo>> = {};
      for (const [sid, bucket] of Object.entries(st.peers)) {
        const nextBucket: Record<string, PeerInfo> = {};
        for (const [uid, peer] of Object.entries(bucket)) {
          if (peer.lastSeenMs < cutoff) {
            mutated = true;
            continue;
          }
          nextBucket[uid] = peer;
        }
        nextPeers[sid] = nextBucket;
      }
      if (!mutated) return st;
      return { peers: nextPeers };
    }),
  setPresenceDisplayName: (name) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(PRESENCE_DISPLAY_NAME_KEY, trimmed);
      } catch {
        /* ignored */
      }
    }
    set({ myPresenceDisplayName: trimmed });
  },
  // PRESENCE-SECTION-END
  setSessionMessages: (sessionId, msgs) =>
    set((st) => applySetSessionMessages(st, sessionId, msgs)),
  setSessionMessagesIfChanged: (sessionId, msgs) =>
    set((st) => {
      // Identity short-circuit — write-through during streaming can fire
      // with the exact same array reference once nothing changed.
      if (st.sessionMessages[sessionId] === msgs) return st;
      return applySetSessionMessages(st, sessionId, msgs);
    }),
  appendSessionMessage: (sessionId, msg) =>
    set((st) => {
      const existingIds = st.sessionMessageIds[sessionId];
      // O(1) dedup via parallel id-set — protects against double-commits
      // from WS replays without paying for a linear scan on long sessions.
      if (existingIds !== undefined && existingIds.has(msg.id)) return st;
      const existing = st.sessionMessages[sessionId] ?? [];
      const nextMsgs = [...existing, msg];
      const nextIds = new Set(existingIds);
      nextIds.add(msg.id);
      return applyCacheSlot(st, sessionId, nextMsgs, nextIds);
    }),
  clearSessionMessages: (sessionId) =>
    set((st) => {
      if (st.sessionMessages[sessionId] === undefined) return st;
      const next = { ...st.sessionMessages };
      delete next[sessionId];
      const nextIds = { ...st.sessionMessageIds };
      delete nextIds[sessionId];
      const nextOrder = st.sessionMessagesOrder.filter((id) => id !== sessionId);
      return {
        sessionMessages: next,
        sessionMessageIds: nextIds,
        sessionMessagesOrder: nextOrder,
      };
    }),

  setSkills: (skills) => set({ skills }),
  setPlugins: (plugins) => set({ plugins }),
  toggleSkillLocal: (id) =>
    set((st) => ({
      skills: st.skills.map((s) =>
        s.id === id ? { ...s, active: !s.active } : s,
      ),
    })),
  openSkillsOverlay: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'skills' },
      skillsOverlayOpen: true,
      plusMenuOpen: false,
    })),
  closeSkillsOverlay: () =>
    set((st) => ({
      skillsOverlayOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'skills' ? { kind: 'none' } : st.activeOverlay,
    })),
  openPluginsOverlay: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'plugins' },
      pluginsOverlayOpen: true,
      plusMenuOpen: false,
    })),
  closePluginsOverlay: () =>
    set((st) => ({
      pluginsOverlayOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'plugins' ? { kind: 'none' } : st.activeOverlay,
    })),
  openAddSkill: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'add-skill' },
      addSkillOpen: true,
      plusMenuOpen: false,
    })),
  closeAddSkill: () =>
    set((st) => ({
      addSkillOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'add-skill' ? { kind: 'none' } : st.activeOverlay,
    })),
  openPlusMenu: () => set({ plusMenuOpen: true }),
  closePlusMenu: () => set({ plusMenuOpen: false }),
  openBrowserPanel: () =>
    set((st) => ({ browser: { ...st.browser, open: true } })),
  closeBrowserPanel: () =>
    set((st) => ({ browser: { ...st.browser, open: false } })),
  toggleBrowserPanel: () =>
    set((st) => ({ browser: { ...st.browser, open: !st.browser.open } })),
  setBrowserState: ({ status, url, title, errorMessage }) =>
    set((st) => {
      const next: BrowserSlice = { ...st.browser, status };
      if (url !== undefined) next.url = url;
      else delete next.url;
      if (title !== undefined) next.title = title;
      else delete next.title;
      if (errorMessage !== undefined) next.errorMessage = errorMessage;
      else delete next.errorMessage;
      // Auto-open on first 'starting' transition.
      if (status === 'starting' && !st.browser.open) next.open = true;
      return { browser: next };
    }),
  appendBrowserFrame: (frame) =>
    set((st) => ({ browser: { ...st.browser, latestFrame: frame } })),
  appendBrowserConsole: (entry) =>
    set((st) => {
      const next: BrowserConsoleEntry = {
        id: makeId(),
        receivedAt: Date.now(),
        level: entry.level,
        text: entry.text,
        ...(entry.source !== undefined ? { source: entry.source } : {}),
        ...(entry.line !== undefined ? { line: entry.line } : {}),
      };
      const buf = [...st.browser.console, next];
      const trimmed =
        buf.length > BROWSER_CONSOLE_CAP
          ? buf.slice(buf.length - BROWSER_CONSOLE_CAP)
          : buf;
      return { browser: { ...st.browser, console: trimmed } };
    }),
  enqueueBrowserCursor: (event) =>
    set((st) => ({
      browser: {
        ...st.browser,
        cursorQueue: [...st.browser.cursorQueue, { ...event, id: makeId() }],
      },
    })),
  dequeueBrowserCursor: (id) =>
    set((st) => ({
      browser: {
        ...st.browser,
        cursorQueue: st.browser.cursorQueue.filter((c) => c.id !== id),
      },
    })),
  clearBrowserState: () => set({ browser: { ...INITIAL_BROWSER } }),

  upsertAgent: (node) =>
    set((st) => {
      const existing = st.agentTree[node.parentSessionId] ?? [];
      const idx = existing.findIndex((a) => a.agentId === node.agentId);
      let nextList: AgentNode[];
      if (idx === -1) {
        nextList = [...existing, node];
      } else {
        nextList = existing.slice();
        const prev = existing[idx];
        if (prev !== undefined) {
          nextList[idx] = { ...prev, ...node };
        } else {
          nextList[idx] = node;
        }
      }
      nextList.sort((a, b) => a.startedAt - b.startedAt);
      // Auto-open panel on first spawn for this session.
      const alreadyOpened = st.agentTeamAutoOpenedFor.includes(
        node.parentSessionId,
      );
      const shouldAutoOpen = !alreadyOpened && existing.length === 0;
      return {
        agentTree: { ...st.agentTree, [node.parentSessionId]: nextList },
        ...(shouldAutoOpen
          ? {
              agentTeamPanelOpen: true,
              agentTeamAutoOpenedFor: [
                ...st.agentTeamAutoOpenedFor,
                node.parentSessionId,
              ],
            }
          : {}),
      };
    }),
  updateAgentStatus: (parentSessionId, agentId, partial) =>
    set((st) => {
      const list = st.agentTree[parentSessionId];
      if (list === undefined) return st;
      const idx = list.findIndex((a) => a.agentId === agentId);
      if (idx === -1) return st;
      const prev = list[idx];
      if (prev === undefined) return st;
      const nextList = list.slice();
      nextList[idx] = { ...prev, ...partial };
      // AGENT-LIFECYCLE-SECTION
      // If the agent we were replying to has terminated, drop the
      // reply target so the next Composer send falls back to the lead.
      const nextStatus = partial.status ?? prev.status;
      const isTerminal =
        nextStatus === 'done' ||
        nextStatus === 'failed' ||
        nextStatus === 'cancelled';
      const isReplyTarget =
        st.agentReplyTarget !== null &&
        st.agentReplyTarget.parentSessionId === parentSessionId &&
        st.agentReplyTarget.agentId === agentId;
      const patch: Partial<typeof st> = {
        agentTree: { ...st.agentTree, [parentSessionId]: nextList },
      };
      if (isTerminal && isReplyTarget) {
        patch.agentReplyTarget = null;
      }
      return patch;
      // /AGENT-LIFECYCLE-SECTION
    }),
  appendTeamMessage: (msg) =>
    set((st) => {
      const existing = st.teamMessages[msg.sessionId] ?? [];
      const next = [...existing, msg];
      const trimmed =
        next.length > TEAM_MESSAGE_CAP
          ? next.slice(next.length - TEAM_MESSAGE_CAP)
          : next;
      return {
        teamMessages: { ...st.teamMessages, [msg.sessionId]: trimmed },
      };
    }),
  clearAgentTeam: (parentSessionId) =>
    set((st) => {
      const nextTree = { ...st.agentTree };
      const nextMsgs = { ...st.teamMessages };
      delete nextTree[parentSessionId];
      delete nextMsgs[parentSessionId];
      // AGENT-LIFECYCLE-SECTION — drop reply-target if it pointed here.
      const replyClearPatch =
        st.agentReplyTarget !== null &&
        st.agentReplyTarget.parentSessionId === parentSessionId
          ? { agentReplyTarget: null }
          : {};
      // /AGENT-LIFECYCLE-SECTION
      return {
        agentTree: nextTree,
        teamMessages: nextMsgs,
        agentTeamAutoOpenedFor: st.agentTeamAutoOpenedFor.filter(
          (id) => id !== parentSessionId,
        ),
        ...replyClearPatch,
      };
    }),
  toggleAgentTeamPanel: () =>
    set((st) => ({ agentTeamPanelOpen: !st.agentTeamPanelOpen })),
  openAgentTeamPanel: () => set({ agentTeamPanelOpen: true }),
  closeAgentTeamPanel: () => set({ agentTeamPanelOpen: false }),
  // AGENT-LIFECYCLE-SECTION
  enterAgentReply: (target) =>
    set((st) => {
      const cur = st.agentReplyTarget;
      if (
        cur !== null &&
        cur.parentSessionId === target.parentSessionId &&
        cur.agentId === target.agentId
      ) {
        return st;
      }
      return { agentReplyTarget: { ...target } };
    }),
  exitAgentReply: () => set({ agentReplyTarget: null }),
  // /AGENT-LIFECYCLE-SECTION
  openAgentsConfig: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'agents-config' },
      agentsConfigOverlayOpen: true,
    })),
  closeAgentsConfig: () =>
    set((st) => ({
      agentsConfigOverlayOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'agents-config' ? { kind: 'none' } : st.activeOverlay,
    })),
  setAgentsConfig: (c) => set({ agentsConfig: c }),
  openUsageDashboard: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'usage' },
      usageDashboardOpen: true,
    })),
  closeUsageDashboard: () =>
    set((st) => ({
      usageDashboardOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'usage' ? { kind: 'none' } : st.activeOverlay,
    })),
  toggleUsageDashboard: () =>
    set((st) =>
      st.usageDashboardOpen
        ? {
            usageDashboardOpen: false,
            activeOverlay:
              st.activeOverlay.kind === 'usage' ? { kind: 'none' } : st.activeOverlay,
          }
        : {
            ...OVERLAY_RESET_PATCH,
            activeOverlay: { kind: 'usage' },
            usageDashboardOpen: true,
          },
    ),

  openHooksOverlay: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'hooks' },
      hooksOverlayOpen: true,
    })),
  closeHooksOverlay: () =>
    set((st) => ({
      hooksOverlayOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'hooks' ? { kind: 'none' } : st.activeOverlay,
    })),

  // Memory overlay
  openMemoryOverlay: () =>
    set(() => ({
      ...OVERLAY_RESET_PATCH,
      activeOverlay: { kind: 'memory' },
      memoryOverlayOpen: true,
    })),
  closeMemoryOverlay: () =>
    set((st) => ({
      memoryOverlayOpen: false,
      activeOverlay:
        st.activeOverlay.kind === 'memory' ? { kind: 'none' } : st.activeOverlay,
    })),

  // TODO-WRITE-SECTION actions
  setSessionTodos: (sessionId, todos) =>
    set((st) => {
      const nextTodos = { ...st.sessionTodos, [sessionId]: [...todos] };
      // Auto-open the panel the first time todos arrive for a session
      // (unless it was already auto-opened for this session before).
      const alreadyOpened = st.tasksPanelAutoOpenedFor.includes(sessionId);
      const shouldAutoOpen = !alreadyOpened && todos.length > 0;
      return {
        sessionTodos: nextTodos,
        ...(shouldAutoOpen
          ? {
              tasksPanelOpen: true,
              tasksPanelAutoOpenedFor: [...st.tasksPanelAutoOpenedFor, sessionId],
            }
          : {}),
      };
    }),
  setPendingWakeups: (sessionId, wakeups) =>
    set((st) => ({
      pendingWakeups: { ...st.pendingWakeups, [sessionId]: [...wakeups] },
    })),
  openTasksPanel: () => set({ tasksPanelOpen: true }),
  closeTasksPanel: () => set({ tasksPanelOpen: false }),
  toggleTasksPanel: () => set((st) => ({ tasksPanelOpen: !st.tasksPanelOpen })),
  // /TODO-WRITE-SECTION

  setTheme: (theme) => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        /* ignored */
      }
      if (typeof document !== 'undefined') {
        document.documentElement.dataset.theme = theme;
      }
    }
    set({ theme });
  },

  setLocale: (locale) => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      } catch {
        /* ignored */
      }
      if (typeof document !== 'undefined') {
        // Mirror onto `<html lang>` so screen readers + CSS `:lang(ru)`
        // selectors observe the active locale.
        document.documentElement.lang = locale;
      }
    }
    set({ locale });
  },

  // TABS-DOCK-SECTION actions
  openTab: (sessionId) =>
    set((st) => {
      if (st.openTabs.includes(sessionId)) {
        if (st.activeTab === sessionId) return st;
        persistTabs(st.openTabs, sessionId);
        return { activeTab: sessionId, activeSessionId: sessionId };
      }
      const nextTabs = [...st.openTabs, sessionId];
      persistTabs(nextTabs, sessionId);
      return {
        openTabs: nextTabs,
        activeTab: sessionId,
        activeSessionId: sessionId,
      };
    }),
  closeTab: (sessionId) =>
    set((st) => {
      const idx = st.openTabs.indexOf(sessionId);
      if (idx === -1) return st;
      const nextTabs = st.openTabs.filter((t) => t !== sessionId);
      let nextActive: string | null = st.activeTab;
      let nextSession: string | null = st.activeSessionId;
      if (st.activeTab === sessionId) {
        // Prefer the next tab in the row, else the previous one.
        const replacement =
          nextTabs[idx] ?? nextTabs[idx - 1] ?? nextTabs[0] ?? null;
        nextActive = replacement;
        nextSession = replacement;
      }
      persistTabs(nextTabs, nextActive);
      return {
        openTabs: nextTabs,
        activeTab: nextActive,
        activeSessionId: nextSession,
      };
    }),
  setActiveTab: (sessionId) =>
    set((st) => {
      if (st.activeTab === sessionId && st.activeSessionId === sessionId) {
        return st;
      }
      persistTabs(st.openTabs, sessionId);
      return {
        activeTab: sessionId,
        activeSessionId: sessionId,
      };
    }),
  switchTabByIndex: (index) =>
    set((st) => {
      if (index < 0 || index >= st.openTabs.length) return st;
      const target = st.openTabs[index];
      if (target === undefined || target === st.activeTab) return st;
      persistTabs(st.openTabs, target);
      return { activeTab: target, activeSessionId: target };
    }),
  reorderTabs: (next) =>
    set((st) => {
      // Defensive: ensure no duplicates and only known tab ids.
      const known = new Set(st.openTabs);
      const filtered: string[] = [];
      const seen = new Set<string>();
      for (const id of next) {
        if (known.has(id) && !seen.has(id)) {
          filtered.push(id);
          seen.add(id);
        }
      }
      // Append any tabs missing from `next` so we never lose state.
      for (const id of st.openTabs) {
        if (!seen.has(id)) filtered.push(id);
      }
      persistTabs(filtered, st.activeTab);
      return { openTabs: filtered };
    }),
  movePanel: (id, position) =>
    set((st) => {
      const nextPanels = st.panelLayout.panels.map((p) =>
        p.id === id ? { ...p, position } : p,
      );
      const next: PanelLayout = { panels: nextPanels };
      persistPanelLayout(next);
      return { panelLayout: next };
    }),
  togglePanelVisibility: (id) =>
    set((st) => {
      const def = DEFAULT_PANEL_LAYOUT.panels.find((p) => p.id === id);
      const fallback: PanelPosition = def?.position ?? 'right';
      const nextPanels = st.panelLayout.panels.map((p) =>
        p.id === id
          ? { ...p, position: p.position === 'hidden' ? fallback : 'hidden' }
          : p,
      );
      const next: PanelLayout = { panels: nextPanels };
      persistPanelLayout(next);
      return { panelLayout: next };
    }),
  resetDockLayout: () =>
    set(() => {
      const cloned: PanelLayout = {
        panels: DEFAULT_PANEL_LAYOUT.panels.map((p) => ({ ...p })),
      };
      persistPanelLayout(cloned);
      persistRightDockOrder(DEFAULT_RIGHT_DOCK_ORDER);
      persistRightDockCollapsed(false);
      return {
        panelLayout: cloned,
        rightDockTabOrder: [...DEFAULT_RIGHT_DOCK_ORDER],
        rightDockCollapsed: false,
      };
    }),
  setResizerValue: (key, value) =>
    set((st) => {
      if (st.resizers[key] === value) return st;
      const next = { ...st.resizers, [key]: value };
      persistResizers(next);
      return { resizers: next };
    }),
  setRightDockTabOrder: (next) =>
    set((st) => {
      const ids = new Set<DockPanelId>(DEFAULT_DOCK_PANEL_IDS);
      const filtered: DockPanelId[] = [];
      const seen = new Set<DockPanelId>();
      for (const id of next) {
        if (ids.has(id) && !seen.has(id)) {
          filtered.push(id);
          seen.add(id);
        }
      }
      for (const id of st.rightDockTabOrder) {
        if (!seen.has(id)) filtered.push(id);
      }
      persistRightDockOrder(filtered);
      return { rightDockTabOrder: filtered };
    }),
  setActiveRightDockTab: (id) => {
    persistActiveRightDockTab(id);
    set({ activeRightDockTab: id });
  },
  toggleRightDockCollapsed: () =>
    set((st) => {
      const next = !st.rightDockCollapsed;
      persistRightDockCollapsed(next);
      return { rightDockCollapsed: next };
    }),
  // /TABS-DOCK-SECTION

  // WHITEBOARD-SECTION actions
  openWhiteboard: () =>
    set((st) => {
      // Force-promote the whiteboard panel back into the right dock when
      // the user has previously hidden / moved it elsewhere, otherwise
      // `whiteboardOpen=true` would have no visible surface.
      const layout = st.panelLayout;
      const entry = layout.panels.find((p) => p.id === 'whiteboard');
      let nextLayout = layout;
      if (entry === undefined || entry.position === 'hidden') {
        const def = DEFAULT_PANEL_LAYOUT.panels.find((p) => p.id === 'whiteboard');
        const fallback: PanelLayoutEntry =
          def !== undefined ? { ...def } : { id: 'whiteboard', position: 'right', size: 0.6 };
        const others = layout.panels.filter((p) => p.id !== 'whiteboard');
        nextLayout = { panels: [...others, fallback] };
        persistPanelLayout(nextLayout);
      }
      persistActiveRightDockTab('whiteboard');
      return {
        whiteboardOpen: true,
        panelLayout: nextLayout,
        activeRightDockTab: 'whiteboard',
      };
    }),
  closeWhiteboard: () => set({ whiteboardOpen: false }),
  toggleWhiteboard: () =>
    set((st) => {
      if (st.whiteboardOpen) return { whiteboardOpen: false };
      // Defer to openWhiteboard's promote logic by simulating its body
      // inline — duplicate kept tiny so the toggle path stays a single
      // setState call.
      const layout = st.panelLayout;
      const entry = layout.panels.find((p) => p.id === 'whiteboard');
      let nextLayout = layout;
      if (entry === undefined || entry.position === 'hidden') {
        const def = DEFAULT_PANEL_LAYOUT.panels.find((p) => p.id === 'whiteboard');
        const fallback: PanelLayoutEntry =
          def !== undefined ? { ...def } : { id: 'whiteboard', position: 'right', size: 0.6 };
        const others = layout.panels.filter((p) => p.id !== 'whiteboard');
        nextLayout = { panels: [...others, fallback] };
        persistPanelLayout(nextLayout);
      }
      persistActiveRightDockTab('whiteboard');
      return {
        whiteboardOpen: true,
        panelLayout: nextLayout,
        activeRightDockTab: 'whiteboard',
      };
    }),
  setWhiteboardPendingImage: (img) => set({ whiteboardPendingImage: img }),
  // /WHITEBOARD-SECTION

  // NOTIFICATIONS-SECTION: actions
  pushNotification: (input) =>
    set((st) => {
      const entry: Notification = {
        id: input.id ?? makeId(),
        type: input.type,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        timestamp: input.timestamp ?? Date.now(),
        read: false,
      };
      const next = [...st.notifications, entry];
      // FIFO eviction — drop oldest when over the cap.
      const trimmed =
        next.length > NOTIFICATION_CAP
          ? next.slice(next.length - NOTIFICATION_CAP)
          : next;
      return { notifications: trimmed };
    }),
  markRead: (id) =>
    set((st) => {
      const idx = st.notifications.findIndex((n) => n.id === id);
      if (idx === -1) return st;
      const current = st.notifications[idx];
      if (current === undefined || current.read) return st;
      const nextList = st.notifications.slice();
      nextList[idx] = { ...current, read: true };
      return { notifications: nextList };
    }),
  markAllRead: () =>
    set((st) => {
      if (st.notifications.every((n) => n.read)) return st;
      return {
        notifications: st.notifications.map((n) =>
          n.read ? n : { ...n, read: true },
        ),
      };
    }),
  clearAll: () => set({ notifications: [] }),
  toggleNotificationCenter: () =>
    set((st) => ({ notificationsOpen: !st.notificationsOpen })),
  openNotificationCenter: () => set({ notificationsOpen: true }),
  closeNotificationCenter: () => set({ notificationsOpen: false }),
  setBrowserNotificationsEnabled: (v) => {
    persistBrowserNotifications(v);
    set({ browserNotificationsEnabled: v });
  },
  // /NOTIFICATIONS-SECTION
}));
