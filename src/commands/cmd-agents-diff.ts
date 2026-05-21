/**
 * /agents diff <agent-id> — open the full-screen DiffViewer on the
 * unified diff between the worker's worktree and its base commit (HEAD).
 *
 *   /agents diff a1b2c3       — DiffViewer over `git diff HEAD` inside
 *                                the worker's isolated worktree.
 *
 * The command resolves the worker's worktree path via the orchestrator
 * (`orchestrator.get(parentSessionId, agentId).worktreePath`), shells
 * out to `git -C <worktree> diff --name-status -z HEAD` to enumerate
 * changed files, then reads each side (HEAD blob vs working tree) so
 * the viewer can render unified or side-by-side. The handoff to the
 * viewer is via the same `openViewer` injection wired by app.tsx.
 *
 * Failure modes:
 *   - No subcommand or unknown subcommand → usage hint.
 *   - Unknown agent id under the current session → friendly error.
 *   - Worker has no worktree (isolation='shared') → explanatory error.
 *   - Worktree path missing on disk (already cleaned up) → friendly error.
 *   - Clean worktree → "No changes." (no viewer).
 *   - `openViewer` not wired → text-fallback summary.
 */

import { execa } from 'execa';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { CommandContext, SlashCommand } from '@/types/global';
import type { DiffEntry } from '@/commands/cmd-diff';
import type { AgentHandle } from '@/agents/types';

/**
 * Narrow contract the command needs from the orchestrator. Keeps the
 * test surface tiny — the harness can stub a single `get()` method
 * instead of constructing a real AgentOrchestrator.
 */
export interface AgentsDiffOrchestrator {
  get(
    parentSessionId: string,
    agentId: string,
  ): AgentHandle | undefined;
}

export interface AgentsDiffDeps {
  /**
   * Lazy orchestrator getter so the command captures the lifecycle-
   * managed instance from `app.tsx`'s ref (which may construct on first
   * touch). Returning `null` means "no orchestrator in this host" —
   * the command surfaces a friendly note instead of crashing.
   */
  readonly orchestrator: () => AgentsDiffOrchestrator | null;
  /**
   * Active lead/parent session id resolver. The orchestrator keys its
   * team bookkeeping by the lead session id — we never look at the
   * agent's own child session id.
   */
  readonly getParentSessionId: () => string | null;
  /**
   * Called when the command has assembled a non-empty `DiffEntry[]`.
   * The composition root wires this to the same `openDiffViewer` used
   * by `/diff`. Optional — when undefined the command falls back to a
   * text summary so headless tests can assert on chat output.
   */
  readonly openViewer?: (entries: readonly DiffEntry[]) => void;
}

const NAME = 'agents';
const DESCRIPTION =
  'Multi-agent helpers. Subcommands: diff <agent-id> — open the DiffViewer on a worker worktree.';
const USAGE = '/agents diff <agent-id>';

export function createAgentsDiffCommand(deps: AgentsDiffDeps): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        ctx.print(`Usage: ${USAGE}`);
        return;
      }
      const [verb, rest] = splitFirst(trimmed);
      if (verb !== 'diff') {
        ctx.print(`Unknown subcommand "${verb}". Usage: ${USAGE}`);
        return;
      }
      const agentId = rest.trim();
      if (agentId.length === 0) {
        ctx.print(`Missing <agent-id>. Usage: ${USAGE}`);
        return;
      }

      const orch = deps.orchestrator();
      if (orch === null) {
        ctx.print('/agents diff: orchestrator is not available in this session.');
        return;
      }

      const parentSessionId = deps.getParentSessionId();
      if (parentSessionId === null) {
        ctx.print('/agents diff: no active session — start one first.');
        return;
      }

      const handle = orch.get(parentSessionId, agentId);
      if (handle === undefined) {
        ctx.print(`/agents diff: unknown agent "${agentId}".`);
        return;
      }
      const wtPath = handle.worktreePath;
      if (wtPath === null) {
        ctx.print(
          `/agents diff: agent ${agentId} ran in shared isolation — no worktree to diff.`,
        );
        return;
      }
      try {
        const stat = await fs.stat(wtPath);
        if (!stat.isDirectory()) {
          ctx.print(
            `/agents diff: agent ${agentId} worktree path is not a directory (was it cleaned up?).`,
          );
          return;
        }
      } catch {
        ctx.print(
          `/agents diff: agent ${agentId} worktree no longer exists on disk.`,
        );
        return;
      }

      let entries: readonly DiffEntry[];
      try {
        entries = await collectWorktreeEntries(wtPath);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/agents diff failed: ${msg}`);
        return;
      }

      if (entries.length === 0) {
        ctx.print(`No changes in agent ${agentId}'s worktree.`);
        return;
      }

      if (deps.openViewer !== undefined) {
        deps.openViewer(entries);
        return;
      }

      // Headless fallback — same shape as cmd-diff's fallback.
      ctx.print(
        `Worktree diff for agent ${agentId} (${entries.length} file${entries.length === 1 ? '' : 's'}):`,
      );
      for (const e of entries) {
        ctx.print(`  [${e.mode}] ${e.filePath}`);
      }
    },
  };
}

