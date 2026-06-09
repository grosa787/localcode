/**
 * Golden-task runner.
 *
 * `runTask` scaffolds a task's repo into a fresh tmp directory, runs an
 * autonomous agent loop against a LIVE adapter + ToolExecutor (capped at
 * `task.maxTurns`), captures cost/latency metrics, runs the deterministic
 * success check, and returns a {@link TaskResult}.
 *
 * Why a minimal loop instead of `src/agents/runner-factory.ts`?
 * ----------------------------------------------------------------
 * The production worker loop (`ChatRuntimeAgentRunner.runLoop`) is the
 * pattern this harness mirrors — system+user seed, per-turn streamChat,
 * execute pending tool calls BEFORE honouring the `<DONE>` sentinel,
 * bounded turn count — but it is tightly bound to the orchestrator
 * surface (`AgentRunnerSpec`, `TeamBus`, `SessionManager` persistence,
 * synthetic child sessions). The eval harness needs none of that and
 * MUST be cheaply injectable so tests drive it with a scripted fake
 * adapter. So we re-implement the same loop shape here, minus the
 * orchestrator coupling. The load-bearing invariant — tool calls run
 * before `<DONE>` terminates the turn — is preserved verbatim.
 *
 * The adapter is injected (matching the `WorkerAdapter` `{ streamChat }`
 * fragment) and the ToolExecutor is built per-task with
 * `dangerouslyAllowAll: true` so writes / edits / commands run
 * unattended. Both are overridable for tests.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Message, ToolCall } from '@/types/global';
import type { StreamChatParams, ToolSchema } from '@/types/message';
import { ToolExecutor } from '@/llm/tool-executor';
import { TOOLS_SCHEMA } from '@/llm/tools-schema';
import {
  createToolHandlerMap,
  type ToolHandler,
  type ToolHandlerMap,
} from '@/tools';
import type {
  ToolHandler as FlatToolHandler,
  ToolHandlerMap as FlatToolHandlerMap,
} from '@/types/message';
import { resolvePrice } from '@/llm/pricing/resolver';
import { computeCostBreakdown } from '@/llm/pricing/cost-calculator';

import type { EvalReport, GoldenTask, TaskResult } from './types';

/**
 * Minimal adapter shape the runner exercises. Matches the fragment of
 * `LLMAdapter` the loop calls so tests can supply a scripted fake without
 * constructing the full adapter.
 */
export interface EvalAdapter {
  streamChat(params: StreamChatParams): Promise<void>;
}

/** Sentinel the agent emits to signal task completion. Mirrors workers. */
export const EVAL_DONE_SENTINEL = '<DONE>';

/** Default maximum turns when a task omits `maxTurns` (defensive). */
const DEFAULT_MAX_TURNS = 12;

/**
 * System prompt handed to the agent for every eval task. Deliberately
 * compact + stable: it explains the tool loop and the `<DONE>` contract
 * without leaking task-specific data (so a local model's prefix cache
 * stays warm across tasks in the same suite run).
 */
const EVAL_SYSTEM_PROMPT = [
  'You are an autonomous coding agent working inside a small repository.',
  'Use the provided tools to read and modify files until the task is done.',
  'Prefer write_file / edit_file to make changes. Read files before editing.',
  'When — and only when — the task is fully complete, end your reply with',
  'the exact sentinel <DONE> on its own. Do not emit <DONE> prematurely.',
].join('\n');

export interface RunTaskOptions {
  /** Live (or fake) adapter driving the streaming loop. Required. */
  readonly adapter: EvalAdapter;
  /** Model id recorded on the result + used for cost resolution. */
  readonly model: string;
  /** Backend used for cost resolution (local providers → $0). */
  readonly backend: string;
  /**
   * Override the ToolExecutor factory. Defaults to a real executor with
   * `dangerouslyAllowAll: true` bound to the scaffolded repo root. Tests
   * that want to observe tool dispatch can inject their own.
   */
  readonly executorFactory?: (projectRoot: string) => ToolExecutor;
  /**
   * Override the tools schema advertised to the model. Defaults to the
   * production `TOOLS_SCHEMA`. Tests can pass a narrowed set.
   */
  readonly tools?: readonly ToolSchema[];
  /** Override "now" for deterministic wall-clock assertions in tests. */
  readonly nowMs?: () => number;
}

export interface RunSuiteOptions extends Omit<RunTaskOptions, never> {
  /**
   * Optional progress callback fired after each task completes. Lets the
   * command surface live "task N/M" output without buffering the whole
   * suite. Errors thrown by the callback are swallowed.
   */
  readonly onTaskComplete?: (result: TaskResult, index: number) => void;
}

/**
 * Scaffold a task's repo into a fresh tmp dir, run the agent loop, run
 * the success check, and clean up. Never throws — any failure becomes a
 * `TaskResult` with `passed: false` and an `error` string.
 */
