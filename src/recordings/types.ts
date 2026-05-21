/**
 * Recording + playback types.
 *
 * A `Recording` is an ordered, timestamped capture of a chat session — user
 * turns, assistant turns, tool calls (with their results), and system
 * notices. The format is intentionally lightweight (JSON over the wire,
 * serialized as either pretty JSON or JSON-Lines on disk) so it can be
 * replayed by `Player` later as a demo.
 *
 * `RecordingEntry` is a discriminated union keyed by `kind` — discriminator
 * narrowing in TS lets the player branch over the entry types without
 * unsafe casts.
 */

export interface RecordingUserEntry {
  readonly kind: 'user';
  readonly content: string;
  /** Wall-clock ms since epoch when the entry was appended. */
  readonly ts: number;
}

export interface RecordingAssistantEntry {
  readonly kind: 'assistant';
  readonly content: string;
  readonly ts: number;
}

export interface RecordingToolCallEntry {
  readonly kind: 'tool_call';
  /** Tool name (e.g. `read_file`, `run_command`). */
  readonly name: string;
  /** Tool arguments — JSON-serialisable record. */
  readonly args: Record<string, unknown>;
  /** Tool result text (stringified — recordings are display-only). */
  readonly result: string;
  readonly ts: number;
}

export interface RecordingSystemEntry {
  readonly kind: 'system';
  readonly content: string;
  readonly ts: number;
}

export type RecordingEntry =
  | RecordingUserEntry
  | RecordingAssistantEntry
  | RecordingToolCallEntry
  | RecordingSystemEntry;

export interface Recording {
  /** Stable identifier — `rec-<uuid>`. */
  readonly id: string;
  /** Source session id (informational; cross-session replay is supported). */
  readonly sessionId: string;
  /** When the recording started (ms since epoch). */
  readonly startedAt: number;
  /** When the recording was finalized (ms since epoch). `undefined` while live. */
  readonly endedAt?: number;
  /** Ordered entries — append-only during capture. */
  readonly entries: readonly RecordingEntry[];
}

/**
 * Replay options accepted by `Player.replay`.
 *
 * `speed` is a unit-less multiplier applied to inter-entry delays:
 *   - `1` (default) → real-time
 *   - `2` → twice as fast
 *   - `0.5` → half speed
 *
 * `skipDelays` short-circuits all delays — entries fire back-to-back.
 * `maxDelayMs` clamps individual delays (e.g. so a 1-hour pause in the
 * original session doesn't stall the demo).
 */
export interface ReplayOptions {
  readonly speed: number;
  readonly skipDelays: boolean;
  readonly maxDelayMs?: number;
}

/**
 * Dispatch sink for replay. The composition root supplies a function that
 * routes the entry into the local chat-state model. The player itself
 * stays decoupled from UI / DB concerns.
 */
export type ReplayDispatch = (entry: RecordingEntry) => void | Promise<void>;
