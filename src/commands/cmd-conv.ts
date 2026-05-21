/**
 * /conv — conversation utilities. Currently exposes one subcommand:
 *
 *   /conv diff <branch-A> <branch-B>   — compute a structural diff
 *                                         between two branches and open
 *                                         the DiffViewer overlay.
 *   /conv diff                         — list the current session's
 *                                         family so the user can pick a
 *                                         pair (or use Ctrl+B to pick
 *                                         from the branch overlay).
 *
 * The command never reaches the LLM — it operates entirely on stored
 * sessions and surfaces results either through `print()` (listing,
 * errors) or `openViewer()` (the DiffViewer overlay populated with
 * conversation-diff entries).
 *
 * Branch resolution mirrors `/branch switch <name>`: exact branch-name
 * match wins; falls back to session-id prefix (≥3 chars), then title
 * substring. Ambiguity is surfaced via `print` with the candidate list
 * so the user knows what to disambiguate.
 */

import type {
  CommandContext,
  SlashCommand,
} from '@/types/global';
import type { BranchInfo, SessionManager } from '@/sessions/session-manager';
import {
  computeConversationDiff,
  conversationDiffToViewerEntries,
  type ConversationDiffViewerEntry,
} from '@/sessions/conversation-diff';

export interface ConvDeps {
  readonly sessionManager: SessionManager;
  /** Active session id at command-execute time (getter to avoid stale snapshots). */
  readonly getActiveSessionId: () => string | null;
  /**
   * Open the DiffViewer with the supplied entries. Same callback shape
   * as `/diff`'s `openViewer` so the host can reuse a single dispatcher.
   * Optional — when undefined the command falls back to a text summary
   * via `ctx.print`.
   */
  readonly openViewer?: (entries: readonly ConversationDiffViewerEntry[]) => void;
}

const CONV_NAME = 'conv';
const CONV_DESCRIPTION =
  'Conversation utilities — compare two branches of the current session.';
const CONV_USAGE = '/conv diff [<branch-A> <branch-B>]';

const ID_PREFIX_LEN = 8;

function shortId(id: string): string {
  return id.slice(0, ID_PREFIX_LEN);
}

function labelFor(info: BranchInfo): string {
  if (info.branchName !== null && info.branchName.length > 0) {
    return info.branchName;
  }
  if (info.title !== null && info.title.length > 0) {
    return info.title;
  }
  return `(root ${shortId(info.id)})`;
}

/**
 * Resolve a user-typed branch identifier against the family. Returns
 * the matched `BranchInfo`, `null` when nothing matches, or an
 * `{ ambiguous, matches }` marker.
 */
export function resolveBranchByQuery(
  family: readonly BranchInfo[],
  query: string,
): BranchInfo | { ambiguous: true; matches: readonly BranchInfo[] } | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return null;

  const nameMatch = family.filter(
    (b) => b.branchName !== null && b.branchName.toLowerCase() === needle,
  );
  if (nameMatch.length === 1) {
    const only = nameMatch[0];
    return only ?? null;
  }
  if (nameMatch.length > 1) return { ambiguous: true, matches: nameMatch };

  if (needle.length >= 3) {
    const idMatch = family.filter((b) =>
      b.id.toLowerCase().startsWith(needle),
    );
    if (idMatch.length === 1) {
      const only = idMatch[0];
      return only ?? null;
    }
    if (idMatch.length > 1) return { ambiguous: true, matches: idMatch };
  }

  const titleMatch = family.filter(
    (b) => b.title !== null && b.title.toLowerCase().includes(needle),
  );
  if (titleMatch.length === 1) {
    const only = titleMatch[0];
    return only ?? null;
  }
  if (titleMatch.length > 1) return { ambiguous: true, matches: titleMatch };

  return null;
}

export type ParsedConvArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'diff-list' }
  | { readonly kind: 'diff-pair'; readonly a: string; readonly b: string }
  | { readonly kind: 'error'; readonly message: string };

export function parseConvArgs(rawArgs: string): ParsedConvArgs {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'error',
      message: `Usage: ${CONV_USAGE}. Try \`/conv diff\` to list branches.`,
    };
  }
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0]?.toLowerCase() ?? '';
  if (head !== 'diff') {
    return {
      kind: 'error',
      message: `Unknown subcommand '${tokens[0] ?? ''}'. Usage: ${CONV_USAGE}.`,
    };
  }
  const rest = tokens.slice(1);
  if (rest.length === 0) {
    return { kind: 'diff-list' };
  }
  if (rest.length === 1) {
    return {
      kind: 'error',
      message:
        'Usage: /conv diff <branch-A> <branch-B>. Provide two branch identifiers (name, id prefix, or title).',
    };
  }
  if (rest.length === 2) {
    const a = rest[0];
    const b = rest[1];
    if (a === undefined || b === undefined) {
      return { kind: 'error', message: `Usage: ${CONV_USAGE}` };
    }
    return { kind: 'diff-pair', a, b };
  }
  return {
    kind: 'error',
    message: `Too many arguments (got ${rest.length}, expected 0..2). Usage: ${CONV_USAGE}`,
  };
}

