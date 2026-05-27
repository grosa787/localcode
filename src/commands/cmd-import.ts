/**
 * /import — migrate sessions from other CLI tools into LocalCode.
 *
 *   /import claude-code         → scan ~/.claude/projects/ and print a
 *                                 summary of what would be imported.
 *   /import cc                  → alias for `/import claude-code`.
 *   /import claude-code all     → non-interactive: import every found
 *                                 session immediately, no overlay.
 *
 * Without `all`, the command opens the `ImportOverlay` so the user can
 * pick which projects/sessions to bring across. Falls back to a plain
 * text listing when the host doesn't wire `showOverlay` (tests,
 * non-interactive contexts).
 *
 * Everything happens locally — no network round-trip, no LLM call.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type { SessionManager } from '@/sessions/session-manager';
import {
  importAll,
  importSession,
  scanClaudeCode,
} from '@/migration/from-claude-code';

export interface ImportDeps {
  sessionManager: SessionManager;
  /** Optional override for tests — defaults to homedir(). */
  homeDir?: string;
}

const NAME = 'import';
const DESCRIPTION = 'Import sessions from another CLI (claude-code)';
const USAGE = '/import <claude-code|cc> [all]';

const SOURCE_ALIASES: Readonly<Record<string, string>> = {
  'claude-code': 'claude-code',
  cc: 'claude-code',
};

export function createImportCommand(deps: ImportDeps): SlashCommand {
  const { sessionManager, homeDir } = deps;

  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        ctx.print(
          'Usage: /import <claude-code|cc> [all]. Try `/import claude-code`.',
        );
        return;
      }
      const parts = trimmed.split(/\s+/);
      const rawSource = (parts[0] ?? '').toLowerCase();
      const source = SOURCE_ALIASES[rawSource];
      if (source === undefined) {
        ctx.print(
          `Unknown import source: '${rawSource}'. Supported: claude-code (alias: cc).`,
        );
        return;
      }
      const wantAll = (parts[1] ?? '').toLowerCase() === 'all';

      try {
        const plan = await scanClaudeCode(homeDir);
        if (plan.totalSessions === 0) {
          ctx.print(
            'No Claude Code sessions found at ~/.claude/projects/ (set $CLAUDE_HOME to override).',
          );
          return;
        }

        if (wantAll) {
          ctx.print(
            `Importing ${plan.totalSessions} Claude Code session(s) across ${plan.projects.length} project(s)…`,
          );
          let lastPct = -1;
          const result = await importAll(plan, sessionManager, (done, total) => {
            const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
            // Throttle the progress feed — chat prints aren't free.
            if (pct >= lastPct + 10 || done === total) {
              ctx.print(`  ${done}/${total} (${pct}%)`);
              lastPct = pct;
            }
          });
          let line = `✓ Imported ${result.imported} session(s)`;
          if (result.skipped > 0) {
            line += `, skipped ${result.skipped} already-imported`;
          }
          if (result.errors.length > 0) {
            line += `, ${result.errors.length} error(s)`;
          }
          ctx.print(line);
          for (const err of result.errors.slice(0, 5)) {
            ctx.print(`  ! ${err}`);
          }
          if (result.errors.length > 5) {
            ctx.print(`  …and ${result.errors.length - 5} more`);
          }
          return;
        }

        // Interactive path — try the overlay first; fall back to text.
        // The overlay-aware host accepts the same OverlayKind union as
        // `/permissions` etc. and renders ImportOverlay against the
        // plan held in chat state.
        if (ctx.showOverlay !== undefined) {
          // We intentionally call through with the unused kind 'import'
          // — the dispatcher in app.tsx narrows on the literal. When
          // the host pre-dates the import overlay it ignores unknown
          // kinds and we fall through to the text summary below.
          try {
            // The OverlayKind union doesn't list 'import' (the type
            // lives in @/types/global outside our ownership). We dodge
            // by casting through unknown — runtime dispatcher checks
            // string identity, type checking remains sound for callers
            // that don't know about the new kind.
            (ctx.showOverlay as (kind: string, data?: unknown) => void)(
              'import',
              { plan, source },
            );
            return;
          } catch {
            // Fall through to the text listing.
          }
        }
        // Plain-text listing (fallback).
        ctx.print(
          `Found ${plan.totalSessions} session(s) across ${plan.projects.length} project(s):`,
        );
        for (const proj of plan.projects) {
          ctx.print(
            `  ${proj.absolutePath}  (${proj.sessions.length} session(s))`,
          );
          for (const sess of proj.sessions.slice(0, 5)) {
            const id8 = sess.sessionId.slice(0, 8);
            ctx.print(
              `    ${id8}  ${sess.messageCount} msgs  ${sess.preview}`,
            );
          }
          if (proj.sessions.length > 5) {
            ctx.print(`    …and ${proj.sessions.length - 5} more`);
          }
        }
        ctx.print('Run `/import claude-code all` to import everything.');
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Import failed: ${msg}`);
      }
    },
  };
}

/**
 * Re-export for callers (overlay submit handler) that prefer a single
 * import surface rather than reaching across modules.
 */
export { importSession, importAll, scanClaudeCode };
