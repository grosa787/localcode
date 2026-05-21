/**
 * `localcode doctor` — installation-health diagnostic.
 *
 * Runs the checks in `doctor-checks/` and prints a colored boxed
 * report (default) or a structured JSON document (`--json`).
 *
 * Every check is wrapped in try/catch so a failing check is downgraded
 * to a `fail` status with the error message — `doctor` itself never
 * crashes on a single bad check.
 *
 * Exit code: 0 when no checks failed (warnings still exit 0); 1 if any
 * check returned `fail`.
 */

import type { DoctorCheckEnv, DoctorCheckResult, DoctorStatus } from './doctor-checks/types';
import { checkBunVersion } from './doctor-checks/bun-version';
import { checkPath } from './doctor-checks/path';
import { checkConfig, type ConfigCheckResult } from './doctor-checks/config';
import { checkBackend } from './doctor-checks/backends';
import { checkApiKeys } from './doctor-checks/api-keys';
import { checkModels } from './doctor-checks/models';
import { checkLatestVersion } from './doctor-checks/latest-version';
import { checkDiskSpace } from './doctor-checks/disk-space';
import { checkSkillsMemory } from './doctor-checks/skills-memory';
import { checkHooks } from './doctor-checks/hooks';
import { checkMcp } from './doctor-checks/mcp';
import { checkGit } from './doctor-checks/git';

export interface DoctorCliWriters {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface DoctorCliOptions {
  /** Override the version string used by the latest-version check. */
  readonly currentVersion?: string;
  /** Inject writers (tests). */
  readonly writers?: Partial<DoctorCliWriters>;
  /** Inject env stubs for every check (tests). */
  readonly checkEnv?: DoctorCheckEnv;
  /** Force colour on / off. Defaults to TTY detection. */
  readonly color?: boolean;
}

const HELP_TEXT = `localcode doctor — diagnose installation health.

Usage:
  localcode doctor             Print a coloured report and exit.
  localcode doctor --json      Emit machine-readable JSON.
  localcode doctor --help      Show this help.
`;

interface Color {
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  cyan: (s: string) => string;
}

function makeColor(enable: boolean): Color {
  if (!enable) {
    return {
      bold: (s) => s,
      dim: (s) => s,
      green: (s) => s,
      yellow: (s) => s,
      red: (s) => s,
      cyan: (s) => s,
    };
  }
  const wrap = (code: string) => (s: string): string => `[${code}m${s}[0m`;
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
    cyan: wrap('36'),
  };
}

function shouldUseColor(opts: DoctorCliOptions): boolean {
  if (opts.color !== undefined) return opts.color;
  // Respect NO_COLOR (https://no-color.org).
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    return false;
  }
  return Boolean(process.stdout.isTTY);
}

function statusGlyph(status: DoctorStatus, color: Color): string {
  switch (status) {
    case 'ok':
      return color.green('OK ');
    case 'warn':
      return color.yellow('WARN');
    case 'fail':
      return color.red('FAIL');
  }
}

function visibleWidth(s: string): number {
  // Strip ANSI escape codes for column measurement.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '').length;
}

function padRight(s: string, w: number): string {
  const pad = Math.max(0, w - visibleWidth(s));
  return s + ' '.repeat(pad);
}

function renderTable(
  results: readonly DoctorCheckResult[],
  color: Color,
  terminalWidth: number,
): string {
  const STATUS_W = 4;
  const NAME_W = Math.max(
    8,
    ...results.map((r) => r.name.length),
  );
  // Reserve room for borders + spacing: 2 (left bar + space) + STATUS_W
  // + 3 (space + bar + space) + NAME_W + 3 (space + bar + space) + 2.
  const overhead = 2 + STATUS_W + 3 + NAME_W + 3 + 2;
  const msgW = Math.max(20, terminalWidth - overhead);

  const lines: string[] = [];
  const horizontal = `+${'-'.repeat(STATUS_W + 2)}+${'-'.repeat(NAME_W + 2)}+${'-'.repeat(msgW + 2)}+`;
  lines.push(color.dim(horizontal));
  lines.push(
    color.dim('| ') +
      color.bold(padRight('St.', STATUS_W)) +
      color.dim(' | ') +
      color.bold(padRight('Check', NAME_W)) +
      color.dim(' | ') +
      color.bold(padRight('Message', msgW)) +
      color.dim(' |'),
  );
  lines.push(color.dim(horizontal));

  for (const r of results) {
    const msg = r.message.length > msgW ? r.message.slice(0, msgW - 1) + '…' : r.message;
    lines.push(
      color.dim('| ') +
        padRight(statusGlyph(r.status, color), STATUS_W) +
        color.dim(' | ') +
        padRight(r.name, NAME_W) +
        color.dim(' | ') +
        padRight(msg, msgW) +
        color.dim(' |'),
    );
    if (r.detail !== undefined && r.detail.length > 0) {
      const detail = r.detail.length > msgW - 2 ? r.detail.slice(0, msgW - 3) + '…' : r.detail;
      lines.push(
        color.dim('| ') +
          padRight('', STATUS_W) +
          color.dim(' | ') +
          padRight('', NAME_W) +
          color.dim(' | ') +
          padRight(color.dim(`  ${detail}`), msgW) +
          color.dim(' |'),
      );
    }
  }
  lines.push(color.dim(horizontal));
  return lines.join('\n');
}

