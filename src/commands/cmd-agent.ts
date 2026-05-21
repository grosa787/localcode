/**
 * /agent — agentic loop (ROADMAP #16).
 *
 * Runs the model in a write-run-review loop until a task is complete or a
 * safety limit is hit:
 *   - "wrote → ran → error → analyse → fix → ran → success → next subtask"
 *   - never stops until the model emits a clean finish OR the user cancels.
 *
 * Surface:
 *   /agent <task description>     — start a new agentic run
 *   /agent execute                — alias for "use the most recent /plan as the task"
 *   /agent resume                 — resume from `.localcode/agent-state.json`
 *   /agent cancel                 — flip state to `paused`, halts the next iteration
 *   /agent --auto <task>          — same as above but bypasses approval prompts
 *                                   (sets `dangerouslyAllowAll` for THIS run only)
 *
 * Safety limits (HARDCODED for now — Agent F may promote to config later):
 *   - max iterations:  100
 *   - max wall-clock:  1 hour
 *   - max tokens:      1_000_000 across the whole run
 *   - watchdog:        5 consecutive identical tool calls → pause + ask user
 *   - 10-iteration confirmation: every 10 iterations the loop pauses with
 *     a "Continue? [y/n]" prompt unless `--auto` is set
 *
 * Persistence:
 *   `<projectRoot>/.localcode/agent-state.json` is written after every
 *   iteration so an interrupted run (Ctrl+C, crash, OS shutdown) can be
 *   resumed via `/agent resume`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  CommandContext,
  Message,
  SlashCommand,
  ToolCall,
  ToolResult,
} from '@/types/global';
import type { ContextManager } from '@/llm/context-manager';
import type { ToolExecutor } from '@/llm/tool-executor';
import type {
  StreamChatParams,
  StreamDoneResult,
  StreamUsage,
  ToolSchema,
} from '@/types/message';

// ---------- Constants ----------

const AGENT_NAME = 'agent';
const AGENT_DESCRIPTION =
  'Agentic loop — run the model autonomously until the task is complete or a safety limit is hit.';
const AGENT_USAGE =
  '/agent <task> | /agent execute | /agent resume | /agent cancel | /agent --auto <task>';

/** Hard ceiling on iterations within a single run. */
const MAX_ITERATIONS = 100;
/** Hard ceiling on wall-clock duration in milliseconds (1 hour). */
const MAX_WALL_MS = 60 * 60 * 1000;
/** Hard ceiling on cumulative tokens (input + output across all turns). */
const MAX_TOKENS = 1_000_000;
/** Number of consecutive identical tool calls that triggers the watchdog. */
const WATCHDOG_REPEAT_THRESHOLD = 5;
/** Iteration interval at which we ask the user to confirm continuation. */
const CONFIRM_EVERY_N_ITERATIONS = 10;

const STATE_FILE_NAME = 'agent-state.json';
const PLANS_DIR_NAME = 'plans';

const AGENT_SYSTEM_SUFFIX = [
  'You are operating in AGENTIC LOOP mode.',
  'After each tool call you will see the tool result and decide the next step.',
  'When the task is complete say exactly "TASK COMPLETE" on its own line — that signals the loop to stop.',
  'If you cannot make progress, say "BLOCKED: <reason>" and wait for guidance.',
  'Do NOT chat — work the problem.',
].join(' ');

// ---------- State ----------

export type AgentStatus = 'running' | 'paused' | 'done' | 'failed';

export interface AgentState {
  task: string;
  startedAt: number;
  iterations: number;
  lastTool: string | null;
  status: AgentStatus;
  /** Cumulative tokens used by this run. */
  tokensUsed: number;
  /** Hash of the last tool call (toolName + JSON args) — for watchdog detection. */
  lastToolHash: string | null;
  /** How many times the lastToolHash repeated in a row. */
  repeatCount: number;
  /** Auto-approve mode for this run. */
  auto: boolean;
}

// ---------- Dependencies ----------

/**
 * Subset of `LLMAdapter` consumed by the agent loop. Mirrors the
 * `streamChat` signature exactly so callers can hand in the real adapter
 * without an explicit cast.
 */
export interface AgentLLM {
  streamChat: (params: StreamChatParams) => Promise<void>;
}

/**
 * Subset of `ContextManager` the agent loop needs. The loop appends new
 * messages (assistant turns + synthetic tool-result messages) so the next
 * iteration carries the freshest history.
 */
