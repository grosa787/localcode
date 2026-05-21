/**
 * Player — replays a saved recording back into a chat-state dispatch.
 *
 * The player is transport-agnostic. The composition root supplies a
 * `ReplayDispatch` callback that decides how each entry materialises in
 * the UI (e.g. push to the in-memory message store, write a system
 * notice). The player computes inter-entry delays from the original
 * timestamps, applies the speed/skip-delays modifiers, and awaits each
 * dispatch in sequence so the display order matches the recording.
 *
 * Validation: `loadRecording` runs the file through a small `unknown`
 * shape-check before returning a typed `Recording` — guards against
 * hand-edited / corrupt files without pulling in Zod (recordings are
 * not security-critical input, but a malformed file should not crash
 * the CLI with `TypeError: cannot read 'kind' of undefined`).
 */

import { promises as fs } from 'node:fs';
import type {
  Recording,
  RecordingEntry,
  ReplayDispatch,
  ReplayOptions,
} from './types';

const DEFAULT_OPTIONS: ReplayOptions = {
  speed: 1,
  skipDelays: false,
};

/** Hard upper bound on any computed delay (ms). */
const DEFAULT_MAX_DELAY_MS = 5_000;

export class PlayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerError';
  }
}

export interface PlayerOptions {
  /** Override for `setTimeout` — defaults to `globalThis.setTimeout`. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
}

/**
 * Player is stateless across recordings — one instance can replay
 * multiple files. The `cancel` flag on the live promise lets callers
 * abort an in-flight replay (e.g. user hits Esc).
 */
export class Player {
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private cancelled = false;

  constructor(opts: PlayerOptions = {}) {
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms): unknown => globalThis.setTimeout(cb, ms));
  }

  /**
   * Replay `rec` by dispatching each entry through `dispatch` at the
   * appropriate (modified) delay. Resolves when every entry has been
   * dispatched, or earlier when `cancel()` is called.
   *
   * Delays are computed from the *first* entry's timestamp — i.e. the
   * first entry fires at t=0 (no leading pause), and every subsequent
   * entry fires at `(entry.ts - first.ts) / speed` after the start.
   * This avoids stalling on a recording that began with a long idle
   * gap before the first user message.
   */
  async replay(
    rec: Recording,
    dispatch: ReplayDispatch,
    opts: Partial<ReplayOptions> = {},
  ): Promise<void> {
    this.cancelled = false;
    const merged: ReplayOptions = {
      ...DEFAULT_OPTIONS,
      ...opts,
    };
    if (!Number.isFinite(merged.speed) || merged.speed <= 0) {
      throw new PlayerError(
        `Replay speed must be a positive finite number; got ${String(merged.speed)}`,
      );
    }
    if (rec.entries.length === 0) return;

    const first = rec.entries[0];
    if (first === undefined) return;
    const baseTs = first.ts;
    let lastTs = baseTs;

    for (const entry of rec.entries) {
      if (this.cancelled) return;
      const rawDelay = entry.ts - lastTs;
      const adjusted = merged.skipDelays
        ? 0
        : clampDelay(rawDelay / merged.speed, merged.maxDelayMs);
      lastTs = entry.ts;
      if (adjusted > 0) await this.sleep(adjusted);
      if (this.cancelled) return;
      await dispatch(entry);
    }
  }

  /** Cancel an in-flight replay. The current `await dispatch` still runs
   *  to completion; cancellation takes effect at the next loop iteration. */
  cancel(): void {
    this.cancelled = true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setTimeoutFn(resolve, ms);
    });
  }
}

function clampDelay(raw: number, max?: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const ceiling = max ?? DEFAULT_MAX_DELAY_MS;
  if (raw > ceiling) return ceiling;
  return Math.floor(raw);
}

/**
 * Load + parse a recording from disk. Throws `PlayerError` on malformed
 * files. Accepts both pretty-JSON (default) and any future format that
 * still emits `{ id, sessionId, startedAt, entries }`.
 */
export async function loadRecording(filePath: string): Promise<Recording> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new PlayerError(`Failed to read recording at ${filePath}: ${msg}`);
  }
  return parseRecording(raw);
}

/**
 * Parse a recording from a serialized string. Exposed for tests that
 * round-trip without hitting disk.
 */
export function parseRecording(raw: string): Recording {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new PlayerError(`Recording is not valid JSON: ${msg}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlayerError('Recording must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const id = obj['id'];
  const sessionId = obj['sessionId'];
  const startedAt = obj['startedAt'];
  const entriesRaw = obj['entries'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new PlayerError("Recording 'id' must be a non-empty string");
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new PlayerError("Recording 'sessionId' must be a non-empty string");
  }
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    throw new PlayerError("Recording 'startedAt' must be a finite number");
  }
  if (!Array.isArray(entriesRaw)) {
    throw new PlayerError("Recording 'entries' must be an array");
  }
  const entries: RecordingEntry[] = entriesRaw.map((e, i) => parseEntry(e, i));
  const endedAt = obj['endedAt'];
  return Object.freeze({
    id,
    sessionId,
    startedAt,
    endedAt:
      typeof endedAt === 'number' && Number.isFinite(endedAt) ? endedAt : undefined,
    entries: Object.freeze(entries) as readonly RecordingEntry[],
  }) as Recording;
}

function parseEntry(raw: unknown, index: number): RecordingEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlayerError(`Recording entry #${index} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj['kind'];
  const ts = obj['ts'];
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    throw new PlayerError(`Entry #${index} 'ts' must be a finite number`);
  }
  if (kind === 'user' || kind === 'assistant' || kind === 'system') {
    const content = obj['content'];
    if (typeof content !== 'string') {
      throw new PlayerError(`Entry #${index} 'content' must be a string`);
    }
    return { kind, content, ts };
  }
  if (kind === 'tool_call') {
    const name = obj['name'];
    const args = obj['args'];
    const result = obj['result'];
    if (typeof name !== 'string') {
      throw new PlayerError(`Entry #${index} 'name' must be a string`);
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new PlayerError(`Entry #${index} 'args' must be an object`);
    }
    if (typeof result !== 'string') {
      throw new PlayerError(`Entry #${index} 'result' must be a string`);
    }
    return {
      kind: 'tool_call',
      name,
      args: args as Record<string, unknown>,
      result,
      ts,
    };
  }
  throw new PlayerError(
    `Entry #${index} has unknown kind '${String(kind)}' (expected user|assistant|tool_call|system)`,
  );
}