// ---------- helpers ----------

function splitFirst(s: string): [string, string] {
  const idx = s.indexOf(' ');
  if (idx === -1) return [s.toLowerCase(), ''];
  return [s.slice(0, idx).toLowerCase(), s.slice(idx + 1).trim()];
}

/**
 * Enumerate `git diff HEAD --name-status -z` inside `worktreePath`,
 * then read each side (HEAD blob vs on-disk content) and build a
 * `DiffEntry[]` for `<DiffViewer>` to render. Mirrors the strategy in
 * `cmd-diff.ts` but stays self-contained — we never want to reach into
 * that file's private helpers (separate ownership in the wave plan).
 */
async function collectWorktreeEntries(
  worktreePath: string,
): Promise<readonly DiffEntry[]> {
  const listing = await runGit(
    ['diff', '--name-status', '-z', 'HEAD'],
    worktreePath,
  );
  const records = parseNameStatus(listing);
  const entries: DiffEntry[] = [];
  for (const rec of records) {
    if (rec.status.startsWith('A')) {
      const after = await readWorkingSide(worktreePath, rec.path);
      entries.push({
        filePath: rec.path,
        before: '',
        after,
        mode: 'created',
      });
      continue;
    }
    if (rec.status.startsWith('D')) {
      const before = await readHeadSide(worktreePath, rec.path);
      entries.push({
        filePath: rec.path,
        before,
        after: '',
        mode: 'deleted',
      });
      continue;
    }
    if (rec.status.startsWith('R') && rec.renameTo !== undefined) {
      const before = await readHeadSide(worktreePath, rec.path);
      const after = await readWorkingSide(worktreePath, rec.renameTo);
      entries.push({
        filePath: `${rec.path} → ${rec.renameTo}`,
        before,
        after,
        mode: 'modified',
      });
      continue;
    }
    const before = await readHeadSide(worktreePath, rec.path);
    const after = await readWorkingSide(worktreePath, rec.path);
    entries.push({
      filePath: rec.path,
      before,
      after,
      mode: 'modified',
    });
  }
  return entries;
}

interface NameStatusRecord {
  readonly status: string;
  readonly path: string;
  readonly renameTo?: string;
}

function parseNameStatus(raw: string): readonly NameStatusRecord[] {
  const out: NameStatusRecord[] = [];
  const tokens = raw.split('\0').filter((s) => s.length > 0);
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] ?? '';
    const tabIdx = tok.indexOf('\t');
    let status: string;
    let p: string;
    if (tabIdx !== -1) {
      status = tok.slice(0, tabIdx);
      p = tok.slice(tabIdx + 1);
    } else {
      status = tok;
      p = tokens[i + 1] ?? '';
      if (p.length === 0) continue;
      i += 1;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const next = tokens[i + 1] ?? '';
      out.push({ status, path: p, renameTo: next });
      i += 1;
      continue;
    }
    out.push({ status, path: p });
  }
  return out;
}

async function readHeadSide(
  worktreePath: string,
  filePath: string,
): Promise<string> {
  try {
    return await runGit(['show', `HEAD:${filePath}`], worktreePath);
  } catch {
    return '';
  }
}

async function readWorkingSide(
  worktreePath: string,
  filePath: string,
): Promise<string> {
  try {
    return await fs.readFile(path.join(worktreePath, filePath), 'utf8');
  } catch {
    return '';
  }
}

async function runGit(argv: readonly string[], cwd: string): Promise<string> {
  let result;
  try {
    result = await execa('git', [...argv], { cwd, reject: false });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git ${argv[0] ?? ''} failed to spawn: ${msg}`);
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const failed =
    result.failed === true ||
    (typeof result.exitCode === 'number' && result.exitCode !== 0);
  if (failed) {
    const stderrLower = stderr.toLowerCase();
    if (stderrLower.includes('not a git repository')) {
      throw new Error('Worktree is not a git repository (or already cleaned up).');
    }
    const reason = stderr.trim().length > 0 ? stderr.trim() : 'unknown error';
    throw new Error(reason);
  }
  return stdout;
}
