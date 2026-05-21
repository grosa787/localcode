/**
 * AgentOrchestrator — lifecycle manager for multi-agent runs.
 *
 * One orchestrator instance per server process. Bookkeeping is keyed by
 * `parentSessionId` (the lead's session): every parent has its own team
 * (a `TeamBus` plus the set of live `AgentHandle`s).
 *
 * Decoupling from ChatRuntime: the orchestrator does NOT directly
 * instantiate the per-worker ChatRuntime. Instead, callers inject a
 * `runWorker(spec)` function that returns an `AgentRunner` — an object
 * exposing `start()`, `cancel()`, and observable status hooks. The
 * production wiring (in `web/runtime/chat-runtime.ts`) supplies a runner
 * backed by RuntimePool + ChatRuntime; tests supply a fake runner.
 *
 * This keeps the orchestrator free of cyclic dependencies on the rest
 * of the runtime and trivially testable.
 */

import type {
  AgentAwaitResult,
  AgentHandle,
  AgentStatus,
  AgentStatusSnapshot,
  AgentTeamState,
  AgentsConfig,
  SpawnAgentRequest,
  TeamBusMessage,
} from './types';
import { LEAD_AGENT_ID } from './types';
import { findAgentTemplate, type AgentTemplate } from './catalog';
import { TeamBus } from './team-bus';
import {
  createWorktree,
  diffWorktree,
  type Worktree,
  type SpawnFn,
} from './worktree';
// WORKER-POOL-SECTION
import type { PooledWorkerHandle, WorkerPool } from './worker-pool';
// WORKTREE-GC-SECTION
import { WorktreeGC, worktreesDir } from './worktree-gc';
// WORKTREE-GC-SECTION-END

/**
 * The runner abstracts "actually run an agent". The orchestrator drives
 * its lifecycle and observes status updates through the supplied
 * callbacks. Implementations may be backed by a real ChatRuntime or by
 * a test fake — the orchestrator doesn't care.
 */
export interface AgentRunnerCallbacks {
  /** Streamed assistant text for `lastMessage` in the snapshot. */
  onMessage: (text: string) => void;
  /** Terminal — `summary` is the post-<DONE> trimmed text. */
  onDone: (info: { summary: string; filesChanged?: readonly string[] }) => void;
  /** Terminal — non-cancellation failure. */
  onError: (error: string) => void;
}

export interface AgentRunner {
  /** Begin executing the worker. Resolves when streaming kicks off. */
  start(callbacks: AgentRunnerCallbacks): Promise<void>;
  /**
   * Best-effort cancel. Implementations should propagate within ~2s
   * (the orchestrator escalates to a hard kill at that boundary).
   */
  cancel(): Promise<void>;
}

/** The factory shape callers inject. */
export type AgentRunnerFactory = (spec: AgentRunnerSpec) => AgentRunner;

export interface AgentRunnerSpec {
  agentId: string;
  parentSessionId: string;
  childSessionId: string;
  task: string;
  ownedFiles: readonly string[];
  otherAgents: ReadonlyArray<{ id: string; ownedFiles: readonly string[] }>;
  model: string;
  skills: readonly string[];
  /** Cwd for the worker — worktree path when isolation='worktree', else parent's projectRoot. */
  cwd: string;
  /** True iff `config.agents.approval === 'auto'`. */
  autoApprove: boolean;
  /**
   * WORKER-POOL-SECTION — template id that drives `WorkerPool` bucket
   * selection. `undefined` when the spawn is template-less (the bulk
   * of `spawn_agent` callers); the orchestrator falls back to
   * `'default'` in that case so workers still share a bucket.
   */
  templateId?: string;
}

/**
 * Events the orchestrator surfaces. The composition root subscribes and
 * forwards them to the WS event bus for the parent session.
 */