export interface AgentContextManager {
  getMessages(): Message[];
  addMessage(message: Message): void;
  buildSystemPrompt(
    localcodeMd: string | null,
    skills: ReadonlyArray<{ content: string }>,
  ): string;
}

/**
 * Subset of `ToolExecutor` the agent loop drives. Uses `executeAll` so
 * approvals + post-commit hooks are honoured exactly as in interactive mode.
 */
export interface AgentToolExecutor {
  executeAll: (
    toolCalls: readonly ToolCall[],
  ) => Promise<Array<{ toolCall: ToolCall; result: ToolResult }>>;
}

/**
 * Optional confirmation hook. When provided, the loop calls it every
 * `CONFIRM_EVERY_N_ITERATIONS` iterations (and after a watchdog trip)
 * with a prompt string. Resolve `true` to continue, `false` to pause.
 *
 * When omitted the loop continues automatically — useful for tests
 * and `--auto` runs.
 */
export type AgentConfirm = (prompt: string) => Promise<boolean>;

export interface AgentDeps {
  llm: AgentLLM;
  contextManager: AgentContextManager;
  toolExecutor: AgentToolExecutor;
  /** Tool catalogue forwarded to the LLM on every iteration. */
  tools: readonly ToolSchema[];
  /** Read LOCALCODE.md for the system-prompt builder. */
  readLocalcodeMd: (projectRoot: string) => string | null;
  /** Optional confirmation hook (10-iteration check + watchdog). */
  confirm?: AgentConfirm;
  /**
   * Optional override for the agent-state file path. Defaults to
   * `<projectRoot>/.localcode/agent-state.json`.
   */
  stateFileOverride?: (projectRoot: string) => string;
  /**
   * Optional override for the plans directory. Used by `/agent execute`
   * to find the most recent plan file.
   */
  plansDirOverride?: (projectRoot: string) => string;
  /** Wall-clock source. Defaults to `Date.now()`. */
  now?: () => number;
}

// ---------- Public factory ----------

export function createAgentCommand(deps: AgentDeps): SlashCommand {
  const now = deps.now ?? (() => Date.now());

  return {
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    usage: AGENT_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const parsed = parseArgs(args);

      if (parsed.kind === 'cancel') {
        await handleCancel(ctx, deps);
        return;
      }
      if (parsed.kind === 'resume') {
        await handleResume(ctx, deps, now);
        return;
      }
      if (parsed.kind === 'execute') {
        await handleExecute(ctx, deps, parsed.auto, now);
        return;
      }
      if (parsed.kind === 'task') {
        await runAgent(ctx, deps, parsed.task, parsed.auto, now);
        return;
      }
      // 'help' fallthrough.
      ctx.print(`Usage: ${AGENT_USAGE}`);
    },
  };
}

// ---------- Argument parsing ----------

type ParsedArgs =
  | { kind: 'task'; task: string; auto: boolean }
  | { kind: 'execute'; auto: boolean }
  | { kind: 'resume' }
  | { kind: 'cancel' }
  | { kind: 'help' };

function parseArgs(raw: string): ParsedArgs {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'help' };

  // Extract the auto flag (anywhere in the arg string).
  let body = trimmed;
  let auto = false;
  const autoMatch = /(^|\s)--auto(\s|$)/.exec(body);
  if (autoMatch !== null) {
    auto = true;
    body = (body.slice(0, autoMatch.index) + ' ' + body.slice(autoMatch.index + autoMatch[0].length)).trim();
  }

  if (body.length === 0) return { kind: 'help' };

  const lower = body.toLowerCase();
  if (lower === 'cancel' || lower === 'pause' || lower === 'stop') {
    return { kind: 'cancel' };
  }
  if (lower === 'resume' || lower === 'continue') {
    return { kind: 'resume' };
  }
  if (lower === 'execute' || lower === 'run-plan') {
    return { kind: 'execute', auto };
  }
  return { kind: 'task', task: body, auto };
}

// ---------- Handlers: cancel / resume / execute ----------

async function handleCancel(
  ctx: CommandContext,
  deps: AgentDeps,
): Promise<void> {
  const stateFile = stateFilePath(ctx.projectRoot, deps);
  const state = readState(stateFile);
  if (state === null) {
    ctx.print('No agent run is active.');
    return;
  }
  if (state.status !== 'running') {
    ctx.print(`Agent already in status: ${state.status}.`);
    return;
  }
  state.status = 'paused';
  writeState(stateFile, state);
  ctx.print('Agent paused. Run `/agent resume` to continue.');
}

