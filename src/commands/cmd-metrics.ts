/**
 * /metrics — opt-in local-only metrics dashboard.
 *
 * Two surfaces:
 *   - `/metrics`           — opens the {@link MetricsOverlay} via
 *                            `ctx.showOverlay('metrics')` when the host
 *                            wires overlay dispatch; otherwise prints a
 *                            one-line text snapshot via `ctx.print`.
 *   - `/metrics export`    — writes the latest snapshot as JSON to
 *                            `~/.localcode/metrics-{yyyy-mm-dd}.json`.
 *                            Pure power-user feature; respects the
 *                            opt-in gate (a disabled snapshot writes a
 *                            file with `disabled: true` so the user can
 *                            see the gate is closed).
 *
 * **Privacy invariant.** This command NEVER reaches out to the network
 * and NEVER writes outside `~/.localcode/`. The aggregator already
 * short-circuits when telemetry is disabled.
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { SlashCommand, CommandContext } from '@/types/global';

import { snapshot } from '@/telemetry/aggregator';
import type { MetricsSnapshot } from '@/telemetry/types';

/**
 * Synthetic OverlayKind value reserved for the metrics dashboard.
 *
 * The core `OverlayKind` union in `@/types/global` does not yet enumerate
 * `'metrics'` (the type lives outside this command's file ownership).
 * Hosts that wire up the metrics overlay will extend the union AND
 * teach their `showOverlay` dispatch to handle this literal. Until
 * that happens, the command always falls through to the text-snapshot
 * path so it remains useful immediately after wiring without requiring
 * any cross-file coordination.
 */
const METRICS_OVERLAY_KIND = 'metrics';

export interface MetricsCommandDeps {
  /**
   * Override the snapshot factory — tests inject a fixture so we don't
   * have to spin up SQLite + journal directories for every assertion.
   * When omitted, the command calls the production aggregator via the
   * default {@link snapshot} export.
   */
  readonly snapshotFn?: (opts: {
    enabled: boolean;
    windowDays: number;
  }) => Promise<MetricsSnapshot>;
  /**
   * Override the JSON-export directory. Defaults to `~/.localcode/`.
   * Tests point this at a tmp dir.
   */
  readonly exportDir?: string;
  /**
   * Override "now" for the filename stamp. Defaults to `Date.now()`.
   * Tests inject a fixed value so the path is deterministic.
   */
  readonly nowMs?: () => number;
}

const METRICS_NAME = 'metrics';
const METRICS_DESCRIPTION =
  'Show local-only metrics dashboard (tool success, cache, cost). Opt-in via [telemetry] in config.toml.';
const METRICS_USAGE = '/metrics [export]';

/**
 * Construct the `/metrics` slash command.
 *
 * Deps are entirely optional — the command works against the
 * production aggregator with no wiring at all, which keeps the
 * `BuiltinCommandFactories` registration path simple in `app.tsx`.
 */
