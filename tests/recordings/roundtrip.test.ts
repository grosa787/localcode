/**
 * Recording roundtrip — capture a fake session, save to disk, load it
 * back, replay it, and assert the reconstructed entries match the
 * originals.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Player,
  Recorder,
  defaultRecordingPath,
  loadRecording,
  saveRecording,
  type RecordingEntry,
} from '@/recordings';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-roundtrip-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Recording roundtrip', () => {
  test('record → save → load → replay reconstructs entries verbatim', async () => {
    const recorder = new Recorder({ randomIdFn: () => 'roundtrip' });
    recorder.start('sess-x');
    recorder.appendUser('write me a quick script');
    recorder.appendAssistant("sure! here's the plan…");
    recorder.appendToolCall('write_file', { path: 'a.ts', contents: 'export {};' }, 'wrote 10 bytes');
    recorder.appendAssistant('done — anything else?');
    recorder.appendSystem('session ended');
    const finalized = recorder.stop();

    const target = defaultRecordingPath(tmpDir, finalized.id);
    await saveRecording(finalized, target);

    const loaded = await loadRecording(target);
    expect(loaded.id).toBe(finalized.id);
    expect(loaded.sessionId).toBe(finalized.sessionId);
    expect(loaded.entries.length).toBe(finalized.entries.length);

    // Verify field-by-field equality of every entry.
    finalized.entries.forEach((orig, i) => {
      const loadedEntry = loaded.entries[i];
      expect(loadedEntry).toBeDefined();
      if (loadedEntry === undefined) return;
      expect(loadedEntry.kind).toBe(orig.kind);
      expect(loadedEntry.ts).toBe(orig.ts);
      if (orig.kind === 'tool_call' && loadedEntry.kind === 'tool_call') {
        expect(loadedEntry.name).toBe(orig.name);
        expect(loadedEntry.args).toEqual(orig.args);
        expect(loadedEntry.result).toBe(orig.result);
      } else if (
        (orig.kind === 'user' || orig.kind === 'assistant' || orig.kind === 'system') &&
        (loadedEntry.kind === 'user' || loadedEntry.kind === 'assistant' || loadedEntry.kind === 'system')
      ) {
        expect(loadedEntry.content).toBe(orig.content);
      }
    });

    // Replay reproduces the same entries through the dispatch sink.
    const player = new Player({
      setTimeoutFn: (cb: () => void): unknown => {
        queueMicrotask(cb);
        return null;
      },
    });
    const seen: RecordingEntry[] = [];
    await player.replay(
      loaded,
      (e) => {
        seen.push(e);
      },
      { skipDelays: true, speed: 1 },
    );
    expect(seen.length).toBe(finalized.entries.length);
    seen.forEach((entry, i) => {
      const orig = finalized.entries[i];
      expect(orig).toBeDefined();
      if (orig === undefined) return;
      expect(entry.kind).toBe(orig.kind);
      expect(entry.ts).toBe(orig.ts);
    });
  });
});
