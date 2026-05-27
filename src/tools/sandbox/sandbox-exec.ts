/**
 * macOS-native `sandbox-exec` backend.
 *
 * Generates a Scheme-syntax sandbox profile based on the requested
 * `SandboxOpts` and runs the command via `sandbox-exec -p <profile>
 * sh -c <cmd>`. Profile shape:
 *   - `(deny default)` — default-deny
 *   - `(allow process*)` — let the child fork + exec
 *   - `(allow file-read*)` — reads stay broad (so commands like `cat`
 *     and `ls` work); this is the right tradeoff: secrets exfiltration
 *     is constrained by the network-deny + write-restriction, and
 *     enumerating the disk is exactly what most legitimate dev commands
 *     need.
 *   - `(allow file-write* (subpath <cwd>) (subpath <allow1>) …)` —
 *     restrict writes to the project root and any explicit override.
 *   - When `allowNetwork=false`: no `network*` allow rule (default-deny
 *     blocks every outbound socket).
 *   - When `allowNetwork=true`: `(allow network*)`.
 *
 * NOTE: `sandbox-exec` is officially deprecated on macOS but remains
 * available on every shipping release (including 14.x / Sonoma) and is
 * the only Apple-supplied user-mode sandbox tool. Until Apple removes
 * it we ship it; the `auto` factory falls back to `none` on systems
 * where the binary is missing.
 */

import { execa } from 'execa';

import type { SandboxOpts, SandboxResult, SandboxRunner } from './types';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/**
 * Generate the Scheme profile string for the given options.
 * Exported for unit testing — production callers should go through
 * `SandboxExecRunner.run`.
 */
export function buildSandboxExecProfile(opts: SandboxOpts): string {
  const writePaths = uniqueAbsolutePaths([opts.cwd, ...opts.allowWritePaths]);
  const writeRules = writePaths
    .map((p) => `  (subpath ${quoteSchemeString(p)})`)
    .join('\n');

  // Standard temp + cache subpaths that almost every command touches —
  // npm/bun/pip caches, the system temp dir, the user's TMPDIR. Without
  // these even `ls` can fail because system frameworks try to write
  // dyld closures. Keep tight (no /Users/<user> writable here — that's
  // gated on the caller passing it in via allowWritePaths).
  const systemWriteScratch = [
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    '(subpath "/private/var/tmp")',
    '(subpath "/tmp")',
  ].join('\n  ');

  const networkRule = opts.allowNetwork
    ? '(allow network*)'
    // No allow rule — default-deny blocks everything.
    : ';; network denied';

  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow file-read*)',
    '(allow file-write*',
    `  ${systemWriteScratch}`,
    writeRules,
    ')',
    networkRule,
  ].join('\n');
}

/** Escape a path so it round-trips through Scheme string literals. */
function quoteSchemeString(input: string): string {
  // Scheme string literals: escape `\` and `"`.
  const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Deduplicate + drop empty/relative entries from a path list. */
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

export class SandboxExecRunner implements SandboxRunner {
  readonly id = 'sandbox-exec' as const;

  async run(cmd: string, opts: SandboxOpts): Promise<SandboxResult> {
    const profile = buildSandboxExecProfile(opts);
    const result = await execa(
      SANDBOX_EXEC_PATH,
      ['-p', profile, 'sh', '-c', cmd],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        reject: false,
        all: false,
        env: opts.env,
      },
    );

    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: result.exitCode ?? -1,
      sandboxed: true,
      timedOut: result.timedOut === true,
    };
  }
}