export type OrchestratorEvent =
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
      status: AgentStatus;
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
  // Fires once per agent right after it terminates (done/failed/cancelled)
  // AND has been moved from the `active` list into `history`. Frontend
  // panels use this to drop the row from the "currently running" view
  // while preserving the entry for the `/agents` historical view. Carries
  // the terminal status + the timestamp the move happened so consumers
  // can render a "moved to history Xs ago" hint without polling.
  | {
      type: 'agent_removed';
      sessionId: string;
      agentId: string;
      status: AgentStatus;
      removedAt: number;
    };
// AGENT-LIFECYCLE-SECTION-END

export type OrchestratorListener = (evt: OrchestratorEvent) => void;

export interface AgentOrchestratorOptions {
  /** Project root used as the git repo for worktree creation. */
  projectRoot: string;
  /** Effective agents-config block (resolved from app config). */
  config: AgentsConfig;
  /** Factory that produces a runner for each spawn. */
  runnerFactory: AgentRunnerFactory;
  /** Inject Bun.spawn for git ops; mainly a test seam. */
  gitSpawn?: SpawnFn;
  /** Optional id generator — tests pass a deterministic one. */
  idGenerator?: () => string;
  /** Bus capacity override per parent. */
  busCapacity?: number;
  // WORKER-POOL-SECTION (start)
  /**
   * Optional pool of warm workers per template id. When provided AND
   * `pooledRunnerFactory` is also supplied, the orchestrator will
   * try `pool.acquire(templateId)` before falling back to
   * `pooledRunnerFactory(spec)`. On worker completion the pool
   * receives the handle via `release()` — the pool's `reset()` hook
   * clears conversation state before recycling.
   *
   * The production `buildAgentRunnerFactory` returns one-shot
   * runners; pool wiring is provided here as a forward-compatible
   * seam (no behaviour change today). Tests inject a stateful runner
   * to exercise the reuse path.
   */
  workerPool?: WorkerPool<AgentRunner>;
  /**
   * Pool-aware runner factory. Returns a `PooledWorkerHandle` whose
   * `worker` field is the `AgentRunner`. The pool calls `reset()` on
   * release; `dispose()` runs at eviction. Mutually exclusive with
   * relying solely on `runnerFactory` — both may be set, in which
   * case the pool path is preferred when `workerPool` is also set.
   */
  pooledRunnerFactory?: (spec: AgentRunnerSpec) => PooledWorkerHandle<AgentRunner>;
  // WORKER-POOL-SECTION (end)
}

/**
 * Public surface used by the agent_* tools. Kept tight to make the
 * tool wiring obvious and to keep the test contract small.
 */
export class AgentOrchestrator {
  private readonly teams = new Map<string, AgentTeamStateInternal>();
  private readonly opts: AgentOrchestratorOptions;
  private readonly listeners = new Set<OrchestratorListener>();
  // WORKTREE-GC-SECTION
  private readonly worktreeGC: WorktreeGC;
  // WORKTREE-GC-SECTION-END

  constructor(opts: AgentOrchestratorOptions) {
    this.opts = opts;
    // WORKTREE-GC-SECTION
    this.worktreeGC = new WorktreeGC();
    // WORKTREE-GC-SECTION-END
  }

  // WORKTREE-GC-SECTION
  /** Expose the GC for startup/shutdown hooks + the `/worktrees` command. */
  getWorktreeGC(): WorktreeGC {
    return this.worktreeGC;
  }
  // WORKTREE-GC-SECTION-END

