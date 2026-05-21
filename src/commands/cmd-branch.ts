/**
 * /branch — branching sessions ("like git branches for conversations").
 *
 * Usage:
 *   /branch                          → list branches in the current
 *                                      session's family, marking the
 *                                      active one with `*`.
 *   /branch <name>                   → fork the current session at its
 *                                      LATEST message into a new branch
 *                                      and switch to it.
 *   /branch <name> at <message-idx>  → fork at a specific message
 *                                      (1-based index into the current
 *                                      session's chronological message
 *                                      list).
 *   /branch switch <name>            → switch to an existing branch by
 *                                      name (or session-id prefix).
 *   /branch delete <name>            → soft-archive the named branch.
 *                                      Data is preserved; the branch
 *                                      hides from the breadcrumb.
 *
 * The host wires a `switchSession` callback that does the same things
 * `cmd-resume.loadSession` does — persist the outgoing summary, load
 * the new session's messages into ContextManager, REPLACE_MESSAGES on
 * the chat reducer, and update the active session id.
 */

import type { CommandContext, SlashCommand } from '@/types/global';
import type { BranchInfo, SessionManager } from '@/sessions/session-manager';

export interface BranchDeps {
  readonly sessionManager: SessionManager;
  /**
   * Active session id at the moment the command runs. Wired as a getter
   * (not a snapshot) so the wrapper always reads the CURRENT id rather
   * than the one captured at command-construction time. Returning null
   * is a valid "no session yet" state — the command then explains it.
   */
  readonly getActiveSessionId: () => string | null;
  /**
   * Switch the active session to `id`. Implemented by the host the same
   * way as `cmd-resume.loadSession` — persist outgoing summary, load
   * the target's messages, REPLACE_MESSAGES, set the session id.
   */
  readonly switchSession: (id: string) => Promise<void>;
}

const BRANCH_NAME = 'branch';
const BRANCH_DESCRIPTION =
  'Fork the current session into a new branch, switch between branches, or list them.';
const BRANCH_USAGE =
  '/branch [<name> [at <idx>] | switch <name> | delete <name>]';

const ID_PREFIX_LEN = 8;

/** Token used to mark the active branch in the listing. */
const ACTIVE_MARKER = '*';
const INACTIVE_MARKER = ' ';

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
 * Locate a branch in the family by user-supplied identifier. Matches
 * (in order) the branch name (exact, case-insensitive), the session id
 * prefix (case-insensitive, ≥3 chars), and finally the display title.
 * Returns null when no match, or an `ambiguous` marker when more than
 * one row matches.
 */
function resolveBranch(
  family: readonly BranchInfo[],
  query: string,
): BranchInfo | { ambiguous: true; matches: BranchInfo[] } | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return null;

  // Exact name match wins outright.
  const nameMatch = family.filter(
    (b) => b.branchName !== null && b.branchName.toLowerCase() === needle,
  );
  if (nameMatch.length === 1) {
    const only = nameMatch[0];
    return only ?? null;
  }
  if (nameMatch.length > 1) return { ambiguous: true, matches: nameMatch };

  // Session id prefix (need at least 3 chars to avoid false positives).
  if (needle.length >= 3) {
    const idMatch = family.filter((b) => b.id.toLowerCase().startsWith(needle));
    if (idMatch.length === 1) {
      const only = idMatch[0];
      return only ?? null;
    }
    if (idMatch.length > 1) return { ambiguous: true, matches: idMatch };
  }

  // Title fallback (case-insensitive contains).
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

/**
 * Parse the imperative arg list into a structured token list.
 *
 * Recognised shapes (lowercase head):
 *   - "" / "list"             → list
 *   - "switch <name>"          → switch
 *   - "delete <name>" / "rm"   → delete
 *   - "<name>"                 → create branch at latest
 *   - "<name> at <idx>"        → create branch at specific message index
 */
type ParsedBranchArgs =
  | { readonly kind: 'list' }
  | { readonly kind: 'switch'; readonly target: string }
  | { readonly kind: 'delete'; readonly target: string }
  | { readonly kind: 'create'; readonly name: string; readonly atIndex: number | null }
  | { readonly kind: 'error'; readonly message: string };

