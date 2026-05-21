/**
 * /plan — two-phase generation (ROADMAP #10).
 *
 * Flow:
 *   1. User runs `/plan <task description>`.
 *   2. The command sends the LLM a planning-only prompt that asks for:
 *      - the list of files to create/modify with one-line descriptions,
 *      - a numbered execution order,
 *      - tests to write,
 *      - an estimated complexity (small/medium/large).
 *   3. The LLM streams the plan back into the chat; the plan is captured
 *      verbatim and saved to `<projectRoot>/.localcode/plans/<timestamp>.md`.
 *   4. A trailing note tells the user how to approve / refine: `/agent execute`
 *      or chat-based refinement.
 *
 * The command intentionally does NOT mutate the live `ContextManager` —
 * planning is a side-channel exchange so it can be repeated without
 * polluting the chat history. Plans are persisted to disk as a paper
 * trail (the user often wants to revisit them).
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { LLMAdapter } from '@/llm/adapter';
import type { ContextManager } from '@/llm/context-manager';
import type {
  CommandContext,
  Message,
  SlashCommand,
} from '@/types/global';

// ---------- Constants ----------

const PLAN_NAME = 'plan';
const PLAN_DESCRIPTION =
  'Two-phase generation: ask the model to produce a concrete plan before writing any code.';
const PLAN_USAGE = '/plan <task description>';

const PLANNING_SYSTEM_PROMPT = [
  'You are a senior software engineer producing a concrete plan, NOT code.',
  'Your output must be a markdown document with the four sections listed below.',
  'Be specific about file paths and order. Do NOT include any code blocks.',
  'Do NOT begin implementation. Only the plan.',
].join(' ');

const PLAN_DIR_NAME = 'plans';

// ---------- Dependencies ----------

/**
 * Subset of `LLMAdapter` `/plan` needs. Mirrors the `streamChat`
 * method shape so tests can inject a fake without standing up the
 * whole adapter.
 */
export interface PlanLLM {
  streamChat: (params: {
    messages: Message[];
    onChunk?: (text: string) => void;
    onDone?: (result: { error?: string }) => void;
  }) => Promise<void>;
}

/**
 * Subset of `ContextManager` `/plan` reads. The plan command does NOT
 * mutate context — it only borrows the system prompt builder so the
 * planning request inherits the same active skills + project context.
 */
export interface PlanContextManager {
  buildSystemPrompt(
    localcodeMd: string | null,
    skills: ReadonlyArray<{ content: string }>,
  ): string;
}

export interface PlanDeps {
  llm: PlanLLM;
  contextManager: PlanContextManager;
  /**
   * Returns the LOCALCODE.md content (or `null`) so the planning prompt
   * inherits project context. Wired by Agent F to the same accessor used
   * by `/init`.
   */
  readLocalcodeMd: (projectRoot: string) => string | null;
  /**
   * Optional override for the plan persistence directory. When omitted,
   * defaults to `<projectRoot>/.localcode/plans/`. Tests pass a tmp dir.
   */
  plansDirOverride?: (projectRoot: string) => string;
  /** Wall-clock timestamp source. Defaults to `Date.now()`. */
  now?: () => number;
}

// ---------- Public factory ----------