async function handleResume(
  ctx: CommandContext,
  deps: AgentDeps,
  now: () => number,
): Promise<void> {
  const stateFile = stateFilePath(ctx.projectRoot, deps);
  const state = readState(stateFile);
  if (state === null) {
    ctx.print('No agent state to resume — start a new run with `/agent <task>`.');
    return;
  }
  if (state.status === 'done' || state.status === 'failed') {
    ctx.print(
      `Previous run ended with status "${state.status}". Start a new one with /agent <task>.`,
    );
    return;
  }
  state.status = 'running';
  writeState(stateFile, state);
  ctx.print(`Resuming agent at iteration ${state.iterations + 1}...`);
  await runLoop(ctx, deps, state, now);
}

async function handleExecute(
  ctx: CommandContext,
  deps: AgentDeps,
  auto: boolean,
  now: () => number,
): Promise<void> {
  const plansDir =
    deps.plansDirOverride !== undefined
      ? deps.plansDirOverride(ctx.projectRoot)
      : path.join(ctx.projectRoot, '.localcode', PLANS_DIR_NAME);
  const planText = readMostRecentPlan(plansDir);
  if (planText === null) {
    ctx.print('No saved plan found. Run `/plan <task>` first.');
    return;
  }
  const task = `Execute the following plan:\n\n${planText}`;
  await runAgent(ctx, deps, task, auto, now);
}

// ---------- Main loop ----------

async function runAgent(
  ctx: CommandContext,
  deps: AgentDeps,
  task: string,
  auto: boolean,
  now: () => number,
): Promise<void> {
  const startedAt = now();
  const state: AgentState = {
    task,
    startedAt,
    iterations: 0,
    lastTool: null,
    status: 'running',
    tokensUsed: 0,
    lastToolHash: null,
    repeatCount: 0,
    auto,
  };
  const stateFile = stateFilePath(ctx.projectRoot, deps);
  writeState(stateFile, state);

  // Seed the conversation with the task as the user message + an
  // agent-mode system suffix. The base ContextManager already includes
  // active skills and LOCALCODE.md.
  const systemPrompt = buildAgentSystemPrompt(deps, ctx.projectRoot);
  const seedMsgs: Message[] = [
    {
      id: `agent-sys-${idSuffix(now())}`,
      role: 'system',
      content: systemPrompt,
      createdAt: now(),
    },
    {
      id: `agent-task-${idSuffix(now())}`,
      role: 'user',
      content: task,
      createdAt: now(),
    },
  ];
  for (const m of seedMsgs) deps.contextManager.addMessage(m);

  ctx.print(`Agent started. Task: ${truncate(task, 100)}`);
  ctx.print(
    `Limits: ${MAX_ITERATIONS} iterations, ${Math.round(MAX_WALL_MS / 60000)} min, ${MAX_TOKENS.toLocaleString()} tokens.`,
  );
  if (auto) {
    ctx.print('Auto-approval ON for this run (--auto).');
  }

  await runLoop(ctx, deps, state, now);
}