export function parseBranchArgs(rawArgs: string): ParsedBranchArgs {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'list') {
    return { kind: 'list' };
  }

  const parts = trimmed.split(/\s+/);
  const head = parts[0]?.toLowerCase() ?? '';

  if (head === 'switch') {
    const target = parts.slice(1).join(' ').trim();
    if (target.length === 0) {
      return { kind: 'error', message: 'Usage: /branch switch <name>' };
    }
    return { kind: 'switch', target };
  }

  if (head === 'delete' || head === 'rm') {
    const target = parts.slice(1).join(' ').trim();
    if (target.length === 0) {
      return {
        kind: 'error',
        message: `Usage: /branch ${head} <name>`,
      };
    }
    return { kind: 'delete', target };
  }

  // Create form. Look for the "at <idx>" tail.
  const atIdx = parts.findIndex((p) => p.toLowerCase() === 'at');
  if (atIdx === -1) {
    return { kind: 'create', name: trimmed, atIndex: null };
  }
  const nameTokens = parts.slice(0, atIdx);
  const tailTokens = parts.slice(atIdx + 1);
  if (nameTokens.length === 0) {
    return {
      kind: 'error',
      message: 'Usage: /branch <name> at <message-index>',
    };
  }
  if (tailTokens.length === 0) {
    return {
      kind: 'error',
      message: 'Usage: /branch <name> at <message-index>',
    };
  }
  const idxRaw = tailTokens[0];
  if (idxRaw === undefined) {
    return {
      kind: 'error',
      message: 'Usage: /branch <name> at <message-index>',
    };
  }
  const idxParsed = Number.parseInt(idxRaw, 10);
  if (!Number.isFinite(idxParsed) || idxParsed <= 0) {
    return {
      kind: 'error',
      message: `Invalid message index '${idxRaw}'. Indices are 1-based positive integers.`,
    };
  }
  return {
    kind: 'create',
    name: nameTokens.join(' '),
    atIndex: idxParsed,
  };
}

