/**
 * /diagnose — run the process-monitor diagnoser against a watched
 * process and inject a synthetic system message describing the most
 * recent failure (if any).
 *
 * Forms:
 *   /diagnose            Run against every alive watched process and
 *                        emit a synthetic message per signal found.
 *   /diagnose <id>       Narrow to one watched process.
 *
 * The synthetic message follows the format requested by the spec:
 *   "📡 Process "<label>" reported: <digest> @ <file>:<line>"
 *
 * Surfaced via the same callback shape as the auto-lint post-commit
 * hook (`onAutoCheckResult`) so the chat reducer + ContextManager
 * already know how to handle it. Tests inject a custom
 * `injectSyntheticMessage` to avoid touching real chat state.
 */

import { randomUUID } from 'node:crypto';

import type { CommandContext, Message, SlashCommand } from '@/types/global';
import {
  ProcessMonitor,
  getProcessMonitor,
} from '@/process-monitor';
import type { DiagnosticSignal, WatchedProcess } from '@/process-monitor';

export interface DiagnoseDeps {
  /** Optional monitor override. Defaults to the process-wide singleton. */
  readonly monitor?: ProcessMonitor;
  /**
   * Inject a synthetic system Message into the chat. The default
   * implementation appends to the CommandContext's `print` (so a user
   * running `/diagnose` always sees the digest inline); the
   * composition root replaces this with a callback that pushes the
   * message into the active ContextManager + chat reducer.
   */
  readonly injectSyntheticMessage?: (msg: Message) => void;
}

const NAME = 'diagnose';
const DESCRIPTION =
  'Run the diagnostic matcher against watched processes and surface failures.';
const USAGE = '/diagnose [<id>]';

/**
 * Build the synthetic system message body. Format:
 *   "📡 Process "<label>" reported: <digest> @ file:line"
 * The `@ file:line` suffix is omitted when no location was captured.
 */
function buildDigestText(
  label: string,
  signal: DiagnosticSignal,
): string {
  if (signal.file !== null) {
    const locus = signal.line !== null
      ? `${signal.file}:${signal.line}`
      : signal.file;
    return `📡 Process "${label}" reported: ${signal.digest} @ ${locus}`;
  }
  return `📡 Process "${label}" reported: ${signal.digest}`;
}

function syntheticMessage(text: string): Message {
  return {
    id: `diag-${randomUUID().slice(0, 8)}`,
    role: 'system',
    content: text,
    createdAt: Date.now(),
  };
}

export function createDiagnoseCommand(deps: DiagnoseDeps): SlashCommand {
  const monitor = deps.monitor ?? getProcessMonitor();
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      const targets: readonly WatchedProcess[] =
        trimmed.length === 0
          ? monitor.list()
          : ((): readonly WatchedProcess[] => {
              const snap = monitor.get(trimmed);
              return snap === null ? [] : [snap];
            })();
      if (targets.length === 0) {
        if (trimmed.length === 0) {
          ctx.print('No processes are being watched.');
        } else {
          ctx.print(`Unknown watch id: ${trimmed}`);
        }
        return;
      }

      let found = 0;
      for (const p of targets) {
        const signal = monitor.diagnoseNow(p.id);
        if (signal === null) {
          ctx.print(`${p.id}: no diagnostic signal in recent output.`);
          continue;
        }
        found += 1;
        const text = buildDigestText(p.label, signal);
        ctx.print(text);
        const msg = syntheticMessage(text);
        if (deps.injectSyntheticMessage !== undefined) {
          deps.injectSyntheticMessage(msg);
        }
      }
      if (found === 0) {
        ctx.print('(no diagnostics emitted)');
      }
    },
  };
}

/** Helper exported for tests + the auto-inject wire in app.tsx. */
export function buildDiagnosticMessage(
  label: string,
  signal: DiagnosticSignal,
): Message {
  return syntheticMessage(buildDigestText(label, signal));
}
