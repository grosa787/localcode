/**
 * agent_* tool handlers — bridge between the model's tool calls and the
 * `AgentOrchestrator` (lifecycle + team-bus).
 *
 * Five tools:
 *   - spawn_agent
 *   - agent_status
 *   - await_agent
 *   - team_send
 *   - team_read
 *
 * The `ToolContext` carries the standard `projectRoot` /
 * `dangerouslyAllowAll` fields. To reach the orchestrator we extend
 * the context shape with two extras (`agents` + `callerAgentId`) — set
 * by the runtime when it builds the per-session executor. Tools sniff
 * the runtime context defensively so an unconfigured executor surfaces
 * a friendly "agents not enabled" error rather than a crash.
 */

import { z } from 'zod';

import type { ToolContext, ToolResult } from './types';
import type { AgentOrchestrator } from '@/agents/orchestrator';
import type {
  AgentHandle,
  SpawnAgentRequest,
} from '@/agents/types';
import { LEAD_AGENT_ID } from '@/agents/types';
import { findAgentTemplate } from '@/agents/catalog';
import type { AgentsConfig, AgentsWorkerSlotConfig } from '@/types/global';

/** Augmented context required by agent-* tools. */
export interface AgentToolContext extends ToolContext {
  /** Set by the runtime when agent tooling is enabled. */
  agents?: AgentOrchestrator;
  /** The parent session id (lead) running the tool. */
  parentSessionId?: string;
  /**
   * The id of the agent CALLING the tool. `'lead'` when the parent is
   * calling, or `<agentId>` for sub-agents. Used by team_send/team_read
   * to scope sender / recipient.
   */
  callerAgentId?: string;
  /**
   * Snapshot of `cfg.agents` at the moment the tool ctx was assembled.
   * Used by `spawn_agent` to enforce the worker-slot allow-list (the
   * lead may only spawn workers whose model matches a configured slot).
   * Optional for backwards compatibility with tests / older harnesses
   * that pre-date the slot allow-list — when undefined, spawn falls
   * back to the legacy behaviour (any model accepted, default is
   * `cfg.agents.workerModel`).
   */
  agentsConfig?: AgentsConfig;
}

// ---------- spawn_agent ----------

export const SpawnAgentArgsSchema = z.object({
  task: z.string().min(1, 'task must be a non-empty string'),
  files: z.array(z.string()).readonly(),
  model: z.string().optional(),
  /**
   * Optional 0-indexed worker-slot pointer. When supplied, wins over
   * `model`. Convenient for the lead to address slots positionally
   * without having to re-spell the exact model id.
   */
  slot: z.number().int().nonnegative().optional(),
  skills: z.array(z.string()).optional(),
  isolation: z.enum(['worktree', 'shared']).optional(),
  timeout: z.number().int().positive().optional(),
  /**
   * Optional curated catalog template id. When supplied, the template's
   * system prompt is prepended to the worker's `task` body so the
   * worker boots up as a specialist (architect/debugger/reviewer/etc.)
   * without the lead having to re-spell the role definition.
   */
  template: z.string().min(1).optional(),
});

export type SpawnAgentArgs = z.infer<typeof SpawnAgentArgsSchema>;

/**
 * Resolve `{model, skills}` for a spawn request given the caller's
 * `model` / `slot` args and the active agents config. Encapsulates the
 * strict allow-list enforcement: when `cfg.workerSlots` is non-empty,
 * the lead may ONLY pick a model that matches one of the configured
 * slots; an unknown model id is rejected with a message naming the
 * configured slots.
 *
 * When `cfg.workerSlots` is absent or empty, falls back to the legacy
 * `cfg.workerModel` single-element allow-list — preserves backward
 * compatibility for harnesses that haven't migrated to slot-based
 * configuration yet.
 *
 * Throws `Error` on rejection so the caller can surface the message
 * back to the model verbatim (the lead reads tool errors as text).
 */
