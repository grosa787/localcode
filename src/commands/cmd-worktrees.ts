/**
 * /worktrees — inspect and prune sub-agent git worktrees.
 *
 *   /worktrees             list active + orphan-candidate worktrees
 *   /worktrees gc          show what would be removed, then ask the
 *                          user to confirm with `/worktrees gc force`
 *   /worktrees gc force    actually run the GC pass
 *
 * The active set is sourced from `WorktreeGC.register` calls the
 * orchestrator makes at spawn time. Anything sitting under
 * `<projectRoot>/.localcode/worktrees/` that isn't in that set (and is
 * older than the orphan-age threshold) is reported as an orphan
 * candidate.
 */

import type { CommandContext, SlashCommand } from '@/types/global';
import type { WorktreeGC, WorktreeSummary } from '@/agents/worktree-gc';

export interface WorktreesDeps {
  /**
   * The process-wide WorktreeGC instance. The composition root pulls it
   * off `AgentOrchestrator.getWorktreeGC()`. Optional null lets older
   * wiring (or tests without the orchestrator) register the command
   * without a backing GC — it prints an explanatory message instead.
   */
  gc: WorktreeGC | null;
  /**
   * Project root resolver — the command derives the worktrees dir from
   * this. Reading from `ctx.projectRoot` is fine for the TUI but the
   * web path's CommandContext might point at a different root; the
   * dependency makes the override explicit.
   */
  getProjectRoot: () => string;
}

const NAME = 'worktrees';
const DESCRIPTION = 'List sub-agent git worktrees and prune orphans.';
const USAGE = '/worktrees [gc [force]]';

export function createWorktreesCommand(deps: WorktreesDeps): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const gc = deps.gc;
      if (gc === null) {
        ctx.print('Worktree GC is not enabled in this session.');
        return;
      }
      const projectRoot = deps.getProjectRoot();
      const trimmed = args.trim();

      if (trimmed.length === 0) {
        await printList(gc, projectRoot, ctx);
        return;
      }

      const [verb, modifier] = splitFirst(trimmed);
      if (verb !== 'gc') {
        ctx.print(`Unknown subcommand: ${verb}. Usage: ${USAGE}`);
        return;
      }

      if (modifier === 'force') {
        const result = await gc.gcOrphans(projectRoot);
        if (result.removed.length === 0 && result.errors.length === 0) {
          ctx.print('No orphan worktrees to remove.');
          return;
        }
        if (result.removed.length > 0) {
          ctx.print(`Removed ${result.removed.length} orphan worktree(s):`);
          for (const p of result.removed) ctx.print(`  ${p}`);
        }
        if (result.errors.length > 0) {
          ctx.print(`Encountered ${result.errors.length} error(s):`);
          for (const e of result.errors) ctx.print(`  ${e}`);
        }
        return;
      }

      // Dry-run preview.
      const summaries = await gc.listAll(projectRoot);
      const candidates = summaries.filter((s) => !s.active);
      if (candidates.length === 0) {
        ctx.print('No orphan worktree candidates found.');
        return;
      }
      ctx.print(`Would remove ${candidates.length} worktree(s):`);
      for (const s of candidates) {
        const tag = s.corrupt ? ' (corrupt — not in git worktree list)' : '';
        ctx.print(`  ${s.path}${tag}`);
      }
      ctx.print('Run `/worktrees gc force` to actually remove them.');
    },
  };
}

async function printList(
  gc: WorktreeGC,
  projectRoot: string,
  ctx: CommandContext,
): Promise<void> {
  const summaries = await gc.listAll(projectRoot);
  if (summaries.length === 0) {
    ctx.print('No sub-agent worktrees on disk.');
    return;
  }
  const active = summaries.filter((s) => s.active);
  const orphans = summaries.filter((s) => !s.active);

  ctx.print(`Sub-agent worktrees (${summaries.length}):`);
  if (active.length > 0) {
    ctx.print(`  active (${active.length}):`);
    for (const s of active) ctx.print(`    ${fmt(s)}`);
  }
  if (orphans.length > 0) {
    ctx.print(`  orphan candidates (${orphans.length}):`);
    for (const s of orphans) ctx.print(`    ${fmt(s)}`);
    ctx.print('Run `/worktrees gc` to preview removals.');
  }
}

function fmt(s: WorktreeSummary): string {
  const tags: string[] = [];
  if (s.corrupt) tags.push('corrupt');
  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  return `${s.path}${tagStr}`;
}

function splitFirst(s: string): [string, string] {
  const idx = s.indexOf(' ');
  if (idx === -1) return [s.toLowerCase(), ''];
  return [s.slice(0, idx).toLowerCase(), s.slice(idx + 1).trim()];
}
