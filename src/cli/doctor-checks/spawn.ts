/**
 * Default `spawn` adapter for doctor checks. Wraps `node:child_process`
 * in a small promise so each check (`bun-version`, `git`, `path`) shares
 * the same surface — and tests can inject a fake implementation via
 * `DoctorCheckEnv.spawn`.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { DoctorSpawnResult } from './types';

/** Hard ceiling so a stuck child can't hang `localcode doctor`. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Run `command args` and capture stdout/stderr.
 *
 * `notFound` is set to `true` when the binary doesn't exist on PATH
 * (`ENOENT`). Other spawn errors (permission denied, killed by signal)
 * are surfaced through `status = -1` + a non-empty `stderr`.
 *
 * Times out at `DEFAULT_TIMEOUT_MS` to keep `localcode doctor` responsive
 * even when an upstream binary hangs.
 */
export async function defaultSpawn(
  command: string,
  args: readonly string[],
): Promise<DoctorSpawnResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = nodeSpawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (res: DoctorSpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* swallow */
      }
      finish({ status: -1, stdout, stderr, notFound: false });
    }, DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const notFound = err.code === 'ENOENT';
      finish({
        status: -1,
        stdout,
        stderr: stderr || err.message,
        notFound,
      });
    });

    child.on('close', (code) => {
      finish({
        status: typeof code === 'number' ? code : -1,
        stdout,
        stderr,
        notFound: false,
      });
    });
  });
}
