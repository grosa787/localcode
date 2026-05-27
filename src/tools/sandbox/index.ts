/**
 * Sandbox layer barrel — exposes the factory + every backend.
 *
 * The factory `createSandboxRunner` auto-detects an appropriate backend
 * for the host platform when `config.backend === 'auto'`:
 *   - darwin  → sandbox-exec (always available on macOS)
 *   - linux   → firejail (if present) else `none` (with warning)
 *   - win32   → `none` (Windows sandboxing TBD)
 *   - other   → `none`
 *
 * Explicit backend selection (`config.backend === 'firejail' | 'docker'
 * | ...`) is always honoured. When the requested backend is unavailable
 * the factory falls back to `none` and logs a warning so the user knows
 * sandboxing is off.
 */

import { existsSync } from 'node:fs';

import { DockerRunner, findDockerBinary } from './docker';
import { FirejailRunner, findFirejailBinary } from './firejail';
import { NoneRunner } from './none';
import { SandboxExecRunner } from './sandbox-exec';
import type {
  SandboxBackend,
  SandboxOpts,
  SandboxResult,
  SandboxRunner,
  SandboxRuntimeConfig,
} from './types';

export {
  buildDockerArgs,
  DockerRunner,
  findDockerBinary,
} from './docker';
export {
  buildFirejailArgs,
  FirejailRunner,
  findFirejailBinary,
} from './firejail';
export { _resetNoSandboxWarning, NoneRunner } from './none';
export {
  buildSandboxExecProfile,
  SandboxExecRunner,
} from './sandbox-exec';
export type {
  SandboxBackend,
  SandboxOpts,
  SandboxResult,
  SandboxRunner,
  SandboxRuntimeConfig,
} from './types';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/**
 * Override the platform detection in tests. Passing `null` restores
 * the live `process.platform` lookup. Production callers MUST NOT
 * reach for this — it exists purely for the unit tests in
 * `tests/tools/sandbox-*.test.ts`.
 */
let platformOverride: NodeJS.Platform | null = null;
export function _setSandboxPlatformOverride(
  platform: NodeJS.Platform | null,
): void {
  platformOverride = platform;
}
function getPlatform(): NodeJS.Platform {
  return platformOverride ?? process.platform;
}

let warnedFallback = new Set<string>();
/** Reset for tests — call between scenarios that assert the warning. */
export function _resetFallbackWarnings(): void {
  warnedFallback = new Set<string>();
}

function warnFallback(requested: SandboxBackend, reason: string): void {
  if (warnedFallback.has(requested)) return;
  warnedFallback.add(requested);
  // eslint-disable-next-line no-console
  console.warn(
    `[localcode] sandbox backend '${requested}' unavailable (${reason}); falling back to passthrough. Shell commands run with full host privileges.`,
  );
}

/**
 * Factory — resolves a concrete `SandboxRunner` for the supplied
 * configuration. Always returns a runner; falls back to `none` when the
 * requested backend can't be constructed.
 */
export function createSandboxRunner(
  config: SandboxRuntimeConfig,
): SandboxRunner {
  const requested = config.backend;
  const platform = getPlatform();

  if (requested === 'auto') {
    if (platform === 'darwin') {
      if (existsSync(SANDBOX_EXEC_PATH)) return new SandboxExecRunner();
      warnFallback('sandbox-exec', 'sandbox-exec binary missing');
      return new NoneRunner();
    }
    if (platform === 'linux') {
      const bin = findFirejailBinary();
      if (bin !== null) return new FirejailRunner(bin);
      warnFallback('firejail', 'firejail not installed');
      return new NoneRunner();
    }
    // win32 + everything else — no native sandbox yet.
    if (platform === 'win32') {
      warnFallback('auto', 'Windows sandboxing not yet implemented');
    } else {
      warnFallback('auto', `platform ${platform} not supported`);
    }
    return new NoneRunner();
  }

  if (requested === 'sandbox-exec') {
    if (existsSync(SANDBOX_EXEC_PATH)) return new SandboxExecRunner();
    warnFallback('sandbox-exec', 'sandbox-exec binary missing');
    return new NoneRunner();
  }

  if (requested === 'firejail') {
    const bin = findFirejailBinary();
    if (bin !== null) return new FirejailRunner(bin);
    warnFallback('firejail', 'firejail not installed');
    return new NoneRunner();
  }

  if (requested === 'docker') {
    const bin = findDockerBinary();
    if (bin !== null) {
      return new DockerRunner(bin, config.dockerImage);
    }
    warnFallback('docker', 'docker CLI not found');
    return new NoneRunner();
  }

  // requested === 'none' — explicit opt-out.
  return new NoneRunner();
}

/**
 * Build the per-call `SandboxOpts` from a runtime config + a resolved
 * working directory. The `cwd` is added implicitly to the allow-write
 * set inside each backend, so no need to repeat it here.
 */
export function buildSandboxOpts(
  config: SandboxRuntimeConfig,
  cwd: string,
): SandboxOpts {
  return {
    cwd,
    allowNetwork: config.allowNetwork,
    allowWritePaths: config.allowWritePaths,
    timeoutMs: config.timeoutMs,
  };
}
