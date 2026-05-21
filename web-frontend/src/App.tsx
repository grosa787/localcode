/**
 * App.tsx — composition root for the LocalCode SPA.
 *
 * Responsibilities:
 *   1. Read CSRF token from `location.hash`, scrub it, store in
 *      sessionStorage (and the zustand store).
 *   2. Bootstrap projects/sessions/config via the REST client.
 *   3. Open a single WSClient that drives connection state.
 *   4. Render the shell — Sidebar / Main column / Toasts / ChatView.
 *
 * Phase 2 (Agent H): Agent F's chat surface (`<ChatView />`) is wired
 * here. The WSClient's single-consumer `onMessage` callback fans out to
 * a list of subscribers (`feedSubscribers`) so multiple components can
 * observe inbound frames without fighting over the slot.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  WSClientMessage,
  WSServerMessage,
} from '../../src/web/protocol/messages.js';
import type {
  AgentsConfigSnapshot,
  SessionSummaryWire,
} from '../../src/web/protocol/rest-types.js';

import { RestAuthError, RestClient } from './api/rest-client';
import { WSClient } from './api/ws-client';
import { AddProjectDialog } from './components/AddProjectDialog';
import { LanguagePicker } from './components/LanguagePicker';
import { AgentSettingsOverlay } from './components/AgentSettingsOverlay';
import { AgentTeamPanel } from './components/AgentTeamPanel';
import { TasksPanel } from './components/TasksPanel';
import { BrowserPanel } from './components/BrowserPanel';
import { AddSkillDialog } from './components/AddSkillDialog';
import { BackendServerOverlay } from './components/BackendServerOverlay';
import { ChatView } from './components/ChatView';
import { ProfileBanner } from './components/ProfileBanner';
import { PluginsOverlay } from './components/PluginsOverlay';
import { SessionSearchOverlay } from './components/SessionSearchOverlay';
import { SkillsOverlay } from './components/SkillsOverlay';
import { ConnectionBanner } from './components/ConnectionBanner';
import { EmptyState } from './components/EmptyState';
import { ProjectBar } from './components/ProjectBar';
// TABS-DOCK-SECTION
// RightDock removed Wave 8B — all panels accessible via ProjectBar top icons.
// Component file retained for backward compat; do not re-mount.
import { SessionTabs } from './components/SessionTabs';
// /TABS-DOCK-SECTION
import { MemoryEditor } from './components/MemoryEditor';
import { Modal, ModalBody } from './components/Modal';
// OVERLAY-HOST-MOUNT-SECTION
import { OverlayHost } from './components/OverlayHost';
import type { HookSummary } from './components/HookSettingsOverlay';
// /OVERLAY-HOST-MOUNT-SECTION
import { SettingsOverlay } from './components/SettingsOverlay';
import { Sidebar } from './components/Sidebar';
import { SlashCommandsOverlay } from './components/SlashCommandsOverlay';
import { StaleTokenBanner } from './components/StaleTokenBanner';
import { ToastStack } from './components/Toast';
import { UsageDashboard } from './components/UsageDashboard';
import { useT } from './i18n';
import { MessageSquare } from './icons';
// NOTIFICATIONS-SERVICE-MOUNT-SECTION
import { createNotificationsService } from './services/notifications-service';
// /NOTIFICATIONS-SERVICE-MOUNT-SECTION
import { useStore, type AgentNode, type AgentRunStatus } from './state/store';
// VIEWPORT-WIRE-SECTION
import { useViewportDataAttribute } from './util/use-viewport';
// /VIEWPORT-WIRE-SECTION
import styles from './App.module.css';

/**
 * Wire shape for agent_* frames sent by the backend orchestrator.
 * Defined locally because the canonical `WSServerMessage` union owned
 * by the backend agent may not yet carry these variants — the App's
 * dispatcher narrows by `type` and casts safely once the runtime check
 * succeeds.
 */
interface AgentSpawnedFrame {
  type: 'agent_spawned';
  sessionId: string;
  agentId: string;
  parentAgentId: string | null;
  model: string;
  task: string;
  ownedFiles: string[];
  worktreePath?: string;
  startedAt: number;
}
interface AgentStatusFrame {
  type: 'agent_status';
  sessionId: string;
  agentId: string;
  status: AgentRunStatus;
  lastMessage?: string;
  error?: string;
}
interface AgentTeamMessageFrame {
  type: 'agent_team_message';
  sessionId: string;
  from: string;
  to: string;
  message: string;
  at: number;
}
interface AgentCompletedFrame {
  type: 'agent_completed';
  sessionId: string;
  agentId: string;
  summary: string;
  diff?: string;
  durationMs: number;
}
type AgentFrame =
  | AgentSpawnedFrame
  | AgentStatusFrame
  | AgentTeamMessageFrame
  | AgentCompletedFrame;

interface GenerationParams {
  temperature: number;
  topP: number;
  repeatPenalty: number;
  maxTokens: number;
}

interface ApiClients {
  rest: RestClient;
  ws: WSClient;
  /**
   * Register a handler for inbound WS frames. Returns an unsubscriber.
   * Multi-subscriber fan-out — the App's WSClient single `onMessage`
   * iterates this set on every frame.
   */
  subscribeFeed: (handler: (msg: WSServerMessage) => void) => () => void;
  /** Convenience: send a frame (binds to the WSClient). */
  wsSend: (msg: WSClientMessage) => void;
}

