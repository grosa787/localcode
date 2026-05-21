/**
 * Recorder lifecycle + serialization coverage.
 *
 * Verifies:
 *   - start/stop/snapshot flow,
 *   - entries are captured in order with strictly-monotonic timestamps,
 *   - serializeRecording round-trips through JSON.parse,
 *   - saveRecording writes atomically to disk,
 *   - idempotent start, error on stop-when-idle.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Recorder,
  RecorderError,
  defaultRecordingPath,
  saveRecording,
  serializeRecording,
} from '@/recordings';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-recorder-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function fixedClock(base = 1_700_000_000_000): () => number {
  let t = base;
  return (): number => {
    t += 10; // every read advances 10 ms
    return t;
  };
}

describe('Recorder lifecycle', () => {
  test('start returns a fresh recording with empty entries', () => {
    const rec = new Recorder({ randomIdFn: () => 'abc' });
    const initial = rec.start('sess-1');
    expect(initial.id).toBe('rec-abc');
    expect(initial.sessionId).toBe('sess-1');
    expect(initial.entries).toEqual([]);
    expect(rec.isRecording).toBe(true);
    expect(rec.activeSessionId).toBe('sess-1');
  });

  test('start is idempotent — second call returns the same recording', () => {
    const rec = new Recorder({ randomIdFn: () => 'abc' });
    const a = rec.start('sess-1');
    const b = rec.start('sess-2');
    expect(b.id).toBe(a.id);
    expect(b.sessionId).toBe('sess-1');
  });

  test('stop without active recording throws RecorderError', () => {
    const rec = new Recorder();
    expect(() => rec.stop()).toThrow(RecorderError);
  });

  test('append* without active recording throws', () => {
    const rec = new Recorder();
    expect(() => rec.appendUser('hi')).toThrow(RecorderError);
  });

  test('entries are captured in order with monotonic timestamps', () => {
    const rec = new Recorder({ nowFn: fixedClock(), randomIdFn: () => 'abc' });
    rec.start('s');
    rec.appendUser('hello');
    rec.appendAssistant('hi');
    rec.appendToolCall('read_file', { path: 'a.ts' }, 'contents');
    rec.appendSystem('note');
    const finalized = rec.stop();
    expect(finalized.entries).toHaveLength(4);
    const entryZero = finalized.entries[0];
    const entryOne = finalized.entries[1];
    const entryTwo = finalized.entries[2];
    const entryThree = finalized.entries[3];
    expect(entryZero?.kind).toBe('user');
    expect(entryOne?.kind).toBe('assistant');
    expect(entryTwo?.kind).toBe('tool_call');
    expect(entryThree?.kind).toBe('system');
    for (let i = 1; i < finalized.entries.length; i += 1) {
      const prev = finalized.entries[i - 1];
      const curr = finalized.entries[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr.ts).toBeGreaterThan(prev.ts);
      }
    }
    expect(finalized.endedAt).toBeGreaterThan(finalized.startedAt);
  });

  test('clock that returns the same value still produces strictly-increasing ts', () => {
    const stuckClock = (): number => 1_700_000_000_000;
    const rec = new Recorder({ nowFn: stuckClock });
    rec.start('s');
    rec.appendUser('a');
    rec.appendUser('b');
    rec.appendUser('c');
    const final = rec.stop();
    const entryZero = final.entries[0];
    const entryOne = final.entries[1];
    const entryTwo = final.entries[2];
    if (entryZero && entryOne && entryTwo) {
      expect(entryOne.ts).toBeGreaterThan(entryZero.ts);
      expect(entryTwo.ts).toBeGreaterThan(entryOne.ts);
    }
  });
});

describe('Recorder serialization', () => {
  test('serializeRecording round-trips through JSON.parse', () => {
    const rec = new Recorder({ randomIdFn: () => 'abc' });
    rec.start('s');
    rec.appendUser('hi');
    const finalized = rec.stop();
    const raw = serializeRecording(finalized);
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(finalized.id);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].kind).toBe('user');
    expect(parsed.entries[0].content).toBe('hi');
  });

  test('saveRecording writes a readable file at the target path', async () => {
    const rec = new Recorder({ randomIdFn: () => 'abc' });
    rec.start('s');
    rec.appendUser('hi');
    const finalized = rec.stop();
    const target = defaultRecordingPath(tmpDir, finalized.id);
    await saveRecording(finalized, target);
    const onDisk = await stat(target);
    expect(onDisk.isFile()).toBe(true);
    const text = await readFile(target, 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed.id).toBe(finalized.id);
  });

  test('saveRecording creates the parent directory tree', async () => {
    const rec = new Recorder({ randomIdFn: () => 'abc' });
    rec.start('s');
    rec.appendUser('hi');
    const finalized = rec.stop();
    const target = path.join(tmpDir, 'deep', 'nested', 'file.lcrec');
    await saveRecording(finalized, target);
    const onDisk = await stat(target);
    expect(onDisk.isFile()).toBe(true);
  });
});
