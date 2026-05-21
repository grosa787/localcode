/**
 * SoundPlayer — fire-and-forget audio cues for LocalCode.
 *
 * FIX #29: the `sound` config block (schema owned by Agent 5 R5) lets
 * users opt in to audible cues on three events:
 *   - `completion` — a stream has finished (onDone of streamChat).
 *   - `approval`   — the model has requested permission for a
 *                    destructive tool (write_file / run_command) and
 *                    the UI is showing the approval prompt.
 *   - `error`      — a tool call returned `success: false` with a
 *                    non-empty error string.
 *
 * Playback strategy:
 *   - macOS: `afplay <file> -v <volume>` when a file path is set.
 *   - Linux: `aplay <file>` (volume control is out of scope for this
 *            pass — `aplay` has no direct `-v` flag and shelling out
 *            to `amixer` would be overkill).
 *   - Everything else (Windows incl. WSL, or missing files): fall back
 *     to the terminal bell (`\x07` to stdout) — always available, low
 *     effort, and users can silence it with `enabled: false`.
 *
 * Every spawn uses `stdio: 'ignore'` + `detached: true` + `.unref()` so
 * the player process never blocks LocalCode's shutdown, and we never
 * await playback. Spawn failures are swallowed — a silent cue is
 * strictly better than a crash.
 *
 * The helper reads config fresh on every call via the `getConfig`
 * thunk, so live `/ctxsize`-style overlays can flip `sound.enabled`
 * without a restart.
 */

import { spawn } from 'node:child_process';
import type { SoundConfig } from '@/types/global';

/** Supported event kinds. */
export type SoundEvent = 'completion' | 'approval' | 'error';

/**
 * Guard against pathological user-supplied volume values. `afplay -v`
 * treats values outside [0, 1] as garbage; clamp here to be safe.
 */
function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** `true` when the user's config has this event enabled. */
function isEventEnabled(cfg: SoundConfig, event: SoundEvent): boolean {
  if (!cfg.enabled) return false;
  if (event === 'completion') return cfg.onCompletion;
  if (event === 'approval') return cfg.onApproval;
  return cfg.onError;
}

/** Resolve the configured sound file path for an event, or `null`. */
function fileFor(cfg: SoundConfig, event: SoundEvent): string | null {
  if (event === 'completion') return cfg.completionFile;
  if (event === 'approval') return cfg.approvalFile;
  return cfg.errorFile;
}

export class SoundPlayer {
  private readonly getConfig: () => SoundConfig;

  constructor(getConfig: () => SoundConfig) {
    this.getConfig = getConfig;
  }

  /**
   * Play the cue for the given event. Never throws, never blocks.
   * Callers can fire-and-forget.
   */
  play(event: SoundEvent): void {
    let cfg: SoundConfig;
    try {
      cfg = this.getConfig();
    } catch {
      // A broken config supplier shouldn't kill the session. Just bell.
      this.bell();
      return;
    }

    if (!isEventEnabled(cfg, event)) return;

    const file = fileFor(cfg, event);
    const volume = clampVolume(cfg.volume);

    if (process.platform === 'darwin' && file !== null && file.length > 0) {
      try {
        spawn('afplay', ['-v', String(volume), file], {
          stdio: 'ignore',
          detached: true,
        }).unref();
        return;
      } catch {
        // fall through to bell
      }
    }

    if (process.platform === 'linux' && file !== null && file.length > 0) {
      try {
        spawn('aplay', [file], {
          stdio: 'ignore',
          detached: true,
        }).unref();
        return;
      } catch {
        // fall through to bell
      }
    }

    this.bell();
  }

  /**
   * Terminal bell — always safe, always available. Swallows failures
   * so we can't crash the TUI from here.
   */
  private bell(): void {
    try {
      process.stdout.write('\x07');
    } catch {
      // ignore
    }
  }
}
