/**
 * /profile — switch the active permission profile.
 *
 * Usage:
 *   /profile                      → print current profile + options
 *   /profile <name>               → set the active profile
 *
 * Recognised names match `PermissionProfileSchema` in
 * `src/config/types.ts`:
 *   - `default`            → edit + command tools prompt.
 *   - `acceptEdits`        → edit tools auto, command tools prompt.
 *   - `plan`               → edit + command tools blocked (Plan Mode).
 *   - `dontAsk`            → edit + command tools auto, no banner.
 *   - `bypassPermissions`  → edit + command tools auto + red WARNING banner.
 *
 * No `/plan` alias — that name is already owned by `cmd-plan.ts` (the
 * two-phase generation command). Users enter Plan Mode via `/profile plan`.
 *
 * On success, the executor's `useMemo` rebuilds because `app.tsx` lists
 * `config.permissions.profile` as a dep — no session restart needed.
 */

import type { ConfigManager } from '@/config/config-manager';
import type { PermissionProfile } from '@/config/types';
import type { CommandContext, SlashCommand } from '@/types/global';

export interface ProfileDeps {
  configManager: ConfigManager;
}

const PROFILE_NAME = 'profile';
const PROFILE_DESCRIPTION =
  'Switch the active permission profile (default / acceptEdits / plan / dontAsk / bypassPermissions)';
const PROFILE_USAGE = '/profile [name]';

/** Canonical ordering — used for `/profile` listing output. */
const PROFILE_NAMES: readonly PermissionProfile[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
];

const PROFILE_DESCRIPTIONS: Record<PermissionProfile, string> = {
  default: 'edit + command tools prompt for approval',
  acceptEdits: 'edit tools auto-approved; command tools still prompt',
  plan: 'Plan Mode — edit + command tools blocked; summarise plan only',
  dontAsk: 'edit + command tools auto-approved',
  bypassPermissions: 'edit + command tools auto-approved + WARNING banner',
};

function isPermissionProfile(value: string): value is PermissionProfile {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

export function createProfileCommand(deps: ProfileDeps): SlashCommand {
  const { configManager } = deps;

  return {
    name: PROFILE_NAME,
    description: PROFILE_DESCRIPTION,
    usage: PROFILE_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const arg = args.trim();
      const current: PermissionProfile = ctx.config.permissions.profile ?? 'default';

      if (arg.length === 0) {
        ctx.print(`Current permission profile: ${current}`);
        ctx.print('Available profiles:');
        for (const name of PROFILE_NAMES) {
          const marker = name === current ? '*' : ' ';
          ctx.print(`  ${marker} ${name} — ${PROFILE_DESCRIPTIONS[name]}`);
        }
        ctx.print('Switch with `/profile <name>`.');
        return;
      }

      if (!isPermissionProfile(arg)) {
        ctx.print(
          `Unknown profile: '${arg}'. Valid profiles: ${PROFILE_NAMES.join(', ')}.`,
        );
        return;
      }

      if (arg === current) {
        ctx.print(`Already on profile '${arg}'.`);
        return;
      }

      try {
        configManager.update({
          permissions: {
            // Preserve the per-tool whitelist verbatim. Profile is an
            // orthogonal layer so we don't want a switch to clobber any
            // `/permissions add` grants.
            autoApprove: ctx.config.permissions.autoApprove,
            profile: arg,
          },
        });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to switch profile: ${msg}`);
        return;
      }

      ctx.print(`Permission profile set to '${arg}'.`);
      if (arg === 'plan') {
        ctx.print(
          'Plan Mode active — every edit + command tool will return an error until you exit.',
        );
      } else if (arg === 'bypassPermissions') {
        ctx.print(
          'WARNING: every edit + command tool will run without approval. Use with care.',
        );
      } else if (arg === 'dontAsk') {
        ctx.print('All edit + command tools will now run without approval.');
      } else if (arg === 'acceptEdits') {
        ctx.print(
          'Edit tools (write_file / edit_file) will now run without approval; commands still prompt.',
        );
      }
    },
  };
}