export function resolveSpawnTarget(args: {
  model?: string;
  slot?: number;
  skills?: readonly string[];
}, cfg: AgentsConfig): { model: string; skills?: readonly string[] } {
  const slots: readonly AgentsWorkerSlotConfig[] =
    cfg.workerSlots !== undefined && cfg.workerSlots.length > 0
      ? cfg.workerSlots
      : [];

  // Slot-based addressing wins over model when both supplied — keeps
  // positional and explicit forms unambiguous.
  if (args.slot !== undefined) {
    if (slots.length === 0) {
      throw new Error(
        `spawn_agent: 'slot' cannot be used because no worker slots are configured. ` +
          `Configure slots via UserCog -> Worker slots in the web UI, or omit 'slot'.`,
      );
    }
    if (args.slot < 0 || args.slot >= slots.length) {
      throw new Error(
        `spawn_agent: slot ${args.slot} is out of range. ` +
          `Configured slots: 0..${slots.length - 1}.`,
      );
    }
    const picked = slots[args.slot];
    if (picked === undefined) {
      // Unreachable given the bounds check above; satisfies
      // noUncheckedIndexedAccess.
      throw new Error(`spawn_agent: slot ${args.slot} resolved to undefined`);
    }
    const out: { model: string; skills?: readonly string[] } = {
      model: picked.model,
    };
    // Caller-supplied skills win; otherwise inherit slot defaults.
    if (args.skills !== undefined) out.skills = args.skills;
    else if (picked.skills !== undefined) out.skills = picked.skills;
    return out;
  }

  // No slot — derive the available model set from configured slots
  // when present, otherwise fall back to the legacy single-model
  // workerModel field.
  const available: readonly string[] =
    slots.length > 0 ? slots.map((s) => s.model) : [cfg.workerModel];

  if (args.model === undefined) {
    // Unspecified -> first slot's model (or workerModel fallback).
    const firstSlot = slots[0];
    const inheritedSkills =
      firstSlot !== undefined && firstSlot.skills !== undefined
        ? firstSlot.skills
        : undefined;
    const fallback = available[0];
    if (fallback === undefined) {
      // Should not be reachable: workerModel is `string` (default),
      // which means `available` is always at least 1-long.
      throw new Error(
        'spawn_agent: no worker model configured. Set agents.workerModel or agents.workerSlots.',
      );
    }
    const out: { model: string; skills?: readonly string[] } = {
      model: fallback,
    };
    if (args.skills !== undefined) out.skills = args.skills;
    else if (inheritedSkills !== undefined) out.skills = inheritedSkills;
    return out;
  }

  // Explicit model — must match the allow-list.
  if (!available.includes(args.model)) {
    const list = available.map((m) => `"${m}"`).join(', ');
    throw new Error(
      `Model '${args.model}' is not configured as a worker slot. ` +
        `Configured: [${list}]. Update via UserCog -> Worker slots in the web UI.`,
    );
  }
  // Find matching slot (if any) so we can inherit its skills when the
  // caller didn't supply explicit ones.
  const matchedSlot = slots.find((s) => s.model === args.model);
  const out: { model: string; skills?: readonly string[] } = {
    model: args.model,
  };
  if (args.skills !== undefined) out.skills = args.skills;
  else if (matchedSlot !== undefined && matchedSlot.skills !== undefined) {
    out.skills = matchedSlot.skills;
  }
  return out;
}

