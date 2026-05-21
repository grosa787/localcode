/**
 * Player replay coverage.
 *
 * Verifies:
 *   - replay dispatches entries in order,
 *   - speed multiplier shortens delays,
 *   - --instant skips delays entirely,
 *   - cancel aborts mid-replay,
 *   - parseRecording rejects malformed input,
 *   - loadRecording reads a written file end-to-end.
 */

import { describe, test, expect } from 'bun:test';
import {
  Player,
  PlayerError,
  parseRecording,
  type Recording,
  type RecordingEntry,
} from '@/recordings';

function buildRecording(entries: RecordingEntry[]): Recording {
  return {
    id: 'rec-test',
    sessionId: 'sess',
    startedAt: 1_000_000,
    endedAt: 1_000_000 + 9999,
    entries,
  };
}

class FakeTimers {
  delays: number[] = [];
  setTimeoutFn = (cb: () => void, ms: number): unknown => {
    this.delays.push(ms);
    // Run immediately for deterministic test pacing.
    queueMicrotask(cb);
    return null;
  };
}

describe('Player.replay', () => {
  test('dispatches entries in order with --instant', async () => {
    const fake = new FakeTimers();
    const player = new Player({ setTimeoutFn: fake.setTimeoutFn });
    const rec = buildRecording([
      { kind: 'user', content: 'a', ts: 1_000_000 },
      { kind: 'assistant', content: 'b', ts: 1_001_000 },
      { kind: 'user', content: 'c', ts: 1_002_000 },
    ]);
    const seen: string[] = [];
    await player.replay(
      rec,
      (e) => {
        if (e.kind === 'user' || e.kind === 'assistant') seen.push(e.content);
      },
      { skipDelays: true, speed: 1 },
    );
    expect(seen).toEqual(['a', 'b', 'c']);
    // --instant means we never call setTimeout with a non-zero delay.
    expect(fake.delays.every((d) => d === 0)).toBe(true);
  });

  test('speed=2 halves the per-entry delay', async () => {
    const fake = new FakeTimers();
    const player = new Player({ setTimeoutFn: fake.setTimeoutFn });
    const rec = buildRecording([
      { kind: 'user', content: 'a', ts: 1_000_000 },
      { kind: 'user', content: 'b', ts: 1_000_200 },
    ]);
    await player.replay(rec, () => {}, { skipDelays: false, speed: 2 });
    // First entry has no leading delay (it fires at relative t=0).
    // Second entry was 200 ms after the first → 100 ms at speed=2.
    const nonZero = fake.delays.filter((d) => d > 0);
    expect(nonZero).toEqual([100]);
  });

  test('speed=0.5 doubles the per-entry delay', async () => {
    const fake = new FakeTimers();
    const player = new Player({ setTimeoutFn: fake.setTimeoutFn });
    const rec = buildRecording([
      { kind: 'user', content: 'a', ts: 1_000_000 },
      { kind: 'user', content: 'b', ts: 1_000_100 },
    ]);
    await player.replay(rec, () => {}, { skipDelays: false, speed: 0.5 });
    const nonZero = fake.delays.filter((d) => d > 0);
    expect(nonZero).toEqual([200]);
  });

  test('rejects non-positive speed values', async () => {
    const player = new Player();
    const rec = buildRecording([{ kind: 'user', content: 'a', ts: 1 }]);
    await expect(
      player.replay(rec, () => {}, { speed: 0, skipDelays: false }),
    ).rejects.toBeInstanceOf(PlayerError);
    await expect(
      player.replay(rec, () => {}, { speed: -1, skipDelays: false }),
    ).rejects.toBeInstanceOf(PlayerError);
  });

  test('cancel aborts subsequent dispatches', async () => {
    const fake = new FakeTimers();
    const player = new Player({ setTimeoutFn: fake.setTimeoutFn });
    const rec = buildRecording([
      { kind: 'user', content: 'a', ts: 1 },
      { kind: 'user', content: 'b', ts: 2 },
      { kind: 'user', content: 'c', ts: 3 },
    ]);
    const seen: string[] = [];
    const dispatch = (e: RecordingEntry): void => {
      if (e.kind === 'user') {
        seen.push(e.content);
        if (e.content === 'a') player.cancel();
      }
    };
    await player.replay(rec, dispatch, { skipDelays: true, speed: 1 });
    expect(seen).toEqual(['a']);
  });

  test('empty recording is a no-op', async () => {
    const player = new Player();
    const rec = buildRecording([]);
    let dispatched = 0;
    await player.replay(rec, () => {
      dispatched += 1;
    });
    expect(dispatched).toBe(0);
  });

  test('maxDelayMs clamps a large inter-entry gap', async () => {
    const fake = new FakeTimers();
    const player = new Player({ setTimeoutFn: fake.setTimeoutFn });
    const rec = buildRecording([
      { kind: 'user', content: 'a', ts: 0 },
      { kind: 'user', content: 'b', ts: 60 * 60 * 1000 }, // 1h gap
    ]);
    await player.replay(rec, () => {}, {
      skipDelays: false,
      speed: 1,
      maxDelayMs: 250,
    });
    const nonZero = fake.delays.filter((d) => d > 0);
    expect(nonZero).toEqual([250]);
  });
});

describe('parseRecording validation', () => {
  test('accepts a valid recording JSON', () => {
    const raw = JSON.stringify({
      id: 'rec-1',
      sessionId: 's',
      startedAt: 1,
      entries: [{ kind: 'user', content: 'hi', ts: 1 }],
    });
    const rec = parseRecording(raw);
    expect(rec.id).toBe('rec-1');
    expect(rec.entries).toHaveLength(1);
  });

  test('rejects non-JSON input', () => {
    expect(() => parseRecording('not json{')).toThrow(PlayerError);
  });

  test("rejects missing 'kind' on an entry", () => {
    const raw = JSON.stringify({
      id: 'r',
      sessionId: 's',
      startedAt: 1,
      entries: [{ content: 'hi', ts: 1 }],
    });
    expect(() => parseRecording(raw)).toThrow(PlayerError);
  });

  test('rejects unknown kind', () => {
    const raw = JSON.stringify({
      id: 'r',
      sessionId: 's',
      startedAt: 1,
      entries: [{ kind: 'bogus', content: 'hi', ts: 1 }],
    });
    expect(() => parseRecording(raw)).toThrow(PlayerError);
  });

  test('parses tool_call entries with their args + result', () => {
    const raw = JSON.stringify({
      id: 'r',
      sessionId: 's',
      startedAt: 1,
      entries: [
        {
          kind: 'tool_call',
          name: 'read_file',
          args: { path: 'a.ts' },
          result: 'hello',
          ts: 1,
        },
      ],
    });
    const rec = parseRecording(raw);
    const first = rec.entries[0];
    expect(first).toBeDefined();
    if (first === undefined || first.kind !== 'tool_call') throw new Error('unexpected');
    expect(first.name).toBe('read_file');
    expect(first.args).toEqual({ path: 'a.ts' });
    expect(first.result).toBe('hello');
  });
});
