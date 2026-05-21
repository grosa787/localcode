/**
 * Wave 5A (TA team) — FileSnapshotStack contract.
 *
 *   - push/pop/list semantics
 *   - ring-buffer eviction at the configured capacity (default 10)
 *   - newest-first list ordering
 *   - process singleton getter / setter
 *
 * The stack records pre-mutation snapshots so `/undo` can roll back
 * the last N file mutations. New-file mutations carry `contentBefore =
 * null`, which `/undo` interprets as "delete the file to undo".
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  FileSnapshotStack,
  getProcessFileSnapshotStack,
  setProcessFileSnapshotStack,
} from '@/sessions/file-snapshot-stack';

describe('FileSnapshotStack — basic push/pop/list', () => {
  test('push then pop returns the most recent entry', () => {
    const s = new FileSnapshotStack();
    s.push('a.ts', 'before-a', 'write_file');
    s.push('b.ts', 'before-b', 'edit_file');
    const popped = s.pop();
    expect(popped?.path).toBe('b.ts');
    expect(popped?.contentBefore).toBe('before-b');
    expect(popped?.toolName).toBe('edit_file');
    expect(s.size).toBe(1);
  });

  test('pop on empty stack returns null', () => {
    const s = new FileSnapshotStack();
    expect(s.pop()).toBeNull();
  });

  test('list returns newest-first defensive copy', () => {
    const s = new FileSnapshotStack();
    s.push('a.ts', 'A', 'write_file');
    s.push('b.ts', 'B', 'write_file');
    s.push('c.ts', 'C', 'write_file');
    const list = s.list();
    expect(list.map((e) => e.path)).toEqual(['c.ts', 'b.ts', 'a.ts']);
    // Defensive copy — list() must not let callers mutate internal state.
    expect(s.size).toBe(3);
  });

  test('contentBefore=null records a new-file mutation', () => {
    const s = new FileSnapshotStack();
    s.push('new.ts', null, 'write_file');
    expect(s.pop()?.contentBefore).toBeNull();
  });

  test('empty string and zero-length path is silently ignored', () => {
    const s = new FileSnapshotStack();
    s.push('', 'X', 'write_file');
    expect(s.size).toBe(0);
  });

  test('clear empties the stack', () => {
    const s = new FileSnapshotStack();
    s.push('a.ts', 'A', 'write_file');
    s.push('b.ts', 'B', 'write_file');
    s.clear();
    expect(s.size).toBe(0);
    expect(s.list()).toHaveLength(0);
  });
});

describe('FileSnapshotStack — ring buffer at capacity', () => {
  test('default capacity is 10', () => {
    const s = new FileSnapshotStack();
    expect(s.maxCapacity).toBe(10);
  });

  test('eviction drops the oldest entry once capacity is exceeded', () => {
    const s = new FileSnapshotStack(3);
    s.push('a.ts', 'A', 'write_file');
    s.push('b.ts', 'B', 'write_file');
    s.push('c.ts', 'C', 'write_file');
    // 4th push evicts 'a.ts'.
    s.push('d.ts', 'D', 'write_file');
    expect(s.size).toBe(3);
    const list = s.list();
    expect(list.map((e) => e.path)).toEqual(['d.ts', 'c.ts', 'b.ts']);
  });

  test('exact capacity at 10 entries — 11th push evicts the oldest', () => {
    const s = new FileSnapshotStack(10);
    for (let i = 0; i < 10; i++) {
      s.push(`f${i}.ts`, `c${i}`, 'write_file');
    }
    expect(s.size).toBe(10);
    s.push('f10.ts', 'c10', 'write_file');
    expect(s.size).toBe(10);
    const list = s.list();
    // f0 should be gone; newest first is f10.
    expect(list[0]?.path).toBe('f10.ts');
    expect(list.map((e) => e.path)).not.toContain('f0.ts');
  });

  test('non-positive capacity falls back to the default', () => {
    const s = new FileSnapshotStack(0);
    expect(s.maxCapacity).toBe(10);
    const s2 = new FileSnapshotStack(-5);
    expect(s2.maxCapacity).toBe(10);
    const s3 = new FileSnapshotStack(Number.NaN);
    expect(s3.maxCapacity).toBe(10);
  });
});

describe('FileSnapshotStack — process singleton', () => {
  beforeEach(() => {
    // Reset between tests so cross-test state doesn't leak.
    setProcessFileSnapshotStack(null);
  });

  test('getProcessFileSnapshotStack returns the same instance', () => {
    const a = getProcessFileSnapshotStack();
    const b = getProcessFileSnapshotStack();
    expect(a).toBe(b);
  });

  test('setProcessFileSnapshotStack replaces the singleton', () => {
    const fresh = new FileSnapshotStack(5);
    setProcessFileSnapshotStack(fresh);
    expect(getProcessFileSnapshotStack()).toBe(fresh);
  });
});