export async function spawnAgent(
  args: SpawnAgentArgs,
  ctx: AgentToolContext,
): Promise<ToolResult> {
  const parsed = SpawnAgentArgsSchema.safeParse(args);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const orch = requireOrchestrator(ctx);
  if (orch === null) return notEnabled();
  const parentSessionId = ctx.parentSessionId;
  if (parentSessionId === undefined) {
    return {
      success: false,
      output: '',
      error: 'spawn_agent: parent session id missing from tool context',
    };
  }

  // Only the lead may spawn — keeps the topology a forest of depth-1.
  if (ctx.callerAgentId !== undefined && ctx.callerAgentId !== LEAD_AGENT_ID) {
    return {
      success: false,
      output: '',
      error: `spawn_agent is restricted to the lead. Caller=${ctx.callerAgentId}.`,
    };
  }

  // Strict slot/model enforcement — only resolved when the runtime
  // wired an `agentsConfig`. Without one (older harnesses / tests) we
  // fall through to the orchestrator's legacy default.
  let resolvedModel: string | undefined;
  let resolvedSkills: readonly string[] | undefined;
  if (ctx.agentsConfig !== undefined) {
    try {
      const target = resolveSpawnTarget(
        {
          ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
          ...(parsed.data.slot !== undefined ? { slot: parsed.data.slot } : {}),
          ...(parsed.data.skills !== undefined ? { skills: parsed.data.skills } : {}),
        },
        ctx.agentsConfig,
      );
      resolvedModel = target.model;
      if (target.skills !== undefined) resolvedSkills = target.skills;
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    if (parsed.data.model !== undefined) resolvedModel = parsed.data.model;
    if (parsed.data.skills !== undefined) resolvedSkills = parsed.data.skills;
  }

  // When the lead supplies a catalog template id, prepend the template's
  // system prompt to the worker's task body. Unknown ids return a
  // friendly error instead of being silently ignored.
  let effectiveTask = parsed.data.task;
  if (parsed.data.template !== undefined) {
    const template = findAgentTemplate(parsed.data.template);
    if (template === undefined) {
      return {
        success: false,
        output: '',
        error: `spawn_agent: unknown template "${parsed.data.template}". See \`/spawn\` for the available templates.`,
      };
    }
    effectiveTask = [
      `[role: ${template.name}]`,
      template.systemPrompt,
      '',
      `[task]`,
      parsed.data.task,
      '',
      `[tools allow-list]`,
      template.tools.length === 0
        ? '(no restriction)'
        : template.tools.join(', '),
    ].join('\n');
  }

  const req: SpawnAgentRequest = {
    task: effectiveTask,
    files: [...parsed.data.files],
    ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
    ...(resolvedSkills !== undefined ? { skills: [...resolvedSkills] } : {}),
    ...(parsed.data.isolation !== undefined ? { isolation: parsed.data.isolation } : {}),
    ...(parsed.data.timeout !== undefined ? { timeout: parsed.data.timeout } : {}),
  };

  try {
    const handle = await orch.spawn(parentSessionId, req);
    const payload: { agentId: string; worktreePath?: string } = {
      agentId: handle.agentId,
    };
    if (handle.worktreePath !== null) payload.worktreePath = handle.worktreePath;
    return { success: true, output: JSON.stringify(payload) };
  } catch (err) {
    return {
      success: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------- agent_status ----------

export const AgentStatusArgsSchema = z.object({
  agentId: z.string().min(1),
});
export type AgentStatusArgs = z.infer<typeof AgentStatusArgsSchema>;

export async function agentStatus(
  args: AgentStatusArgs,
  ctx: AgentToolContext,
): Promise<ToolResult> {
  const parsed = AgentStatusArgsSchema.safeParse(args);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const orch = requireOrchestrator(ctx);
  if (orch === null) return notEnabled();
  const parentSessionId = ctx.parentSessionId;
  if (parentSessionId === undefined) {
    return {
      success: false,
      output: '',
      error: 'agent_status: parent session id missing from tool context',
    };
  }
  const handle: AgentHandle | undefined = orch.get(parentSessionId, parsed.data.agentId);
  if (handle === undefined) {
    return {
      success: false,
      output: '',
      error: `agent_status: unknown agentId ${parsed.data.agentId}`,
    };
  }
  return { success: true, output: JSON.stringify(handle.snapshot()) };
}

// ---------- await_agent ----------

export const AwaitAgentArgsSchema = z.object({
  agentId: z.string().min(1),
  timeoutSec: z.number().int().positive().optional(),
});
export type AwaitAgentArgs = z.infer<typeof AwaitAgentArgsSchema>;

const DEFAULT_AWAIT_TIMEOUT_SEC = 600;

export async function awaitAgent(
  args: AwaitAgentArgs,
  ctx: AgentToolContext,
): Promise<ToolResult> {
  const parsed = AwaitAgentArgsSchema.safeParse(args);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const orch = requireOrchestrator(ctx);
  if (orch === null) return notEnabled();
  const parentSessionId = ctx.parentSessionId;
  if (parentSessionId === undefined) {
    return {
      success: false,
      output: '',
      error: 'await_agent: parent session id missing from tool context',
    };
  }
  const handle = orch.get(parentSessionId, parsed.data.agentId);
  if (handle === undefined) {
    return {
      success: false,
      output: '',
      error: `await_agent: unknown agentId ${parsed.data.agentId}`,
    };
  }
  const timeoutMs = (parsed.data.timeoutSec ?? DEFAULT_AWAIT_TIMEOUT_SEC) * 1000;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const winner = await Promise.race([handle.done(), timeoutPromise]);
  if (timeout !== null) clearTimeout(timeout);
  if (winner === 'timeout') {
    // Don't cancel — caller may want to keep polling; surface a 408-ish error.
    return {
      success: false,
      output: JSON.stringify(handle.snapshot()),
      error: `await_agent: timed out after ${parsed.data.timeoutSec ?? DEFAULT_AWAIT_TIMEOUT_SEC}s`,
    };
  }
  return { success: true, output: JSON.stringify(winner) };
}

// ---------- team_send ----------

export const TeamSendArgsSchema = z.object({
  to: z.string().min(1),
  message: z.string().min(1),
});
export type TeamSendArgs = z.infer<typeof TeamSendArgsSchema>;

export async function teamSend(
  args: TeamSendArgs,
  ctx: AgentToolContext,
): Promise<ToolResult> {
  const parsed = TeamSendArgsSchema.safeParse(args);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const orch = requireOrchestrator(ctx);
  if (orch === null) return notEnabled();
  const parentSessionId = ctx.parentSessionId;
  if (parentSessionId === undefined) {
    return {
      success: false,
      output: '',
      error: 'team_send: parent session id missing from tool context',
    };
  }
  const from = ctx.callerAgentId ?? LEAD_AGENT_ID;
  const env = orch.postTeamMessage(parentSessionId, from, parsed.data.to, parsed.data.message);
  return {
    success: true,
    output: JSON.stringify({ at: env.at, from: env.from, to: env.to }),
  };
}

// ---------- team_read ----------

export const TeamReadArgsSchema = z.object({
  sinceSec: z.number().int().nonnegative().optional(),
  fromAgentId: z.string().optional(),
});
export type TeamReadArgs = z.infer<typeof TeamReadArgsSchema>;

export async function teamRead(
  args: TeamReadArgs,
  ctx: AgentToolContext,
): Promise<ToolResult> {
  const parsed = TeamReadArgsSchema.safeParse(args);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const orch = requireOrchestrator(ctx);
  if (orch === null) return notEnabled();
  const parentSessionId = ctx.parentSessionId;
  if (parentSessionId === undefined) {
    return {
      success: false,
      output: '',
      error: 'team_read: parent session id missing from tool context',
    };
  }
  const forId = ctx.callerAgentId ?? LEAD_AGENT_ID;
  const sinceSec = parsed.data.sinceSec ?? 0;
  const sinceMs = sinceSec === 0 ? 0 : Date.now() - sinceSec * 1000;
  let messages = orch.readTeamMessages(parentSessionId, forId, sinceMs);
  if (parsed.data.fromAgentId !== undefined) {
    const fromFilter = parsed.data.fromAgentId;
    messages = messages.filter((m) => m.from === fromFilter);
  }
  return { success: true, output: JSON.stringify({ messages }) };
}

// ---------- helpers ----------

function invalid(detail: string): ToolResult {
  return { success: false, output: '', error: `Invalid args: ${detail}` };
}

function notEnabled(): ToolResult {
  return {
    success: false,
    output: '',
    error: 'agent tools are not enabled in this session',
  };
}

function requireOrchestrator(
  ctx: AgentToolContext,
): AgentOrchestrator | null {
  return ctx.agents ?? null;
}
