/**
 * Check #1 — Bun runtime version.
 *
 * Spawns `bun --version`. Fails when Bun is absent (LocalCode is a Bun
 * project; it cannot run elsewhere). Warns when the installed version
 * is older than the supported minimum (1.1) since some adapter code
 * relies on `bun:sqlite` features only stabilised in newer point
 * releases.
 */

import type { DoctorCheckEnv, DoctorCheckResult } from './types';
import { defaultSpawn } from './spawn';

const MIN_MAJOR = 1;
const MIN_MINOR = 1;

/**
 * Parse a `M.m.p` (or `M.m`) string into a tuple. Returns `null` on a
 * malformed input — caller treats that as a warning.
 */
export function parseSemver(
  raw: string,
): readonly [number, number, number] | null {
  const trimmed = raw.trim().replace(/^v/, '');
  // Accept "1.1.40", "1.1", "1.1.40+abc"; ignore everything after the
  // first whitespace / build-meta separator.
  const head = trimmed.split(/[\s+\-]/, 1)[0] ?? '';
  const parts = head.split('.');
  if (parts.length < 2 || parts.length > 3) return null;
  const major = Number.parseInt(parts[0] ?? '', 10);
  const minor = Number.parseInt(parts[1] ?? '', 10);
  const patch = parts.length === 3 ? Number.parseInt(parts[2] ?? '', 10) : 0;
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return [major, minor, patch];
}

/** Compare two semver tuples. Returns -1 / 0 / +1 (a < b / a == b / a > b). */
export function compareTuple(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): -1 | 0 | 1 {
  for (let i = 0; i < 3; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export async function checkBunVersion(
  env: DoctorCheckEnv = {},
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  const spawn = env.spawn ?? defaultSpawn;
  const res = await spawn('bun', ['--version']);
  const durationMs = Date.now() - startedAt;

  if (res.notFound) {
    return {
      name: 'Bun runtime',
      status: 'fail',
      message: 'bun not found on PATH. Install from https://bun.sh.',
      durationMs,
    };
  }
  if (res.status !== 0) {
    return {
      name: 'Bun runtime',
      status: 'fail',
      message: `bun --version exited ${res.status}.`,
      durationMs,
      detail: res.stderr.trim() || res.stdout.trim(),
    };
  }
  const raw = res.stdout.trim();
  const parsed = parseSemver(raw);
  if (parsed === null) {
    return {
      name: 'Bun runtime',
      status: 'warn',
      message: `Unrecognised bun version: "${raw}".`,
      durationMs,
    };
  }
  const cmp = compareTuple(parsed, [MIN_MAJOR, MIN_MINOR, 0]);
  if (cmp < 0) {
    return {
      name: 'Bun runtime',
      status: 'warn',
      message: `bun ${raw} is older than the supported ${MIN_MAJOR}.${MIN_MINOR}+. Run \`bun upgrade\`.`,
      durationMs,
    };
  }
  return {
    name: 'Bun runtime',
    status: 'ok',
    message: `bun ${raw}`,
    durationMs,
  };
}
