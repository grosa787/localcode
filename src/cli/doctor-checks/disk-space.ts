/**
 * Check #8 — `~/.localcode/` write-test + free disk space.
 *
 * - Writes a `.doctor-write-test` file and removes it. If write fails,
 *   the whole check is `fail`.
 * - Best-effort `statfs`-style free-bytes lookup. When < 100 MB free,
 *   warn so users notice before tool calls / session writes fail.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { DoctorCheckEnv, DoctorCheckResult } from './types';

const MIN_FREE_BYTES = 100 * 1024 * 1024;

/**
 * Default free-bytes lookup. Uses `statfs` when available (node >=18.15
 * exposes it under `node:fs/promises`). Falls back to `null` ("unknown")
 * so the check can downgrade to a warning rather than a failure.
 */
async function defaultDiskFreeBytes(p: string): Promise<number | null> {
  try {
    const fs = await import('node:fs/promises');
    const fsRecord = fs as unknown as Record<string, unknown>;
    const statfs = fsRecord['statfs'];
    if (typeof statfs !== 'function') return null;
    const call = statfs as (
      target: string,
    ) => Promise<{ bavail: bigint | number; bsize: bigint | number }>;
    const stat = await call(p);
    const bavail =
      typeof stat.bavail === 'bigint' ? Number(stat.bavail) : Number(stat.bavail);
    const bsize =
      typeof stat.bsize === 'bigint' ? Number(stat.bsize) : Number(stat.bsize);
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize)) return null;
    return bavail * bsize;
  } catch {
    return null;
  }
}

export async function checkDiskSpace(
  env: DoctorCheckEnv = {},
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  const home = env.homedir ?? homedir;
  const dir = path.join(home(), '.localcode');
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch (cause) {
    return {
      name: 'Disk',
      status: 'fail',
      message: `Cannot create ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      durationMs: Date.now() - startedAt,
    };
  }

  // Write test.
  const probe = path.join(dir, '.doctor-write-test');
  try {
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
  } catch (cause) {
    return {
      name: 'Disk',
      status: 'fail',
      message: `Write test failed in ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      durationMs: Date.now() - startedAt,
    };
  }

  const fetchFree = env.diskFreeBytes ?? defaultDiskFreeBytes;
  const free = await fetchFree(dir);
  const durationMs = Date.now() - startedAt;
  if (free === null) {
    return {
      name: 'Disk',
      status: 'ok',
      message: `Write test passed (free space unknown on this platform).`,
      durationMs,
    };
  }
  const mb = Math.round(free / (1024 * 1024));
  if (free < MIN_FREE_BYTES) {
    return {
      name: 'Disk',
      status: 'warn',
      message: `Only ${mb} MB free in ${dir}.`,
      durationMs,
    };
  }
  return {
    name: 'Disk',
    status: 'ok',
    message: `Write test passed (${mb} MB free).`,
    durationMs,
  };
}
