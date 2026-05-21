/**
 * Check #2 — PATH resolution.
 *
 * Runs `which localcode` (or `where localcode` on Windows) and compares
 * the resolved path to `process.argv[1]` so we can detect a stale symlink
 * pointing at an older bundle.
 */

import type { DoctorCheckEnv, DoctorCheckResult } from './types';
import { defaultSpawn } from './spawn';

export async function checkPath(
  env: DoctorCheckEnv = {},
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  const spawn = env.spawn ?? defaultSpawn;
  const platform = env.platform ?? process.platform;
  const argv1 = env.argv1 ?? process.argv[1] ?? '';

  const cmd = platform === 'win32' ? 'where' : 'which';
  const res = await spawn(cmd, ['localcode']);
  const durationMs = Date.now() - startedAt;

  if (res.notFound) {
    return {
      name: 'PATH',
      status: 'warn',
      message: `Could not run \`${cmd} localcode\`. Cannot verify symlink.`,
      durationMs,
    };
  }
  if (res.status !== 0) {
    return {
      name: 'PATH',
      status: 'warn',
      message: 'localcode not on PATH. Run `./install.sh` to register it.',
      durationMs,
      detail: res.stderr.trim() || undefined,
    };
  }
  const resolved = res.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  if (resolved.length === 0) {
    return {
      name: 'PATH',
      status: 'warn',
      message: 'localcode not on PATH.',
      durationMs,
    };
  }
  // Symlink targets often differ from `argv1` (e.g. `/usr/local/bin/localcode`
  // -> the bundled dist path). We surface both so the user can spot a stale
  // install.
  return {
    name: 'PATH',
    status: 'ok',
    message: `localcode → ${resolved}`,
    durationMs,
    detail: argv1.length > 0 && argv1 !== resolved ? `running: ${argv1}` : undefined,
  };
}