export function createPlanCommand(deps: PlanDeps): SlashCommand {
  const { llm, contextManager, readLocalcodeMd } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    name: PLAN_NAME,
    description: PLAN_DESCRIPTION,
    usage: PLAN_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const description = args.trim();
      if (description.length === 0) {
        ctx.print(
          'Usage: /plan <task description>. Example: /plan add a /usage command.',
        );
        return;
      }

      ctx.print('Planning...');

      const systemPrompt = buildSystemPromptForPlan(
        contextManager,
        readLocalcodeMd,
        ctx.projectRoot,
      );

      const userPrompt = buildPlanUserPrompt(description);

      const messages: Message[] = [
        {
          id: `plan-sys-${idSuffix(now())}`,
          role: 'system',
          content: systemPrompt,
          createdAt: now(),
        },
        {
          id: `plan-usr-${idSuffix(now())}`,
          role: 'user',
          content: userPrompt,
          createdAt: now(),
        },
      ];

      let accumulated = '';
      let streamError: string | null = null;
      try {
        await llm.streamChat({
          messages,
          onChunk: (text: string): void => {
            accumulated += text;
            ctx.print(text);
          },
          onDone: (result): void => {
            if (typeof result.error === 'string' && result.error.length > 0) {
              streamError = result.error;
            }
          },
        });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`LLM stream failed: ${msg}`);
        return;
      }

      if (streamError !== null) {
        ctx.print(`LLM stream ended with error: ${streamError}`);
        return;
      }

      const cleaned = accumulated.trim();
      if (cleaned.length === 0) {
        ctx.print('LLM returned an empty plan — nothing to save.');
        return;
      }

      // Persist the plan.
      const plansDir =
        deps.plansDirOverride !== undefined
          ? deps.plansDirOverride(ctx.projectRoot)
          : defaultPlansDir(ctx.projectRoot);
      let savedPath: string | null = null;
      try {
        savedPath = persistPlan(plansDir, description, cleaned, now());
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`(Warning: failed to save plan to disk: ${msg})`);
      }

      ctx.print('');
      ctx.print(
        'Approve this plan? Run `/agent execute` to start, or refine via chat.',
      );
      if (savedPath !== null) {
        ctx.print(`Plan saved to ${savedPath}`);
      }
    },
  };
}

// ---------- Internals ----------

function buildSystemPromptForPlan(
  cm: PlanContextManager,
  readLocalcodeMd: (root: string) => string | null,
  projectRoot: string,
): string {
  let localcodeMd: string | null = null;
  try {
    localcodeMd = readLocalcodeMd(projectRoot);
  } catch {
    localcodeMd = null;
  }
  const baseSystem = cm.buildSystemPrompt(localcodeMd, []);
  // Layer the planning-specific instructions on top of the project system
  // prompt so the model still sees the project conventions / LOCALCODE.md
  // context but is constrained to "plan, don't code".
  return `${baseSystem}\n\n${PLANNING_SYSTEM_PROMPT}`;
}

function buildPlanUserPrompt(description: string): string {
  return [
    `The user wants to: ${description}`,
    '',
    'Produce a CONCRETE plan with:',
    '1. List of files to create/modify (path + 1-line description)',
    '2. Order of implementation (numbered steps)',
    '3. Tests to write',
    '4. Estimated complexity (small/medium/large)',
    '',
    'DO NOT write code yet. Only the plan.',
    'Use markdown headings: ## Files, ## Implementation order, ## Tests, ## Complexity.',
  ].join('\n');
}

function defaultPlansDir(projectRoot: string): string {
  return path.join(projectRoot, '.localcode', PLAN_DIR_NAME);
}

/**
 * Save the plan to disk. Returns the absolute path of the written file.
 * Throws on filesystem errors so the caller can surface them.
 */
function persistPlan(
  dir: string,
  description: string,
  body: string,
  ts: number,
): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const stamp = formatTimestamp(ts);
  const filePath = path.join(dir, `${stamp}.md`);
  const header = [
    `# Plan: ${description}`,
    '',
    `_Generated: ${new Date(ts).toISOString()}_`,
    '',
    '---',
    '',
  ].join('\n');
  writeFileSync(filePath, `${header}${body.endsWith('\n') ? body : `${body}\n`}`, 'utf8');
  return filePath;
}

/**
 * Render a wall-clock timestamp into a filename-safe, lexicographically
 * sortable string. Format: `YYYYMMDD-HHMMSS`.
 */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}` +
    `-${pad(d.getHours())}` +
    `${pad(d.getMinutes())}` +
    `${pad(d.getSeconds())}`
  );
}

function idSuffix(ts: number): string {
  return `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Re-export for test/typing parity (Agent F may want the adapter type).
export type { LLMAdapter };
export type { ContextManager };