  /** Subscribe to orchestrator events. Returns an unsubscribe fn. */
  subscribe(fn: OrchestratorListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Diagnostics — count of live (non-terminal) agents under a parent. */
  liveCount(parentSessionId: string): number {
    const t = this.teams.get(parentSessionId);
    if (t === undefined) return 0;
    let n = 0;
    for (const h of t.agents.values()) {
      if (h.getStatus() === 'running') n += 1;
    }
    return n;
  }

  /** Look up a handle. Used by the agent_status / await_agent tools. */
  get(parentSessionId: string, agentId: string): AgentHandle | undefined {
    const t = this.teams.get(parentSessionId);
    if (t === undefined) return undefined;
    return t.agents.get(agentId) ?? t.history.get(agentId);
  }

  /**
   * Snapshot of every agent under a parent — combined active + history.
   * Returns the active list followed by historical entries for the
   * `/agents` view and `await_agent` lookups.
   */
  list(parentSessionId: string): readonly AgentHandle[] {
    const t = this.teams.get(parentSessionId);
    if (t === undefined) return [];
    return [...t.agents.values(), ...t.history.values()];
  }

  // AGENT-LIFECYCLE-SECTION
  /**
   * Currently-running agents only. Used by panels that want the
   * "active" view — completed/failed/cancelled rows are moved to
   * `listHistory()` immediately on terminate.
   */
  listActive(parentSessionId: string): readonly AgentHandle[] {
    const t = this.teams.get(parentSessionId);
    if (t === undefined) return [];
    return [...t.agents.values()];
  }

  /** Terminated agents only, in completion order (oldest first). */
  listHistory(parentSessionId: string): readonly AgentHandle[] {
    const t = this.teams.get(parentSessionId);
    if (t === undefined) return [];
    return [...t.history.values()];
  }
  // AGENT-LIFECYCLE-SECTION-END

  /** Get-or-create the team's TeamBus. Used by team_send / team_read. */
  getBus(parentSessionId: string): TeamBus {
    return this.ensureTeam(parentSessionId).bus;
  }

  /**
   * Send a team message. Wrapper exists so the orchestrator can fan
   * the event out to listeners (WS forwarding) on every send. Returns
   * the canonical envelope.
   */
  postTeamMessage(
    parentSessionId: string,
    from: string,
    to: string,
    message: string,
  ): TeamBusMessage {
    const team = this.ensureTeam(parentSessionId);
    return team.bus.send({ from, to, message });
  }

  /** Read team messages addressed to `forAgentId` since a cursor. */
  readTeamMessages(
    parentSessionId: string,
    forAgentId: string,
    sinceMs: number,
  ): TeamBusMessage[] {
    return this.ensureTeam(parentSessionId).bus.read(forAgentId, sinceMs);
  }

  /**
   * Spawn a fresh sub-agent. Enforces `maxConcurrent`, creates an
   * optional worktree, builds the runner, kicks off the worker
   * asynchronously, and returns the handle (status: 'running').
   *
   * Throws synchronously when the cap is exceeded or args are invalid.
   * Worktree-creation failures fall back to shared mode rather than
   * surfacing — the lead can still salvage progress.
   */
  async spawn(
    parentSessionId: string,
    req: SpawnAgentRequest,
  ): Promise<AgentHandle> {
    if (typeof req.task !== 'string' || req.task.trim().length === 0) {
      throw new Error('spawn_agent: task must be a non-empty string');
    }
    if (!Array.isArray(req.files)) {
      throw new Error('spawn_agent: files must be an array');
    }
    const team = this.ensureTeam(parentSessionId);
    const live = this.countLive(team);
    if (live >= this.opts.config.maxConcurrent) {
      throw new Error(
        `spawn_agent: maxConcurrent reached (${this.opts.config.maxConcurrent} agents already running for ${parentSessionId})`,
      );
    }

    const agentId = this.generateAgentId();
    const childSessionId = `${parentSessionId}.agent.${agentId}`;
    const isolation = req.isolation ?? this.opts.config.isolation;
    const model = req.model ?? this.opts.config.workerModel;
    const skills = req.skills ?? [];
    const timeoutSec = req.timeout ?? this.opts.config.defaultTimeoutSec;

    let worktree: Worktree | null = null;
    let cwd = this.opts.projectRoot;
    if (isolation === 'worktree') {
      try {
        worktree = await createWorktree(this.opts.projectRoot, agentId, {
          ...(this.opts.gitSpawn !== undefined ? { spawn: this.opts.gitSpawn } : {}),
          // WORKTREE-GC-SECTION
          // Anchor worktrees inside the project so WorktreeGC can scan a
          // predictable, safe-to-prune location at startup/shutdown.
          baseDir: worktreesDir(this.opts.projectRoot),
          // WORKTREE-GC-SECTION-END
        });
        cwd = worktree.path;
        // WORKTREE-GC-SECTION
        // Track the new worktree so the GC's active-set check skips it.
        // Branch is null today — createWorktree pins HEAD without forking
        // a new branch — but we keep the slot in the registry shape for
        // a future change that does.
        this.worktreeGC.register(agentId, worktree.path, null);
        // WORKTREE-GC-SECTION-END
      } catch (err) {
        // Fall back to shared mode — log but never fail the spawn.
        // eslint-disable-next-line no-console
        console.warn(
          `[agents] worktree create failed (${err instanceof Error ? err.message : String(err)}); falling back to shared isolation`,
        );
        worktree = null;
      }
    }

    const otherAgents = [...team.agents.values()]
      .filter((h) => h.getStatus() === 'running')
      .map((h) => ({ id: h.agentId, ownedFiles: h.ownedFiles }));

    const startedAt = Date.now();
    const handleImpl = new AgentHandleImpl({
      agentId,
      parentSessionId,
      childSessionId,
      task: req.task,
      ownedFiles: [...req.files],
      model,
      worktreePath: worktree?.path ?? null,
      startedAt,
    });
    team.agents.set(agentId, handleImpl);

    const spawnedEvt: OrchestratorEvent = worktree !== null
      ? {
          type: 'agent_spawned',
          sessionId: parentSessionId,
          agentId,
          parentAgentId: LEAD_AGENT_ID,
          model,
          task: req.task,
          ownedFiles: [...req.files],
          worktreePath: worktree.path,
          startedAt,
        }
      : {
          type: 'agent_spawned',
          sessionId: parentSessionId,
          agentId,
          parentAgentId: LEAD_AGENT_ID,
          model,
          task: req.task,
          ownedFiles: [...req.files],
          startedAt,
        };
    this.fire(spawnedEvt);

    // WORKER-POOL-SECTION (start) — Try the pool before spawning fresh.
    //
    // The pool is keyed by `req.templateId` (defaulting to 'default' so
    // template-less spawns still share one bucket). When `workerPool` +
    // `pooledRunnerFactory` are both wired AND the pool has a warm
    // handle for this template, we reuse the handle's runner; otherwise
    // we fall back to `pooledRunnerFactory` (pool miss) or the legacy
    // `runnerFactory` (no pool configured at all).
    //
    // `pooledHandle` is captured so terminal callbacks below can call
    // `pool.release(...)` — that's what triggers `reset()` and
    // re-insertion into the bucket.
    const templateId = req.templateId ?? 'default';
    const spec: AgentRunnerSpec = {
      agentId,
      parentSessionId,
      childSessionId,
      task: req.task,
      ownedFiles: [...req.files],
      otherAgents,
      model,
      skills: [...skills],
      cwd,
      autoApprove: this.opts.config.approval === 'auto',
      templateId,
    };
    let runner: AgentRunner;
    let pooledHandle: PooledWorkerHandle<AgentRunner> | null = null;
    if (this.opts.workerPool !== undefined && this.opts.pooledRunnerFactory !== undefined) {
      const acquired = await this.opts.workerPool.acquire(templateId);
      if (acquired !== null) {
        pooledHandle = acquired;
        runner = acquired.worker;
      } else {
        // Pool miss — spawn a fresh handle through the pool-aware factory.
        pooledHandle = this.opts.pooledRunnerFactory(spec);
        runner = pooledHandle.worker;
      }
    } else {
      runner = this.opts.runnerFactory(spec);
    }
    handleImpl.bind(runner, worktree, this.opts.gitSpawn);
    // WORKER-POOL-SECTION (end)

    // Timeout watchdog.
    const timeoutMs = timeoutSec * 1000;
    const timer = setTimeout(() => {
      if (handleImpl.getStatus() === 'running') {
        // eslint-disable-next-line no-console
        console.warn(`[agents] ${agentId} timed out after ${timeoutSec}s; cancelling`);
        void handleImpl.cancel(`timeout after ${timeoutSec}s`);
      }
    }, timeoutMs);
    handleImpl.onTerminal(() => clearTimeout(timer));

    // WORKER-POOL-SECTION — return the warm worker to the pool when the
    // handle terminates (done / failed / cancelled). Pool decides
    // whether to recycle (reset succeeded, bucket below cap, worker
    // alive) or dispose. Fire-and-forget — `release()` is awaited inside
    // the pool but we can't block terminal propagation on it.
    if (pooledHandle !== null && this.opts.workerPool !== undefined) {
      const pool = this.opts.workerPool;
      const handleToRelease = pooledHandle;
      handleImpl.onTerminal(() => {
        void pool.release(handleToRelease);
      });
    }

    // Wire status -> orchestrator events.
    handleImpl.onUpdate((snap) => {
      const evt: OrchestratorEvent = snap.error !== undefined
        ? {
            type: 'agent_status',
            sessionId: parentSessionId,
            agentId,
            status: snap.status,
            ...(snap.lastMessage !== undefined ? { lastMessage: snap.lastMessage } : {}),
            error: snap.error,
          }
        : {
            type: 'agent_status',
            sessionId: parentSessionId,
            agentId,
            status: snap.status,
            ...(snap.lastMessage !== undefined ? { lastMessage: snap.lastMessage } : {}),
          };
      this.fire(evt);
    });
    // WORKTREE-GC-SECTION
    // Drop the registry entry whenever the agent terminates (done,
    // failed, or cancelled). The handle's own `terminate()` already
    // runs the per-worktree `cleanup()`, so we only need to update the
    // GC's active-set bookkeeping here.
    handleImpl.onTerminal(() => {
      this.worktreeGC.release(agentId);
    });
    // WORKTREE-GC-SECTION-END
    // AGENT-LIFECYCLE-SECTION
    // Move from `active` → `history` the moment we hit a terminal state.
    // We capture the team reference up front (rather than re-looking up
    // by parent id) so a parallel `disposeTeam` racing the terminal
    // callback can't have us re-insert into a freshly-cleared team. If
    // the team was already disposed, both maps are clear and we no-op.
    const teamForLifecycle = team;
    handleImpl.onTerminal(() => {
      if (!teamForLifecycle.agents.has(agentId)) return;
      teamForLifecycle.agents.delete(agentId);
      teamForLifecycle.history.set(agentId, handleImpl);
      this.fire({
        type: 'agent_removed',
        sessionId: parentSessionId,
        agentId,
        status: handleImpl.getStatus(),
        removedAt: Date.now(),
      });
    });
    // AGENT-LIFECYCLE-SECTION-END
    handleImpl.onComplete((res) => {
      const evt: OrchestratorEvent = res.diff && res.diff.length > 0
        ? {
            type: 'agent_completed',
            sessionId: parentSessionId,
            agentId,
            summary: res.summary,
            diff: res.diff,
            durationMs: res.durationMs,
          }
        : {
            type: 'agent_completed',
            sessionId: parentSessionId,
            agentId,
            summary: res.summary,
            durationMs: res.durationMs,
          };
      this.fire(evt);
    });

    // Async start — failures land in handle's terminal state.
    void handleImpl.runStart();

    return handleImpl;
  }

  /**
   * Spawn a sub-agent using a curated catalog template. The template's
   * `systemPrompt` is prepended to the user-supplied `customPrompt` so
   * the worker sees the role definition followed by the concrete task.
   *
   * Returns the same `AgentHandle` shape as `spawn`. Throws synchronously
   * when `templateId` is unknown — callers (the `/spawn` slash command
   * and the `spawn_agent` tool when `template` is set) should validate
   * the id before invoking this method.
   *
   * The template's `tools` allow-list is NOT enforced at the
   * orchestrator boundary (yet) — that requires runner-factory support
   * which is intentionally out of scope here. The system prompt
   * documents the constraint to the worker so it self-limits.
   */
  async spawnFromTemplate(
    parentSessionId: string,
    templateId: string,
    customPrompt: string,
    overrides?: {
      files?: readonly string[];
      model?: string;
      isolation?: 'worktree' | 'shared';
      timeout?: number;
    },
  ): Promise<AgentHandle> {
    const template: AgentTemplate | undefined = findAgentTemplate(templateId);
    if (template === undefined) {
      throw new Error(
        `spawnFromTemplate: unknown template "${templateId}". ` +
          'See `/spawn` (no args) for the list of available templates.',
      );
    }
    const trimmedCustom = customPrompt.trim();
    if (trimmedCustom.length === 0) {
      throw new Error(
        `spawnFromTemplate: customPrompt is empty — describe the concrete task for the ${template.name} template.`,
      );
    }
    const task = [
      `[role: ${template.name}]`,
      template.systemPrompt,
      '',
      `[task]`,
      trimmedCustom,
      '',
      `[tools allow-list]`,
      template.tools.length === 0
        ? '(no restriction)'
        : template.tools.join(', '),
    ].join('\n');

    const req: SpawnAgentRequest = {
      task,
      files: overrides?.files !== undefined ? [...overrides.files] : [],
      ...(overrides?.model !== undefined
        ? { model: overrides.model }
        : template.recommendedModel.length > 0
        ? { model: template.recommendedModel }
        : {}),
      ...(overrides?.isolation !== undefined
        ? { isolation: overrides.isolation }
        : {}),
      ...(overrides?.timeout !== undefined
        ? { timeout: overrides.timeout }
        : {}),
      // WORKER-POOL-SECTION — propagate template id so the pool keys
      // warm workers per template (each template has a different
      // system prompt + tool allow-list).
      templateId,
    };
    return this.spawn(parentSessionId, req);
  }

  /**
   * Cancel and dispose every agent under a parent. Called when the
   * parent runtime is evicted/disposed by the RuntimePool. Awaitable
   * so the caller can guarantee worktrees are cleaned up.
   *
   * Audit M7 — explicit `team.busUnsubscribe()` before `team.bus.clear()`
   * so a mid-dispose throw (cancel + worktree cleanup can fail) can't
   * leave the orchestrator's own listener dangling on a stale bus.
   */
  async disposeTeam(parentSessionId: string): Promise<void> {
    const team = this.teams.get(parentSessionId);
    if (team === undefined) return;
    this.teams.delete(parentSessionId);
    // Drop our own bus subscription FIRST — even if the subsequent
    // cancel/cleanup throws, the listener is gone.
    try {
      team.busUnsubscribe();
    } catch {
      // best-effort — bus may already be torn down by a parallel path
    }
    const handles = [...team.agents.values()];
    await Promise.all(
      handles.map((h) => h.cancel('parent disposed').catch(() => undefined)),
    );
    // AGENT-LIFECYCLE-SECTION — drop history together with the live set
    // so the next-incarnation team starts empty.
    team.history.clear();
    // AGENT-LIFECYCLE-SECTION-END
    team.bus.clear();
  }

  /** Drop everything. Used at server shutdown / between tests. */
  async disposeAll(): Promise<void> {
    const ids = [...this.teams.keys()];
    for (const id of ids) await this.disposeTeam(id);
  }

  // ---------- internals ----------

  private ensureTeam(parentSessionId: string): AgentTeamStateInternal {
    let team = this.teams.get(parentSessionId);
    if (team !== undefined) return team;
    const bus = new TeamBus(
      this.opts.busCapacity !== undefined
        ? { capacity: this.opts.busCapacity }
        : {},
    );
    // Forward bus messages to listeners as `agent_team_message` events.
    // Capture the unsubscribe so disposeTeam can release it explicitly
    // (audit M7) rather than relying on `bus.clear()` racing the throw.
    const busUnsubscribe = bus.subscribe((m) => {
      this.fire({
        type: 'agent_team_message',
        sessionId: parentSessionId,
        from: m.from,
        to: m.to,
        message: m.message,
        at: m.at,
      });
    });
    team = { agents: new Map(), history: new Map(), bus, busUnsubscribe };
    this.teams.set(parentSessionId, team);
    return team;
  }

  private countLive(team: AgentTeamStateInternal): number {
    let n = 0;
    for (const h of team.agents.values()) {
      if (h.getStatus() === 'running') n += 1;
    }
    return n;
  }

  private fire(evt: OrchestratorEvent): void {
    const snap = [...this.listeners];
    for (const fn of snap) {
      try {
        fn(evt);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[agents] listener threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private generateAgentId(): string {
    if (this.opts.idGenerator !== undefined) return this.opts.idGenerator();
    // 6-char alphanumeric — short enough to fit in the child sessionId.
    return Math.random().toString(36).slice(2, 8);
  }
}

/** Internal team-state shape — exposes the bus to the orchestrator. */
interface AgentTeamStateInternal extends AgentTeamState {
  agents: Map<string, AgentHandleImpl>;
  // AGENT-LIFECYCLE-SECTION
  /**
   * Terminated agents (done/failed/cancelled). Moved here from `agents`
   * the moment the handle terminates so `listActive()` shrinks and the
   * UI's "currently running" view loses the row. Retained for the
   * `/agents` historical view, `await_agent` post-mortem lookups, and
   * the team-chat transcript context.
   */
  history: Map<string, AgentHandleImpl>;
  // AGENT-LIFECYCLE-SECTION-END
  bus: TeamBus;
  /** Audit M7 — orchestrator's own subscription, released in disposeTeam. */
  busUnsubscribe: () => void;
}

/**
 * Concrete handle implementation. Tracks status, exposes a `done()`
 * promise that resolves at terminal, and serialises cancel into a
 * single deterministic teardown including worktree cleanup + diff.
 */
class AgentHandleImpl implements AgentHandle {
  readonly agentId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly task: string;
  readonly ownedFiles: readonly string[];
  readonly model: string;
  readonly worktreePath: string | null;
  readonly startedAt: number;

  private status: AgentStatus = 'running';
  private lastMessage: string | undefined;
  private filesChanged: readonly string[] | undefined;
  private error: string | undefined;
  private summary = '';
  private diff = '';
  private resolved = false;
  private resolveDone!: (r: AgentAwaitResult) => void;
  private donePromise: Promise<AgentAwaitResult>;
  private updateListeners = new Set<(s: AgentStatusSnapshot) => void>();
  private completeListeners = new Set<(r: AgentAwaitResult) => void>();
  private terminalListeners = new Set<() => void>();
  private runner: AgentRunner | null = null;
  private worktree: Worktree | null = null;
  private gitSpawn: SpawnFn | undefined;

  constructor(init: {
    agentId: string;
    parentSessionId: string;
    childSessionId: string;
    task: string;
    ownedFiles: readonly string[];
    model: string;
    worktreePath: string | null;
    startedAt: number;
  }) {
    this.agentId = init.agentId;
    this.parentSessionId = init.parentSessionId;
    this.childSessionId = init.childSessionId;
    this.task = init.task;
    this.ownedFiles = init.ownedFiles;
    this.model = init.model;
    this.worktreePath = init.worktreePath;
    this.startedAt = init.startedAt;
    this.donePromise = new Promise<AgentAwaitResult>((res) => {
      this.resolveDone = res;
    });
  }

  bind(runner: AgentRunner, worktree: Worktree | null, gitSpawn: SpawnFn | undefined): void {
    this.runner = runner;
    this.worktree = worktree;
    this.gitSpawn = gitSpawn;
  }

  onUpdate(fn: (s: AgentStatusSnapshot) => void): () => void {
    this.updateListeners.add(fn);
    return () => this.updateListeners.delete(fn);
  }
  onComplete(fn: (r: AgentAwaitResult) => void): () => void {
    this.completeListeners.add(fn);
    return () => this.completeListeners.delete(fn);
  }
  onTerminal(fn: () => void): () => void {
    this.terminalListeners.add(fn);
    return () => this.terminalListeners.delete(fn);
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  snapshot(): AgentStatusSnapshot {
    const out: AgentStatusSnapshot = { status: this.status };
    if (this.lastMessage !== undefined) out.lastMessage = this.lastMessage;
    if (this.filesChanged !== undefined) out.filesChanged = this.filesChanged;
    if (this.error !== undefined) out.error = this.error;
    return out;
  }

  done(): Promise<AgentAwaitResult> {
    return this.donePromise;
  }

  async cancel(reason?: string): Promise<void> {
    if (this.status !== 'running') return;
    // Mark as cancelled BEFORE awaiting runner.cancel so concurrent
    // status callbacks see the new status.
    this.status = 'cancelled';
    this.error = reason ?? 'cancelled';
    this.fireUpdate();
    const r = this.runner;
    if (r !== null) {
      // Race runner.cancel() against a 2s hard kill window.
      try {
        await Promise.race([
          r.cancel(),
          new Promise<void>((res) => setTimeout(res, 2000)),
        ]);
      } catch {
        // best-effort
      }
    }
    await this.terminate();
  }

  async runStart(): Promise<void> {
    const r = this.runner;
    if (r === null) {
      this.error = 'runner not bound';
      this.status = 'failed';
      this.fireUpdate();
      await this.terminate();
      return;
    }
    try {
      await r.start({
        onMessage: (text) => {
          // Persist most-recent visible text. Keep at most ~500 chars.
          this.lastMessage = text.length > 500 ? text.slice(-500) : text;
          this.fireUpdate();
        },
        onDone: (info) => {
          if (this.status !== 'running') return;
          this.summary = info.summary;
          if (info.filesChanged !== undefined) this.filesChanged = info.filesChanged;
          this.status = 'done';
          this.fireUpdate();
          void this.terminate();
        },
        onError: (err) => {
          if (this.status !== 'running') return;
          this.error = err;
          this.status = 'failed';
          this.fireUpdate();
          void this.terminate();
        },
      });
    } catch (err) {
      if (this.status !== 'running') return;
      this.error = err instanceof Error ? err.message : String(err);
      this.status = 'failed';
      this.fireUpdate();
      await this.terminate();
    }
  }

  // ---------- internals ----------

  private fireUpdate(): void {
    const snap = this.snapshot();
    for (const fn of [...this.updateListeners]) {
      try {
        fn(snap);
      } catch {
        // ignore — listener errors mustn't break worker lifecycle
      }
    }
  }

  private async terminate(): Promise<void> {
    if (this.resolved) return;
    this.resolved = true;
    // Capture diff before cleaning up the worktree.
    let diff = '';
    if (this.worktree !== null) {
      try {
        diff = await diffWorktree(this.worktree.path, this.gitSpawn);
      } catch {
        diff = '';
      }
      try {
        await this.worktree.cleanup();
      } catch {
        // best-effort
      }
    }
    this.diff = diff;
    const result: AgentAwaitResult = {
      status: this.status,
      summary: this.summary,
      diff: this.diff,
      durationMs: Date.now() - this.startedAt,
      ...(this.lastMessage !== undefined ? { lastMessage: this.lastMessage } : {}),
      ...(this.filesChanged !== undefined ? { filesChanged: this.filesChanged } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
    };
    for (const fn of [...this.completeListeners]) {
      try {
        fn(result);
      } catch {
        // ignore
      }
    }
    for (const fn of [...this.terminalListeners]) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    this.resolveDone(result);
  }
}
