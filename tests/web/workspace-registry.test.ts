import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceRegistry } from '@/web/workspace/workspace-registry';

let tempDir: string;
let workspacesPath: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'localcode-ws-'));
  workspacesPath = join(tempDir, 'workspaces.json');
  projectA = join(tempDir, 'projA');
  projectB = join(tempDir, 'projB');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('WorkspaceRegistry', () => {
  test('starts empty when no file exists', () => {
    const reg = new WorkspaceRegistry({ filePath: workspacesPath });
    expect(reg.list()).toEqual([]);
  });

  test('create persists with atomic write and dedupes by root', () => {
    const reg = new WorkspaceRegistry({ filePath: workspacesPath });
    const first = reg.create(projectA, 'Alpha');
    expect(first.root).toBe(projectA);
    expect(first.label).toBe('Alpha');
    expect(existsSync(workspacesPath)).toBe(true);

    // The temp file must be cleaned up by the rename.
    expect(existsSync(`${workspacesPath}.tmp`)).toBe(false);

    // Re-create same root → returns the same id, touches lastUsedAt.
    const again = reg.create(projectA);
    expect(again.id).toBe(first.id);
    expect(again.lastUsedAt).toBeGreaterThanOrEqual(first.lastUsedAt);
    expect(reg.list()).toHaveLength(1);
  });

  test('rejects non-existent or non-directory roots', () => {
    const reg = new WorkspaceRegistry({ filePath: workspacesPath });
    expect(() => reg.create(join(tempDir, 'does-not-exist'))).toThrow();
    const filePath = join(tempDir, 'a-file');
    writeFileSync(filePath, 'x');
    expect(() => reg.create(filePath)).toThrow();
  });

  test('list orders by lastUsedAt desc', async () => {
    const reg = new WorkspaceRegistry({ filePath: workspacesPath });
    const a = reg.create(projectA);
    await new Promise((r) => setTimeout(r, 5));
    const b = reg.create(projectB);
    const list = reg.list();
    expect(list[0]?.id).toBe(b.id);
    expect(list[1]?.id).toBe(a.id);
    // Touch A → it floats to top.
    reg.touch(a.id);
    const refreshed = reg.list();
    expect(refreshed[0]?.id).toBe(a.id);
  });

  test('remove returns false for unknown id, true for known', () => {
    const reg = new WorkspaceRegistry({ filePath: workspacesPath });
    const w = reg.create(projectA);
    expect(reg.remove('not-real')).toBe(false);
    expect(reg.remove(w.id)).toBe(true);
    expect(reg.list()).toHaveLength(0);
  });

  test('recovers from corruption by backing up the bad file', () => {
    mkdirSync(join(workspacesPath, '..'), { recursive: true });
    writeFileSync(workspacesPath, '{this is not valid json');
    const reg = new WorkspaceRegistry({ filePath: workspacesPath });
    expect(reg.list()).toEqual([]);
    // A backup file should be present alongside the original path.
    const dirEntries = require('node:fs').readdirSync(join(workspacesPath, '..')) as string[];
    expect(dirEntries.some((n: string) => n.startsWith('workspaces.json.') && n.endsWith('.bak'))).toBe(true);
  });

  test('JSON is well-formed after multiple writes', () => {
    const reg = new WorkspaceRegistry({ filePath: workspacesPath });
    reg.create(projectA);
    reg.create(projectB);
    const raw = readFileSync(workspacesPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version: number; workspaces: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.workspaces).toHaveLength(2);
  });
});
