/**
 * Tests for FileChangeTracker — the process-wide read/write ledger that
 * powers the executor's "file changed externally" warning.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { FileChangeTracker } from '@/tools/file-tracker';

describe('FileChangeTracker', () => {
  let tracker: FileChangeTracker;

  beforeEach(() => {
    tracker = new FileChangeTracker();
  });

  test('checkChanged returns null when no prior markRead exists', () => {
    const status = tracker.checkChanged('/abs/foo.ts', 100, 50, 'sess-a');
    expect(status).toBe(null);
  });

  test('markRead then unchanged stat → checkChanged.changed === false', () => {
    tracker.markRead('/abs/foo.ts', 100, 50, 'sess-a');
    const status = tracker.checkChanged('/abs/foo.ts', 100, 50, 'sess-a');
    expect(status).not.toBe(null);
    expect(status!.changed).toBe(false);
    expect(status!.currentMtime).toBe(100);
    expect(typeof status!.lastReadAt).toBe('number');
  });

  test('markRead then mtime delta → checkChanged.changed === true', () => {
    tracker.markRead('/abs/foo.ts', 100, 50, 'sess-a');
    const status = tracker.checkChanged('/abs/foo.ts', 200, 50, 'sess-a');
    expect(status!.changed).toBe(true);
    expect(status!.currentMtime).toBe(200);
  });

  test('markRead then size delta with same mtime → still detected', () => {
    // Some FS report mtime in 1s ticks; rapid in-place truncation can
    // round-trip the mtime bucket. Size is the tiebreaker.
    tracker.markRead('/abs/foo.ts', 1000, 50, 'sess-a');
    const status = tracker.checkChanged('/abs/foo.ts', 1000, 80, 'sess-a');
    expect(status!.changed).toBe(true);
  });

  test('snapshots are scoped per session', () => {
    tracker.markRead('/abs/foo.ts', 100, 50, 'sess-a');
    // Same path, different session → no record.
    const status = tracker.checkChanged('/abs/foo.ts', 100, 50, 'sess-b');
    expect(status).toBe(null);
    // Original session sees its own record.
    const own = tracker.checkChanged('/abs/foo.ts', 100, 50, 'sess-a');
    expect(own!.changed).toBe(false);
  });

  test('omitted session id partitions into a shared bucket', () => {
    tracker.markRead('/abs/foo.ts', 100, 50);
    // Same partition (no session).
    const status = tracker.checkChanged('/abs/foo.ts', 200, 50);
    expect(status!.changed).toBe(true);
    // A real session id is a different partition.
    const other = tracker.checkChanged('/abs/foo.ts', 200, 50, 'sess-a');
    expect(other).toBe(null);
  });

  test('markRead is idempotent — repeated calls overwrite the snapshot', () => {
    tracker.markRead('/abs/foo.ts', 100, 50, 'sess-a');
    tracker.markRead('/abs/foo.ts', 300, 75, 'sess-a');
    const status = tracker.checkChanged('/abs/foo.ts', 300, 75, 'sess-a');
    expect(status!.changed).toBe(false);
  });

  test('clear() drops every snapshot', () => {
    tracker.markRead('/abs/a.ts', 1, 1, 'sess-a');
    tracker.markRead('/abs/b.ts', 2, 2, 'sess-b');
    tracker.clear();
    expect(tracker.checkChanged('/abs/a.ts', 1, 1, 'sess-a')).toBe(null);
    expect(tracker.checkChanged('/abs/b.ts', 2, 2, 'sess-b')).toBe(null);
  });

  test('hasRead reflects the snapshot map state', () => {
    expect(tracker.hasRead('/abs/foo.ts', 'sess-a')).toBe(false);
    tracker.markRead('/abs/foo.ts', 100, 50, 'sess-a');
    expect(tracker.hasRead('/abs/foo.ts', 'sess-a')).toBe(true);
    expect(tracker.hasRead('/abs/foo.ts', 'sess-b')).toBe(false);
    tracker.clear();
    expect(tracker.hasRead('/abs/foo.ts', 'sess-a')).toBe(false);
  });
});
