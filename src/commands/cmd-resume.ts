/**
 * /resume — list recent sessions, or restore one by ID prefix.
 *
 *   /resume                → print the last 20 sessions with summaries
 *   /resume list           → explicit alias for the no-args listing
 *   /resume <idPrefix>     → restore the matching session (first 8 chars
 *                            match, must be unambiguous)
 *
 * Round 3 (FIX #19) — each session entry in the list now prints two lines:
 *   `  <id8>  <date>  <title>  [<model>]`
 *   `    └─ <first 120 chars of summary>`
 * so the user can see at a glance what each session was about before
 * picking one to resume. The actual summary-injection into the model
 * context happens in app.tsx's loadSession (via
 * ContextManager.buildSystemPrompt({ summary: session.summary })).
 */

import type { Screen, Session, SlashCommand, CommandContext } from '@/types/global';
import type { SessionManager } from '@/sessions/session-manager';

export interface ResumeDeps {
  sessionManager: SessionManager;
  setScreen: (screen: Screen) => void;
  loadSession: (id: string) => Promise<void>;
}

const RESUME_NAME = 'resume';
const RESUME_DESCRIPTION = 'List recent sessions, or resume one by ID prefix';
const RESUME_USAGE = '/resume [list | <idPrefix>]';
const LIST_LIMIT = 20;
const ID_PREFIX_LEN = 8;
const SUMMARY_PREVIEW_MAX = 120;
const SUMMARY_PREVIEW_ELLIPSIS_AT = 117;

/**
 * Condense a multi-line summary to a single-line preview capped at
 * SUMMARY_PREVIEW_MAX chars. Returns a placeholder when null/empty so
 * the UI never shows a naked `undefined`.
 *
 * Exported implicitly through closure — kept file-private to avoid
 * accidental reuse; the formatter is the only caller.
 */
function summaryPreview(summary: string | null): string {
  if (!summary) return '(no summary yet)';
  const oneLine = summary.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return '(no summary yet)';
  return oneLine.length > SUMMARY_PREVIEW_MAX
    ? oneLine.slice(0, SUMMARY_PREVIEW_ELLIPSIS_AT) + '...'
    : oneLine;
}

export function createResumeCommand(deps: ResumeDeps): SlashCommand {
  const { sessionManager, loadSession } = deps;

  return {
    name: RESUME_NAME,
    description: RESUME_DESCRIPTION,
    usage: RESUME_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();

      // FIX #32 — no arg / `list` opens the ResumeOverlay when available;
      // falls through to the text listing when the host doesn't wire
      // `showOverlay` (legacy tests, non-interactive contexts).
      if (trimmed.length === 0 || trimmed.toLowerCase() === 'list') {
        if (ctx.showOverlay !== undefined) {
          ctx.showOverlay('resume');
          return;
        }
      }

      let sessions: Session[];
      try {
        sessions = sessionManager.listSessions(LIST_LIMIT);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to read sessions: ${msg}`);
        return;
      }

      // No arg OR explicit `list` alias → print the table.
      if (trimmed.length === 0 || trimmed.toLowerCase() === 'list') {
        if (sessions.length === 0) {
          ctx.print('No sessions yet. Start chatting to create one.');
          return;
        }
        ctx.print(`Recent sessions (${sessions.length}):`);
        for (const s of sessions) {
          const [primary, secondary] = formatSessionBlock(s);
          ctx.print(primary);
          ctx.print(secondary);
        }
        ctx.print('Use /resume <idPrefix> to load one.');
        return;
      }

      // Prefix match against the first ID_PREFIX_LEN chars.
      const needle = trimmed.toLowerCase();
      const matches = sessions.filter((s) =>
        s.id.toLowerCase().startsWith(needle),
      );

      if (matches.length === 0) {
        // Fall back to searching ALL sessions in case the recent-20 list
        // doesn't contain the match. We still want a helpful error path.
        let allSessions: Session[];
        try {
          // Pull a bigger window — 200 is arbitrary but covers most users.
          allSessions = sessionManager.listSessions(200);
        } catch {
          allSessions = sessions;
        }
        const deeper = allSessions.filter((s) =>
          s.id.toLowerCase().startsWith(needle),
        );
        if (deeper.length === 0) {
          ctx.print(`No session matching prefix '${trimmed}'.`);
          return;
        }
        if (deeper.length > 1) {
          ctx.print(
            `Prefix '${trimmed}' is ambiguous (${deeper.length} matches). Try a longer prefix.`,
          );
          return;
        }
        const target = deeper[0];
        if (!target) {
          ctx.print('Unexpected empty match set.');
          return;
        }
        await runLoad(target, ctx, loadSession);
        return;
      }

      if (matches.length > 1) {
        ctx.print(
          `Prefix '${trimmed}' is ambiguous (${matches.length} matches):`,
        );
        for (const m of matches) {
          const [primary, secondary] = formatSessionBlock(m);
          ctx.print(primary);
          ctx.print(secondary);
        }
        ctx.print('Try a longer prefix.');
        return;
      }

      const target = matches[0];
      if (!target) {
        ctx.print('Unexpected empty match set.');
        return;
      }
      await runLoad(target, ctx, loadSession);
    },
  };
}

async function runLoad(
  session: Session,
  ctx: CommandContext,
  loadSession: (id: string) => Promise<void>,
): Promise<void> {
  try {
    await loadSession(session.id);
    ctx.print(
      `✓ Resumed session ${session.id.slice(0, ID_PREFIX_LEN)} (${session.title ?? 'untitled'})`,
    );
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to resume session: ${msg}`);
  }
}

/**
 * Format a session as a two-line block.
 *   Line 1: `  <id8>  <date>  <title>  [<model>]`
 *   Line 2: `    └─ <summary preview>`
 */
function formatSessionBlock(s: Session): [string, string] {
  const idPrefix = s.id.slice(0, ID_PREFIX_LEN);
  const date = formatDate(s.updatedAt);
  const title =
    s.title !== null && s.title.length > 0 ? s.title : '(untitled)';
  const primary = `  ${idPrefix}  ${date}  ${title}  [${s.model}]`;
  const secondary = `    └─ ${summaryPreview(s.summary)}`;
  return [primary, secondary];
}

function formatDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'unknown';
  try {
    const d = new Date(epochMs);
    // YYYY-MM-DD HH:MM — stable sortable format, no locale surprises.
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hour = pad(d.getHours());
    const min = pad(d.getMinutes());
    return `${year}-${month}-${day} ${hour}:${min}`;
  } catch {
    return 'unknown';
  }
}