export function createBranchCommand(deps: BranchDeps): SlashCommand {
  const { sessionManager, getActiveSessionId, switchSession } = deps;

  return {
    name: BRANCH_NAME,
    description: BRANCH_DESCRIPTION,
    usage: BRANCH_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const activeId = getActiveSessionId();
      if (activeId === null || activeId.length === 0) {
        ctx.print('No active session yet. Send a message first.');
        return;
      }

      const parsed = parseBranchArgs(args);

      if (parsed.kind === 'error') {
        ctx.print(parsed.message);
        return;
      }

      if (parsed.kind === 'list') {
        let family: BranchInfo[];
        try {
          family = sessionManager.getBranches(activeId);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to read branches: ${msg}`);
          return;
        }
        if (family.length === 0) {
          ctx.print('No branches yet. Try `/branch <name>` to fork.');
          return;
        }
        ctx.print(`Branches (${family.length}):`);
        for (const b of family) {
          const marker = b.id === activeId ? ACTIVE_MARKER : INACTIVE_MARKER;
          const archived = b.branchArchived ? ' (archived)' : '';
          const root = b.parentSessionId === null ? ' [root]' : '';
          ctx.print(
            `  ${marker} ${shortId(b.id)}  ${labelFor(b)}  · ${b.messageCount} msgs${root}${archived}`,
          );
        }
        ctx.print('Press Ctrl+B to open the branch picker.');
        return;
      }

      if (parsed.kind === 'create') {
        // Resolve the optional `at <idx>` anchor against the current
        // session's chronological message list. The user-facing index
        // is 1-based; the SessionManager API takes a message id.
        let anchorMessageId: string | undefined;
        if (parsed.atIndex !== null) {
          let allMessages;
          try {
            allMessages = sessionManager.getAllMessages(activeId);
          } catch (cause) {
            const msg = cause instanceof Error ? cause.message : String(cause);
            ctx.print(`Failed to read session messages: ${msg}`);
            return;
          }
          if (parsed.atIndex > allMessages.length) {
            ctx.print(
              `Message index ${parsed.atIndex} is out of range (session has ${allMessages.length} messages).`,
            );
            return;
          }
          const anchor = allMessages[parsed.atIndex - 1];
          if (anchor === undefined) {
            ctx.print(`Could not resolve message at index ${parsed.atIndex}.`);
            return;
          }
          anchorMessageId = anchor.id;
        }

        // Refuse duplicate branch names within the same family — keeps
        // the picker / breadcrumb readable.
        try {
          const family = sessionManager.getBranches(activeId);
          const dupe = family.find(
            (b) =>
              b.branchName !== null &&
              b.branchName.toLowerCase() === parsed.name.toLowerCase() &&
              !b.branchArchived,
          );
          if (dupe !== undefined) {
            ctx.print(
              `A branch named '${parsed.name}' already exists in this family. Use \`/branch switch ${parsed.name}\` instead.`,
            );
            return;
          }
        } catch {
          // Non-fatal — keep going; createBranch itself surfaces real errors.
        }

        let created;
        try {
          created = sessionManager.createBranch(
            activeId,
            parsed.name,
            anchorMessageId,
          );
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to create branch: ${msg}`);
          return;
        }
        ctx.print(
          `✓ Created branch '${parsed.name}' (${shortId(created.id)}). Switching…`,
        );
        try {
          await switchSession(created.id);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(
            `Branch created, but failed to switch into it: ${msg}. Run \`/branch switch ${parsed.name}\` to retry.`,
          );
          return;
        }
        ctx.print(`✓ On branch '${parsed.name}'.`);
        return;
      }

      if (parsed.kind === 'switch') {
        let family: BranchInfo[];
        try {
          family = sessionManager.getBranches(activeId);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to read branches: ${msg}`);
          return;
        }
        const resolved = resolveBranch(family, parsed.target);
        if (resolved === null) {
          ctx.print(`No branch matching '${parsed.target}'.`);
          return;
        }
        if ('ambiguous' in resolved) {
          ctx.print(
            `'${parsed.target}' is ambiguous (${resolved.matches.length} matches):`,
          );
          for (const m of resolved.matches) {
            ctx.print(`  ${shortId(m.id)}  ${labelFor(m)}`);
          }
          ctx.print('Try a longer name or a session-id prefix (≥3 chars).');
          return;
        }
        if (resolved.id === activeId) {
          ctx.print(`Already on branch '${labelFor(resolved)}'.`);
          return;
        }
        try {
          await switchSession(resolved.id);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to switch branch: ${msg}`);
          return;
        }
        ctx.print(`✓ Switched to branch '${labelFor(resolved)}'.`);
        return;
      }

      if (parsed.kind === 'delete') {
        let family: BranchInfo[];
        try {
          family = sessionManager.getBranches(activeId);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to read branches: ${msg}`);
          return;
        }
        const resolved = resolveBranch(family, parsed.target);
        if (resolved === null) {
          ctx.print(`No branch matching '${parsed.target}'.`);
          return;
        }
        if ('ambiguous' in resolved) {
          ctx.print(
            `'${parsed.target}' is ambiguous (${resolved.matches.length} matches):`,
          );
          for (const m of resolved.matches) {
            ctx.print(`  ${shortId(m.id)}  ${labelFor(m)}`);
          }
          ctx.print('Try a longer name or a session-id prefix (≥3 chars).');
          return;
        }
        if (resolved.parentSessionId === null) {
          ctx.print(
            'Cannot delete the root session — only forked branches can be archived.',
          );
          return;
        }
        if (resolved.id === activeId) {
          ctx.print(
            'Switch to a different branch before deleting the current one.',
          );
          return;
        }
        try {
          sessionManager.archiveBranch(resolved.id);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to archive branch: ${msg}`);
          return;
        }
        ctx.print(
          `✓ Archived branch '${labelFor(resolved)}'. Data is preserved; use \`/resume <id>\` to recover.`,
        );
        return;
      }

      // Exhaustiveness check — no fall-through reaches here.
      const _exhaustive: never = parsed;
      void _exhaustive;
    },
  };
}
