/**
 * `none` backend — passthrough. Spawns the command directly via execa
 * without any isolation. Preserves the legacy behaviour for users who
 * explicitly opt out of sandboxing AND acts as the fallback when a
 * platform-native backend (sandbox-exec, firejail) is unavailable.
 *
 * Emits a one-line warning on stderr (process-level, NOT the result
 * stderr) the FIRST time it runs per process so users notice that
 * sandboxing is off.
 */

import { execa } from 'execa';

import type { SandboxOpts, SandboxResult, SandboxRunner } from './types';

let warnedNoSandbox = false;

/** Reset for tests — call between scenarios that assert the warning. */
export function _resetNoSandboxWarning(): void {
  warnedNoSandbox = false;
}

export class NoneRunner implements SandboxRunner {
  readonly id = 'none' as const;

  async run(cmd: string, opts: SandboxOpts): Promise<SandboxResult> {
    if (!warnedNoSandbox) {
      warnedNoSandbox = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[localcode] WARNING: run_command sandboxing is OFF — shell commands run with full host privileges.',
      );
    }

    const result = await execa('sh', ['-c', cmd], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      reject: false,
      all: false,
      env: opts.env,
    });

    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: result.exitCode ?? -1,
      sandboxed: false,
      timedOut: result.timedOut === true,
    };
  }
}
