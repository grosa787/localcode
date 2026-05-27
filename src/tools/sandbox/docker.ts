/**
 * Docker backend — opt-in. Runs commands inside an ephemeral container
 * with the working directory mounted as `/workspace`.
 *
 * Spawn shape:
 *   docker run --rm -i \
 *     -w /workspace \
 *     -v <cwd>:/workspace \
 *     [-v <allowWritePath>:<allowWritePath>] (per extra path) \
 *     [--network=none] (when allowNetwork=false) \
 *     <image> \
 *     sh -c <cmd>
 *
 * Notes:
 *   - This backend requires a working Docker daemon. `findDockerBinary`
 *     probes for the CLI; the factory caller decides whether to use it.
 *   - Image defaults to `alpine:latest` — minimal and almost universally
 *     pulled. Users can override via `config.security.sandbox.dockerImage`.
 *   - The mounted workspace is bind-mounted, so writes persist on the
 *     host. This is by design — the sandbox bounds WHAT the command can
 *     touch, not whether its effects vanish.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';

import type { SandboxOpts, SandboxResult, SandboxRunner } from './types';

const DOCKER_PROBE_PATHS = [
  '/usr/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
];

const DEFAULT_DOCKER_IMAGE = 'alpine:latest';

/** Resolve the docker binary or return `null` when unavailable. */
export function findDockerBinary(): string | null {
  for (const candidate of DOCKER_PROBE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  const fromPath = process.env['PATH'] ?? '';
  for (const dir of fromPath.split(':')) {
    if (dir.length === 0) continue;
    const candidate = `${dir}/docker`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Build the docker argv tail (everything after the binary path). Stops
 * just before the `sh -c <cmd>` group. Exported for unit testing.
 */
export function buildDockerArgs(
  opts: SandboxOpts,
  image: string,
): string[] {
  const args: string[] = [
    'run',
    '--rm',
    '-i',
    '-w',
    '/workspace',
    '-v',
    `${opts.cwd}:/workspace`,
  ];
  for (const p of uniqueAbsolutePaths(opts.allowWritePaths)) {
    // Skip the cwd — it's already mounted as /workspace above. Extra
    // write paths are mounted at their host path for clarity (so an
    // absolute path the model passes in resolves the same way inside).
    if (p === opts.cwd) continue;
    args.push('-v', `${p}:${p}`);
  }
  if (!opts.allowNetwork) {
    args.push('--network=none');
  }
  args.push(image);
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

export class DockerRunner implements SandboxRunner {
  readonly id = 'docker' as const;

  constructor(
    private readonly binaryPath: string,
    private readonly image: string = DEFAULT_DOCKER_IMAGE,
  ) {}

  async run(cmd: string, opts: SandboxOpts): Promise<SandboxResult> {
    const args = [...buildDockerArgs(opts, this.image), 'sh', '-c', cmd];
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
