/**
 * Recorder — captures an ordered, timestamped log of chat events.
 *
 * Lifecycle: `start(sessionId)` → many `append*` calls → `stop()` →
 * `save(rec, path)` writes to disk. The recorder is purely in-memory
 * while running; persistence is a separate explicit step so tests can
 * inspect the snapshot before any I/O.
 *
 * The recorder does NOT subscribe to anything automatically — callers
 * (the composition root) push events into it via `appendUser`,
 * `appendAssistant`, `appendToolCall`, `appendSystem`. Keeping the
 * subscription wiring at the call site means tests can drive the
 * recorder with synthetic events without booting the chat runtime.
 *
 * Disk format: pretty JSON for `.lcrec` files. Round-trips through
 * `JSON.parse` / `JSON.stringify` cleanly. Atomic write (tmp + rename)
 * so a crash mid-save never corrupts an existing file.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Recording,
  RecordingAssistantEntry,
  RecordingEntry,
  RecordingSystemEntry,
  RecordingToolCallEntry,
  RecordingUserEntry,
} from './types';

export interface RecorderOptions {
  /** Override for `Date.now()` — tests inject a monotonic clock. */
  readonly nowFn?: () => number;
  /** Override for the random id generator. */
  readonly randomIdFn?: () => string;
}

interface ActiveRecording {
  readonly id: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly entries: RecordingEntry[];
}

export class RecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderError';
  }
}

/**
 * Stateful recorder. One instance per process is enough — `start` /
 * `stop` cycles handle multiple recordings serially.
 */
export class Recorder {
  private active: ActiveRecording | null = null;
  private lastTs = 0;
  private readonly nowFn: () => number;
  private readonly randomIdFn: () => string;

  constructor(opts: RecorderOptions = {}) {
    this.nowFn = opts.nowFn ?? ((): number => Date.now());
    this.randomIdFn = opts.randomIdFn ?? defaultRandomId;
  }

  /**
   * Begin a new recording. Idempotent: calling `start` while another
   * recording is active returns the existing one rather than throwing,
   * so `/record start` is safe to invoke twice in a row.
   */
  start(sessionId: string): Recording {
    if (this.active !== null) return this.snapshot();
    const startedAt = this.nowFn();
    this.active = {
      id: `rec-${this.randomIdFn()}`,
      sessionId,
      startedAt,
      entries: [],
    };
    this.lastTs = startedAt;
    return this.snapshot();
  }

  /** Whether a recording is currently active. */
  get isRecording(): boolean {
    return this.active !== null;
  }

  /** Current session id of the active recording (or `null`). */
  get activeSessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  appendUser(content: string): void {
    const entry: RecordingUserEntry = {
      kind: 'user',
      content,
      ts: this.tick(),
    };
    this.push(entry);
  }

  appendAssistant(content: string): void {
    const entry: RecordingAssistantEntry = {
      kind: 'assistant',
      content,
      ts: this.tick(),
    };
    this.push(entry);
  }

  appendToolCall(
    name: string,
    args: Record<string, unknown>,
    result: string,
  ): void {
    const entry: RecordingToolCallEntry = {
      kind: 'tool_call',
      name,
      args,
      result,
      ts: this.tick(),
    };
    this.push(entry);
  }

  appendSystem(content: string): void {
    const entry: RecordingSystemEntry = {
      kind: 'system',
      content,
      ts: this.tick(),
    };
    this.push(entry);
  }

  /**
   * Snapshot of the current recording. Returns a frozen copy with a
   * defensive copy of `entries` — mutating the result never leaks back
   * into the recorder state.
   */
  snapshot(): Recording {
    if (this.active === null) {
      throw new RecorderError('No active recording — call start() first');
    }
    return Object.freeze({
      id: this.active.id,
      sessionId: this.active.sessionId,
      startedAt: this.active.startedAt,
      entries: [...this.active.entries],
    }) as Recording;
  }

  /**
   * Finalize the current recording. Returns the immutable result.
   * Resets internal state so a follow-up `start` begins clean.
   */
  stop(): Recording {
    if (this.active === null) {
      throw new RecorderError('No active recording to stop');
    }
    const endedAt = this.tick();
    const result: Recording = Object.freeze({
      id: this.active.id,
      sessionId: this.active.sessionId,
      startedAt: this.active.startedAt,
      endedAt,
      entries: Object.freeze([...this.active.entries]) as readonly RecordingEntry[],
    });
    this.active = null;
    this.lastTs = 0;
    return result;
  }

  private push(entry: RecordingEntry): void {
    if (this.active === null) {
      throw new RecorderError(
        'Recorder is not active — call start() before appending entries',
      );
    }
    this.active.entries.push(entry);
  }

  /**
   * Returns a monotonic timestamp, never moving backwards even when the
   * underlying clock does (which can happen with NTP corrections). Two
   * appends in the same millisecond bump by 1 ms so timestamps are
   * strictly increasing — replay relies on this for delay calculation.
   */
  private tick(): number {
    const now = this.nowFn();
    const next = now <= this.lastTs ? this.lastTs + 1 : now;
    this.lastTs = next;
    return next;
  }
}

/**
 * Serialize a recording to a JSON string ready for disk. Indented for
 * human-readability; the format is stable so external tools can
 * round-trip it.
 */
export function serializeRecording(rec: Recording): string {
  // JSON.stringify drops Object.freeze metadata — we re-frame the
  // payload as a plain object for serialisation.
  const payload = {
    id: rec.id,
    sessionId: rec.sessionId,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    entries: rec.entries,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Atomic write to `targetPath`. Creates parent directories if missing.
 * Writes to a sibling `.tmp` then renames so a crash mid-write never
 * corrupts an existing file.
 */
export async function saveRecording(
  rec: Recording,
  targetPath: string,
): Promise<void> {
  const serialized = serializeRecording(rec);
  const parent = path.dirname(targetPath);
  await fs.mkdir(parent, { recursive: true });
  const tmp = `${targetPath}.tmp`;
  await fs.writeFile(tmp, serialized, 'utf8');
  await fs.rename(tmp, targetPath);
}

/**
 * Default location for a fresh recording given a project root.
 * `<projectRoot>/.localcode/recordings/<id>.lcrec`.
 */
export function defaultRecordingPath(projectRoot: string, id: string): string {
  return path.join(projectRoot, '.localcode', 'recordings', `${id}.lcrec`);
}

function defaultRandomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
