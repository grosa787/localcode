/**
 * Concrete `AgentRunnerFactory` implementation.
 *
 * Bridges the orchestrator's runner abstraction to the production stack:
 *   - per-worker adapter (built via `createAdapterForModel`),
 *   - per-worker `ChatRuntime` allocated through the shared `RuntimePool`
 *     under a synthetic child sessionId (`<parent>.agent.<agentId>`),
 *   - worker-side `ToolExecutor` whose `ToolContext` carries
 *     `{ agents, parentSessionId, callerAgentId }` so spawn_agent etc.
 *     route correctly,
 *   - LLM stream callbacks fanned into the orchestrator's runner
 *     `onMessage` / `onDone` / `onError` hooks.
 *
 * This module is the only place that knows BOTH the orchestrator surface
 * and the runtime composition. Keeping it isolated lets `web/index.ts`
 * remain a thin wiring layer and `orchestrator.ts` stay free of runtime
 * dependencies.
 */

import type {
  AgentOrchestrator,
  AgentRunner,
  AgentRunnerCallbacks,
  AgentRunnerFactory,
  AgentRunnerSpec,
} from './orchestrator';
import type { ConfigManager } from '@/config/config-manager';
import type { SessionManager } from '@/sessions/session-manager';
import type { LLMAdapter } from '@/llm/adapter';
import { ContextManager } from '@/llm/context-manager';
import { ToolExecutor } from '@/llm/tool-executor';
import { TOOLS_SCHEMA } from '@/llm/tools-schema';
import { createToolHandlerMap, type ToolHandlerMap } from '@/tools';
import type { AgentToolContext } from '@/tools/agent';
import type {
  ToolHandler as FlatToolHandler,
  ToolHandlerMap as FlatToolHandlerMap,
} from '@/types/message';
import type { Message, ToolCall } from '@/types/global';
import {
  buildWorkerAgentPrompt,
  extractWorkerSummary,
  WORKER_DONE_SENTINEL,
} from '@/llm/agent-prompts';
import type { Backend } from '@/types/global';

/**
 * H5 — Tools a worker is allowed to run without per-call approval when
 * the team's policy is `agents.approval === 'auto'`. `run_command` is
 * DELIBERATELY EXCLUDED: a sub-agent must never auto-shell. If the model
 * emits a `run_command` call and no approval callback is wired, the
 * tool-executor returns a structured error and the worker continues
 * (it sees the rejection and either retries differently or surrenders).
 *
 * Mutating file writes (`write_file`, `edit_file`) ARE auto-approved
 * here because the worker is expected to make code edits within its
 * owned files — that's the point of the multi-agent flow. The risky
 * boundary is the shell, not the editor.
 */
const SUB_AGENT_AUTO_APPROVE_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob_search',
  'lint_file',
  'find_symbol',
  'fetch_image',
  // Multi-agent self-coordination — message + status checks are safe.
  'agent_status',
  'await_agent',
  'team_send',
  'team_read',
];

/**
 * Minimal adapter shape consumed by the worker. Matches the fragment of
 * `LLMAdapter` the streaming loop actually exercises so tests can supply
 * a fake without dragging the full constructor.
 */
export interface WorkerAdapter {
  streamChat: LLMAdapter['streamChat'];
}

export interface BuildAgentRunnerDeps {
  /**
   * The orchestrator instance — passed back into the worker's tool
   * context so nested team_send / team_read calls reach the same bus.
   */
  orchestrator: () => AgentOrchestrator;
  sessionManager: SessionManager;
  configManager: ConfigManager;
  /** Build a fresh adapter for the worker's chosen model. */
  createAdapterForModel: (model: string) => WorkerAdapter;
  /**
   * Read the project root associated with the parent session id, used as
   * a fallback when isolation='shared'. Returns null when unknown — the
   * factory falls back to spec.cwd.
   */
  resolveProjectRoot: (parentSessionId: string) => string | null;
  /** Optional probe of the active backend type — drives the LM-Studio note. */
  resolveBackend?: () => Backend | undefined;
}

/**
 * Build a concrete `AgentRunnerFactory`. The orchestrator calls
 * `factory(spec)` once per spawn; the returned runner owns the worker's
 * lifecycle.
 */
