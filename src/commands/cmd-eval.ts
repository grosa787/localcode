/**
 * `/eval` — run the golden-task eval harness against the active
 * backend/model and print a pass-rate report.
 *
 * Surfaces:
 *   - `/eval`            — run the whole golden suite.
 *   - `/eval <task-id>`  — run a single task by id.
 *   - `/eval export`     — run the whole suite, then write the JSON report
 *                          to `~/.localcode/eval-<date>.json`.
 *   - `/eval list`       — list available task ids without running.
 *
 * The command makes REAL model calls — one autonomous agent loop per
 * task — so it can take a while on a large suite. Each task scaffolds its
 * own throwaway tmp repo and cleans up after itself; nothing touches the
 * user's project files.
 *
 * The LLM adapter is injected (mirroring `/review`) so the freshest
 * adapter — post `/model` or `/provider` swap — is always used and tests
 * can supply a deterministic fake.
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { SlashCommand, CommandContext } from '@/types/global';
import type { StreamChatParams } from '@/types/message';

import {
  GOLDEN_TASKS,
  findTaskById,
  listTaskIds,
  runSuite,
  formatReport,
  toJson,
} from '@/eval';
import type { EvalReport } from '@/eval';

const EVAL_NAME = 'eval';
const EVAL_DESCRIPTION =
  'Run the golden-task eval suite against the current model and print a pass-rate report.';
const EVAL_USAGE = '/eval [<task-id> | export | list]';

/** Minimal LLM-adapter surface needed by `/eval`. Mirrors `/review`. */
export interface EvalLLM {
  streamChat: (params: StreamChatParams) => Promise<void>;
}

export interface EvalCommandDeps {
  /** Thin LLM adapter — only `streamChat` is needed. */
  readonly llm: EvalLLM;
  /**
   * Override the JSON-export directory. Defaults to `~/.localcode/`.
   * Tests point this at a tmp dir.
   */
  readonly exportDir?: string;
  /**
   * Override "now" for the export filename stamp. Defaults to
   * `Date.now()`. Tests inject a fixed value for a deterministic path.
   */
  readonly nowMs?: () => number;
}

/**
 * Construct the `/eval` slash command.
 *
 * Resolves the model + backend from `ctx.config` at execution time so a
 * mid-session `/model` swap is reflected without rebuilding the command.
 */
export function createEvalCommand(deps: EvalCommandDeps): SlashCommand {
  const exportDir = deps.exportDir ?? path.join(homedir(), '.localcode');
  const nowMs = deps.nowMs ?? (() => Date.now());

  return {
    name: EVAL_NAME,
    description: EVAL_DESCRIPTION,
    usage: EVAL_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();

      if (trimmed === 'list') {
        ctx.print(
          `Golden tasks (${GOLDEN_TASKS.length}):\n  ${listTaskIds().join('\n  ')}`,
        );
        return;
      }

      const model = ctx.config.model.current;
      const backend = ctx.config.backend.type;
      const wantExport = trimmed === 'export';
      const taskId = wantExport || trimmed === '' ? null : trimmed;

      // Resolve which tasks to run.
      let tasks = GOLDEN_TASKS;
      if (taskId !== null) {
        const one = findTaskById(taskId);
        if (one === null) {
          ctx.print(
            `Unknown task: "${taskId}". Run /eval list to see available ids.`,
          );
          return;
        }
        tasks = [one];
      }

      ctx.print(
        `Running ${tasks.length} golden task${
          tasks.length === 1 ? '' : 's'
        } against ${model} @ ${backend}…`,
      );

      let report: EvalReport;
      try {
        report = await runSuite(tasks, {
          adapter: { streamChat: deps.llm.streamChat },
          model,
          backend,
          onTaskComplete: (result, index) => {
            ctx.print(
              `  [${index + 1}/${tasks.length}] ${result.taskId}: ${
                result.passed ? 'PASS' : 'FAIL'
              }${result.error !== undefined ? ` (${result.error})` : ''}`,
            );
          },
        });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/eval failed: ${msg}`);
        return;
      }

      ctx.print(formatReport(report));

      if (wantExport) {
        handleExport({ ctx, report, exportDir, nowMs });
      }
    },
  };
}

// ---------- export subcommand ----------

function handleExport(args: {
  readonly ctx: CommandContext;
  readonly report: EvalReport;
  readonly exportDir: string;
  readonly nowMs: () => number;
}): void {
  const stamp = formatDateStamp(args.nowMs());
  const filename = `eval-${stamp}.json`;
  const target = path.join(args.exportDir, filename);
  try {
    fs.mkdirSync(args.exportDir, { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify(toJson(args.report), null, 2),
      'utf8',
    );
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    args.ctx.print(`/eval export failed: ${msg}`);
    return;
  }
  args.ctx.print(`Eval report exported to ${target}`);
}

function formatDateStamp(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export const __test__ = {
  formatDateStamp,
};
