/**
 * Linux `firejail` backend.
 *
 * Spawns commands via `firejail --quiet [flags] sh -c <cmd>`. Flags:
 *   - `--quiet` — suppress firejail's own banner so we capture only the
 *     child's stdout/stderr.
 *   - `--net=none` (only when `allowNetwork=false`) — disable network
 *     namespaces entirely. With network access on we deliberately do
 *     NOT pass `--net=<iface>` — the default profile keeps the host's
 *     network stack which matches how `bun install`, `git clone`, etc.
 *     expect to work.
 *   - `--read-only=/` — restrict the global filesystem to read-only.
 *   - `--read-write=<path>` — one repeat per allowWritePath (plus the
 *     `cwd`) to carve out write access.
 *   - `--private-tmp` — fresh /tmp per invocation.
 *
 * Auto-detect: the `findFirejailBinary` helper walks the standard
 * locations + `$PATH`. When firejail isn't installed the factory in
 * `index.ts` falls back to the `none` backend.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';

import type { SandboxOpts, SandboxResult, SandboxRunner } from './types';

/**
 * Standard install paths to probe before walking `$PATH`. Covers
 * Debian/Ubuntu (`/usr/bin`), Arch (`/usr/bin`), Alpine (`/usr/bin`),
 * Fedora (`/usr/bin`), and Homebrew on Linux (`/home/linuxbrew/.../bin`).
 */
const FIREJAIL_PROBE_PATHS = [
  '/usr/bin/firejail',
  '/usr/local/bin/firejail',
  '/opt/firejail/bin/firejail',
];

/**
 * Resolve the firejail binary or return `null` if unavailable.
 * Synchronous on purpose — the factory consults it once on construction.
 */
export function findFirejailBinary(): string | null {
  for (const candidate of FIREJAIL_PROBE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  const fromPath = process.env['PATH'] ?? '';
  for (const dir of fromPath.split(':')) {
    if (dir.length === 0) continue;
    const candidate = `${dir}/firejail`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Build the firejail argv tail for the given options (without the
 * binary path or the trailing `sh -c <cmd>` group). Exported for unit
 * testing — production callers go through `FirejailRunner.run`.
 */
export function buildFirejailArgs(opts: SandboxOpts): string[] {
  const args: string[] = ['--quiet', '--read-only=/', '--private-tmp'];
  if (!opts.allowNetwork) {
    args.push('--net=none');
  }
  const writes = uniqueAbsolutePaths([opts.cwd, ...opts.allowWritePaths]);
  for (const p of writes) {
    args.push(`--read-write=${p}`);
  }
  return args;
}

function uniqueAbsolutePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    if (!p.startsWith('/')) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export class FirejailRunner implements SandboxRunner {
  readonly id = 'firejail' as const;

  constructor(private readonly binaryPath: string) {}

  async run(cmd: string, opts: SandboxOpts): Promise<SandboxResult> {
    const args = [...buildFirejailArgs(opts), 'sh', '-c', cmd];
    const result = await execa(this.binaryPath, args, {
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
      sandboxed: true,
      timedOut: result.timedOut === true,
    };
  }
}
