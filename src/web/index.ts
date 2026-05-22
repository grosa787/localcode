/**
 * Public entry for `localcode --web`.
 *
 * Phase 2 integration (Agent H) — wires together:
 *   - Agent A's server core (`startWebServer`, router, static, csrf).
 *   - Agent B's REST handlers (`createApiHandler`).
 *   - Agent C's WebSocket bridge (`createWsHandlers`).
 *   - Agent's runtime layer (RuntimePool, SessionEventBus, ApprovalBridge,
 *     ChatRuntime).
 *   - Existing transport-agnostic core (ConfigManager, SessionManager,
 *     ContextManager, ToolExecutor, LLMAdapter / AnthropicAdapter,
 *     createToolHandlerMap).
 *
 * The CLI imports `startWebApp` from here and nothing else.
 */

import {
  startWebServer,
  type RunningWebApp,
  type WebSocketHandlerSlot,
} from './server/start';
import type { Server, ServerWebSocket } from 'bun';

import { WorkspaceRegistry } from './workspace/workspace-registry';
import { createApiHandler, type ProviderAdapter } from './api';
import { SessionEventBus } from './runtime/event-bus';
import { ApprovalBridge } from './runtime/approval-bridge';
import { RuntimePool } from './runtime/runtime-pool';
import { ChatRuntime, buildPreview } from './runtime/chat-runtime';
import { HealthWatchdog, poolToWatchable } from './runtime/health-watchdog';
import { createWsHandlers, type SocketContext } from './server/ws';

import { ConfigManager } from '@/config/config-manager';
import { PROVIDER_DEFAULTS, resolveApiKey } from '@/config/defaults';
import { SessionManager } from '@/sessions/session-manager';
import { ContextManager } from '@/llm/context-manager';
import { ToolExecutor } from '@/llm/tool-executor';
import { LLMAdapter } from '@/llm/adapter';
import { AnthropicAdapter } from '@/llm/adapter-anthropic';
import { TOOLS_SCHEMA } from '@/llm/tools-schema';
import { createToolHandlerMap } from '@/tools';
import type { AgentToolContext } from '@/tools/agent';
import type { Backend, Message } from '@/types/global';
import { AgentOrchestrator } from '@/agents/orchestrator';
import {
  buildAgentRunnerFactory,
  type WorkerAdapter,
} from '@/agents/runner-factory';
import { LEAD_AGENT_ID } from '@/agents/types';
import type {
  ToolHandler as FlatToolHandler,
  ToolHandlerMap as FlatToolHandlerMap,
} from '@/types/message';
import type {
  SetProviderRequest,
  SetProviderResponse,
} from './protocol/rest-types';

import { HookEngine } from '@/hooks';
import { withBuiltinSecurityHooks } from '@/security';
import { getProcessMcpRegistry } from '@/mcp';
// PROCESS-MONITOR-WIRE-SECTION — process registry (used by `/watch`
// + `/diagnose` + `process_status`). The singleton is shared with the
// TUI; we only need to ensure the web server disposes it on shutdown
// so SIGINT/SIGTERM doesn't leave watched children dangling.
import { getProcessMonitor } from '@/process-monitor';
// PROCESS-MONITOR-WIRE-SECTION-END
// ONTOLOGY-WIRE-SECTION — background ontology indexer. One indexer per
// process (web server is single-tenant), shared across runtime pools.
import {
  OntologyIndexer,
  getProcessOntologyIndexer,
  setProcessOntologyIndexer,
} from '@/ontology';
// ONTOLOGY-WIRE-SECTION-END
import {
  buildMcpToolHandlerMap,
  buildMcpToolSchema,
} from '@/tools/mcp-tool';

import { MemoryStore, type MemoryEntry } from '@/memory';
import { renderMemorySection } from '@/llm/memory-prompt';
import { loadHierarchy } from '@/init/localcode-md';
import { WakeupRegistry, setProcessWakeupRegistry } from '@/scheduling';
import chokidar from 'chokidar';
// PRICING-REFRESH-SECTION — fire a non-blocking refresh of the
// OpenRouter pricing catalog at web boot so per-message cost chips +
// dashboards have fresh prices on first session open. The fetch is
// best-effort (5s timeout, 24h disk cache); failures degrade to the
// static table.
import { refreshOpenRouterPricing } from '@/llm/pricing/openrouter-pricing';
// PRICING-REFRESH-SECTION-END

/**
 * Resolve the LOCALCODE.md hierarchy (project root → $HOME, plus global
 * `~/.localcode/LOCALCODE.md`) into a single string for the system prompt.
 * Returns `null` when no LOCALCODE.md was found anywhere; otherwise an
 * inline body (short hierarchies) or a pointer list (when joined size
 * exceeds the inline budget).
 */
