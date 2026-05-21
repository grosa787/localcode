/**
 * Multi-agent shared types.
 *
 * These describe the lifecycle and wire shapes used by:
 *   - `AgentOrchestrator` (lifecycle + bookkeeping)
 *   - `TeamBus`            (inter-agent pub-sub)
 *   - `agent-*` tools      (lead/worker call surface)
 *   - WS protocol          (parent session emits agent_* frames)
 */

/** Terminal-or-running status of a sub-agent. */
export type AgentStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** Agent role within a team. */
export type AgentRole = 'lead' | 'worker';

/** Reserved id used by lead callers when posting to the bus. */
export const LEAD_AGENT_ID = 'lead' as const;

/**
 * Spawn-time payload — both the user-facing tool args (`spawn_agent`) and
 * the orchestrator's internal builder accept this shape.
 */
export interface SpawnAgentRequest {
  task: string;
  files: readonly string[];
  /** Optional model override; defaults to config.agents.workerModel. */
  model?: string;
  /** Optional skill-id allow-list to inject into the worker's system prompt. */
  skills?: readonly string[];
  /** Default 'worktree'. Falls back to 'shared' if git unavailable. */
  isolation?: 'worktree' | 'shared';
  /** Default config.agents.defaultTimeoutSec. */
  timeout?: number;
  /**
   * Optional template id used as the {@link WorkerPool} bucket key
   * when warm-worker reuse is enabled. Falls through to `'default'` so
   * template-less spawns still share a single bucket. Set
   * automatically by `spawnFromTemplate`.
   */
  templateId?: string;
}

/** Snapshot returned by `agent_status`. */
export interface AgentStatusSnapshot {
  status: AgentStatus;
  lastMessage?: string;
  filesChanged?: readonly string[];
  error?: string;
}

/** Result from `await_agent` (terminal) — superset of status snapshot. */
export interface AgentAwaitResult extends AgentStatusSnapshot {
  /** Final assistant summary text (after the worker's <DONE> sentinel). */
  summary: string;
  /** Unified diff of worker's changes vs the worktree base, "" when shared. */
  diff: string;
  /** Wall-clock duration in ms from spawn to terminal. */
  durationMs: number;
}

/** Single broadcast / unicast envelope on the team-bus. */
export interface TeamBusMessage {
  /** Agent id of the sender. `'lead'` for the parent. */
  from: string;
  /** `'all'` for broadcast; otherwise a recipient agent id (or `'lead'`). */
  to: string;
  /** Plain-text message body. */
  message: string;
  /** Date.now() at send time. */
  at: number;
}

/**
 * Public handle exposed by the orchestrator. Each spawn produces one of
 * these and stores it under the parent's `AgentTeamState`.
 *
 * The lifecycle promise is intentionally exposed so `await_agent` can
 * race it against a timeout without polling.
 */
export interface AgentHandle {
  readonly agentId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly task: string;
  readonly ownedFiles: readonly string[];
  readonly model: string;
  readonly worktreePath: string | null;
  readonly startedAt: number;

  /** Latest snapshot — kept up to date by the orchestrator. */
  snapshot(): AgentStatusSnapshot;
  /** Current status without computing a fresh snapshot. */
  getStatus(): AgentStatus;
  /** Final await result. Resolves once the worker terminates. */
  done(): Promise<AgentAwaitResult>;
  /** Best-effort cancel. Idempotent. */
  cancel(reason?: string): Promise<void>;
}

/** Per-parent team bookkeeping. The orchestrator owns one entry per parent. */
export interface AgentTeamState {
  agents: Map<string, AgentHandle>;
}

/** Config block — mirrored in `src/config/types.ts` for Zod parsing. */
export interface AgentsConfig {
  /** Optional explicit lead model id; otherwise reuse the active model. */
  leadModel?: string;
  /** Default model for spawn_agent when caller doesn't specify. */
  workerModel: string;
  /** Hard cap on simultaneously-live workers per parent. */
  maxConcurrent: number;
  /** Default isolation strategy. */
  isolation: 'worktree' | 'shared';
  /** 'auto' bypasses approval for sub-agent tool calls. */
  approval: 'auto' | 'per-action';
  /** Default `timeout` (seconds) when spawn_agent omits the field. */
  defaultTimeoutSec: number;
}
