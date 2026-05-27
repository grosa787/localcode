/**
 * Crash-resilient journal tests.
 *
 * Covers:
 *   - Append + read round-trip
 *   - Recovery scan (no session_end → recoverable)
 *   - Clean close (session_end clean → NOT recoverable)
 *   - Multiple files (mix of clean / crashed)
 *   - Archive (file moves to archive/ subdir)
 *   - Discard (file removed from active dir)
 *   - Prune (archived files older than max age removed)
 *   - Crash simulation (child process killed → events on disk)
 *
 * All tests use a fresh tmp dir per case so the user's real
 * `~/.localcode/journal` is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  JournalWriter,
  archiveJournal,
  discardJournal,
  pruneArchivedJournals,
  readJournalEvents,
  recoverableJournals,
  type JournalEvent,
} from '@/sessions/journal';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-journal-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function mkEvent(type: JournalEvent['type'], data: unknown): JournalEvent {
  return { ts: Date.now(), type, data };
}

describe('JournalWriter.append + readJournalEvents', () => {
  test('round-trips 5 events as JSONL', () => {
    const sid = 'sess-1';
    const w = new JournalWriter(sid, { directory: tmpDir });
    w.append(mkEvent('session_start', { projectRoot: '/p' }));
    w.append(mkEvent('user_input', { text: 'hi' }));
    w.append(mkEvent('chunk', { text: 'Hel' }));
    w.append(mkEvent('chunk', { text: 'lo' }));
    w.append(mkEvent('message_committed', { messageId: 'm1', role: 'user' }));
    // Close uncleanly so the file is left as recoverable for the next test
    // — but we want the 5 events here, NOT 6 (no session_end appended).
    // Instead, just leave the writer open and read the raw file directly.
    const raw = fs.readFileSync(w.filepath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(5);
    const events = readJournalEvents(w.filepath);
    expect(events.length).toBe(5);
    expect(events[0]?.type).toBe('session_start');
    expect(events[4]?.type).toBe('message_committed');
    // explicitly close so the fd is released for cleanup
    w.close('clean');
  });

  test('append after close throws', () => {
    const w = new JournalWriter('sess-x', { directory: tmpDir });
    w.close('clean');
    expect(() => w.append(mkEvent('chunk', { text: 'x' }))).toThrow();
  });

  test('isClosed reflects state', () => {
    const w = new JournalWriter('sess-y', { directory: tmpDir });
    expect(w.isClosed).toBe(false);
    w.close('clean');
    expect(w.isClosed).toBe(true);
  });

  test('handles unserialisable data gracefully', () => {
    const w = new JournalWriter('sess-cycle', { directory: tmpDir });
    interface Cyclic {
      self: Cyclic | null;
    }
    const cyclic: Cyclic = { self: null };
    cyclic.self = cyclic;
    // Should not throw — fallback marker is recorded.
    expect(() => w.append(mkEvent('chunk', cyclic))).not.toThrow();
    w.close('clean');
    const events = readJournalEvents(w.filepath);
    // session_end + the fallback chunk event = 2
    expect(events.length).toBe(2);
  });
});

describe('recoverableJournals', () => {
  test('returns journals WITHOUT session_end', () => {
    const w = new JournalWriter('sess-crash', { directory: tmpDir });
    w.append(mkEvent('user_input', { text: 'hello' }));
    w.append(mkEvent('chunk', { text: 'Hi ' }));
    // Don't call close — simulates a crash.
    // Release the fd so the parent process can scan + archive on next boot.
    // (Real crash leaves the fd dangling; the OS reclaims it.)
    // For test cleanliness we drop the reference by NOT calling any method.
    const recovered = recoverableJournals(tmpDir);
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.sessionId).toBe('sess-crash');
    expect(recovered[0]?.lastEvent?.type).toBe('chunk');
    expect(recovered[0]?.eventCount).toBe(2);
    // Manually close for test cleanup.
    w.close('crash');
  });

  test('does NOT return journals with clean session_end', () => {
    const w = new JournalWriter('sess-clean', { directory: tmpDir });
    w.append(mkEvent('user_input', { text: 'bye' }));
    w.close('clean');
    const recovered = recoverableJournals(tmpDir);
    expect(recovered.length).toBe(0);
  });

  test('returns journals with crash session_end (non-clean)', () => {
    const w = new JournalWriter('sess-crashend', { directory: tmpDir });
    w.append(mkEvent('chunk', { text: 'partial' }));
    w.close('crash');
    const recovered = recoverableJournals(tmpDir);
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.sessionId).toBe('sess-crashend');
  });

  test('mix of 3 unfinished + 1 clean → returns 3', () => {
    for (const sid of ['a', 'b', 'c']) {
      const w = new JournalWriter(sid, { directory: tmpDir });
      w.append(mkEvent('user_input', { text: sid }));
      w.close('crash');
    }
    const clean = new JournalWriter('d', { directory: tmpDir });
    clean.append(mkEvent('user_input', { text: 'd' }));
    clean.close('clean');
    const recovered = recoverableJournals(tmpDir);
    expect(recovered.length).toBe(3);
    const ids = recovered.map((r) => r.sessionId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  test('returns empty when directory does not exist', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const recovered = recoverableJournals(missing);
    expect(recovered).toEqual([]);
  });

  test('empty journal file is surfaced as recoverable with null lastEvent', () => {
    const sid = 'empty-sess';
    fs.writeFileSync(path.join(tmpDir, `${sid}.jsonl`), '');
    const recovered = recoverableJournals(tmpDir);
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.lastEvent).toBeNull();
    expect(recovered[0]?.eventCount).toBe(0);
  });

  test('skips non-.jsonl entries', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hi');
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hi');
    const recovered = recoverableJournals(tmpDir);
    expect(recovered).toEqual([]);
  });
});

describe('archiveJournal', () => {
  test('moves the file into archive/ subdir', () => {
    const w = new JournalWriter('arc-1', { directory: tmpDir });
    w.append(mkEvent('user_input', { text: 'x' }));
    w.close('crash');

    const ok = archiveJournal('arc-1', { directory: tmpDir });
    expect(ok).toBe(true);

    // Source file gone
    expect(fs.existsSync(path.join(tmpDir, 'arc-1.jsonl'))).toBe(false);

    // Archive entry exists
    const archiveDir = path.join(tmpDir, 'archive');
    const archived = fs.readdirSync(archiveDir);
    expect(archived.length).toBe(1);
    const archivedName = archived[0];
    expect(archivedName).toBeDefined();
    if (archivedName !== undefined) {
      expect(archivedName.startsWith('arc-1-')).toBe(true);
      expect(archivedName.endsWith('.jsonl')).toBe(true);
    }
  });

  test('returns false when the source file does not exist', () => {
    expect(archiveJournal('does-not-exist', { directory: tmpDir })).toBe(false);
  });

  test('archived files do NOT appear in recoverableJournals', () => {
    const w = new JournalWriter('arc-hidden', { directory: tmpDir });
    w.append(mkEvent('user_input', { text: 'h' }));
    w.close('crash');
    archiveJournal('arc-hidden', { directory: tmpDir });
    const recovered = recoverableJournals(tmpDir);
    expect(recovered.length).toBe(0);
  });
});

describe('discardJournal', () => {
  test('deletes the file from active dir', () => {
    const w = new JournalWriter('dis-1', { directory: tmpDir });
    w.append(mkEvent('chunk', { text: 'x' }));
    w.close('crash');
    expect(discardJournal('dis-1', tmpDir)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'dis-1.jsonl'))).toBe(false);
  });

  test('returns false when file missing', () => {
    expect(discardJournal('nope', tmpDir)).toBe(false);
  });
});

describe('pruneArchivedJournals', () => {
  test('removes files older than maxAgeMs, keeps fresh ones', () => {
    const archiveDir = path.join(tmpDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });

    const old = path.join(archiveDir, 'old-2023-01-01.jsonl');
    const fresh = path.join(archiveDir, 'fresh.jsonl');
    fs.writeFileSync(old, 'x\n');
    fs.writeFileSync(fresh, 'x\n');
    // Backdate the "old" file by 60 days.
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    fs.utimesSync(old, new Date(sixtyDaysAgo), new Date(sixtyDaysAgo));

    const removed = pruneArchivedJournals({
      archiveDir,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test('returns 0 when archive dir does not exist', () => {
    const removed = pruneArchivedJournals({
      archiveDir: path.join(tmpDir, 'no-such-dir'),
    });
    expect(removed).toBe(0);
  });
});

describe('crash simulation via child process', () => {
  test('events appended before SIGKILL survive on disk', async () => {
    // Spawn a child that writes 10 events then loops without closing.
    // We send SIGKILL after a short delay; the journal file must still
    // contain all 10 events thanks to fsync per append.
    const sid = `crash-${Date.now()}`;
    const filepath = path.join(tmpDir, `${sid}.jsonl`);
    // Locate the journal source so the child can import directly with bun.
    // Resolve via `import.meta.dir` so this works wherever the test runs.
    const journalSrc = path.resolve(
      import.meta.dir,
      '..',
      '..',
      'src',
      'sessions',
      'journal.ts',
    );
    const childScript = `
      import { JournalWriter } from ${JSON.stringify(journalSrc)};
      const w = new JournalWriter(${JSON.stringify(sid)}, {
        directory: ${JSON.stringify(tmpDir)},
      });
      for (let i = 0; i < 10; i += 1) {
        w.append({ ts: Date.now(), type: 'chunk', data: { i } });
      }
      // Signal readiness then spin forever — the parent will kill us.
      process.stdout.write('READY\\n');
      setInterval(() => {}, 60_000);
    `;

    const scriptPath = path.join(tmpDir, 'child.ts');
    fs.writeFileSync(scriptPath, childScript);

    const proc = Bun.spawn(['bun', 'run', scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Wait for READY then kill -9.
    let buffer = '';
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      if (buffer.includes('READY')) break;
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    expect(buffer.includes('READY')).toBe(true);

    proc.kill('SIGKILL');
    await proc.exited;

    // File should have all 10 events.
    expect(fs.existsSync(filepath)).toBe(true);
    const events = readJournalEvents(filepath);
    expect(events.length).toBe(10);
    for (let i = 0; i < 10; i += 1) {
      expect(events[i]?.type).toBe('chunk');
      const d = events[i]?.data;
      expect(typeof d === 'object' && d !== null && (d as { i: number }).i === i).toBe(true);
    }
    // No session_end → recoverable.
    const recovered = recoverableJournals(tmpDir);
    expect(recovered.some((r) => r.sessionId === sid)).toBe(true);
  }, 15_000);
});