export function createMetricsCommand(
  deps: MetricsCommandDeps = {},
): SlashCommand {
  const snapshotFn = deps.snapshotFn ?? defaultSnapshotFn;
  const exportDir = deps.exportDir ?? path.join(homedir(), '.localcode');
  const nowMs = deps.nowMs ?? (() => Date.now());

  return {
    name: METRICS_NAME,
    description: METRICS_DESCRIPTION,
    usage: METRICS_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim().toLowerCase();
      const telemetry = readTelemetryConfig(ctx.config);
      const telemetryEnabled = telemetry.enabled;
      const retentionDays = telemetry.retentionDays;

      if (trimmed === 'export') {
        await handleExport({
          ctx,
          telemetryEnabled,
          retentionDays,
          snapshotFn,
          exportDir,
          nowMs,
        });
        return;
      }

      // Default: open the overlay when the host wires `showOverlay`,
      // otherwise print a short text summary so the command remains
      // useful in non-interactive contexts (tests, scripted runs).
      //
      // The OverlayKind union (declared in `@/types/global`, outside
      // this file's ownership) does not yet enumerate `'metrics'`. We
      // route through a parameter type the dispatcher exposes — the
      // host's `showOverlay` will simply ignore the kind it does not
      // recognise and we'll fall back to the text snapshot below. Once
      // the host extends the union, the cast becomes a no-op.
      const overlayDispatch = ctx.showOverlay as
        | ((kind: string, data?: { filter?: string }) => void)
        | undefined;
      if (overlayDispatch !== undefined) {
        overlayDispatch(METRICS_OVERLAY_KIND);
        return;
      }

      try {
        const snap = await snapshotFn({
          enabled: telemetryEnabled,
          windowDays: retentionDays,
        });
        ctx.print(renderTextSummary(snap));
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/metrics failed: ${msg}`);
      }
    },
  };
}

// ---------- Subcommand: export ----------

async function handleExport(args: {
  readonly ctx: CommandContext;
  readonly telemetryEnabled: boolean;
  readonly retentionDays: number;
  readonly snapshotFn: (opts: {
    enabled: boolean;
    windowDays: number;
  }) => Promise<MetricsSnapshot>;
  readonly exportDir: string;
  readonly nowMs: () => number;
}): Promise<void> {
  let snap: MetricsSnapshot;
  try {
    snap = await args.snapshotFn({
      enabled: args.telemetryEnabled,
      windowDays: args.retentionDays,
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    args.ctx.print(`/metrics export failed: ${msg}`);
    return;
  }

  const stamp = formatDateStamp(args.nowMs());
  const filename = `metrics-${stamp}.json`;
  const target = path.join(args.exportDir, filename);

  try {
    fs.mkdirSync(args.exportDir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(snap, null, 2), 'utf8');
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    args.ctx.print(`/metrics export failed: ${msg}`);
    return;
  }

  args.ctx.print(`Metrics exported to ${target}`);
}

// ---------- Helpers ----------

function renderTextSummary(snap: MetricsSnapshot): string {
  if (snap.disabled) {
    return 'Telemetry is opt-in. Enable in ~/.localcode/config.toml [telemetry] enabled = true';
  }
  const topCost = snap.costByModel[0];
  const topSession = snap.topExpensiveSessions[0];
  const pieces = [
    `${snap.sessionsCounted} sessions counted`,
    `cache-hit ${Math.round(snap.cacheHitPercent)}%`,
    `avg turn ${formatDurationShort(snap.avgTurnDurationMs)}`,
  ];
  if (topCost !== undefined) {
    pieces.push(`top model ${topCost.model} ($${topCost.totalUsd.toFixed(4)})`);
  }
  if (topSession !== undefined) {
    pieces.push(
      `top session ${topSession.title} ($${topSession.costUsd.toFixed(4)})`,
    );
  }
  return `Metrics: ${pieces.join(' · ')}`;
}

function formatDateStamp(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms - min * 60_000) / 1000);
  return `${min}m${sec}s`;
}

/**
 * Default snapshot factory. Wraps the aggregator export with the option
 * shape consumed by {@link createMetricsCommand} — keeps the call site
 * narrow so the command file never has to know about journal directories.
 */
async function defaultSnapshotFn(opts: {
  enabled: boolean;
  windowDays: number;
}): Promise<MetricsSnapshot> {
  return snapshot({
    enabled: opts.enabled,
    windowDays: opts.windowDays,
  });
}

/**
 * Narrow `AppConfig.telemetry` (defined in `src/config/types.ts` but not
 * mirrored in `src/types/global.d.ts`) into a strict `{ enabled,
 * retentionDays }` pair. We can't widen the global `AppConfig` from
 * within this file's ownership, so the narrow lives here. Defaults to
 * `{ enabled: false, retentionDays: 30 }` — matches `TelemetrySchema`'s
 * own defaults.
 */
function readTelemetryConfig(config: unknown): {
  readonly enabled: boolean;
  readonly retentionDays: number;
} {
  if (config === null || typeof config !== 'object') {
    return { enabled: false, retentionDays: 30 };
  }
  const raw = (config as Record<string, unknown>)['telemetry'];
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { enabled: false, retentionDays: 30 };
  }
  const tele = raw as Record<string, unknown>;
  const enabledRaw = tele['enabled'];
  const retentionRaw = tele['retentionDays'];
  const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : false;
  const retentionDays =
    typeof retentionRaw === 'number' && Number.isFinite(retentionRaw) && retentionRaw > 0
      ? Math.floor(retentionRaw)
      : 30;
  return { enabled, retentionDays };
}

export const __test__ = {
  renderTextSummary,
  formatDateStamp,
};