const ApiClientsContext = createContext<ApiClients | null>(null);

/** Hook used inside the chat surface to get the live REST + WS clients. */
export function useApiClients(): ApiClients {
  const clients = useContext(ApiClientsContext);
  if (clients === null) {
    throw new Error('useApiClients must be used inside <App>');
  }
  return clients;
}

const HASH_TOKEN_PREFIX = '#token=';
const SESSION_STORAGE_TOKEN = 'localcode.web.csrf';

interface InitialTokenInfo {
  token: string | null;
  /**
   * True when `sessionStorage` already had a token cached at boot time
   * (i.e. the tab was reused). Used to discriminate a "first-ever
   * launch with no token in URL" — which should NOT trigger the
   * stale-token banner — from a stale-after-restart case.
   */
  hadCachedToken: boolean;
}

/** Pull the CSRF token from `location.hash`, then scrub it from the URL. */
function readCsrfToken(): InitialTokenInfo {
  if (typeof window === 'undefined') return { token: null, hadCachedToken: false };
  let cached: string | null = null;
  try {
    cached = sessionStorage.getItem(SESSION_STORAGE_TOKEN);
  } catch {
    /* ignored */
  }
  const hadCachedToken = cached !== null && cached.length > 0;
  const { hash } = window.location;
  if (hash.startsWith(HASH_TOKEN_PREFIX)) {
    const token = hash.slice(HASH_TOKEN_PREFIX.length);
    if (token.length > 0) {
      try {
        sessionStorage.setItem(SESSION_STORAGE_TOKEN, token);
      } catch {
        /* ignored */
      }
      const url = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', url);
      return { token, hadCachedToken };
    }
  }
  return { token: cached, hadCachedToken };
}

/** Wipe the cached CSRF token so a fresh URL paste replaces it cleanly. */
function clearCachedCsrfToken(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_TOKEN);
  } catch {
    /* ignored */
  }
}

function buildBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.protocol}//${window.location.host}`;
}

function buildWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function App(): JSX.Element {
  const t = useT();
  // VIEWPORT-WIRE-SECTION
  // Subscribe to viewport size and mirror the breakpoint to
  // <html data-viewport="…">. CSS rules in theme/globals.css and the
  // per-component RESPONSIVE-SECTION blocks consume the attribute.
  // The inline script in index.html already set the attribute before
  // first paint, so this just keeps it live on resize.
  const viewport = useViewportDataAttribute();
  // /VIEWPORT-WIRE-SECTION
  const [tokenInfo] = useState<InitialTokenInfo>(() => readCsrfToken());
  const token = tokenInfo.token;
  const [bootError, setBootError] = useState<string | null>(null);
  // LANGUAGE-PICKER-MOUNT-SECTION
  // First-launch language picker. Initialised synchronously so we never
  // render a flash of English copy before swapping to the user's chosen
  // locale on a fresh browser profile. The picker shows iff no locale
  // has been persisted yet (`localcode.locale` absent from storage).
  const [needsLanguagePick, setNeedsLanguagePick] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem('localcode.locale') === null;
    } catch {
      return false;
    }
  });
  const setStoreLocale = useStore((s) => s.setLocale);
  const handleLanguageSelect = useCallback(
    (locale: 'en' | 'ru'): void => {
      setStoreLocale(locale);
      setNeedsLanguagePick(false);
    },
    [setStoreLocale],
  );
  // LANGUAGE-PICKER-MOUNT-SECTION-END
  const [loadingSessions, setLoadingSessions] = useState<boolean>(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GenerationParams | null>(null);
  // OVERLAY-HOST-MOUNT-SECTION — hooks data fetched once on bootstrap so
  // OverlayHost can render <HookSettingsOverlay> with real entries when
  // the user opens it via /hooks or the Settings → Manage hooks button.
  const [hooksData, setHooksData] = useState<readonly HookSummary[]>([]);
  // /OVERLAY-HOST-MOUNT-SECTION

  // OVERLAY-HOST-MOUNT-SECTION — exclusive-overlay state for the host.
  const activeOverlay = useStore((s) => s.activeOverlay);
  // /OVERLAY-HOST-MOUNT-SECTION
  const settingsOpen = useStore((s) => s.settingsOpen);
  const backendServerOpen = useStore((s) => s.backendServerOpen);
  const setProvidersConfig = useStore((s) => s.setProvidersConfig);
  const agentsConfigOverlayOpen = useStore((s) => s.agentsConfigOverlayOpen);
  const setAgentsConfigStore = useStore((s) => s.setAgentsConfig);
  const usageDashboardOpen = useStore((s) => s.usageDashboardOpen);
  const memoryOverlayOpen = useStore((s) => s.memoryOverlayOpen);
  const closeMemoryOverlay = useStore((s) => s.closeMemoryOverlay);
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setProjectExpanded = useStore((s) => s.setProjectExpanded);
  const currentModel = useStore((s) => s.currentModel);
  const addProjectOpen = useStore((s) => s.addProjectOpen);
  const openAddProject = useStore((s) => s.openAddProject);
  const closeAddProject = useStore((s) => s.closeAddProject);
  const slashCommandsOpen = useStore((s) => s.slashCommandsOpen);
  const setSlashCommands = useStore((s) => s.setSlashCommands);
  const skillsOverlayOpen = useStore((s) => s.skillsOverlayOpen);
  const pluginsOverlayOpen = useStore((s) => s.pluginsOverlayOpen);
  const addSkillOpen = useStore((s) => s.addSkillOpen);
  const sessionSearchOpen = useStore((s) => s.sessionSearchOpen);
  const openSessionSearch = useStore((s) => s.openSessionSearch);
  const closeSessionSearch = useStore((s) => s.closeSessionSearch);
  const setSkills = useStore((s) => s.setSkills);
  const setPlugins = useStore((s) => s.setPlugins);

  const setBrowserState = useStore((s) => s.setBrowserState);
  const appendBrowserFrame = useStore((s) => s.appendBrowserFrame);
  const appendBrowserConsole = useStore((s) => s.appendBrowserConsole);
  const enqueueBrowserCursor = useStore((s) => s.enqueueBrowserCursor);
  const clearBrowserState = useStore((s) => s.clearBrowserState);
  const closeBrowserPanel = useStore((s) => s.closeBrowserPanel);

  const upsertAgent = useStore((s) => s.upsertAgent);
  const updateAgentStatus = useStore((s) => s.updateAgentStatus);
  const appendTeamMessage = useStore((s) => s.appendTeamMessage);

  const setConnection = useStore((s) => s.setConnection);
  const setCsrfToken = useStore((s) => s.setCsrfToken);
  const setAuthError = useStore((s) => s.setAuthError);
  const authError = useStore((s) => s.authError);
  const setProjects = useStore((s) => s.setProjects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setSessions = useStore((s) => s.setSessions);
  const setProviderInfo = useStore((s) => s.setProviderInfo);
  const setPermissionProfile = useStore((s) => s.setPermissionProfile);
  const setOutputStyle = useStore((s) => s.setOutputStyle);
  const setCurrentMaxContextTokens = useStore((s) => s.setCurrentMaxContextTokens);
  const pushToast = useStore((s) => s.pushToast);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeBackend = useStore((s) => s.activeBackend);
  const baseUrl = useStore((s) => s.baseUrl);
  const sessions = useStore((s) => s.sessions);
  const setSessionStreaming = useStore((s) => s.setSessionStreaming);
  const setSessionFinished = useStore((s) => s.setSessionFinished);
  const setSessionTodos = useStore((s) => s.setSessionTodos);
  const setPendingWakeups = useStore((s) => s.setPendingWakeups);
  const tickSessionStatus = useStore((s) => s.tickSessionStatus);
  const clearSessionStatus = useStore((s) => s.clearSessionStatus);

  // Multi-subscriber fan-out for inbound WS frames. App.tsx owns the
  // canonical WSClient (with its single `onMessage` slot), and exposes
  // `subscribeFeed` so components like ChatView can react to streaming
  // events without fighting over the slot.
  const feedSubscribersRef = useRef<Set<(msg: WSServerMessage) => void>>(
    new Set(),
  );

  const handleAgentFrame = useCallback(
    (msg: AgentFrame): void => {
      if (msg.type === 'agent_spawned') {
        upsertAgent({
          agentId: msg.agentId,
          parentAgentId: msg.parentAgentId,
          parentSessionId: msg.sessionId,
          model: msg.model,
          task: msg.task,
          ownedFiles: [...msg.ownedFiles],
          ...(msg.worktreePath !== undefined
            ? { worktreePath: msg.worktreePath }
            : {}),
          startedAt: msg.startedAt,
          status: 'running',
        });
      } else if (msg.type === 'agent_status') {
        const partial: Partial<AgentNode> = { status: msg.status };
        if (msg.lastMessage !== undefined) partial.lastMessage = msg.lastMessage;
        if (msg.error !== undefined) partial.error = msg.error;
        updateAgentStatus(msg.sessionId, msg.agentId, partial);
      } else if (msg.type === 'agent_completed') {
        const partial: Partial<AgentNode> = {
          status: 'done',
          summary: msg.summary,
          completedAt: Date.now(),
        };
        if (msg.diff !== undefined) partial.diff = msg.diff;
        updateAgentStatus(msg.sessionId, msg.agentId, partial);
      } else if (msg.type === 'agent_team_message') {
        appendTeamMessage({
          id:
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${msg.at}-${Math.random().toString(36).slice(2)}`,
          sessionId: msg.sessionId,
          from: msg.from,
          to: msg.to,
          message: msg.message,
          at: msg.at,
        });
      }
    },
    [upsertAgent, updateAgentStatus, appendTeamMessage],
  );

  const fanOut = useCallback((msg: WSServerMessage): void => {
    // Update store-level state for global frames first.
    if (msg.type === 'provider_changed') {
      setProviderInfo({
        backend: msg.backend,
        baseUrl: msg.baseUrl,
        models: msg.models,
        currentModel: msg.currentModel,
      });
    } else if (msg.type === 'browser_state') {
      setBrowserState({
        status: msg.status,
        ...(msg.url !== undefined ? { url: msg.url } : {}),
        ...(msg.title !== undefined ? { title: msg.title } : {}),
        ...(msg.errorMessage !== undefined
          ? { errorMessage: msg.errorMessage }
          : {}),
      });
    } else if (msg.type === 'browser_frame') {
      appendBrowserFrame(msg.frame);
    } else if (msg.type === 'browser_cursor') {
      enqueueBrowserCursor({
        fromX: msg.fromX,
        fromY: msg.fromY,
        toX: msg.toX,
        toY: msg.toY,
        durationMs: msg.durationMs,
        action: msg.action,
      });
    } else if (
      msg.type === 'agent_spawned' ||
      msg.type === 'agent_status' ||
      msg.type === 'agent_team_message' ||
      msg.type === 'agent_completed'
    ) {
      handleAgentFrame(msg as unknown as AgentFrame);
    } else if (msg.type === 'browser_console') {
      appendBrowserConsole({
        level: msg.level,
        text: msg.text,
        ...(msg.source !== undefined ? { source: msg.source } : {}),
        ...(msg.line !== undefined ? { line: msg.line } : {}),
      });
    } else if (msg.type === 'todos_updated') {
      setSessionTodos(msg.sessionId, msg.todos);
    } else if (msg.type === 'wakeups_updated') {
      setPendingWakeups(msg.sessionId, msg.wakeups);
    }

    // Per-session run-status tracking for the sidebar indicator.
    // Lives outside ChatView so status updates regardless of which
    // session is currently visible.
    if ('sessionId' in msg && typeof msg.sessionId === 'string') {
      const sid = msg.sessionId;
      switch (msg.type) {
        case 'chunk':
        case 'thinking_chunk':
        case 'tool_call':
          setSessionStreaming(sid);
          break;
        case 'message_committed':
          if (msg.message.role === 'assistant') {
            setSessionStreaming(sid);
          }
          break;
        case 'done':
        case 'error':
          setSessionFinished(sid);
          break;
        default:
          break;
      }
    }

    // Then fan out to per-component subscribers (ChatView etc).
    for (const fn of feedSubscribersRef.current) {
      try {
        fn(msg);
      } catch {
        // Subscribers must be defensive; don't let one break the others.
      }
    }
  }, [
    setProviderInfo,
    setBrowserState,
    appendBrowserFrame,
    enqueueBrowserCursor,
    appendBrowserConsole,
    setSessionStreaming,
    setSessionFinished,
    setSessionTodos,
    setPendingWakeups,
    handleAgentFrame,
  ]);

  // Build clients exactly once. Memoising on `token` is intentional —
  // the token is fixed for the page lifetime.
  const clients = useMemo<ApiClients | null>(() => {
    if (token === null) return null;
    const rest = new RestClient(buildBaseUrl(), token);
    const ws = new WSClient({
      url: buildWsUrl(),
      csrf: token,
      onMessage: (msg) => fanOut(msg),
      onConnectionChange: (status) => {
        setConnection({ status });
      },
      onAuthRejected: (reason) => {
        // WS upgrade rejected — server boot rotated the token. The tab
        // was reused if `tokenInfo.hadCachedToken` is true; otherwise
        // the user pasted a now-invalid URL. Either way, banner the
        // user and clear cache.
        if (tokenInfo.hadCachedToken) {
          setAuthError({
            kind: 'stale_token',
            message: `WebSocket auth rejected (${reason})`,
          });
          clearCachedCsrfToken();
        }
      },
    });
    const subscribeFeed = (
      handler: (msg: WSServerMessage) => void,
    ): (() => void) => {
      feedSubscribersRef.current.add(handler);
      return () => {
        feedSubscribersRef.current.delete(handler);
      };
    };
    const wsSend = (msg: WSClientMessage): void => ws.send(msg);
    return { rest, ws, subscribeFeed, wsSend };
  }, [token, fanOut, setConnection, setAuthError, tokenInfo.hadCachedToken]);

  const didBootstrap = useRef(false);

  useEffect(() => {
    setCsrfToken(token);
  }, [token, setCsrfToken]);

  // Apply theme to <html> on mount and whenever it changes in the store.
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  // Mirror locale to <html lang> so screen readers and CSS `:lang(ru)`
  // selectors observe the active language.
  const locale = useStore((s) => s.locale);
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  // Global hotkey — Cmd/Ctrl+K opens the cross-session search overlay.
  // We listen at the document level so the binding fires regardless of
  // focus (Composer field, sidebar, file browser, …). When the search
  // overlay is already open, the hotkey is a no-op — the Modal owns
  // the input field's focus.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'k' && e.key !== 'K') return;
      e.preventDefault();
      if (sessionSearchOpen) {
        closeSessionSearch();
      } else {
        openSessionSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionSearchOpen, openSessionSearch, closeSessionSearch]);

  // WHITEBOARD-MOUNT-SECTION
  // Global hotkey — Cmd/Ctrl+Shift+W toggles the whiteboard panel.
  // We pull the toggle action via `getState()` to avoid a re-bind on
  // every store update; the action identity is stable for the
  // lifetime of the store.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!e.shiftKey) return;
      if (e.key !== 'w' && e.key !== 'W') return;
      e.preventDefault();
      useStore.getState().toggleWhiteboard();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // /WHITEBOARD-MOUNT-SECTION

  // Initial bootstrap — fetch projects + config once we have clients.
  // PRIOR BUG: setting `didBootstrap.current = true` BEFORE the async
  // fetch ran caused a race in React StrictMode (dev double-mount) and
  // any quick remount: the first mount's cleanup set `cancelled=true`
  // which aborted the fetch's `setProjects` call, while the second
  // mount short-circuited because the ref was already true. Net: empty
  // sidebar on first paint until the user explicitly opened a folder
  // (which re-triggered listProjects via handleAddProject).
  //
  // FIX: keep the guard only for IN-FLIGHT bootstraps and reset it on
  // cleanup. Multiple completed bootstraps are idempotent — setProjects
  // is replace-not-merge, getConfig returns the same data twice.
  useEffect(() => {
    if (clients === null) return;
    if (didBootstrap.current) return;
    didBootstrap.current = true;

    let cancelled = false;
    void (async () => {
      try {
        // NOTE: We deliberately do NOT auto-run `cleanupProjects()` here.
        // FS existence checks are unreliable on first read (Spotlight
        // indexing, slow-mounted volumes, symlink resolution) and would
        // destructively evict real projects from `workspaces.json`. The
        // user can trigger cleanup explicitly via the sidebar filter
        // menu's "Clean stale entries" action.
        const [projectsRes, configRes] = await Promise.all([
          clients.rest.listProjects(),
          clients.rest.getConfig(),
        ]);
        if (cancelled) return;

        setProjects(projectsRes.projects);
        if (
          projectsRes.projects.length > 0 &&
          projectsRes.projects[0] !== undefined
        ) {
          setActiveProject(projectsRes.projects[0].id);
        }

        setProviderInfo({
          backend: configRes.backend.type,
          baseUrl: configRes.backend.baseUrl,
          models: configRes.model.available,
          currentModel: configRes.model.current,
        });
        // Hydrate the active permission profile so ProfileBanner +
        // ProfileChip render the correct mode on first paint. Falls
        // back to `'default'` when the persisted config predates the
        // field (Zod fills the default server-side anyway).
        setPermissionProfile(configRes.permissions.profile ?? 'default');
        // Hydrate the active output style so the StyleChip in Composer
        // shows the correct selection on first paint.
        setOutputStyle(configRes.outputStyle ?? 'concise');
        setGeneration({
          temperature: configRes.generation.temperature,
          topP: configRes.generation.topP,
          repeatPenalty: configRes.generation.repeatPenalty,
          maxTokens: configRes.generation.maxTokens,
        });
        // Feed the user-configured context budget into the store so
        // ContextUsageRing can fall back to it when the active model
        // isn't in the known-models lookup table.
        setCurrentMaxContextTokens(configRes.context.maxTokens);

        // Fetch slash commands. The endpoint is owned by a parallel
        // agent on `RestClient`; if it's not present at runtime yet
        // (or the call fails) we degrade gracefully — autocomplete
        // simply won't surface anything.
        try {
          const restAny: { listCommands?: () => Promise<{
            commands: { name: string; description: string; usage?: string }[];
          }> } = clients.rest;
          if (typeof restAny.listCommands === 'function') {
            const cmdRes = await restAny.listCommands();
            if (!cancelled) {
              setSlashCommands(
                cmdRes.commands.map((c) => {
                  const out: { name: string; description: string; usage?: string } = {
                    name: c.name,
                    description: c.description,
                  };
                  if (c.usage !== undefined) out.usage = c.usage;
                  return out;
                }),
              );
            }
          }
        } catch {
          // Non-fatal: leave commands empty.
        }

        // Skills + plugins. Optional endpoints — degrade silently.
        try {
          const skillsRes = await clients.rest.listSkills();
          if (!cancelled) setSkills(skillsRes.skills);
        } catch {
          /* non-fatal */
        }
        try {
          const pluginsRes = await clients.rest.listPlugins();
          if (!cancelled) setPlugins(pluginsRes.plugins);
        } catch {
          /* non-fatal */
        }
        try {
          const provRes = await clients.rest.listProvidersConfig();
          if (!cancelled) setProvidersConfig(provRes);
        } catch {
          /* non-fatal — overlay degrades to empty defaults */
        }
        try {
          const agentsRes = await clients.rest.getAgentsConfig();
          if (!cancelled) setAgentsConfigStore(agentsRes.current);
        } catch {
          /* non-fatal — overlay seeds from defaults */
        }
        // OVERLAY-HOST-MOUNT-SECTION — hooks fetch.
        // Feeds the HookSettingsOverlay rendered via OverlayHost. Empty
        // array on failure is the same fallback as the overlay's
        // `hooks.length === 0` path → user sees the "no hooks
        // configured" hint and the example TOML snippet.
        try {
          const hooksRes = await clients.rest.listHooks();
          if (!cancelled) setHooksData(hooksRes.hooks);
        } catch {
          /* non-fatal */
        }
        // /OVERLAY-HOST-MOUNT-SECTION
      } catch (err) {
        if (cancelled) return;
        // Stale CSRF: the server rejected our token. Surface a recovery
        // banner instead of a noisy bootstrap toast — only if the tab
        // was reused (had a cached token). A first-ever launch with a
        // bad URL paste falls through to the generic error path.
        if (err instanceof RestAuthError && tokenInfo.hadCachedToken) {
          const message =
            err.body.length > 0 ? err.body : `HTTP ${err.status}`;
          setAuthError({ kind: 'stale_token', message });
          clearCachedCsrfToken();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setBootError(message);
        pushToast({
          level: 'error',
          message: t('toast.bootstrapFailed', { message }),
        });
      }
    })();

    return () => {
      cancelled = true;
      // NOTE: didBootstrap.current is intentionally NOT reset here. A
      // previous attempt to reset it on cleanup caused a re-fire loop
      // because effect deps include `t` (the i18n hook returns a new
      // function reference each render → effect refires → setProjects
      // → new render → new t → ... infinite). Keeping the guard
      // permanent + the (rare) StrictMode dev double-mount edge is
      // tolerable — production builds don't double-mount effects.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients]);

  // Pull sessions for ALL opened projects (parallel round-trips). The
  // sidebar tree shows every project — refreshing on project list
  // changes keeps it in sync after add/delete/cleanup. Cheap because
  // listSessions is a small SQLite scan per project.
  const projects = useStore((s) => s.projects);
  useEffect(() => {
    if (clients === null) return;
    if (projects.length === 0) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    setLoadingSessions(true);
    setSessionsError(null);
    void (async () => {
      try {
        const results = await Promise.all(
          projects.map(
            (p): Promise<SessionSummaryWire[]> =>
              clients.rest
                .listSessions({ projectId: p.id })
                .then((res) => res.sessions)
                .catch((): SessionSummaryWire[] => []),
          ),
        );
        if (cancelled) return;
        const merged: SessionSummaryWire[] = results.flat();
        setSessions(merged);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setSessionsError(message);
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clients, projects, setSessions]);

  // Clear the browser viewer when the active session changes — frames
  // from a prior session are not relevant.
  useEffect(() => {
    clearBrowserState();
    closeBrowserPanel();
  }, [activeSessionId, clearBrowserState, closeBrowserPanel]);

  // Multi-subscribe: ensure the WS is subscribed to every known session
  // (across projects). This keeps the run-status indicator live even
  // when the user is viewing a different chat. Subscribing twice is
  // a server no-op (handleSubscribe early-returns on duplicates), so
  // the worst-case extra cost on each session list refresh is one
  // ignored frame per row.
  const subscribedSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (clients === null) return;
    const known = subscribedSessionsRef.current;
    for (const s of sessions) {
      if (!known.has(s.id)) {
        known.add(s.id);
        clients.ws.send({ type: 'subscribe_session', sessionId: s.id });
      }
    }
  }, [clients, sessions]);

  // Decay tick — `recently-finished` rolls off after 10s.
  useEffect(() => {
    const handle = setInterval(() => {
      tickSessionStatus();
    }, 1000);
    return () => clearInterval(handle);
  }, [tickSessionStatus]);

  // Tear down the WS on unmount.
  useEffect(() => {
    return () => {
      clients?.ws.close();
    };
  }, [clients]);

  // NOTIFICATIONS-SERVICE-MOUNT-SECTION
  // The notifications service consumes the WS feed and pushes entries
  // into the bell. Built once per `clients`, torn down on unmount. The
  // service intentionally reads store state via `useStore.getState()`
  // so it doesn't subscribe to React updates — every action mutates
  // the store directly.
  useEffect(() => {
    if (clients === null) return undefined;
    const service = createNotificationsService({
      subscribeFeed: clients.subscribeFeed,
      store: {
        pushNotification: (n) => useStore.getState().pushNotification(n),
        getBrowserNotificationsEnabled: () =>
          useStore.getState().browserNotificationsEnabled,
        getActiveSessionId: () => useStore.getState().activeSessionId,
      },
    });
    return () => {
      service.dispose();
    };
  }, [clients]);
  // /NOTIFICATIONS-SERVICE-MOUNT-SECTION

  // --- Bound REST callbacks for ChatView ---

  const setProvider = useCallback(
    (req: Parameters<RestClient['setProvider']>[0]) => {
      if (clients === null) {
        return Promise.reject(new Error('REST client not initialised'));
      }
      return clients.rest.setProvider(req);
    },
    [clients],
  );

  const saveAgentsConfig = useCallback(
    async (snap: AgentsConfigSnapshot): Promise<AgentsConfigSnapshot> => {
      if (clients === null) {
        throw new Error('REST client not initialised');
      }
      const res = await clients.rest.setAgentsConfig(snap);
      return res.current;
    },
    [clients],
  );

  const refreshProvidersConfig = useCallback(async (): Promise<void> => {
    if (clients === null) return;
    try {
      const res = await clients.rest.listProvidersConfig();
      setProvidersConfig(res);
    } catch {
      /* non-fatal */
    }
  }, [clients, setProvidersConfig]);

  // The FileBrowser passes the active `showHidden` flag through the
  // store; we read it on every call so the request is always in sync
  // with the toolbar toggle without restructuring the callback graph.
  const fetchFileTree = useCallback(
    (path?: string) => {
      if (clients === null || activeProjectId === null) {
        return Promise.reject(new Error('No active project'));
      }
      const showHidden = useStore.getState().fileBrowser.showHidden;
      const req: {
        projectId: string;
        subpath?: string;
        depth?: 0 | 1;
        showHidden?: boolean;
      } = {
        projectId: activeProjectId,
        depth: 1,
      };
      if (path !== undefined) req.subpath = path;
      if (showHidden) req.showHidden = true;
      return clients.rest.fileTree(req);
    },
    [clients, activeProjectId],
  );

  const fetchFile = useCallback(
    (path: string) => {
      if (clients === null || activeProjectId === null) {
        return Promise.reject(new Error('No active project'));
      }
      return clients.rest.fileRead({ projectId: activeProjectId, path });
    },
    [clients, activeProjectId],
  );

  const fetchMessages = useCallback(
    (sessionId: string) => {
      if (clients === null) {
        return Promise.reject(new Error('REST client not initialised'));
      }
      return clients.rest.listMessages(sessionId);
    },
    [clients],
  );

  const handleAddProject = useCallback(
    async (req: { root: string; label?: string }) => {
      if (clients === null) return;
      try {
        const res = await clients.rest.createProject(req);
        const list = await clients.rest.listProjects();
        setProjects(list.projects);
        setActiveProject(res.project.id);
        closeAddProject();
        pushToast({ level: 'success', message: t('toast.projectAdded') });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushToast({
          level: 'error',
          message: t('toast.addProjectFailed', { message }),
        });
        throw err;
      }
    },
    [clients, setProjects, setActiveProject, closeAddProject, pushToast, t],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (clients === null) return;
      try {
        await clients.rest.deleteSession(sessionId);
        // Stop streaming for this session and drop status entry.
        clients.ws.send({ type: 'unsubscribe_session', sessionId });
        subscribedSessionsRef.current.delete(sessionId);
        clearSessionStatus(sessionId);
        // Local prune — avoid clobbering sessions for other projects
        // (the sidebar tree now spans every opened project).
        const remaining = useStore
          .getState()
          .sessions.filter((s) => s.id !== sessionId);
        setSessions(remaining);
        if (activeSessionId === sessionId) {
          setActiveSession(null);
        }
        pushToast({ level: 'success', message: t('toast.sessionDeleted') });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushToast({
          level: 'error',
          message: t('toast.sessionDeleteFailed', { message }),
        });
      }
    },
    [
      clients,
      activeSessionId,
      setSessions,
      setActiveSession,
      pushToast,
      clearSessionStatus,
      t,
    ],
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      if (clients === null) return;
      try {
        const res = await clients.rest.deleteProject(projectId);
        // Drop sessions belonging to this project from local state and
        // shut down their WS subscriptions.
        const state = useStore.getState();
        const droppedIds = state.sessions
          .filter((s) => s.projectId === projectId)
          .map((s) => s.id);
        for (const sid of droppedIds) {
          clients.ws.send({ type: 'unsubscribe_session', sessionId: sid });
          subscribedSessionsRef.current.delete(sid);
          clearSessionStatus(sid);
        }
        setSessions(
          state.sessions.filter((s) => s.projectId !== projectId),
        );
        // Refresh the project list so the deleted entry disappears.
        try {
          const list = await clients.rest.listProjects();
          setProjects(list.projects);
        } catch {
          // best-effort
        }
        // Close any active session that belonged to the deleted project.
        if (activeSessionId !== null && droppedIds.includes(activeSessionId)) {
          setActiveSession(null);
        }
        // Clear active project if it was the one deleted.
        if (activeProjectId === projectId) {
          setActiveProject(null);
        }
        pushToast({
          level: 'success',
          message: t('toast.projectDeleted', { count: res.removedSessions }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushToast({
          level: 'error',
          message: t('toast.projectDeleteFailed', { message }),
        });
      }
    },
    [
      clients,
      activeProjectId,
      activeSessionId,
      setSessions,
      setProjects,
      setActiveProject,
      setActiveSession,
      clearSessionStatus,
      pushToast,
      t,
    ],
  );

  const handleRetryConnection = useCallback(() => {
    // The WSClient auto-reconnects on transient drops; only `bailOnDrift`
    // kills the loop permanently. A page reload covers both cases.
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  const wsSendBound = useCallback(
    (msg: WSClientMessage) => {
      clients?.ws.send(msg);
    },
    [clients],
  );

  const subscribeFeedBound = useCallback(
    (handler: (msg: WSServerMessage) => void) => {
      if (clients === null) return () => undefined;
      return clients.subscribeFeed(handler);
    },
    [clients],
  );

  const handleNewChat = useCallback(async () => {
    if (clients === null || activeProjectId === null) return;
    try {
      const req: Parameters<RestClient['createSession']>[0] = {
        projectId: activeProjectId,
      };
      if (currentModel !== null && currentModel.length > 0) {
        req.model = currentModel;
      }
      const res = await clients.rest.createSession(req);
      // Append to local sessions (preserve other projects) and ensure
      // the parent project's tree node is expanded so the new session
      // is visible. (`setProjectExpanded` targets the sidebar project
      // tree; `setFolderExpanded` is for the file-browser tree and is
      // not what we want here.)
      const state = useStore.getState();
      setSessions([res.session, ...state.sessions]);
      setProjectExpanded(activeProjectId, true);
      setActiveSession(res.session.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast({
        level: 'error',
        message: t('toast.newSessionFailed', { message }),
      });
    }
  }, [
    clients,
    activeProjectId,
    currentModel,
    setSessions,
    setActiveSession,
    setProjectExpanded,
    pushToast,
    t,
  ]);

  const backendLabel = useMemo<string | null>(() => {
    if (activeBackend === null) return null;
    if (baseUrl === null || baseUrl.length === 0) return activeBackend;
    try {
      const host = new URL(baseUrl).host;
      return `${activeBackend} @ ${host}`;
    } catch {
      return activeBackend;
    }
  }, [activeBackend, baseUrl]);

  if (token === null) {
    return (
      <div className={styles.layout}>
        <main className={styles.main}>
          <div className={styles.chatPlaceholder}>
            <EmptyState
              icon={MessageSquare}
              title={t('toast.tokenMissing.title')}
              description={t('toast.tokenMissing.desc')}
            />
          </div>
        </main>
      </div>
    );
  }

  // Auth-rejected state: server rejected our CSRF token. Hide the rest
  // of the UI behind the recovery banner so the user is focused on the
  // single actionable instruction (open the new URL).
  if (authError !== null) {
    return (
      <div className={styles.layout}>
        <main className={styles.main}>
          <StaleTokenBanner
            onDismiss={() => {
              setAuthError(null);
            }}
          />
        </main>
      </div>
    );
  }

  return (
    <ApiClientsContext.Provider value={clients}>
      <DeleteSessionRegistration
        handler={(sid) => {
          void handleDeleteSession(sid);
        }}
      />
      {/* LANGUAGE-PICKER-MOUNT-SECTION — first-launch modal. Rendered
          ABOVE everything so a fresh visitor confirms a language before
          interacting with the rest of the SPA. */}
      {needsLanguagePick ? (
        <LanguagePicker onSelect={handleLanguageSelect} />
      ) : null}
      {/* LANGUAGE-PICKER-MOUNT-SECTION-END */}
      {/* VIEWPORT-WIRE-SECTION — the active breakpoint is also exposed
          on the layout root via `data-viewport` so component CSS modules
          can scope rules without consuming the hook directly. */}
      <div className={styles.layout} data-viewport={viewport.breakpoint}>
        <Sidebar
          loadingSessions={loadingSessions}
          sessionsError={sessionsError ?? bootError}
          viewport={viewport.breakpoint}
          onNewChat={() => {
            void handleNewChat();
          }}
          onOpenSettings={openSettings}
          onAddProject={openAddProject}
          onDeleteProject={(id) => {
            void handleDeleteProject(id);
          }}
        />
        {settingsOpen ? (
          <SettingsOverlay
            generation={generation}
            onClose={closeSettings}
          />
        ) : null}
        <main className={styles.main}>
          <ConnectionBanner onRetry={handleRetryConnection} />
          {/* TABS-DOCK-SECTION */}
          <SessionTabs
            onNewTab={() => {
              void handleNewChat();
            }}
          />
          {/* /TABS-DOCK-SECTION */}
          <ProjectBar />
          <ProfileBanner />
          {/* QUEUE-AUTODRAIN-SECTION — pending-message queue lives in the
              Zustand store (see QUEUE-NEXT-STORE-SECTION in state/store.ts);
              auto-drain on `done` and per-item dropdown UI live in
              components/ChatView.tsx + components/QueueIndicator.tsx. */}
          <ChatView
            wsSend={wsSendBound}
            subscribeFeed={subscribeFeedBound}
            setProvider={setProvider}
            fetchFileTree={fetchFileTree}
            fetchFile={fetchFile}
            fetchMessages={fetchMessages}
            backendLabel={backendLabel}
          />
        </main>
        {/* RightDock unmounted Wave 8B — top-bar icons own panel access. */}
        <BrowserPanel />
        <AgentTeamPanel />
        <TasksPanel sessionId={activeSessionId} />
        {backendServerOpen ? (
          <BackendServerOverlay
            onSave={setProvider}
            onRefresh={refreshProvidersConfig}
          />
        ) : null}
        {addProjectOpen ? (
          <AddProjectDialog
            onCancel={closeAddProject}
            onSubmit={handleAddProject}
          />
        ) : null}
        {slashCommandsOpen ? <SlashCommandsOverlay /> : null}
        {skillsOverlayOpen ? <SkillsOverlay /> : null}
        {pluginsOverlayOpen ? <PluginsOverlay /> : null}
        {addSkillOpen ? <AddSkillDialog /> : null}
        {sessionSearchOpen ? <SessionSearchOverlay /> : null}
        {agentsConfigOverlayOpen ? (
          <AgentSettingsOverlay onSave={saveAgentsConfig} />
        ) : null}
        {usageDashboardOpen ? <UsageDashboard /> : null}
        {memoryOverlayOpen ? (
          <Modal
            open={true}
            onClose={closeMemoryOverlay}
            title={t('memory.title')}
            ariaLabel={t('memory.title')}
            size="xl"
          >
            <ModalBody>
              <MemoryEditor />
            </ModalBody>
          </Modal>
        ) : null}
        {/* OVERLAY-HOST-MOUNT-SECTION */}
        {/* Single mount point for overlay kinds NOT already covered by
            the legacy boolean renders above. Currently this is just the
            `hooks` overlay (HookSettingsOverlay) since other kinds still
            ride the legacy `xxxOverlayOpen ? <X /> : null` paths during
            the transitional Wave-8B refactor. The exclusive-overlay
            invariant is preserved because `openOverlay()` always
            resets every legacy boolean before setting the chosen kind,
            so at most one overlay paints at a time. */}
        {activeOverlay.kind === 'hooks' ? (
          <OverlayHost
            activeOverlay={activeOverlay}
            hooksData={hooksData}
          />
        ) : null}
        {/* /OVERLAY-HOST-MOUNT-SECTION */}
        <ToastStack />
      </div>
    </ApiClientsContext.Provider>
  );
}

/** Tiny side-effect component: registers a delete-session handler on the store. */
function DeleteSessionRegistration({
  handler,
}: {
  handler: (sessionId: string) => void;
}): null {
  const setDeleteSessionHandler = useStore((s) => s.setDeleteSessionHandler);
  useEffect(() => {
    setDeleteSessionHandler(handler);
    return () => setDeleteSessionHandler(null);
  }, [handler, setDeleteSessionHandler]);
  return null;
}
