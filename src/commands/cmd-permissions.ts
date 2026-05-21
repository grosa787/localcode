/**
 * /permissions — manage the set of tools that are auto-approved (skip the
 * per-call approval prompt).
 *
 * The underlying knob lives at `config.permissions.autoApprove` in
 * `~/.localcode/config.toml`. We surface a small subcommand suite:
 *
 *   /permissions                    — print the current lists.
 *   /permissions add <toolName>     — grant auto-approval for a tool.
 *   /permissions remove <toolName>  — revoke auto-approval for a tool.
 *   /permissions clear              — reset the list to empty.
 *
 * Read-only tools (`read_file`, `list_dir`, `glob_search`) are ALWAYS
 * auto-approved by the ToolExecutor (see its `APPROVAL_REQUIRED_TOOLS`
 * set). `edit_file` always shows a diff even when auto-approved, but for
 * the Round-2 scope only `write_file` and `run_command` sit behind the
 * real user-grant flow — so those are the only names accepted by
 * `/permissions add`.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type { ConfigManager } from '@/config/config-manager';

export interface PermissionsDeps {
  configManager: ConfigManager;
}

const PERMISSIONS_NAME = 'permissions';
const PERMISSIONS_DESCRIPTION =
  'List, grant, or revoke auto-approval for tools';
const PERMISSIONS_USAGE =
  '/permissions [add|remove <toolName> | clear]';

/**
 * Tools the user may explicitly grant. Read-only tools are omitted
 * because they are auto-approved by default and don't need a grant.
 */
const GRANTABLE_TOOLS = ['write_file', 'run_command'] as const;
type GrantableTool = (typeof GRANTABLE_TOOLS)[number];

/**
 * Tools that the ToolExecutor auto-approves unconditionally — shown in
 * the listing so users know why they're not prompted for them.
 */
const ALWAYS_AUTO_APPROVED = [
  { name: 'read_file', note: 'always auto-approved' },
  { name: 'list_dir', note: 'always auto-approved' },
  { name: 'glob_search', note: 'always auto-approved' },
  { name: 'edit_file', note: 'always auto-approved, shows diff' },
] as const;

function isGrantable(value: string): value is GrantableTool {
  return (GRANTABLE_TOOLS as readonly string[]).includes(value);
}

export function createPermissionsCommand(
  deps: PermissionsDeps,
): SlashCommand {
  const { configManager } = deps;

  return {
    name: PERMISSIONS_NAME,
    description: PERMISSIONS_DESCRIPTION,
    usage: PERMISSIONS_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = parts[0]?.toLowerCase() ?? '';

      // FIX #32 — no-arg (and `list`/`ls` aliases) open the local overlay
      // when the host supplies an `showOverlay` dispatcher. Callers that
      // don't (older tests, non-interactive contexts) fall through to the
      // existing text listing so behaviour stays backward-compatible.
      if (sub === '' || sub === 'list' || sub === 'ls') {
        if (ctx.showOverlay !== undefined) {
          ctx.showOverlay('permissions');
          return;
        }
        printPermissions(ctx);
        return;
      }

      if (sub === 'add') {
        const tool = parts[1];
        if (!tool) {
          ctx.print('Usage: /permissions add <toolName>');
          return;
        }
        await addPermission(ctx, configManager, tool);
        return;
      }

      if (sub === 'remove' || sub === 'rm' || sub === 'revoke') {
        const tool = parts[1];
        if (!tool) {
          ctx.print('Usage: /permissions remove <toolName>');
          return;
        }
        await removePermission(ctx, configManager, tool);
        return;
      }

      if (sub === 'clear' || sub === 'reset') {
        await clearPermissions(ctx, configManager);
        return;
      }

      ctx.print(`Unknown subcommand: ${sub}`);
      ctx.print(`Usage: ${PERMISSIONS_USAGE}`);
    },
  };
}

function printPermissions(ctx: CommandContext): void {
  const granted: readonly string[] = ctx.config.permissions.autoApprove;

  ctx.print('Auto-approved tools:');
  for (const { name, note } of ALWAYS_AUTO_APPROVED) {
    ctx.print(`  - ${name} (${note})`);
  }

  ctx.print('User-granted:');
  if (granted.length === 0) {
    ctx.print('  (none)');
  } else {
    for (const name of granted) {
      ctx.print(`  - ${name}`);
    }
  }

  const remaining = GRANTABLE_TOOLS.filter(
    (t) => !granted.includes(t),
  );
  ctx.print('(To grant: /permissions add <tool>)');
  ctx.print('(To revoke: /permissions remove <tool>)');
  if (remaining.length === 0) {
    ctx.print('(All grantable tools are already granted.)');
  } else {
    ctx.print(`(Available to grant: ${remaining.join(', ')})`);
  }
}

async function addPermission(
  ctx: CommandContext,
  configManager: ConfigManager,
  rawTool: string,
): Promise<void> {
  const tool = rawTool.trim();
  if (!isGrantable(tool)) {
    ctx.print(
      `Cannot grant '${tool}'. Grantable tools: ${GRANTABLE_TOOLS.join(', ')}.`,
    );
    return;
  }

  const current = ctx.config.permissions.autoApprove;
  if (current.includes(tool)) {
    ctx.print(`'${tool}' is already granted.`);
    return;
  }

  const next = [...current, tool];
  try {
    configManager.update({ permissions: { autoApprove: next } });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to update permissions: ${msg}`);
    return;
  }

  ctx.print(
    `Granted auto-approval for '${tool}'. Restart the session or run /permissions to verify.`,
  );
}

async function removePermission(
  ctx: CommandContext,
  configManager: ConfigManager,
  rawTool: string,
): Promise<void> {
  const tool = rawTool.trim();
  const current = ctx.config.permissions.autoApprove;
  // Widen the narrow literal array to `readonly string[]` for containment
  // checks — the user's typed argument hasn't been validated against the
  // union yet, so we don't want TS to complain about the comparison.
  const currentAsStrings: readonly string[] = current;
  if (!currentAsStrings.includes(tool)) {
    ctx.print(`'${tool}' is not currently granted — nothing to revoke.`);
    return;
  }

  const next = current.filter((t) => t !== tool);
  try {
    configManager.update({ permissions: { autoApprove: next } });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to update permissions: ${msg}`);
    return;
  }

  ctx.print(`Revoked auto-approval for '${tool}'.`);
}

async function clearPermissions(
  ctx: CommandContext,
  configManager: ConfigManager,
): Promise<void> {
  if (ctx.config.permissions.autoApprove.length === 0) {
    ctx.print('No granted permissions to clear.');
    return;
  }
  try {
    configManager.update({ permissions: { autoApprove: [] } });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to clear permissions: ${msg}`);
    return;
  }
  ctx.print('Cleared all user-granted permissions.');
}