export function createConvCommand(deps: ConvDeps): SlashCommand {
  const { sessionManager, getActiveSessionId, openViewer } = deps;

  return {
    name: CONV_NAME,
    description: CONV_DESCRIPTION,
    usage: CONV_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const activeId = getActiveSessionId();
      if (activeId === null || activeId.length === 0) {
        ctx.print('No active session yet. Send a message first.');
        return;
      }

      const parsed = parseConvArgs(args);

      if (parsed.kind === 'help' || parsed.kind === 'error') {
        ctx.print(
          parsed.kind === 'error'
            ? parsed.message
            : `Usage: ${CONV_USAGE}`,
        );
        return;
      }

      // Pull the current session's family once — both branches in the
      // pair-form, and the listing form, draw from the same set.
      let family: BranchInfo[];
      try {
        family = sessionManager.getBranches(activeId);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to read branches: ${msg}`);
        return;
      }

      if (parsed.kind === 'diff-list') {
        if (family.length < 2) {
          ctx.print(
            'Need at least two branches in this session to compare. Try `/branch <name>` first.',
          );
          return;
        }
        ctx.print(
          `Branches (${family.length}). Pick two: /conv diff <A> <B>`,
        );
        for (const b of family) {
          const marker = b.id === activeId ? '*' : ' ';
          const archived = b.branchArchived ? ' (archived)' : '';
          ctx.print(
            `  ${marker} ${shortId(b.id)}  ${labelFor(b)}  · ${b.messageCount} msgs${archived}`,
          );
        }
        return;
      }

      // diff-pair
      const aResolved = resolveBranchByQuery(family, parsed.a);
      const bResolved = resolveBranchByQuery(family, parsed.b);

      if (aResolved === null) {
        ctx.print(`No branch matching '${parsed.a}'.`);
        return;
      }
      if (bResolved === null) {
        ctx.print(`No branch matching '${parsed.b}'.`);
        return;
      }
      if ('ambiguous' in aResolved) {
        ctx.print(
          `'${parsed.a}' is ambiguous (${aResolved.matches.length} matches):`,
        );
        for (const m of aResolved.matches) {
          ctx.print(`  ${shortId(m.id)}  ${labelFor(m)}`);
        }
        return;
      }
      if ('ambiguous' in bResolved) {
        ctx.print(
          `'${parsed.b}' is ambiguous (${bResolved.matches.length} matches):`,
        );
        for (const m of bResolved.matches) {
          ctx.print(`  ${shortId(m.id)}  ${labelFor(m)}`);
        }
        return;
      }

      if (aResolved.id === bResolved.id) {
        ctx.print('Both arguments resolve to the same branch — nothing to diff.');
        return;
      }

      const sessionA = sessionManager.getSession(aResolved.id);
      const sessionB = sessionManager.getSession(bResolved.id);
      if (sessionA === null || sessionB === null) {
        ctx.print('One of the branches could not be loaded.');
        return;
      }

      let diff;
      try {
        diff = await computeConversationDiff(sessionA, sessionB, {
          getAllMessages: (sid: string) => sessionManager.getAllMessages(sid),
        });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to compute conversation diff: ${msg}`);
        return;
      }

      const viewerEntries = conversationDiffToViewerEntries(diff);
      if (viewerEntries.length === 0) {
        ctx.print(
          `Branches '${labelFor(aResolved)}' and '${labelFor(bResolved)}' are identical (${diff.diffs.length} positions, no differences).`,
        );
        return;
      }

      if (openViewer !== undefined) {
        openViewer(viewerEntries);
        if (diff.branchPoint !== null) {
          ctx.print(
            `Diverged after message ${shortId(diff.branchPoint.messageId)} · ${viewerEntries.length} differing position(s).`,
          );
        } else {
          ctx.print(
            `No shared history · ${viewerEntries.length} differing position(s).`,
          );
        }
        return;
      }

      // Fallback summary when the viewer isn't wired.
      ctx.print(
        `Conversation diff (${viewerEntries.length} differing positions):`,
      );
      for (const e of viewerEntries) {
        ctx.print(`  [${e.mode}] ${e.filePath}`);
      }
    },
  };
}