async function runLoop(
  ctx: CommandContext,
  deps: AgentDeps,
  state: AgentState,
  now: () => number,
): Promise<void> {
  const stateFile = stateFilePath(ctx.projectRoot, deps);

  while (state.status === 'running') {
    // ---- Safety limits ----
    if (state.iterations >= MAX_ITERATIONS) {
      finalize(ctx, stateFile, state, 'failed', `Hit max iterations (${MAX_ITERATIONS}).`);
      return;
    }
    const elapsed = now() - state.startedAt;
    if (elapsed > MAX_WALL_MS) {
      finalize(ctx, stateFile, state, 'failed', `Hit max wall-clock (${Math.round(MAX_WALL_MS / 60000)} min).`);
      return;
    }
    if (state.tokensUsed > MAX_TOKENS) {
      finalize(ctx, stateFile, state, 'failed', `Hit max tokens (${MAX_TOKENS.toLocaleString()}).`);
      return;
    }

    // ---- Periodic confirmation ----
    if (
      state.iterations > 0 &&
      state.iterations % CONFIRM_EVERY_N_ITERATIONS === 0 &&
      !state.auto
    ) {
      ctx.print(
        `--- Iteration ${state.iterations} reached. ${MAX_ITERATIONS - state.iterations} remaining. ${state.tokensUsed.toLocaleString()} tokens used so far. ---`,
      );
      const ok = await askConfirm(deps, 'Continue? [y/n]');
      if (!ok) {
        finalize(ctx, stateFile, state, 'paused', 'User declined to continue.');
        return;
      }
    }

    state.iterations += 1;
    ctx.print(
      `Step ${state.iterations}/${MAX_ITERATIONS}: thinking…`,
    );

    // ---- Run a single LLM iteration ----
    const turn = await runOneTurn(ctx, deps, state, now);

    state.tokensUsed += turn.tokensThisTurn;
    if (turn.error !== null) {
      finalize(ctx, stateFile, state, 'failed', `LLM error: ${turn.error}`);
      return;
    }

    // ---- Process tool calls ----
    if (turn.toolCalls.length > 0) {
      const toolHash = hashToolCall(turn.toolCalls);
      if (state.lastToolHash === toolHash) {
        state.repeatCount += 1;
      } else {
        state.lastToolHash = toolHash;
        state.repeatCount = 1;
      }
      state.lastTool = turn.toolCalls[0]?.name ?? state.lastTool;

      // Watchdog
      if (state.repeatCount >= WATCHDOG_REPEAT_THRESHOLD) {
        ctx.print(
          `Watchdog: same tool+args repeated ${state.repeatCount} times in a row. Pausing.`,
        );
        const cont = await askConfirm(
          deps,
          'Continue anyway? [y/n] (n recommended — likely stuck loop)',
        );
        if (!cont) {
          finalize(ctx, stateFile, state, 'paused', 'Watchdog paused the run.');
          return;
        }
        // Reset the counter so we don't immediately re-trip.
        state.repeatCount = 0;
      }

      // Execute tools (approvals handled by the executor).
      let results: Array<{ toolCall: ToolCall; result: ToolResult }>;
      try {
        results = await deps.toolExecutor.executeAll(turn.toolCalls);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        finalize(ctx, stateFile, state, 'failed', `Tool execution threw: ${msg}`);
        return;
      }

      for (const { toolCall, result } of results) {
        // Append a tool-role message so the next iteration sees the result.
        const toolMsg: Message = {
          id: `agent-tool-${idSuffix(now())}`,
          role: 'tool',
          content: renderToolResult(result),
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          createdAt: now(),
        };
        deps.contextManager.addMessage(toolMsg);
      }
    } else {
      // No tool calls. Check if the assistant signalled completion.
      if (turn.signaledComplete) {
        finalize(ctx, stateFile, state, 'done', 'Model emitted TASK COMPLETE.');
        return;
      }
      if (turn.signaledBlocked) {
        finalize(ctx, stateFile, state, 'paused', 'Model emitted BLOCKED — human input requested.');
        return;
      }
      if (turn.finishReason === 'stop' && turn.assistantText.length === 0) {
        // Nothing happened. Inject a continue prompt so the loop doesn't deadlock.
        const continueMsg: Message = {
          id: `agent-continue-${idSuffix(now())}`,
          role: 'user',
          content: 'Continue with next step (or say "TASK COMPLETE" if done).',
          createdAt: now(),
        };
        deps.contextManager.addMessage(continueMsg);
      } else if (turn.finishReason === 'stop' || turn.finishReason === 'length') {
        // Ask the model whether it's done.
        const continueMsg: Message = {
          id: `agent-continue-${idSuffix(now())}`,
          role: 'user',
          content:
            'If the task is complete say "TASK COMPLETE". Otherwise continue with the next step.',
          createdAt: now(),
        };
        deps.contextManager.addMessage(continueMsg);
      }
    }

    // Persist after each iteration.
    writeState(stateFile, state);
  }
}

// ---------- One iteration ----------

interface OneTurnResult {
  assistantText: string;
  toolCalls: ToolCall[];
  finishReason: string;
  tokensThisTurn: number;
  signaledComplete: boolean;
  signaledBlocked: boolean;
  error: string | null;
}