export function buildAgentRunnerFactory(
  deps: BuildAgentRunnerDeps,
): AgentRunnerFactory {
  return (spec: AgentRunnerSpec): AgentRunner => new ChatRuntimeAgentRunner(spec, deps);
}

/**
 * Concrete runner. One instance per `spawn`. Manages a single streaming
 * loop and a synthetic child session for diagnostics + persistence.
 */
class ChatRuntimeAgentRunner implements AgentRunner {
  private readonly spec: AgentRunnerSpec;
  private readonly deps: BuildAgentRunnerDeps;
  private readonly abort: AbortController = new AbortController();
  private callbacks: AgentRunnerCallbacks | null = null;
  private cancelled = false;
  /** Accumulated assistant text across the entire worker turn-loop. */
  private assistantText = '';
  /** True once we observed the `<DONE>` sentinel — stop further turns. */
  private sawDoneSentinel = false;
  // AGENT-INBOUND-MSG-SECTION
  /**
   * Inbound user messages delivered via TeamBus (`lead → this.agentId`)
   * while the worker is mid-turn. We can't safely inject mid-stream
   * (the wire conversation must stay consistent for the in-flight
   * assistant turn), so we buffer them here and flush as one combined
   * user message at the top of the next turn.
   */
  private inboundUserMessages: string[] = [];
  /** Unsubscribe handle for the TeamBus listener — released on cancel/end. */
  private busUnsubscribe: (() => void) | null = null;
  // AGENT-INBOUND-MSG-SECTION-END

  constructor(spec: AgentRunnerSpec, deps: BuildAgentRunnerDeps) {
    this.spec = spec;
    this.deps = deps;
  }