function readLocalcodeHierarchyForPrompt(projectRoot: string): string | null {
  try {
    const result = loadHierarchy(projectRoot);
    if (result.inline !== undefined) return result.inline;
    if (result.pointers !== undefined && result.pointers.length > 0) {
      const lines = [
        'LOCALCODE.md hierarchy exceeds the inline budget; read on demand:',
        ...result.pointers.map((p) => `- ${p}`),
      ];
      return lines.join('\n');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fire `SessionStart` hooks defined in config. Mirror of the same helper
 * in `src/cli.tsx`. Fire-and-forget — errors are swallowed so a broken
 * hook never prevents the web server from starting.
 */
async function fireSessionStartHooks(projectRoot: string): Promise<void> {
  let cfg: import('@/config/types').Config;
  try {
    cfg = new (await import('@/config/config-manager').then((m) => m.ConfigManager))().read();
  } catch {
    return;
  }
  const hooks = cfg.hooks ?? [];
  if (hooks.length === 0) return;
  try {
    const engine = new HookEngine({
      hooks,
      logger: {
        warn: (m): void => {
          process.stderr.write(`localcode(web): hook warning: ${m}\n`);
        },
      },
    });
    if (!engine.hasHooksFor('SessionStart')) return;
    await engine.run({ trigger: 'SessionStart', projectRoot });
  } catch {
    // Best-effort; never fail startup on hooks.
  }
}

/** Public options for `startWebApp`. Mirrors the CLI flags 1:1. */
export interface StartWebAppOptions {
  readonly projectRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly openInBrowser?: boolean;
}

export type { RunningWebApp } from './server/start';

const SERVER_VERSION = '0.1.0';

/**
 * Boot the web app. Resolves with a handle the CLI can keep alive and
 * cleanly stop on signal.
 */
export async function startWebApp(
  opts: StartWebAppOptions,
): Promise<RunningWebApp> {
  // ── Singleton services ────────────────────────────────────────────────
  const configManager = new ConfigManager();
  const sessionManager = new SessionManager();
  const workspaceRegistry = new WorkspaceRegistry();
  const eventBus = new SessionEventBus();
  const approvalBridge = new ApprovalBridge();
  // Process-wide HookEngine for non-session lifecycle hooks (SessionEnd
   // fired from pool eviction / shutdown, SessionStart fired on boot).
   // Each per-session runtime still builds its own HookEngine to capture
   // a snapshot of the hooks config at session-construction time.
  const lifecycleHookEngine = new HookEngine({
    // SECURITY-CONFIG-SECTION — auto-prepend built-in secret scanner.
    hooks: withBuiltinSecurityHooks(configManager.read().hooks, {
      enabled: configManager.read().security?.secretScanner?.enabled,
    }),
    logger: {
      warn: (m): void => {
        process.stderr.write(`localcode(web): hook warning: ${m}\n`);
      },
    },
  });
  // WEB-PROJECT-CWD-FIX-SECTION
  // Resolve a session's projectRoot at call time via the registered
  // workspaces, falling back to the launch dir when the session row /
  // workspace can't be located (covers transient races where the row was
  // deleted seconds before SessionEnd fired).
  function resolveSessionProjectRoot(sessionId: string): string {
    try {
      const sess = sessionManager.getSession(sessionId);
      if (sess !== null && sess.projectRoot.length > 0) return sess.projectRoot;
    } catch {
      // fallthrough — best-effort lookup
    }
    return opts.projectRoot;
  }
  // WEB-PROJECT-CWD-FIX-SECTION-END
  const runtimePool = new RuntimePool({
    onSessionEnd: (sessionId, reason): void => {
      if (!lifecycleHookEngine.hasHooksFor('SessionEnd')) return;
      try {
        void lifecycleHookEngine
          .run({
            trigger: 'SessionEnd',
            // WEB-PROJECT-CWD-FIX-SECTION
            // Resolve the session's actual project root at fire time so
            // user-authored SessionEnd hooks see the directory THIS session
            // operated against, not the directory localcode --web was
            // launched from.
            projectRoot: resolveSessionProjectRoot(sessionId),
            // WEB-PROJECT-CWD-FIX-SECTION-END
            sessionId,
            reason,
          })
          .catch(() => {
            // best-effort — SessionEnd hooks can never keep a session alive.
          });
      } catch {
        // ignore — fire-and-forget contract
      }
    },
  });

  // RECOVERY-FIX-3-SECTION
  // Background watchdog — sweeps every minute looking for runtimes
  // whose `isStreaming === true` AND no chunk/tool_call activity for
  // 5 minutes. Force-releases the stream lock + emits error/done so
  // the user can continue. Cheap (1 map walk per sweep) and unrefs
  // its timer so it never holds the process open by itself.
  const healthWatchdog = new HealthWatchdog(poolToWatchable(runtimePool));
  healthWatchdog.start();
  const cleanupWatchdog = (): void => {
    try {
      healthWatchdog.stop();
    } catch {
      // best-effort
    }
  };
  process.once('SIGINT', cleanupWatchdog);
  process.once('SIGTERM', cleanupWatchdog);
  // RECOVERY-FIX-3-SECTION-END

  // ── WakeupRegistry: install the process-wide singleton ───────────────
  // When a wakeup fires, find the matching session's ChatRuntime (if it
  // is still resident in the pool) and inject the self-prompt via the
  // runtime's `queueWakeupPrompt`. Wakeups whose session has already
  // evicted are dropped silently — the user can `schedule_wakeup` again
  // if they want the prompt back.
  const wakeupRegistry = new WakeupRegistry((sessionId, prompt) => {
    const runtime = runtimePool.get(sessionId);
    if (runtime === undefined) return;
    void runtime.queueWakeupPrompt(prompt).catch(() => {
      // best-effort — wakeup dispatch failures must never crash the
      // server. The user will see `done { error }` via the WS stream if
      // sendUserMessage downstream errored.
    });
  });
  setProcessWakeupRegistry(wakeupRegistry);

  // Fan out `wakeups_updated` WS frames whenever the registry changes.
  // Group entries by sessionId and emit one frame per session so each
  // browser tab only sees its own wakeups. The eventBus is the same one
  // each ChatRuntime publishes on, so subscribers (the WS bridge)
  // forward the frames transparently.
  const unsubscribeWakeups = wakeupRegistry.subscribe((snapshot) => {
    const bySession = new Map<string, typeof snapshot>();
    for (const w of snapshot) {
      const prev = bySession.get(w.sessionId) ?? [];
      bySession.set(w.sessionId, [...prev, w]);
    }
    // Also emit empty arrays for sessions that just emptied — track
    // previously-known sessions via a separate map. Simpler: every
    // session id we have seen this tick gets a frame.
    for (const [sid, list] of bySession.entries()) {
      eventBus.emit(sid, {
        type: 'wakeups_updated',
        sessionId: sid,
        wakeups: list.map((w) => ({
          id: w.id,
          sessionId: w.sessionId,
          prompt: w.prompt,
          reason: w.reason,
          createdAt: w.createdAt,
          fireAt: w.fireAt,
        })),
      });
    }
  });

  const cleanupWakeups = (): void => {
    try {
      unsubscribeWakeups();
    } catch {
      /* swallow */
    }
    setProcessWakeupRegistry(null);
  };
  process.once('SIGINT', cleanupWakeups);
  process.once('SIGTERM', cleanupWakeups);

  // ── Memory: per-project store + watcher ──────────────────────────────
  // WEB-PROJECT-CWD-FIX-SECTION
  // Memory is per-PROJECT, not per-launch-dir. When the user opens a
  // different project via the workspace switcher, sessions for THAT
  // project must see THAT project's `<root>/.localcode/memory/` — not the
  // memory store rooted at the directory `localcode --web` was launched
  // from. We lazily build a (store + watcher + snapshot) bag the first
  // time each projectRoot is observed, and `createRuntimeForSession`
  // resolves the bag for the session's projectRoot when building the
  // system prompt.
  interface MemoryBag {
    readonly store: MemoryStore;
    readonly close: () => void;
    snapshot: readonly MemoryEntry[];
  }
  const memoryBags = new Map<string, MemoryBag>();
  function getMemoryBag(projectRoot: string): MemoryBag {
    const existing = memoryBags.get(projectRoot);
    if (existing !== undefined) return existing;
    const store = new MemoryStore(projectRoot);
    const bag: MemoryBag = { store, snapshot: [], close: () => {} };
    const reload = async (): Promise<void> => {
      try {
        bag.snapshot = await store.list();
      } catch {
        bag.snapshot = [];
      }
    };
    void reload();
    const watcher = chokidar.watch(store.directory, {
      ignoreInitial: false,
      depth: 1,
      persistent: true,
    });
    watcher.on('add', () => { void reload(); });
    watcher.on('change', () => { void reload(); });
    watcher.on('unlink', () => { void reload(); });
    watcher.on('error', () => { /* swallow — memory is best-effort */ });
    (bag as { close: () => void }).close = (): void => {
      void watcher.close().catch(() => { /* swallow */ });
    };
    memoryBags.set(projectRoot, bag);
    return bag;
  }
  // Eagerly prime the launch-dir bag so the first session under
  // `opts.projectRoot` doesn't pay the watcher-bootstrap latency on its
  // first turn. Additional projects pay it lazily on first session open.
  getMemoryBag(opts.projectRoot);
  const cleanupMemory = (): void => {
    for (const bag of memoryBags.values()) {
      try { bag.close(); } catch { /* swallow */ }
    }
    memoryBags.clear();
  };
  process.once('SIGINT', cleanupMemory);
  process.once('SIGTERM', cleanupMemory);
  // WEB-PROJECT-CWD-FIX-SECTION-END

  // ── Multi-agent orchestrator ─────────────────────────────────────────
  // One orchestrator per process — keyed on parent (lead) sessionId.
  // The runner factory is wired below once `createWorkerAdapter` is
  // defined; we rely on the lazy getter pattern so the orchestrator's
  // factory closes over the latest config/state at spawn time.
  // eslint-disable-next-line prefer-const
  let agentOrchestrator: AgentOrchestrator | null = null;
  function getAgentOrchestrator(): AgentOrchestrator {
    if (agentOrchestrator !== null) return agentOrchestrator;
    const cfg = configManager.read();
    // LM Studio defaults to 3 parallel slots; everything else keeps the
    // schema default of 5.
    const isLmStudio = cfg.backend.type === 'lmstudio';
    const fallbackMaxConcurrent = isLmStudio ? 3 : 5;
    const agentsCfg = cfg.agents ?? {
      workerModel: cfg.model.current,
      maxConcurrent: fallbackMaxConcurrent,
      isolation: 'worktree' as const,
      approval: 'auto' as const,
      defaultTimeoutSec: 600,
    };
    agentOrchestrator = new AgentOrchestrator({
      projectRoot: opts.projectRoot,
      config: agentsCfg,
      runnerFactory: buildAgentRunnerFactory({
        orchestrator: () => getAgentOrchestrator(),
        sessionManager,
        configManager,
        createAdapterForModel: (model: string): WorkerAdapter => {
          // Reuse the active backend baseUrl + key. For LM Studio the
          // OpenAI-compat shim handles parallel slot allocation server-
          // side, so multiple workers can share the same baseUrl.
          const fresh = configManager.read();
          if (fresh.backend.type === 'anthropic') {
            const key = fresh.backend.apiKey ?? resolveApiKey('anthropic') ?? '';
            return new AnthropicAdapter({
              baseUrl: fresh.backend.baseUrl,
              model,
              apiKey: key,
            });
          }
          const adapterCfg: ConstructorParameters<typeof LLMAdapter>[0] = {
            baseUrl: fresh.backend.baseUrl,
            model,
            backend: fresh.backend.type,
          };
          if (
            fresh.backend.apiKey !== undefined &&
            fresh.backend.apiKey.length > 0
          ) {
            adapterCfg.apiKey = fresh.backend.apiKey;
          }
          if (fresh.backend.customHeaders !== undefined) {
            adapterCfg.customHeaders = fresh.backend.customHeaders;
          }
          return new LLMAdapter(adapterCfg);
        },
        resolveProjectRoot: (parentSessionId: string): string | null => {
          const sess = sessionManager.getSession(parentSessionId);
          return sess !== null ? sess.projectRoot : null;
        },
        resolveBackend: () => configManager.read().backend.type,
      }),
    });
    return agentOrchestrator;
  }

  // WORKTREE-GC-STARTUP-SECTION
  // Sweep stale sub-agent worktrees on web boot — fire-and-forget so a
  // slow git call never blocks the server start. SIGINT/SIGTERM run
  // releaseAll() with a 1.5s budget below so we never hold the exit.
  void (async () => {
    try {
      const orch = getAgentOrchestrator();
      const res = await orch.getWorktreeGC().gcOrphans(opts.projectRoot);
      if (res.removed.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[worktree-gc] removed ${res.removed.length} stale worktree(s) at boot`,
        );
      }
    } catch {
      /* best-effort */
    }
  })();
  const worktreeGcShutdown = (): void => {
    try {
      const orch = agentOrchestrator;
      if (orch === null) return;
      // Race releaseAll against a 1.5s timeout. We don't await — the
      // surrounding signal handler returns immediately so process exit
      // isn't blocked by a stuck git call.
      void Promise.race([
        orch.getWorktreeGC().releaseAll(opts.projectRoot),
        new Promise<void>((res) => setTimeout(res, 1500)),
      ]).catch(() => { /* best-effort */ });
    } catch {
      /* best-effort */
    }
  };
  process.once('SIGINT', worktreeGcShutdown);
  process.once('SIGTERM', worktreeGcShutdown);
  // WORKTREE-GC-STARTUP-SECTION-END

  // Auto-register the cwd as a workspace if not already present so the
  // first REST `/api/projects` call returns a non-empty list.
  if (workspaceRegistry.byRoot(opts.projectRoot) === null) {
    try {
      workspaceRegistry.create(opts.projectRoot);
    } catch {
      // Best-effort — surface as empty list rather than fail boot.
    }
  }

  // ── Adapter factory ───────────────────────────────────────────────────
  // Mirrors `createAdapter` in app.tsx. Returns an object with at least
  // `getModels()` (the `ProviderAdapter` shape Agent B's REST uses).
  function createAdapterForBackend(
    backend: Backend,
    baseUrl: string,
    apiKey?: string,
  ): ProviderAdapter & { streamChat?: LLMAdapter['streamChat'] } {
    if (backend === 'anthropic') {
      // AnthropicAdapter requires non-empty `model`; we pass the current
      // config model when known, falling back to a placeholder that is
      // only valid for `getModels()` (which is hardcoded). Real chat use
      // goes through `createRuntimeForSession` which constructs a fresh
      // adapter with the correct model.
      let currentModel = '';
      try {
        currentModel = configManager.read().model.current;
      } catch {
        // Config may not exist yet on first boot.
      }
      const model = currentModel.length > 0 ? currentModel : 'claude-3-5-sonnet-latest';
      const key = apiKey ?? resolveApiKey('anthropic') ?? '';
      // For getModels-only usage the key isn't validated until streamChat;
      // empty keys are accepted here so `/api/models/refresh?provider=anthropic`
      // works before the user has supplied a key.
      return new AnthropicAdapter({
        baseUrl,
        model,
        apiKey: key.length > 0 ? key : 'placeholder-not-used-by-getModels',
      });
    }
    // OpenAI-compatible path covers ollama / lmstudio / openai / openrouter /
    // google / custom.
    let currentModel = '';
    try {
      currentModel = configManager.read().model.current;
    } catch {
      // Config may not exist yet.
    }
    const config: ConstructorParameters<typeof LLMAdapter>[0] = {
      baseUrl,
      model: currentModel,
      backend,
    };
    const resolvedKey = apiKey ?? resolveApiKey(backend);
    if (resolvedKey !== null && resolvedKey !== undefined && resolvedKey.length > 0) {
      config.apiKey = resolvedKey;
    }
    return new LLMAdapter(config);
  }

  // ── Provider switch handler ──────────────────────────────────────────
  // Probes the new backend (via `getModels()`), persists the change in
  // ConfigManager, returns the resolved model list. Errors propagate so
  // the WS / REST layer can surface them.
  async function applyProviderChange(
    req: SetProviderRequest,
  ): Promise<SetProviderResponse> {
    const baseUrl =
      req.baseUrl !== undefined && req.baseUrl.length > 0
        ? req.baseUrl
        : PROVIDER_DEFAULTS[req.type].baseUrl;
    const apiKey = req.apiKey ?? resolveApiKey(req.type) ?? undefined;
    const probe = createAdapterForBackend(req.type, baseUrl, apiKey);
    const models = await probe.getModels();
    let curModel = '';
    try {
      curModel = configManager.read().model.current;
    } catch {
      // No existing config — `update` will materialise a fresh one.
    }
    const currentModel = models.includes(curModel)
      ? curModel
      : (models[0] ?? '');
    const updateBackend: { type: Backend; baseUrl: string; apiKey?: string } = {
      type: req.type,
      baseUrl,
    };
    if (apiKey !== undefined && apiKey.length > 0) {
      updateBackend.apiKey = apiKey;
    }
    configManager.update({
      backend: updateBackend,
      model: { current: currentModel, available: [...models] },
    });
    return {
      ok: true,
      backend: req.type,
      baseUrl,
      models,
      currentModel,
    };
  }

  // ── ChatRuntime factory per session ──────────────────────────────────
  function createRuntimeForSession(sessionId: string): ChatRuntime {
    const session = sessionManager.getSession(sessionId);
    if (session === null) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectRoot = session.projectRoot;
    const config = configManager.read();

    // Build a real LLM adapter for streaming. Anthropic uses its own
    // adapter; everything else uses LLMAdapter.
    let llmStream: { streamChat: LLMAdapter['streamChat'] };
    if (config.backend.type === 'anthropic') {
      const key = config.backend.apiKey ?? resolveApiKey('anthropic') ?? '';
      llmStream = new AnthropicAdapter({
        baseUrl: config.backend.baseUrl,
        model: config.model.current,
        apiKey: key,
      });
    } else {
      const adapterCfg: ConstructorParameters<typeof LLMAdapter>[0] = {
        baseUrl: config.backend.baseUrl,
        model: config.model.current,
        backend: config.backend.type,
      };
      if (config.backend.apiKey !== undefined && config.backend.apiKey.length > 0) {
        adapterCfg.apiKey = config.backend.apiKey;
      }
      if (config.backend.customHeaders !== undefined) {
        adapterCfg.customHeaders = config.backend.customHeaders;
      }
      if (config.diagnostics?.dumpFailedRequests === true) {
        adapterCfg.dumpFailedRequests = true;
      }
      llmStream = new LLMAdapter(adapterCfg);
    }

    // Per-session ContextManager. Hydrate from persisted history.
    const contextManager = new ContextManager();
    const persisted = sessionManager.getAllMessages(sessionId);
    contextManager.addMany(persisted);

    // Tool executor — adapt the preview/commit handler shape into the
    // flat (args) => ToolResult contract ToolExecutor expects (mirrors
    // the pattern from `src/app.tsx`). The lead's tool ctx carries the
    // orchestrator + caller='lead' so spawn_agent / team_* tools can
    // reach the bus.
    //
    // `agentsConfig` is propagated so spawn_agent can enforce the
    // strict worker-slot allow-list. Surfaced under the AgentToolContext
    // shape; createToolHandlerMap accepts the wider AgentToolContext
    // structurally (it casts to AgentToolContext for agent-* tools).
    const orch = getAgentOrchestrator();
    const toolCtx: AgentToolContext = {
      projectRoot,
      dangerouslyAllowAll: false,
      agents: orch,
      parentSessionId: sessionId,
      callerAgentId: LEAD_AGENT_ID,
      ...(config.agents !== undefined ? { agentsConfig: config.agents } : {}),
      // todo_write — provide sessionId and sessionManager so the tool
      // can persist todos to the correct session row.
      sessionId,
      sessionManager,
      // schedule_wakeup — share the process-wide WakeupRegistry so the
      // model can defer its own continuation.
      wakeupRegistry,
      // ONTOLOGY-WIRE-SECTION — surface the indexer so find_call_sites
      // / impacts_of / type_hierarchy can run. Will report
      // "Ontology not ready" when the first scan hasn't completed.
      ontology: getProcessOntologyIndexer(projectRoot) ?? undefined,
      // ONTOLOGY-WIRE-SECTION-END
    };
    const handlerMap = createToolHandlerMap(toolCtx);
    const flatHandlers: FlatToolHandlerMap = {};
    for (const [name, handler] of Object.entries(handlerMap)) {
      const flat: FlatToolHandler = async (args) => {
        const preview = await handler.preview(args, toolCtx);
        if (handler.commit === undefined) return preview;
        if (!preview.success) return preview;
        const committed = await handler.commit(args, toolCtx);
        if (committed.success && committed.output.length === 0) {
          return { ...committed, output: preview.output };
        }
        return committed;
      };
      flatHandlers[name] = flat;
    }

    // MCP tools merged last — shadow plugins and built-ins on collision.
    const mcpMap = buildMcpToolHandlerMap(getProcessMcpRegistry());
    for (const [mcpName, mcpHandler] of Object.entries(mcpMap)) {
      flatHandlers[mcpName] = (args) => mcpHandler.preview(args, toolCtx);
    }

    // One HookEngine per session-runtime — cheap construction, zero
    // overhead when no hooks are configured.
    // SECURITY-CONFIG-SECTION — auto-prepend built-in secret scanner.
    const sessionHookEngine = new HookEngine({
      hooks: withBuiltinSecurityHooks(config.hooks, {
        enabled: config.security?.secretScanner?.enabled,
      }),
    });

    const toolExecutor = new ToolExecutor({
      handlers: flatHandlers,
      dangerouslyAllowAll: false,
      autoApproveTools: config.permissions.autoApprove ?? [],
      // Permission profile — falls back to `'default'` when the config
      // predates this field (Zod fills the default on read but we keep
      // the explicit ?? here for older test fixtures).
      profile: config.permissions.profile ?? 'default',
      autoLintAfterWrite: true,
      onAutoCheckResult: (msg: Message) => {
        contextManager.add(msg);
      },
      hookBridge: sessionHookEngine,
      onHookEvent: (msg: Message) => {
        contextManager.add(msg);
      },
      projectRoot,
      sessionId,
      approvalCallback: async (
        toolName: string,
        args: Record<string, unknown>,
      ): Promise<boolean> => {
        const toolCallId =
          typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const preview = buildPreview(toolName, args);
        eventBus.emit(sessionId, {
          type: 'approval_request',
          sessionId,
          toolCallId,
          toolName,
          ...(args !== undefined ? { args } : {}),
          ...(preview !== null ? { preview } : {}),
        });
        const resolution = await approvalBridge.request(
          toolCallId,
          toolName,
          args,
          preview,
          sessionId,
        );
        // APPROVAL-MODIFIED-ARGS-SECTION
        // Apply Monaco-edited args in-place so the executor / handler
        // sees the user's edits when commit() runs. Mutating rather
        // than replacing keeps the same reference the executor passed
        // in, which is the contract the post-commit hook + autolint
        // relies on (they re-read `args.path`).
        if (resolution.approved && resolution.modifiedArgs !== undefined) {
          for (const key of Object.keys(resolution.modifiedArgs)) {
            args[key] = resolution.modifiedArgs[key];
          }
        }
        // APPROVAL-MODIFIED-ARGS-SECTION-END
        return resolution.approved;
      },
    });
    // Sorted, byte-stable list of agent tool names — only included in
    // the prompt when the agents config is materialised. Sorting keeps
    // the system-prompt prefix identical across builds.
    const agentToolNames = [
      'agent_status',
      'await_agent',
      'spawn_agent',
      'team_read',
      'team_send',
    ] as const;
    const agentsExposed =
      config.agents !== undefined &&
      TOOLS_SCHEMA.some((t) => t.function.name === 'spawn_agent');

    return new ChatRuntime({
      sessionId,
      tools: [...TOOLS_SCHEMA, ...buildMcpToolSchema(getProcessMcpRegistry())],
      hookEngine: sessionHookEngine,
      projectRoot,
      buildSystemMessage: () => {
        const fresh = configManager.read();
        // Surface the configured worker-slot allow-list to the lead so
        // it never picks an unconfigured model. Falls back to the
        // legacy `workerModel` when no slots are configured.
        const freshAgents = fresh.agents;
        const slotsForPrompt =
          freshAgents !== undefined &&
          freshAgents.workerSlots !== undefined &&
          freshAgents.workerSlots.length > 0
            ? freshAgents.workerSlots.map((s) => {
                const out: { model: string; skills?: readonly string[] } = {
                  model: s.model,
                };
                if (s.skills !== undefined) out.skills = s.skills;
                return out;
              })
            : [];
        const fallbackModel =
          freshAgents !== undefined ? freshAgents.workerModel : undefined;
        // Memory section — read the latest watcher snapshot for THIS
        // session's project. The closure runs once per turn so newly
        // added memory propagates without restarting the session.
        // WEB-PROJECT-CWD-FIX-SECTION — resolve the per-project bag so
        // sessions opened against a different workspace see THAT
        // project's `.localcode/memory/` entries, not the launch dir's.
        const memorySection = renderMemorySection(
          getMemoryBag(projectRoot).snapshot,
        );
        // WEB-PROJECT-CWD-FIX-SECTION-END
        // Hierarchy of LOCALCODE.md files (project root → $HOME, plus
        // the global `~/.localcode/LOCALCODE.md`). Concatenated outermost
        // → innermost so the model sees broader rules first and project-
        // specific rules last. Falls back to a pointer list when the
        // joined body exceeds `LOCALCODE_INLINE_LIMIT`.
        const localcodeMd = readLocalcodeHierarchyForPrompt(projectRoot);
        const content = contextManager.buildSystemPrompt({
          ...(localcodeMd !== null ? { localcodeMd } : {}),
          modelName: fresh.model.current,
          agentsExposed,
          agentTools: agentsExposed ? agentToolNames : [],
          ...(agentsExposed && slotsForPrompt.length > 0
            ? { agentWorkerSlots: slotsForPrompt }
            : {}),
          ...(agentsExposed && slotsForPrompt.length === 0 && fallbackModel !== undefined
            ? { agentWorkerModelFallback: fallbackModel }
            : {}),
          memorySection,
          ...(fresh.outputStyle !== undefined ? { outputStyle: fresh.outputStyle } : {}),
        });
        return {
          id: `sys-${sessionId}-${Date.now()}`,
          role: 'system',
          content,
          createdAt: Date.now(),
        };
      },
      maxContextTokens: config.context.maxTokens,
      llm: llmStream,
      toolExecutor,
      contextManager,
      sessionManager,
      eventBus,
      approvalBridge,
      agentOrchestrator: orch,
    });
  }

  // ── Build handler bag ────────────────────────────────────────────────
  const apiHandler = createApiHandler({
    workspaceRegistry,
    sessionManager,
    configManager,
    createAdapterForBackend,
    // Audit L4 — DELETE /api/sessions/:id releases the per-session
    // ChatRuntime from the pool so its in-memory state is torn down
    // alongside the SQLite row.
    releaseSession: (sessionId: string) => {
      runtimePool.release(sessionId);
    },
  });

  // ── WebSocket wiring ─────────────────────────────────────────────────
  // The csrfToken is generated inside `startWebServer`. We need it in
  // `createWsHandlers` for the hello-gate. Pattern: instantiate the
  // handlers AFTER the token is known by passing a token holder closure
  // and populating it from a wrapper. Simplest approach: read token via
  // a sentinel object whose `csrfToken` field is set before any frame
  // arrives (Bun's `Bun.serve` returns synchronously, so we can populate
  // the handlers after `bindServer` if we delay registration… but Agent
  // A's `startWebServer` accepts the handlers up-front).
  //
  // Cleaner: pre-generate the CSRF token here, pass it into both
  // createWsHandlers AND startWebServer. We replicate the token format
  // from Agent A's `generateCsrfToken` (32 bytes hex).
  const csrfToken = generateCsrfTokenLocal();

  const wsBridge = createWsHandlers({
    csrfToken,
    serverVersion: SERVER_VERSION,
    workspaceRegistry,
    sessionManager,
    configManager,
    eventBus,
    approvalBridge,
    runtimePool,
    createRuntimeForSession,
    applyProviderChange,
    // AGENT-LIFECYCLE-SECTION
    // Lazy orchestrator getter — `getAgentOrchestrator()` materialises
    // the singleton on first use. We expose the LIVE binding via a
    // property getter so the WS handler reads the current state at
    // fire-time without forcing eager construction at handler-build
    // time. `relay_to_agent` only matters once an agent has actually
    // been spawned, which is guaranteed to have already triggered the
    // orchestrator's lazy build via the spawn_agent tool path.
    get agentOrchestrator(): AgentOrchestrator | undefined {
      return agentOrchestrator ?? undefined;
    },
    // /AGENT-LIFECYCLE-SECTION
  });

  // Adapter from Agent C's per-frame handler shape to Bun's
  // server-level WebSocketHandler contract Agent A expects.
  const wsHandlers: WebSocketHandlerSlot = {
    open(ws: ServerWebSocket<Record<string, unknown>>) {
      wsBridge.onOpen(ws as unknown as ServerWebSocket<SocketContext>);
    },
    async message(
      ws: ServerWebSocket<Record<string, unknown>>,
      data: string | Buffer,
    ) {
      await wsBridge.onMessage(
        ws as unknown as ServerWebSocket<SocketContext>,
        // Bun's `data` arrives as `string | Buffer`; Agent C accepts
        // `string | ArrayBuffer | Uint8Array`. Buffer IS a Uint8Array
        // subclass, so the cast is safe.
        typeof data === 'string' ? data : (data as unknown as Uint8Array),
      );
    },
    close(ws: ServerWebSocket<Record<string, unknown>>) {
      wsBridge.onClose(ws as unknown as ServerWebSocket<SocketContext>);
    },
  };

  // Adapter for the upgrade hook — Agent A's router expects
  // `(req, server) => 'upgraded' | Response`. Agent C's `upgrade` returns
  // the same union.
  const upgradeWebSocket = (
    req: Request,
    server: Server<Record<string, unknown>>,
  ) => wsBridge.upgrade(req, server as unknown as Server<SocketContext>);

  // Fire SessionStart hooks (best-effort — never block web startup).
  void fireSessionStartHooks(opts.projectRoot);

  // PRICING-REFRESH-SECTION — kick a background refresh of the
  // OpenRouter pricing catalog. Non-blocking: the call respects the
  // 24h on-disk cache TTL (so most boots are a no-op) and silently
  // falls back to the existing cache / static table on network failure.
  // Persisted-cost lookups in SessionManager.addMessage pick up the
  // refreshed map on the next turn.
  void refreshOpenRouterPricing().catch(() => {
    /* best-effort — pricing degrades to static table on failure */
  });
  // PRICING-REFRESH-SECTION-END

  // UPDATER-WIRE-SECTION
  // Auto-update singleton — mirrors the TUI integration in app.tsx.
  // Emits synthetic system messages (broadcast across all subscribed
  // sessions) on `update-available` / `update-downloaded`. Disabled
  // when `config.updater.enabled === false` (zero traffic).
  let updaterCleanup: (() => void) | null = null;
  void (async (): Promise<void> => {
    try {
      let updaterCfg: {
        enabled: boolean;
        channel: 'stable' | 'beta';
        checkIntervalHours: number;
        autoDownload: boolean;
        checkOnLaunch: boolean;
        silentBackground: boolean;
        preferPatchDelta: boolean;
      } = {
        enabled: true,
        channel: 'stable',
        checkIntervalHours: 6,
        autoDownload: true,
        checkOnLaunch: true,
        silentBackground: true,
        preferPatchDelta: true,
      };
      try {
        const cfg = configManager.read();
        if (cfg.updater !== undefined) {
          updaterCfg = {
            enabled: cfg.updater.enabled,
            channel: cfg.updater.channel,
            checkIntervalHours: cfg.updater.checkIntervalHours,
            autoDownload: cfg.updater.autoDownload,
            checkOnLaunch: cfg.updater.checkOnLaunch,
            silentBackground: cfg.updater.silentBackground,
            preferPatchDelta: cfg.updater.preferPatchDelta,
          };
        }
      } catch {
        /* swallow — keep defaults */
      }
      if (!updaterCfg.enabled) return;
      const { getProcessUpdater } = await import('@/updater');
      // PKG_VERSION mirror — kept in sync with cli.tsx via the same
      // single-source-of-truth (package.json) discipline.
      const updater = getProcessUpdater({
        currentVersion: '0.19.0',
        autoDownload: updaterCfg.autoDownload,
        intervalMs: updaterCfg.checkIntervalHours * 60 * 60 * 1_000,
        preferPatchDelta: updaterCfg.preferPatchDelta,
        forceNew: true,
      });
      const unsubscribe = updater.on((event) => {
        // UPDATE-MODAL-WS-SECTION — broadcast the dedicated update
        // frames so the SPA can render the polished modal. The old
        // error-message broadcast is removed: the modal owns the
        // user-facing affordance, and silent background mode means we
        // emit nothing else.
        if (event.type === 'update-available') {
          if (updaterCfg.silentBackground !== true) {
            process.stderr.write(
              `localcode(web): Update available: v${event.currentVersion} → v${event.release.version}\n`,
            );
          }
          const recent = sessionManager.listSessions(20);
          for (const s of recent) {
            eventBus.emit(s.id, {
              type: 'update_available',
              currentVersion: event.currentVersion,
              latestVersion: event.release.version,
              releaseUrl: event.release.htmlUrl,
              releaseName: event.release.name,
              body: event.release.body,
              publishedAt: event.release.publishedAt,
            });
          }
          // DELTA-NOTES-WS-SECTION — opportunistically fetch the
          // concatenated delta (every release between current → latest)
          // and re-emit a SECOND frame so the modal swaps in the
          // richer body. Best-effort: a failure here just leaves the
          // single-release `body` from the first frame.
          void (async (): Promise<void> => {
            try {
              const delta = await updater.getDeltaNotes();
              if (delta === null || delta.notes.trim().length === 0) return;
              const refreshed = sessionManager.listSessions(20);
              for (const s of refreshed) {
                eventBus.emit(s.id, {
                  type: 'update_available',
                  currentVersion: event.currentVersion,
                  latestVersion: event.release.version,
                  releaseUrl: event.release.htmlUrl,
                  releaseName: event.release.name,
                  body: event.release.body,
                  publishedAt: event.release.publishedAt,
                  deltaNotes: delta.notes,
                });
              }
            } catch {
              /* swallow — first frame already shipped */
            }
          })();
        } else if (event.type === 'update-downloaded') {
          if (updaterCfg.silentBackground !== true) {
            process.stderr.write(
              `localcode(web): Update ready: v${event.version}. Restart LocalCode to apply.\n`,
            );
          }
          const recent = sessionManager.listSessions(20);
          for (const s of recent) {
            eventBus.emit(s.id, {
              type: 'update_downloaded',
              version: event.version,
            });
          }
        }
      });
      if (updaterCfg.checkOnLaunch !== false) {
        updater.start();
      }
      updaterCleanup = (): void => {
        try {
          unsubscribe();
        } catch {
          /* swallow */
        }
        try {
          updater.stop();
        } catch {
          /* swallow */
        }
      };
    } catch {
      /* best-effort — updater never blocks boot */
    }
  })();
  const cleanupUpdater = (): void => {
    if (updaterCleanup !== null) updaterCleanup();
    updaterCleanup = null;
  };
  process.once('SIGINT', cleanupUpdater);
  process.once('SIGTERM', cleanupUpdater);
  // UPDATER-WIRE-SECTION-END

  // Boot the MCP registry. Each configured server starts in parallel;
  // failures are recorded inside the registry (never thrown here).
  //
  // The TUI's app.tsx may already have started the same process-wide
  // singleton — `start()` is idempotent on slots-already-present, so
  // calling it again is cheap and won't double-spawn. We still attach a
  // `.catch` defensively so an unexpected rejection (e.g. an upstream
  // change in the registry contract) doesn't surface as an unhandled
  // rejection and crash the TUI hosting the embedded server.
  const mcpRegistry = getProcessMcpRegistry();
  void mcpRegistry
    .start(
      ((): Record<string, import('@/types/global').McpServerConfig> => {
        try { return new ConfigManager().read().mcpServers ?? {}; }
        catch { return {}; }
      })(),
    )
    .catch(() => { /* swallow — individual server errors are recorded inside the registry */ });
  // Register shutdown cleanup for the MCP registry.
  const cleanupMcp = (): void => {
    void mcpRegistry.dispose().catch(() => { /* swallow */ });
  };
  process.once('SIGINT', cleanupMcp);
  process.once('SIGTERM', cleanupMcp);

  // ONTOLOGY-WIRE-SECTION — boot the per-project ontology indexer.
  // Lazy-constructs the singleton, kicks the first scan, and arms a
  // background loop + chokidar watcher (debounced 2s) for incremental
  // refresh. Disposed on SIGINT/SIGTERM. All failures are swallowed —
  // ontology is best-effort.
  const ontologyIndexer = new OntologyIndexer({ projectRoot: opts.projectRoot });
  setProcessOntologyIndexer(ontologyIndexer);
  void (async (): Promise<void> => {
    try {
      await ontologyIndexer.loadPersisted();
      void ontologyIndexer.indexProject();
    } catch { /* swallow */ }
  })();
  const stopOntologyInterval = ontologyIndexer.startBackgroundReindex(300_000);
  const ontologyWatcher = chokidar.watch(opts.projectRoot, {
    ignoreInitial: true,
    depth: 8,
    persistent: true,
    ignored: (filePath: string) =>
      filePath.includes('node_modules') ||
      filePath.includes('.git') ||
      filePath.includes('/dist/') ||
      filePath.includes('/dist-web/') ||
      filePath.includes('.localcode'),
  });
  const onOntologyChange = (filePath: string): void => {
    if (!/\.(?:tsx|ts|cts|mts)$/.test(filePath)) return;
    ontologyIndexer.scheduleReindex(2_000);
  };
  ontologyWatcher.on('add', onOntologyChange);
  ontologyWatcher.on('change', onOntologyChange);
  ontologyWatcher.on('unlink', onOntologyChange);
  ontologyWatcher.on('error', () => { /* swallow */ });
  const cleanupOntology = (): void => {
    stopOntologyInterval();
    void ontologyWatcher.close();
    void ontologyIndexer.dispose().catch(() => { /* swallow */ });
    setProcessOntologyIndexer(null);
  };
  process.once('SIGINT', cleanupOntology);
  process.once('SIGTERM', cleanupOntology);
  // ONTOLOGY-WIRE-SECTION-END

  // B3 — kill any still-running background `run_command` children on
  // unattended termination. Mirrors `cleanupMcp` / `cleanupMemory` —
  // lazy-import via `@/tools` keeps the web bundle entry stable.
  const cleanupBackgroundTasks = (): void => {
    void (async (): Promise<void> => {
      try {
        const { getProcessBackgroundTaskRegistry } = await import('@/tools');
        await getProcessBackgroundTaskRegistry().dispose();
      } catch {
        /* swallow — best-effort */
      }
    })();
  };
  process.once('SIGINT', cleanupBackgroundTasks);
  process.once('SIGTERM', cleanupBackgroundTasks);

  // PROCESS-MONITOR-WIRE-SECTION — dispose the long-running process
  // registry on shutdown. SIGTERM (then SIGKILL after the grace
  // window) is delivered to every watched child by the monitor itself,
  // so a single best-effort dispose call is enough.
  const cleanupProcessMonitor = (): void => {
    void getProcessMonitor().dispose().catch(() => {
      /* swallow — best-effort */
    });
  };
  process.once('SIGINT', cleanupProcessMonitor);
  process.once('SIGTERM', cleanupProcessMonitor);
  // PROCESS-MONITOR-WIRE-SECTION-END

  const running = await startWebServer({
    projectRoot: opts.projectRoot,
    ...(opts.host !== undefined && { host: opts.host }),
    ...(opts.port !== undefined && { port: opts.port }),
    ...(opts.openInBrowser !== undefined && { openInBrowser: opts.openInBrowser }),
    handleApi: apiHandler,
    upgradeWebSocket,
    wsHandlers,
    csrfToken,
  });

  // Wrap `stop()` so the memory watcher is closed cleanly on
  // programmatic shutdown (callers that don't rely on signals). The
  // SIGINT/SIGTERM listeners above remain as a backstop for unattended
  // termination.
  //
  // Teardown order matters:
  //   1. `runtimePool.dispose()` — fires `SessionEnd` hooks (cause
  //      `'shutdown'`) for every resident runtime BEFORE the underlying
  //      WS connections are torn down, so user hooks observe a coherent
  //      session-id and projectRoot. Mirrors the `cleanupMcp` /
  //      `cleanupMemory` pattern above.
  //   2. `cleanupMemory()` — close the chokidar watcher.
  //   3. `originalStop()` — drains the HTTP/WS server.
  const originalStop = running.stop;
  return {
    ...running,
    stop: async () => {
      // RECOVERY-FIX-3-SECTION — stop the watchdog before disposing
      // the pool so an in-flight sweep can't observe a partially-torn
      // pool. cleanupWatchdog is idempotent so the SIGINT/SIGTERM
      // listeners above are harmless when both fire.
      cleanupWatchdog();
      // RECOVERY-FIX-3-SECTION-END
      try {
        await runtimePool.dispose();
      } catch (err) {
        process.stderr.write(
          `localcode(web): runtimePool.dispose failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
      cleanupMemory();
      // C2 — dispose the WakeupRegistry so no pending timer survives
      // beyond the server lifetime. Mirrors `cleanupMemory` / `cleanupMcp`.
      cleanupWakeups();
      // B3 — drain background `run_command` tasks before stopping the
      // server so we don't leak children when callers programmatically
      // restart the web app.
      try {
        const { getProcessBackgroundTaskRegistry } = await import('@/tools');
        await getProcessBackgroundTaskRegistry().dispose();
      } catch (err) {
        process.stderr.write(
          `localcode(web): background-task dispose failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
      // PROCESS-MONITOR-WIRE-SECTION — drain watched processes too.
      try {
        await getProcessMonitor().dispose();
      } catch (err) {
        process.stderr.write(
          `localcode(web): process-monitor dispose failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
      // PROCESS-MONITOR-WIRE-SECTION-END
      await originalStop();
    },
  };
}

/**
 * Local CSRF generator. Mirrors the one in `src/web/server/csrf.ts` so we
 * don't have to thread the same token through two construction sites.
 * 32 bytes hex-encoded.
 */
function generateCsrfTokenLocal(): string {
  const bytes = new Uint8Array(32);
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
