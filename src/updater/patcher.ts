/**
 * Binary patch (bsdiff / bspatch) helper for the auto-updater.
 *
 * Delta-patch updates fetch a small `*-from-<prev>-to-<new>.patch` asset
 * (~150 KB for our ~13 MB bundle) and reconstruct the new binary on
 * disk via `bspatch oldFile newFile patchFile`. We shell out to the
 * system `bspatch` binary so we don't pull in a 200 KB-of-deps wrapper
 * just for the cold update path. If `bspatch` is missing the caller
 * falls back to the full-binary download.
 *
 * Public contract:
 *   - `isBspatchAvailable()` — cheap PATH probe via `bspatch -h`. Cached
 *     across calls in a single process so we don't fork the binary on
 *     every update tick.
 *   - `applyPatch(oldBinary, patchFile, outNewBinary)` — produce a fresh
 *     file at `outNewBinary`. Throws `BspatchUnavailableError` when the
 *     tool isn't on PATH; throws `BspatchExecutionError` when the
 *     subprocess fails (corrupt patch, unreadable inputs, etc).
 *
 * Errors deliberately bubble out of this module — the downloader wraps
 * the call and downgrades the failure into the "fall back to full
 * download" path, which is the safe degraded behaviour for the whole
 * updater module.
 */

import { execa } from 'execa';

/**
 * Thrown when the host doesn't have `bspatch` available. Callers should
 * catch this specifically and fall back to the full-binary download
 * path; everything else (corrupt patch, unreadable old binary) should
 * surface as `BspatchExecutionError`.
 */
export class BspatchUnavailableError extends Error {
  override readonly name = 'BspatchUnavailableError';
  constructor(message = 'bspatch not found on PATH') {
    super(message);
  }
}

/**
 * Thrown when `bspatch` was on PATH but exited non-zero. Wraps the
 * subprocess stderr so callers can surface a diagnostic line.
 */
export class BspatchExecutionError extends Error {
  override readonly name = 'BspatchExecutionError';
  readonly exitCode: number;
  readonly stderr: string;
  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Injection point so tests can stub the subprocess without a real
 * `bspatch` binary on disk. Production callers omit and the default
 * `execa` runner is used.
 */
export interface BspatchRunResult {
  readonly exitCode: number;
  readonly stderr: string;
}
export interface BspatchRunner {
  (cmd: string, args: readonly string[]): Promise<BspatchRunResult>;
}

const defaultRunner: BspatchRunner = async (cmd, args) => {
  try {
    const res = await execa(cmd, [...args], {
      reject: false,
      stripFinalNewline: true,
    });
    return {
      exitCode: res.exitCode ?? 0,
      stderr: typeof res.stderr === 'string' ? res.stderr : '',
    };
  } catch (err) {
    // execa throws on spawn failures (binary not on PATH, EACCES, ...).
    // Surface as a sentinel exit code so the caller can map to the
    // typed "unavailable" error.
    let stderrFromErr: string;
    if (err !== null && typeof err === 'object' && 'stderr' in err) {
      const raw: unknown = (err as { stderr?: unknown }).stderr;
      stderrFromErr = typeof raw === 'string' ? raw : '';
    } else if (err instanceof Error) {
      stderrFromErr = err.message;
    } else {
      stderrFromErr = String(err);
    }
    return { exitCode: -1, stderr: stderrFromErr };
  }
};

/**
 * In-process cache so repeated checks during a long-lived TUI don't
 * re-fork `bspatch -h`. Set by `isBspatchAvailable` on first call.
 */
let cachedAvailability: boolean | null = null;

/**
 * Reset the in-process availability cache. Test-only.
 */
export function _resetBspatchAvailabilityCache(): void {
  cachedAvailability = null;
}

/**
 * Probe PATH for `bspatch`. Returns `true` when the binary exists and
 * exits cleanly on `-h` (some platforms exit 1 for `-h`, so we treat
 * any non-spawn failure as "present"). The result is cached for the
 * lifetime of the process.
 */
export async function isBspatchAvailable(
  runner: BspatchRunner = defaultRunner,
): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability;
  const res = await runner('bspatch', []);
  // exit -1 is our sentinel for "spawn failed" (not on PATH).
  // Anything else means the binary is callable — bspatch with no args
  // typically prints usage to stderr and exits 1, which we treat as
  // "available".
  cachedAvailability = res.exitCode !== -1;
  return cachedAvailability;
}

/**
 * Apply `patchFile` to `oldBinary` and write the result to
 * `outNewBinary`. The caller is responsible for verifying the SHA-256
 * of the output against the expected release digest.
 *
 * Throws `BspatchUnavailableError` when the tool is missing — the
 * downloader catches this specifically to trigger the full-download
 * fallback. Throws `BspatchExecutionError` when the patch itself fails.
 */
export async function applyPatch(
  oldBinary: string,
  patchFile: string,
  outNewBinary: string,
  runner: BspatchRunner = defaultRunner,
): Promise<void> {
  if (!(await isBspatchAvailable(runner))) {
    throw new BspatchUnavailableError();
  }
  // bspatch invocation: `bspatch <oldfile> <newfile> <patchfile>`.
  // It does not write to stdout; failures surface via non-zero exit +
  // a single stderr line.
  const res = await runner('bspatch', [oldBinary, outNewBinary, patchFile]);
  if (res.exitCode === -1) {
    // Race: availability flipped between probe and apply. Fall back to
    // the "unavailable" path so the caller can full-download.
    throw new BspatchUnavailableError(
      `bspatch disappeared between probe and apply: ${res.stderr}`,
    );
  }
  if (res.exitCode !== 0) {
    throw new BspatchExecutionError(
      `bspatch exited ${res.exitCode}`,
      res.exitCode,
      res.stderr,
    );
  }
}