async function runOneTurn(
  ctx: CommandContext,
  deps: AgentDeps,
  state: AgentState,
  now: () => number,
): Promise<OneTurnResult> {
  let buffer = '';
  let collectedToolCalls: ToolCall[] = [];
  let finishReason = '';
  let usage: StreamUsage | undefined;
  let streamErr: string | null = null;

  const messages = deps.contextManager.getMessages();

  try {
    await deps.llm.streamChat({
      messages,
      tools: deps.tools,
      onChunk: (text: string): void => {
        buffer += text;
        ctx.print(text);
      },
      onToolCalls: (calls: ToolCall[]): void => {
        collectedToolCalls = [...calls];
      },
      onDone: (result: StreamDoneResult): void => {
        if (typeof result.error === 'string' && result.error.length > 0) {
          streamErr = result.error;
        }
        finishReason = String(result.finishReason ?? '');
        usage = result.usage;
      },
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return {
      assistantText: buffer,
      toolCalls: [],
      finishReason: 'error',
      tokensThisTurn: 0,
      signaledComplete: false,
      signaledBlocked: false,
      error: msg,
    };
  }

  // Append the assistant message (text + tool calls) so the next turn
  // includes it in history. This mirrors how the chat loop persists model output.
  const assistantMsg: Message = {
    id: `agent-asst-${idSuffix(now())}`,
    role: 'assistant',
    content: buffer,
    toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
    createdAt: now(),
  };
  deps.contextManager.addMessage(assistantMsg);

  const tokensThisTurn =
    (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);

  return {
    assistantText: buffer,
    toolCalls: collectedToolCalls,
    finishReason,
    tokensThisTurn,
    signaledComplete: /\bTASK COMPLETE\b/.test(buffer),
    signaledBlocked: /\bBLOCKED\b/.test(buffer),
    error: streamErr,
  };
}

// ---------- Helpers ----------

function buildAgentSystemPrompt(
  deps: AgentDeps,
  projectRoot: string,
): string {
  let localcodeMd: string | null = null;
  try {
    localcodeMd = deps.readLocalcodeMd(projectRoot);
  } catch {
    localcodeMd = null;
  }
  const base = deps.contextManager.buildSystemPrompt(localcodeMd, []);
  return `${base}\n\n${AGENT_SYSTEM_SUFFIX}`;
}

function finalize(
  ctx: CommandContext,
  stateFile: string,
  state: AgentState,
  status: AgentStatus,
  reason: string,
): void {
  state.status = status;
  writeState(stateFile, state);
  const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
  ctx.print(
    `Agent ${status}. ${reason} (iterations=${state.iterations}, tokens=${state.tokensUsed.toLocaleString()}, elapsed=${elapsed}s)`,
  );
}

async function askConfirm(deps: AgentDeps, prompt: string): Promise<boolean> {
  if (deps.confirm === undefined) return true; // fallback: continue silently
  try {
    return await deps.confirm(prompt);
  } catch {
    return false;
  }
}

function stateFilePath(projectRoot: string, deps: AgentDeps): string {
  if (deps.stateFileOverride !== undefined) {
    return deps.stateFileOverride(projectRoot);
  }
  return path.join(projectRoot, '.localcode', STATE_FILE_NAME);
}

function readState(stateFile: string): AgentState | null {
  if (!existsSync(stateFile)) return null;
  try {
    const raw = readFileSync(stateFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isAgentState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeState(stateFile: string, state: AgentState): void {
  const dir = path.dirname(stateFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

function isAgentState(value: unknown): value is AgentState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['task'] === 'string' &&
    typeof v['startedAt'] === 'number' &&
    typeof v['iterations'] === 'number' &&
    (v['lastTool'] === null || typeof v['lastTool'] === 'string') &&
    (v['status'] === 'running' ||
      v['status'] === 'paused' ||
      v['status'] === 'done' ||
      v['status'] === 'failed') &&
    typeof v['tokensUsed'] === 'number' &&
    (v['lastToolHash'] === null || typeof v['lastToolHash'] === 'string') &&
    typeof v['repeatCount'] === 'number' &&
    typeof v['auto'] === 'boolean'
  );
}

function hashToolCall(toolCalls: readonly ToolCall[]): string {
  // Hash the (toolName + sorted JSON args) of every call so the order
  // within a batch matters but minor argument-key ordering does not.
  const repr = toolCalls
    .map((c) => `${c.name}:${stableStringify(c.arguments)}`)
    .join('|');
  return createHash('sha1').update(repr).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

function renderToolResult(result: ToolResult): string {
  const status = result.success ? 'success' : 'error';
  const trailer = result.error !== undefined ? `\nerror: ${result.error}` : '';
  return `[${status}]\n${result.output}${trailer}`;
}

function readMostRecentPlan(plansDir: string): string | null {
  if (!existsSync(plansDir)) return null;
  let files: string[];
  try {
    files = readdirSync(plansDir).filter((f) =>
      f.toLowerCase().endsWith('.md'),
    );
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort(); // lexicographic = chronological for our timestamp format
  const latest = files[files.length - 1];
  if (latest === undefined) return null;
  try {
    return readFileSync(path.join(plansDir, latest), 'utf8');
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function idSuffix(ts: number): string {
  return `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Re-export the pure types Agent F may want.
export type { ContextManager };
export type { ToolExecutor };