function summarise(
  results: readonly DoctorCheckResult[],
  color: Color,
): string {
  const ok = results.filter((r) => r.status === 'ok').length;
  const warn = results.filter((r) => r.status === 'warn').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const parts: string[] = [];
  parts.push(color.green(`${ok} ok`));
  if (warn > 0) parts.push(color.yellow(`${warn} warn`));
  if (fail > 0) parts.push(color.red(`${fail} fail`));
  return parts.join(' · ');
}

/**
 * Wrap a check so a thrown exception becomes a `fail` result.
 *
 * Generic so callers that produce a wider result shape (e.g.
 * `ConfigCheckResult` which carries the parsed `config` for downstream
 * checks) preserve their narrower type rather than collapsing back to
 * the base `DoctorCheckResult`.
 */
async function safeRun<T extends DoctorCheckResult>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | DoctorCheckResult> {
  const startedAt = Date.now();
  try {
    return await fn();
  } catch (cause) {
    return {
      name,
      status: 'fail',
      message: `Check crashed: ${cause instanceof Error ? cause.message : String(cause)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Run every check sequentially (cheap, deterministic, predictable
 * ordering in the rendered table). Returns the typed array of results
 * + the pass/fail boolean.
 */
export async function runAllChecks(
  opts: DoctorCliOptions = {},
): Promise<{ ok: boolean; checks: DoctorCheckResult[] }> {
  const env = opts.checkEnv ?? {};
  const cfgResult = await safeRun<ConfigCheckResult>('Config', () => checkConfig(env));
  // `cfgResult` is `ConfigCheckResult | DoctorCheckResult` — only the
  // former carries the parsed `config` for downstream checks. Narrow via
  // a structural in-check rather than `instanceof` so a synthetic crash
  // result (status === 'fail') still flows through unchanged.
  const cfg =
    'config' in cfgResult && cfgResult.status === 'ok' ? cfgResult.config : null;

  const checks: DoctorCheckResult[] = [];
  checks.push(await safeRun('Bun runtime', () => checkBunVersion(env)));
  checks.push(await safeRun('PATH', () => checkPath(env)));
  checks.push(cfgResult);
  checks.push(await safeRun('Backend', () => checkBackend(cfg, env)));
  checks.push(await safeRun('API key', () => checkApiKeys(cfg, env)));
  checks.push(await safeRun('Models', () => checkModels(cfg)));
  checks.push(
    await safeRun('Latest version', () =>
      checkLatestVersion(
        { currentVersion: opts.currentVersion ?? '0.0.0' },
        env,
      ),
    ),
  );
  checks.push(await safeRun('Disk', () => checkDiskSpace(env)));
  checks.push(await safeRun('Skills + memory', () => checkSkillsMemory(env)));
  checks.push(await safeRun('Hooks', () => checkHooks(cfg)));
  checks.push(await safeRun('MCP servers', () => checkMcp(cfg)));
  checks.push(await safeRun('Git', () => checkGit(env)));

  const ok = checks.every((r) => r.status !== 'fail');
  return { ok, checks };
}

/**
 * Entry point used by `cli.tsx` when the first positional arg is
 * `doctor`. Returns an exit code (0 on success, 1 if any check failed).
 */
export async function runDoctorCli(
  argv: readonly string[],
  opts: DoctorCliOptions = {},
): Promise<number> {
  const out = opts.writers?.out ?? ((l): void => {
    process.stdout.write(`${l}\n`);
  });
  const err = opts.writers?.err ?? ((l): void => {
    process.stderr.write(`${l}\n`);
  });

  let jsonMode = false;
  for (const tok of argv) {
    if (tok === '--help' || tok === '-h') {
      out(HELP_TEXT);
      return 0;
    }
    if (tok === '--json') {
      jsonMode = true;
      continue;
    }
    err(`doctor: unknown argument "${tok}"`);
    err('Run `localcode doctor --help` for usage.');
    return 1;
  }

  const { ok, checks } = await runAllChecks(opts);

  if (jsonMode) {
    const payload = {
      ok,
      checks: checks.map((c) => {
        const base: Record<string, unknown> = {
          name: c.name,
          status: c.status,
          message: c.message,
          duration_ms: c.durationMs,
        };
        if (c.detail !== undefined) base['detail'] = c.detail;
        return base;
      }),
    };
    out(JSON.stringify(payload, null, 2));
    return ok ? 0 : 1;
  }

  const color = makeColor(shouldUseColor(opts));
  const width = Math.max(60, Math.min(160, process.stdout.columns ?? 100));
  out(color.bold('localcode doctor'));
  out('');
  out(renderTable(checks, color, width));
  out('');
  out(summarise(checks, color));
  return ok ? 0 : 1;
}