  async start(callbacks: AgentRunnerCallbacks): Promise<void> {
    this.callbacks = callbacks;
    // AGENT-INBOUND-MSG-SECTION
    // Subscribe to the team's bus so the user (via UI agent-reply mode)
    // can send mid-run clarifications addressed to THIS agent. The
    // orchestrator routes any `to === this.agentId` envelope from
    // `from === 'lead'` (or `'all'`, broadcast); we buffer the text and
    // flush at the next turn boundary (see `runLoop`). The TeamBus is
    // shared across the team — peer agent_team_message envelopes go
    // through their own `team_read` polling path inside the worker
    // system prompt, so we only inject lead/all → this.agentId here.
    try {
      const orch = this.deps.orchestrator();
      const bus = orch.getBus(this.spec.parentSessionId);
      this.busUnsubscribe = bus.subscribe((m) => {
        // Filter: must be addressed to us (unicast) or all (broadcast)
        // AND must originate from the lead user (not from a peer
        // worker — peer messages are intentionally surfaced only via
        // the `team_read` tool so the agent stays in control of what
        // it pulls).
        if (m.from !== 'lead') return;
        if (m.to !== this.spec.agentId) return;
        const text = m.message.trim();
        if (text.length === 0) return;
        this.inboundUserMessages.push(text);
      });
    } catch {
      // Best-effort — bus may not exist yet for synthetic runners
      // (tests without an orchestrator). The runner still works.
    }
    // AGENT-INBOUND-MSG-SECTION-END
    // Materialise a child session row so the persisted history is
    // queryable post-mortem. Failure is non-fatal — we run in-memory.
    try {
      const projectRoot =
        this.deps.resolveProjectRoot(this.spec.parentSessionId) ?? this.spec.cwd;
      // Persist the row under the synthetic `<parent>.agent.<agentId>`
      // id chosen by the orchestrator. The id namespace doubles as
      // the filter key for `listSessions` (see `isSubAgentSessionId`)
      // so these rows never leak into the user-facing sidebar — they
      // are surfaced via agent_* WS frames in AgentTeamPanel and remain
      // directly queryable via `getSession(id)` for post-mortem.
      this.deps.sessionManager.createSession(
        projectRoot,
        this.spec.model,
        'agent',
        { id: this.spec.childSessionId },
      );
    } catch {
      // Best-effort — sessions table is just for inspection here.
    }

    // Fire off the worker streaming loop; it owns its own retry-after-
    // tool-call recursion. Errors land in the `onError` callback rather
    // than throwing, so we don't need a try/catch around the whole loop —
    // but we DO want to catch any synchronous setup error.
    try {
      await this.runLoop();
    } catch (err) {
      this.callbacks?.onError(err instanceof Error ? err.message : String(err));
    } finally {
      // AGENT-INBOUND-MSG-SECTION — release the TeamBus listener once
      // the worker is terminal; cancel() also drops it, so this is
      // idempotent for the cancellation path.
      this.releaseBusSubscription();
      // AGENT-INBOUND-MSG-SECTION-END
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    try {
      this.abort.abort();
    } catch {
      // ignore
    }
    // AGENT-INBOUND-MSG-SECTION
    this.releaseBusSubscription();
    // AGENT-INBOUND-MSG-SECTION-END
  }

  // AGENT-INBOUND-MSG-SECTION
  private releaseBusSubscription(): void {
    if (this.busUnsubscribe === null) return;
    try {
      this.busUnsubscribe();
    } catch {
      // ignore — best-effort
    }
    this.busUnsubscribe = null;
  }
  // AGENT-INBOUND-MSG-SECTION-END

  // ---------- internals ----------

  /**
   * Build the worker's tool executor. Carries the augmented
   * `AgentToolContext` so the agent_* tools see the orchestrator + the
   * caller's id. Workers cannot spawn sub-sub-agents — that's enforced
   * inside `spawnAgent` via the `callerAgentId !== 'lead'` guard.
   */
  private buildExecutor(): { executor: ToolExecutor; ctx: AgentToolContext } {
    const projectRoot = this.spec.cwd;
    const orch = this.deps.orchestrator();
    // H5 — Sub-agents never get a global `dangerouslyAllowAll` even
    // when the team's approval policy is 'auto'. Instead we expose a
    // tight per-tool allow-list that excludes `run_command`. The
    // worker's `ToolContext.dangerouslyAllowAll` is set to `false` so
    // any tool handler that consults it (e.g. a future shell tool) is
    // forced down the supervised path. `run_command` is in
    // `APPROVAL_REQUIRED_TOOLS`; without an approval callback the
    // executor returns a structured error and the worker turn-loop
    // surfaces that error to the model — it cannot unsupervised-shell.
    const ctx: AgentToolContext = {
      projectRoot,
      dangerouslyAllowAll: false,
      agents: orch,
      parentSessionId: this.spec.parentSessionId,
      callerAgentId: this.spec.agentId,
    };
    const handlerMap: ToolHandlerMap = createToolHandlerMap(ctx);
    const flatHandlers: FlatToolHandlerMap = {};
    for (const [name, handler] of Object.entries(handlerMap)) {
      const flat: FlatToolHandler = async (args) => {
        const preview = await handler.preview(args, ctx);
        if (handler.commit === undefined) return preview;
        if (!preview.success) return preview;
        const committed = await handler.commit(args, ctx);
        if (committed.success && committed.output.length === 0) {
          return { ...committed, output: preview.output };
        }
        return committed;
      };
      flatHandlers[name] = flat;
    }
    const executor = new ToolExecutor({
      handlers: flatHandlers,
      dangerouslyAllowAll: false,
      // Auto-approve only the curated safe set when the team policy is
      // 'auto'. Empty list when 'manual' — every mutating call needs an
      // approval callback, which the worker doesn't have, so writes
      // also fail safely under manual policy (the user's intent).
      autoApproveTools: this.spec.autoApprove
        ? [...SUB_AGENT_AUTO_APPROVE_TOOLS]
        : [],
      autoLintAfterWrite: true,
    });
    return { executor, ctx };
  }

  /**
   * Build the worker system prompt. Uses `buildWorkerAgentPrompt` with
   * an LM-Studio hint when the active backend is lmstudio.
   *
   * `spec.skills` is forwarded so the worker prompt surfaces any
   * lead-supplied or slot-default skills (driven by the strict
   * model-allow-list in `spawn_agent`).
   */
  private buildSystemPrompt(): Message {
    const backend = this.deps.resolveBackend?.();
    const content = buildWorkerAgentPrompt({
      agentId: this.spec.agentId,
      task: this.spec.task,
      ownedFiles: this.spec.ownedFiles,
      otherAgents: this.spec.otherAgents,
      ...(this.spec.skills.length > 0 ? { skills: this.spec.skills } : {}),
      ...(backend !== undefined ? { runtimeBackend: backend } : {}),
    });
    return {
      id: `sys-${this.spec.childSessionId}-${Date.now()}`,
      role: 'system',
      content,
      createdAt: Date.now(),
    };
  }

  /**
   * Worker turn-loop. Mirrors ChatRuntime.runStreamLoop in spirit but
   * without WS event emission — orchestrator events are emitted by the
   * orchestrator itself in response to the runner callbacks we drive.
   */
  private async runLoop(): Promise<void> {
    const { executor } = this.buildExecutor();
    const adapter = this.deps.createAdapterForModel(this.spec.model);
    const ctx = new ContextManager();
    // Seed the conversation: system + the lead's task as user msg.
    const systemMsg = this.buildSystemPrompt();
    const userMsg: Message = {
      id: `usr-${this.spec.childSessionId}`,
      role: 'user',
      content: this.spec.task,
      createdAt: Date.now(),
    };
    ctx.add(userMsg);

    // AGENT-RELIABILITY-FIX-2-SECTION
    // Bounded turn count. Bumped from 20→40 because tool-heavy refactors
    // (read N files → edit N files → lint) routinely hit the old cap mid-
    // task. The previous code silently surfaced cap-hit as success; the
    // surfacing path below now reports it as `onError` so the caller can
    // distinguish "agent completed" from "agent ran out of turns."
    const MAX_TURNS = 40;
    // AGENT-RELIABILITY-FIX-2-SECTION-END
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      // AGENT-INBOUND-MSG-SECTION
      // Drain any TeamBus messages addressed to us between turns. We
      // splice them into the conversation as plain user messages so
      // the next streamChat call sees the additional context inline.
      // Drained as one combined message (rather than N user-messages)
      // because some providers reject consecutive same-role messages.
      if (this.inboundUserMessages.length > 0) {
        const pending = this.inboundUserMessages.splice(0);
        const inboundContent =
          pending.length === 1
            ? `[user follow-up]\n${pending[0]}`
            : pending
                .map((m, i) => `[user follow-up #${i + 1}]\n${m}`)
                .join('\n\n');
        const inboundMsg: Message = {
          id: `usr-${this.spec.childSessionId}-inbound-${turn}`,
          role: 'user',
          content: inboundContent,
          createdAt: Date.now(),
        };
        ctx.add(inboundMsg);
        try {
          this.deps.sessionManager.addMessage(
            this.spec.childSessionId,
            inboundMsg,
          );
        } catch {
          // best-effort
        }
      }
      // AGENT-INBOUND-MSG-SECTION-END
      if (this.cancelled) {
        // AGENT-RELIABILITY-FIX-4-SECTION
        // eslint-disable-next-line no-console
        console.warn(
          `[agents] runner ${this.spec.agentId} cancelled at turn ${turn}`,
        );
        // AGENT-RELIABILITY-FIX-4-SECTION-END
        return;
      }
      const wireMessages: Message[] = [systemMsg, ...ctx.getMessages()];
      let turnText = '';
      let pendingToolCalls: ToolCall[] = [];
      let streamError: string | null = null;
      // COST-PERSIST-SECTION — capture usage telemetry from onDone so
      // sub-agent rows persist tokens + cost like the lead. The model
      // is fixed by `spec.model` (workers don't switch); backend comes
      // from `resolveBackend` (falls back to undefined → addMessage
      // path will subquery the session row).
      let turnPromptTokens: number | undefined;
      let turnCompletionTokens: number | undefined;
      let turnCachedTokens: number | undefined;
      let turnCacheCreationTokens: number | undefined;
      let turnDurationMs: number | undefined;
      // COST-PERSIST-SECTION-END
      try {
        await adapter.streamChat({
          messages: wireMessages,
          tools: TOOLS_SCHEMA,
          signal: this.abort.signal,
          onChunk: (text) => {
            turnText += text;
            this.assistantText += text;
            // AGENT-RELIABILITY-FIX-3-SECTION
            // Push the running assistant text as the snapshot
            // lastMessage. Wrap in try/catch so a throwing listener
            // (orchestrator forwarding, WS emit, etc.) cannot tear
            // down the streaming callback chain mid-turn.
            try {
              this.callbacks?.onMessage(this.assistantText);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(
                `[agents] onMessage listener threw for ${this.spec.agentId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
            // AGENT-RELIABILITY-FIX-3-SECTION-END
          },
          onToolCalls: (calls) => {
            pendingToolCalls = [...calls];
          },
          onDone: (result) => {
            if (result.error !== undefined && result.error !== '') {
              streamError = result.error;
            }
            // COST-PERSIST-SECTION — pull usage off the final result so
            // SessionManager.addMessage can compute cost_usd.
            if (result.usage !== undefined) {
              turnPromptTokens = result.usage.promptTokens;
              turnCompletionTokens = result.usage.completionTokens;
              turnCachedTokens = result.usage.cachedInputTokens;
              turnCacheCreationTokens = result.usage.cacheCreationTokens;
            }
            if (result.durationMs !== undefined) {
              turnDurationMs = result.durationMs;
            }
            // COST-PERSIST-SECTION-END
          },
        });
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err);
      }

      if (this.cancelled) {
        // AGENT-RELIABILITY-FIX-4-SECTION
        // eslint-disable-next-line no-console
        console.warn(
          `[agents] runner ${this.spec.agentId} cancelled after streamChat at turn ${turn}`,
        );
        // AGENT-RELIABILITY-FIX-4-SECTION-END
        return;
      }
      if (streamError !== null) {
        // AGENT-RELIABILITY-FIX-4-SECTION
        // eslint-disable-next-line no-console
        console.warn(
          `[agents] runner ${this.spec.agentId} stream error at turn ${turn}: ${streamError}`,
        );
        // AGENT-RELIABILITY-FIX-4-SECTION-END
        this.callbacks?.onError(streamError);
        return;
      }

      // Persist the assistant message into the in-memory context for
      // any subsequent turn.
      const hasToolCalls = pendingToolCalls.length > 0;
      const assistantMsg: Message = {
        id: `asst-${this.spec.childSessionId}-${turn}`,
        role: 'assistant',
        content: turnText,
        ...(hasToolCalls ? { toolCalls: pendingToolCalls } : {}),
        createdAt: Date.now(),
        // COST-PERSIST-SECTION — sub-agent rows must carry the same
        // telemetry envelope as the lead so dashboard aggregates total
        // correctly across the team.
        ...(turnPromptTokens !== undefined ? { tokensInput: turnPromptTokens } : {}),
        ...(turnCompletionTokens !== undefined
          ? { tokensOutput: turnCompletionTokens }
          : {}),
        ...(turnDurationMs !== undefined ? { durationMs: turnDurationMs } : {}),
        model: this.spec.model,
        ...(turnCachedTokens !== undefined
          ? { cachedInputTokens: turnCachedTokens }
          : {}),
        ...(turnCacheCreationTokens !== undefined
          ? { cacheCreationTokens: turnCacheCreationTokens }
          : {}),
        // COST-PERSIST-SECTION-END
      };
      ctx.add(assistantMsg);
      // Audit M9 — also persist to SQLite so post-mortem inspection of
      // the worker session shows the full transcript instead of just
      // the row stub created in `start()`. Persistence failure is
      // non-fatal — the runtime continues on the in-memory copy.
      try {
        const backendForCost = this.deps.resolveBackend?.();
        this.deps.sessionManager.addMessage(
          this.spec.childSessionId,
          assistantMsg,
          {
            // COST-PERSIST-SECTION — pass backend so SessionManager can
            // resolve OpenRouter-routed prices. Model defaults to
            // `this.spec.model` (set on the Message above), but we pass
            // it explicitly so options-form callers stay symmetric.
            model: this.spec.model,
            ...(backendForCost !== undefined ? { backend: backendForCost } : {}),
            ...(turnPromptTokens !== undefined
              ? { tokensInput: turnPromptTokens }
              : {}),
            ...(turnCompletionTokens !== undefined
              ? { tokensOutput: turnCompletionTokens }
              : {}),
            ...(turnDurationMs !== undefined
              ? { durationMs: turnDurationMs }
              : {}),
            ...(turnCachedTokens !== undefined
              ? { cachedInputTokens: turnCachedTokens }
              : {}),
            ...(turnCacheCreationTokens !== undefined
              ? { cacheCreationTokens: turnCacheCreationTokens }
              : {}),
            // COST-PERSIST-SECTION-END
          },
        );
      } catch {
        // best-effort
      }

      // Detect <DONE> sentinel — terminal even if extra tool calls were
      // emitted in the same turn.
      if (turnText.includes(WORKER_DONE_SENTINEL)) {
        this.sawDoneSentinel = true;
      }

      // AGENT-RELIABILITY-FIX-1-SECTION
      // CRITICAL: when the worker emits BOTH <DONE> and tool calls on the
      // same turn (a very common pattern — "I'll write file X. <DONE>"
      // followed by a `write_file` tool call), the previous logic
      // short-circuited and returned WITHOUT executing the pending tool
      // calls. Result: the final write_file/edit_file was silently
      // dropped and the agent reported success.
      //
      // Fix: tool calls are always executed first. <DONE> only triggers
      // termination AFTER the turn's pending tool calls have run. If
      // there are no tool calls, <DONE> (or implicit no-tools end) ends
      // the loop as before.
      if (!hasToolCalls) {
        const summary = extractWorkerSummary(this.assistantText);
        this.callbacks?.onDone({ summary });
        return;
      }
      // AGENT-RELIABILITY-FIX-1-SECTION-END

      // Execute tool calls before next turn.
      for (const call of pendingToolCalls) {
        if (this.cancelled) {
          // AGENT-RELIABILITY-FIX-4-SECTION
          // eslint-disable-next-line no-console
          console.warn(
            `[agents] runner ${this.spec.agentId} cancelled before tool ${call.name} at turn ${turn}`,
          );
          // AGENT-RELIABILITY-FIX-4-SECTION-END
          return;
        }
        const result = await executor.execute(call);
        const toolMsg: Message = {
          id: `tool-${this.spec.childSessionId}-${turn}-${call.id}`,
          role: 'tool',
          content: result.error
            ? `${result.output}\n[error] ${result.error}`
            : result.output,
          toolName: call.name,
          toolCallId: call.id,
          createdAt: Date.now(),
        };
        ctx.add(toolMsg);
        // Audit M9 — persist tool reply for post-mortem.
        try {
          this.deps.sessionManager.addMessage(
            this.spec.childSessionId,
            toolMsg,
          );
        } catch {
          // best-effort
        }
      }

      // AGENT-RELIABILITY-FIX-1-SECTION
      // <DONE> AFTER tool execution: now that the writes have committed,
      // surface the summary and exit. This is the path that fixes the
      // "files not getting written" symptom for same-turn <DONE>+tools.
      if (this.sawDoneSentinel) {
        const summary = extractWorkerSummary(this.assistantText);
        this.callbacks?.onDone({ summary });
        return;
      }
      // AGENT-RELIABILITY-FIX-1-SECTION-END
      // loop again for next turn
    }

    // AGENT-RELIABILITY-FIX-2-SECTION
    // MAX_TURNS exhausted without <DONE>. The previous code surfaced this
    // as `onDone` with a synthetic summary, which the orchestrator marked
    // as `status: 'done'` — indistinguishable from a real completion. We
    // now surface as `onError` so the parent can react (retry, escalate,
    // ask user). Log at warn level for observability.
    const summary = extractWorkerSummary(this.assistantText);
    // eslint-disable-next-line no-console
    console.warn(
      `[agents] runner ${this.spec.agentId} exhausted ${MAX_TURNS} turns without <DONE>; surfacing as failure`,
    );
    this.callbacks?.onError(
      summary.length > 0
        ? `Worker exhausted ${MAX_TURNS} turns without <DONE>. Partial progress: ${summary.slice(0, 200)}`
        : `Worker exhausted ${MAX_TURNS} turns without <DONE>`,
    );
    // AGENT-RELIABILITY-FIX-2-SECTION-END
  }
}