export async function runTask(
  task: GoldenTask,
  opts: RunTaskOptions,
): Promise<TaskResult> {
  const now = opts.nowMs ?? (() => Date.now());
  const startedAt = now();
  const repoRoot = await scaffoldRepo(task);
  const executor =
    opts.executorFactory?.(repoRoot) ?? defaultExecutor(repoRoot);
  const tools = opts.tools ?? TOOLS_SCHEMA;
  const maxTurns = task.maxTurns > 0 ? task.maxTurns : DEFAULT_MAX_TURNS;

  let tokensIn = 0;
  let tokensOut = 0;
  let turns = 0;
  let loopError: string | null = null;

  const conversation: Message[] = [
    {
      id: `eval-sys-${task.id}`,
      role: 'system',
      content: EVAL_SYSTEM_PROMPT,
      createdAt: startedAt,
    },
    {
      id: `eval-usr-${task.id}`,
      role: 'user',
      content: task.prompt,
      createdAt: startedAt,
    },
  ];

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      turns = turn + 1;
      let turnText = '';
      let pendingToolCalls: ToolCall[] = [];
      let streamError: string | null = null;

      await opts.adapter.streamChat({
        messages: conversation,
        tools,
        model: opts.model,
        onChunk: (text) => {
          turnText += text;
        },
        onToolCalls: (calls) => {
          pendingToolCalls = [...calls];
        },
        onDone: (result) => {
          if (result.error !== undefined && result.error !== '') {
            streamError = result.error;
          }
          if (result.usage !== undefined) {
            tokensIn += result.usage.promptTokens ?? 0;
            tokensOut += result.usage.completionTokens ?? 0;
          }
        },
      });

      if (streamError !== null) {
        loopError = `stream error on turn ${turns}: ${streamError}`;
        break;
      }

      const hasToolCalls = pendingToolCalls.length > 0;
      const assistantMsg: Message = {
        id: `eval-asst-${task.id}-${turn}`,
        role: 'assistant',
        content: turnText,
        ...(hasToolCalls ? { toolCalls: pendingToolCalls } : {}),
        createdAt: now(),
      };
      conversation.push(assistantMsg);

      const sawDone = turnText.includes(EVAL_DONE_SENTINEL);

      // No tool calls this turn → the agent is done (explicit <DONE> or
      // an implicit text-only end). Terminate the loop.
      if (!hasToolCalls) {
        break;
      }

      // CRITICAL (mirrors runner-factory FIX5): execute pending tool
      // calls BEFORE honouring <DONE>. A turn that emits both a final
      // write_file AND <DONE> must still commit the write.
      for (const call of pendingToolCalls) {
        const result = await executor.execute(call);
        conversation.push({
          id: `eval-tool-${task.id}-${turn}-${call.id}`,
          role: 'tool',
          content: result.error
            ? `${result.output}\n[error] ${result.error}`
            : result.output,
          toolName: call.name,
          toolCallId: call.id,
          createdAt: now(),
        });
      }

      // <DONE> after tools have committed — terminate.
      if (sawDone) break;
    }
  } catch (err) {
    loopError = err instanceof Error ? err.message : String(err);
  }

  const hitCap = loopError === null && turns >= maxTurns && !conversationEnded(conversation);

  // Run the success check regardless of how the loop ended — even a
  // maxTurns-capped run may have produced a passing repo state, and the
  // check is the source of truth for the verdict.
  let passed = false;
  let checkError: string | null = null;
  try {
    const verdict = await runSuccessCheck(task, repoRoot);
    passed = verdict.passed;
    if (!verdict.passed) checkError = verdict.detail;
  } catch (err) {
    checkError = err instanceof Error ? err.message : String(err);
  }

  await cleanupRepo(repoRoot);

  const wallMs = Math.max(0, now() - startedAt);
  const costUsd = estimateCost(opts.backend, opts.model, tokensIn, tokensOut);

  const error = passed
    ? undefined
    : (loopError ??
      (hitCap ? `maxTurns (${maxTurns}) reached without completing` : null) ??
      checkError ??
      'success check failed');

  return {
    taskId: task.id,
    passed,
    turns,
    tokensIn,
    tokensOut,
    costUsd,
    wallMs,
    ...(error !== undefined && error !== null ? { error } : {}),
  };
}

/**
 * Run every task in `tasks` sequentially against the same model+backend
 * and aggregate the results into an {@link EvalReport}. Sequential by
 * design — parallel runs would race shared local-model resources and
 * make latency metrics meaningless.
 */
export async function runSuite(
  tasks: readonly GoldenTask[],
  opts: RunSuiteOptions,
): Promise<EvalReport> {
  const now = opts.nowMs ?? (() => Date.now());
  const ranAt = now();
  const results: TaskResult[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (task === undefined) continue;
    const result = await runTask(task, opts);
    results.push(result);
    if (opts.onTaskComplete !== undefined) {
      try {
        opts.onTaskComplete(result, i);
      } catch {
        // Progress callback failures must never abort the suite.
      }
    }
  }

  return aggregate(results, opts.model, opts.backend, ranAt);
}

/**
 * Fold a list of {@link TaskResult}s into an {@link EvalReport}. Exposed
 * for tests that construct results directly.
 */
