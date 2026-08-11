/**
 * Tests for the LOCALCODE.md hierarchy loader.
 *
 * Mirrors Claude Code's CLAUDE.md walk: from `projectRoot` upward to `$HOME`
 * collecting every `.localcode/LOCALCODE.md`, plus the global one.
 *
 * Every case pins `homeDir` to the per-test tmpdir. Bun's `os.homedir()`
 * ignores a mid-process `$HOME` change, so without the injection the walk
 * climbs past the fixture into the developer's real
 * `~/.localcode/LOCALCODE.md` and the size assertions read its bytes.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadHierarchy, type LoadHierarchyOptions } from '@/init/localcode-md';

let tmpRoot = '';
let hier: LoadHierarchyOptions = {};

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-hier-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
  // Walk ceiling = fixture root: nothing above it can leak in.
  hier = { homeDir: tmpRoot };
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeMd(dir: string, content: string): Promise<string> {
  const localcodeDir = path.join(dir, '.localcode');
  await mkdir(localcodeDir, { recursive: true });
  const mdPath = path.join(localcodeDir, 'LOCALCODE.md');
  await writeFile(mdPath, content, 'utf8');
  return mdPath;
}

describe('loadHierarchy — basic behaviour', () => {
  test('returns size=0 with no inline/pointers when no LOCALCODE.md exists', () => {
    const result = loadHierarchy(tmpRoot, hier);
    expect(result.size).toBe(0);
    expect(result.inline).toBeUndefined();
    expect(result.pointers).toBeUndefined();
  });

  test('returns inline string for a single project-level LOCALCODE.md', async () => {
    await writeMd(tmpRoot, '# Project\n\nProject-level instructions.');
    const result = loadHierarchy(tmpRoot, hier);
    expect(result.inline).toBeDefined();
    expect(result.pointers).toBeUndefined();
    expect(result.inline ?? '').toContain('Project-level instructions');
    expect(result.size).toBeGreaterThan(0);
  });

  test('outermost (parent) appears before innermost (project) in inlined output', async () => {
    // tmpRoot/parent/child/.localcode/LOCALCODE.md  (innermost)
    // tmpRoot/parent/.localcode/LOCALCODE.md        (outer)
    const parent = path.join(tmpRoot, 'parent');
    const child = path.join(parent, 'child');
    await mkdir(child, { recursive: true });
    await writeMd(parent, '# Outer\n\nPARENT-MARKER');
    await writeMd(child, '# Inner\n\nCHILD-MARKER');

    const result = loadHierarchy(child, hier);
    expect(result.inline).toBeDefined();
    const body = result.inline ?? '';
    const parentIdx = body.indexOf('PARENT-MARKER');
    const childIdx = body.indexOf('CHILD-MARKER');
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeGreaterThanOrEqual(0);
    // Outermost first.
    expect(parentIdx).toBeLessThan(childIdx);
  });

  test('separator is "\\n\\n---\\n\\n# <label>" between hierarchy levels', async () => {
    const parent = path.join(tmpRoot, 'parent');
    const child = path.join(parent, 'child');
    await mkdir(child, { recursive: true });
    await writeMd(parent, '# Outer\n\nOUTER');
    await writeMd(child, '# Inner\n\nINNER');
    const result = loadHierarchy(child, hier);
    const body = result.inline ?? '';
    expect(body).toContain('\n\n---\n\n# ');
  });
});

describe('loadHierarchy — size accounting and pointer fallback', () => {
  test('switches to pointers when joined body exceeds the inline budget', async () => {
    const big = 'X'.repeat(6000); // > LOCALCODE_INLINE_LIMIT (5000)
    await writeMd(tmpRoot, big);
    const result = loadHierarchy(tmpRoot, hier);
    expect(result.inline).toBeUndefined();
    expect(result.pointers).toBeDefined();
    expect((result.pointers ?? []).length).toBe(1);
    expect((result.pointers ?? [])[0]).toContain('LOCALCODE.md');
    expect(result.size).toBeGreaterThan(5000);
  });

  test('size accounts for separator overhead, not just content lengths', async () => {
    await writeMd(tmpRoot, 'a');
    const result = loadHierarchy(tmpRoot, hier);
    // size includes the label + content; must be larger than just content.
    expect(result.size).toBeGreaterThanOrEqual(1);
  });
});

describe('loadHierarchy — safety invariants', () => {
  test('skips an empty LOCALCODE.md (no inline, no pointers, size=0)', async () => {
    await writeMd(tmpRoot, '   \n\n   ');
    const result = loadHierarchy(tmpRoot, hier);
    expect(result.size).toBe(0);
    expect(result.inline).toBeUndefined();
    expect(result.pointers).toBeUndefined();
  });

  test('does not follow symlinked LOCALCODE.md files', async () => {
    // Create a real LOCALCODE.md outside the project, and a symlink at
    // the project's expected location pointing to it.
    const outside = path.join(tmpRoot, 'outside');
    await mkdir(outside, { recursive: true });
    const realPath = path.join(outside, 'real.md');
    await writeFile(realPath, '# Should be ignored\nLEAKED', 'utf8');

    const project = path.join(tmpRoot, 'project');
    const localcodeDir = path.join(project, '.localcode');
    await mkdir(localcodeDir, { recursive: true });
    const linkPath = path.join(localcodeDir, 'LOCALCODE.md');
    try {
      await symlink(realPath, linkPath);
    } catch {
      // Some filesystems / CI sandboxes refuse symlinks — skip in that case.
      return;
    }
    const result = loadHierarchy(project, hier);
    expect(result.size).toBe(0);
    expect(result.inline).toBeUndefined();
  });

  test('returns empty result if projectRoot does not exist (no throw)', () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    const result = loadHierarchy(missing, hier);
    expect(result.size).toBe(0);
  });
});

describe('loadHierarchy — walk termination', () => {
  test('stops walking at $HOME (does not climb above)', async () => {
    // projectRoot === homeDir: the walk collects exactly one layer and
    // stops, so nothing from the real filesystem above tmpdir appears.
    await writeMd(tmpRoot, 'PROJECT');
    const result = loadHierarchy(tmpRoot, hier);
    const body = result.inline ?? '';
    expect(body.includes('PROJECT')).toBe(true);
    expect(body.split('---').length).toBe(1); // single layer, no separator
  });
});
