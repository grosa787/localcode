/**
 * MemoryStore unit tests.
 *
 * Covers: write/read/list/remove, frontmatter validation, atomic write
 * semantics (tmp→rename), and rebuildIndex correctness.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { MemoryStore, MemoryStoreError } from '@/memory/store';
import type { MemoryEntry } from '@/memory/types';

let tempDir: string;
let projectRoot: string;
let store: MemoryStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-mem-'));
  projectRoot = join(tempDir, 'project');
  store = new MemoryStore(projectRoot);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    name: 'test-entry',
    description: 'A test memory entry',
    type: 'project',
    body: 'This is the body.',
    path: '',
    ...overrides,
  };
}

describe('MemoryStore.list', () => {
  test('returns empty array when directory does not exist', async () => {
    const entries = await store.list();
    expect(entries).toEqual([]);
  });

  test('returns entries after write', async () => {
    await store.write(makeEntry({ name: 'alpha', description: 'Alpha entry' }));
    await store.write(makeEntry({ name: 'beta', description: 'Beta entry' }));
    const entries = await store.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe('alpha');
    expect(entries[1]?.name).toBe('beta');
  });

  test('sorts entries by name deterministically', async () => {
    await store.write(makeEntry({ name: 'zebra', description: 'Z' }));
    await store.write(makeEntry({ name: 'alpha', description: 'A' }));
    await store.write(makeEntry({ name: 'middle', description: 'M' }));
    const entries = await store.list();
    expect(entries.map((e) => e.name)).toEqual(['alpha', 'middle', 'zebra']);
  });

  test('skips MEMORY.md index file', async () => {
    await store.write(makeEntry({ name: 'real-entry', description: 'Real' }));
    const entries = await store.list();
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('MEMORY');
    expect(names).toContain('real-entry');
  });
});

describe('MemoryStore.get', () => {
  test('returns null for non-existent entry', async () => {
    const entry = await store.get('nonexistent');
    expect(entry).toBeNull();
  });

  test('returns entry after write', async () => {
    await store.write(makeEntry({ name: 'my-entry', description: 'My desc', type: 'user', body: 'hello' }));
    const entry = await store.get('my-entry');
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe('my-entry');
    expect(entry?.description).toBe('My desc');
    expect(entry?.type).toBe('user');
    expect(entry?.body).toBe('hello');
  });
});

describe('MemoryStore.write', () => {
  test('creates the memory directory if missing', async () => {
    await store.write(makeEntry());
    const dir = join(projectRoot, '.localcode', 'memory');
    expect(existsSync(dir)).toBe(true);
  });

  test('writes frontmatter + body to disk', async () => {
    await store.write(makeEntry({ name: 'persist-test', description: 'Persist', body: 'body text' }));
    const fp = join(projectRoot, '.localcode', 'memory', 'persist-test.md');
    expect(existsSync(fp)).toBe(true);
    const raw = readFileSync(fp, 'utf8');
    expect(raw).toContain('name: persist-test');
    expect(raw).toContain('description: Persist');
    expect(raw).toContain('type: project');
    expect(raw).toContain('body text');
  });

  test('returns entry with correct path set', async () => {
    const result = await store.write(makeEntry({ name: 'check-path' }));
    expect(result.path).toContain('check-path.md');
  });

  test('overwrites existing entry', async () => {
    await store.write(makeEntry({ name: 'overwrite-me', body: 'old body' }));
    await store.write(makeEntry({ name: 'overwrite-me', body: 'new body' }));
    const entry = await store.get('overwrite-me');
    expect(entry?.body).toBe('new body');
  });

  test('no orphan .tmp file left on successful write', async () => {
    await store.write(makeEntry({ name: 'clean-tmp' }));
    const tmp = join(projectRoot, '.localcode', 'memory', 'clean-tmp.md.tmp');
    expect(existsSync(tmp)).toBe(false);
  });

  test('throws MemoryStoreError for invalid name', async () => {
    await expect(
      store.write(makeEntry({ name: 'INVALID NAME' })),
    ).rejects.toBeInstanceOf(MemoryStoreError);
  });

  test('throws MemoryStoreError for empty description', async () => {
    await expect(
      store.write(makeEntry({ description: '' })),
    ).rejects.toBeInstanceOf(MemoryStoreError);
  });

  test('throws MemoryStoreError for invalid type', async () => {
    await expect(
      store.write(makeEntry({ type: 'invalid' as never })),
    ).rejects.toBeInstanceOf(MemoryStoreError);
  });

  test('all four memory types are valid', async () => {
    for (const type of ['user', 'feedback', 'project', 'reference'] as const) {
      await expect(
        store.write(makeEntry({ name: `entry-${type}`, type })),
      ).resolves.toBeDefined();
    }
  });
});

describe('MemoryStore.remove', () => {
  test('silently succeeds for non-existent entry', async () => {
    await expect(store.remove('nonexistent')).resolves.toBeUndefined();
  });

  test('removes the file from disk', async () => {
    await store.write(makeEntry({ name: 'to-remove' }));
    const fp = join(projectRoot, '.localcode', 'memory', 'to-remove.md');
    expect(existsSync(fp)).toBe(true);
    await store.remove('to-remove');
    expect(existsSync(fp)).toBe(false);
  });

  test('entry no longer appears in list after remove', async () => {
    await store.write(makeEntry({ name: 'removable' }));
    await store.remove('removable');
    const entries = await store.list();
    expect(entries.map((e) => e.name)).not.toContain('removable');
  });

  test('throws for empty name', async () => {
    await expect(store.remove('')).rejects.toBeInstanceOf(MemoryStoreError);
  });
});

describe('MemoryStore.rebuildIndex', () => {
  test('creates empty index when no entries', async () => {
    // Need to create directory first for rebuildIndex to work
    await store.write(makeEntry({ name: 'temp' }));
    await store.remove('temp');
    const index = await store.rebuildIndex();
    expect(index).toContain('(no entries)');
  });

  test('index contains all entry names and descriptions', async () => {
    await store.write(makeEntry({ name: 'alpha', description: 'Alpha entry' }));
    await store.write(makeEntry({ name: 'beta', description: 'Beta entry' }));
    const indexFp = join(projectRoot, '.localcode', 'memory', 'MEMORY.md');
    const raw = readFileSync(indexFp, 'utf8');
    expect(raw).toContain('alpha');
    expect(raw).toContain('Alpha entry');
    expect(raw).toContain('beta');
    expect(raw).toContain('Beta entry');
  });

  test('index is sorted by name', async () => {
    await store.write(makeEntry({ name: 'zebra', description: 'Z' }));
    await store.write(makeEntry({ name: 'alpha', description: 'A' }));
    const indexFp = join(projectRoot, '.localcode', 'memory', 'MEMORY.md');
    const raw = readFileSync(indexFp, 'utf8');
    const alphaPos = raw.indexOf('alpha');
    const zebraPos = raw.indexOf('zebra');
    expect(alphaPos).toBeLessThan(zebraPos);
  });

  test('no orphan .tmp file left on successful rebuildIndex', async () => {
    await store.write(makeEntry({ name: 'idx-tmp-test' }));
    const tmp = join(projectRoot, '.localcode', 'memory', 'MEMORY.md.tmp');
    expect(existsSync(tmp)).toBe(false);
  });
});
