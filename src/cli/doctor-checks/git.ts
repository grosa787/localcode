/**
 * Check #12 — `git --version`.
 *
 * Required by the sub-agent orchestrator (worktree-based isolation).
 * Without git the orchestrator falls back to `shared` isolation which
 * exposes worker writes to the lead session — surface this as a warn.
 */

import type { DoctorCheckEnv, DoctorCheckResult } from './types';
import { defaultSpawn } from './spawn';

export async function checkGit(
  env: DoctorCheckEnv = {},
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  const spawn = env.spawn ?? defaultSpawn;
  const res = await spawn('git', ['--version']);
  const durationMs = Date.now() - startedAt;

  if (res.notFound) {
    return {
      name: 'Git',
      status: 'warn',
      message: 'git not found on PATH. Sub-agent worktrees will be unavailable.',
      durationMs,
    };
  }
  if (res.status !== 0) {
    return {
      name: 'Git',
      status: 'warn',
      message: `git --version exited ${res.status}.`,
      durationMs,
      detail: res.stderr.trim() || res.stdout.trim(),
    };
  }
  const line = res.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  return {
    name: 'Git',
    status: 'ok',
    message: line.length > 0 ? line : 'git installed',
    durationMs,
  };
}
