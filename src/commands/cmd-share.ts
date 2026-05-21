/**
 * /share — manage LAN session sharing.
 *
 * Subcommands:
 *   /share start [view|edit]            Begin sharing the active session.
 *                                       Prints the 6-digit pairing code
 *                                       and the peer URL.
 *   /share stop                         Stop sharing the active session.
 *   /share peers                        List discovered LAN peers.
 *   /share accept <peer-id> <code>      Dial a peer's shared session.
 *
 * Pre-conditions: `--lan` flag at boot. When the flag is absent the
 * command itself is still registered but every subcommand surfaces a
 * friendly error explaining how to enable it.
 *
 * No LLM round-trip; every subcommand is local.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type {
  DiscoveredPeer,
  ShareCoordinator,
  ShareMode,
  StartShareResult,
} from '@/networking';

const NAME = 'share';
const DESCRIPTION =
  'Share the active session with another LocalCode on your LAN (or accept a share).';
const USAGE = '/share [start [view|edit] | stop | peers | accept <peer-id> <code>]';

export interface ShareCommandDeps {
  /**
   * Returns the live coordinator when `--lan` was enabled at boot;
   * `null` when LAN sharing is off. Resolved lazily so the command can
   * be registered before the coordinator starts up.
   */
  getCoordinator: () => ShareCoordinator | null;
}

export function createShareCommand(deps: ShareCommandDeps): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      const [subRaw, ...rest] = trimmed.length > 0 ? trimmed.split(/\s+/) : ['help'];
      const sub = (subRaw ?? 'help').toLowerCase();

      const coord = deps.getCoordinator();
      if (coord === null) {
        ctx.print(
          'LAN sharing is disabled. Start localcode with `--lan` to enable session sharing.',
        );
        return;
      }

      switch (sub) {
        case 'start':
          return runStart(coord, ctx, rest);
        case 'stop':
          return runStop(coord, ctx);
        case 'peers':
        case 'list':
          return runPeers(coord, ctx);
        case 'accept':
          return runAccept(coord, ctx, rest);
        case 'help':
        default:
          ctx.print(`Usage: ${USAGE}`);
          ctx.print('Subcommands:');
          ctx.print('  start [view|edit]            Begin sharing this session');
          ctx.print('  stop                         Stop sharing this session');
          ctx.print('  peers                        List discovered LAN peers');
          ctx.print('  accept <peer-id> <code>      Connect to a peer\'s shared session');
          return;
      }
    },
  };
}

function runStart(
  coord: ShareCoordinator,
  ctx: CommandContext,
  rest: readonly string[],
): void {
  if (ctx.sessionId === null) {
    ctx.print('No active session to share. Start a chat first.');
    return;
  }
  const modeArg = (rest[0] ?? 'view').toLowerCase();
  if (modeArg !== 'view' && modeArg !== 'edit') {
    ctx.print(`Unknown share mode: ${modeArg}. Expected: view | edit.`);
    return;
  }
  const mode: ShareMode = modeArg;
  let result: StartShareResult;
  try {
    result = coord.startSharing(ctx.sessionId, mode);
  } catch (err) {
    ctx.print(`/share start failed: ${errMsg(err)}`);
    return;
  }
  const ttlSec = Math.max(0, Math.round((result.expiresAt - Date.now()) / 1000));
  ctx.print('Session sharing started.');
  ctx.print(`  Mode:          ${mode}`);
  ctx.print(`  Pairing code:  ${result.code}`);
  ctx.print(`  Peer URL:      ${result.peerUrl}`);
  ctx.print(`  Code expires:  in ${ttlSec}s`);
  ctx.print('Tell your peer to run /share accept <your-instance-id> <code>.');
}

function runStop(coord: ShareCoordinator, ctx: CommandContext): void {
  if (ctx.sessionId === null) {
    ctx.print('No active session.');
    return;
  }
  const removed = coord.stopSharing(ctx.sessionId);
  if (removed) {
    ctx.print('Session sharing stopped.');
  } else {
    ctx.print('This session was not being shared.');
  }
}

function runPeers(coord: ShareCoordinator, ctx: CommandContext): void {
  const peers = coord.listPeers();
  if (peers.length === 0) {
    ctx.print('No LocalCode peers discovered on the LAN yet.');
    ctx.print('Make sure the other side also started with `--lan` and is on the same network.');
    return;
  }
  ctx.print(`Discovered peers (${peers.length}):`);
  for (const peer of peers) {
    ctx.print(formatPeer(peer));
  }
}

async function runAccept(
  coord: ShareCoordinator,
  ctx: CommandContext,
  rest: readonly string[],
): Promise<void> {
  const peerId = rest[0];
  const code = rest[1];
  if (!peerId || !code) {
    ctx.print('Usage: /share accept <peer-id> <code>');
    return;
  }
  try {
    const result = await coord.acceptShare(peerId, code);
    ctx.print(`Connected. Mirroring remote session: ${result.sessionId}`);
  } catch (err) {
    ctx.print(`/share accept failed: ${errMsg(err)}`);
  }
}

function formatPeer(peer: DiscoveredPeer): string {
  const caps = peer.capabilities.length > 0 ? peer.capabilities.join(',') : '-';
  return (
    `  ${peer.displayName.padEnd(28)} ` +
    `id=${peer.instanceId.slice(0, 12)} ` +
    `host=${peer.host}:${peer.port} ` +
    `caps=${caps}`
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