export function aggregate(
  results: readonly TaskResult[],
  model: string,
  backend: string,
  ranAt: number,
): EvalReport {
  let passes = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  let totalWallMs = 0;
  for (const r of results) {
    if (r.passed) passes += 1;
    totalTokensIn += r.tokensIn;
    totalTokensOut += r.tokensOut;
    totalCostUsd += r.costUsd;
    totalWallMs += r.wallMs;
  }
  const passRate = results.length === 0 ? 0 : passes / results.length;
  return {
    model,
    backend,
    ranAt,
    results: [...results],
    passRate,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd: round6(totalCostUsd),
    totalWallMs,
  };
}

// ---------- internals ----------

/**
 * Build the default ToolExecutor for a scaffolded repo: real handler
 * map, `dangerouslyAllowAll: true` (unattended), auto-lint OFF (the
 * scaffold files aren't part of the host project and linting them adds
 * noise + latency without affecting the success check).
 */
function defaultExecutor(projectRoot: string): ToolExecutor {
  const ctx = { projectRoot, dangerouslyAllowAll: true };
  const twoPhase: ToolHandlerMap = createToolHandlerMap(ctx);
  const flat: FlatToolHandlerMap = {};
  for (const [name, handler] of Object.entries(twoPhase)) {
    flat[name] = makeFlatHandler(handler, ctx);
  }
  return new ToolExecutor({
    handlers: flat,
    dangerouslyAllowAll: true,
    autoLintAfterWrite: false,
    projectRoot,
  });
}

/**
 * Collapse a two-phase `{ preview, commit }` handler into the flat
 * `(args) => Promise<ToolResult>` shape the ToolExecutor expects. Mirrors
 * the flattening in `runner-factory.ts`: run preview, then commit if the
 * preview succeeded; preserve the preview's output when commit is silent.
 */
function makeFlatHandler(
  handler: ToolHandler,
  ctx: { projectRoot: string; dangerouslyAllowAll: boolean },
): FlatToolHandler {
  return async (args) => {
    const preview = await handler.preview(args, ctx);
    if (handler.commit === undefined) return preview;
    if (!preview.success) return preview;
    const committed = await handler.commit(args, ctx);
    if (committed.success && committed.output.length === 0) {
      return { ...committed, output: preview.output };
    }
    return committed;
  };
}

/** Scaffold the task's files into a fresh tmp repo; returns the root. */
async function scaffoldRepo(task: GoldenTask): Promise<string> {
  const root = path.join(os.tmpdir(), `localcode-eval-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  for (const [relPath, content] of Object.entries(task.scaffold.files)) {
    const abs = path.join(root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

/** Best-effort recursive removal of the scaffolded repo. */
async function cleanupRepo(root: string): Promise<void> {
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch {
    // Leaving a tmp dir behind is harmless — the OS reaps /tmp.
  }
}

/**
 * Run a task's deterministic success check against the scaffolded repo.
 * Returns `{ passed, detail }` — `detail` describes the failure.
 */
async function runSuccessCheck(
  task: GoldenTask,
  repoRoot: string,
): Promise<{ passed: boolean; detail: string }> {
  const check = task.success;
  if (check.kind === 'fileContains') {
    const abs = path.join(repoRoot, check.path);
    let body: string;
    try {
      body = await fs.readFile(abs, 'utf8');
    } catch {
      return { passed: false, detail: `file not found: ${check.path}` };
    }
    if (body.includes(check.needle)) return { passed: true, detail: '' };
    return {
      passed: false,
      detail: `${check.path} does not contain "${check.needle}"`,
    };
  }

  // kind === 'command' — run with a hard timeout so a hung check can't
  // wedge the suite. Use a shell so pipelines / `!` / `&&` work.
  const expectExit = check.expectExit ?? 0;
  const proc = spawnSync(check.cmd, {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const actual = proc.status ?? -1;
  if (actual === expectExit) return { passed: true, detail: '' };
  const stderr = (proc.stderr ?? '').trim().slice(0, 300);
  return {
    passed: false,
    detail: `command exited ${actual}, expected ${expectExit}${
      stderr.length > 0 ? `: ${stderr}` : ''
    }`,
  };
}

/**
 * Estimate USD cost from token counts. Local providers / unknown models
 * resolve to `null` pricing → $0. No cache split is available at the
 * suite level so all input tokens are billed at the fresh rate.
 */
function estimateCost(
  backend: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const pricing = resolvePrice(backend, model);
  const breakdown = computeCostBreakdown(
    { inputTokens: tokensIn, outputTokens: tokensOut },
    pricing,
  );
  return breakdown.total;
}

/**
 * True when the conversation's last assistant turn terminated cleanly
 * (saw the <DONE> sentinel or ended with no tool calls). Used only to
 * distinguish a clean end from a maxTurns cut-off for the error message.
 */
function conversationEnded(conversation: readonly Message[]): boolean {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const msg = conversation[i];
    if (msg === undefined) continue;
    if (msg.role !== 'assistant') continue;
    const noTools = msg.toolCalls === undefined || msg.toolCalls.length === 0;
    return noTools || msg.content.includes(EVAL_DONE_SENTINEL);
  }
  return false;
}

function round6(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}
