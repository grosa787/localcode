/**
 * Structural validity of the golden-task catalog. These run with no
 * model — they only assert each fixture is well-formed and deterministic
 * by construction.
 */

import { describe, expect, test } from 'bun:test';

import { GOLDEN_TASKS, findTaskById, listTaskIds } from '@/eval/tasks';

describe('golden task catalog', () => {
  test('ships at least ten golden tasks', () => {
    expect(GOLDEN_TASKS.length).toBeGreaterThanOrEqual(10);
  });

  test('every task id is unique and non-empty', () => {
    const ids = GOLDEN_TASKS.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
    }
  });

  test('every task is structurally valid', () => {
    for (const task of GOLDEN_TASKS) {
      // Title + tags present.
      expect(task.title.length).toBeGreaterThan(0);
      expect(Array.isArray(task.tags)).toBe(true);
      expect(task.tags.length).toBeGreaterThan(0);

      // A non-empty prompt.
      expect(task.prompt.trim().length).toBeGreaterThan(0);

      // A scaffold with at least one file (path → content).
      const files = Object.entries(task.scaffold.files);
      expect(files.length).toBeGreaterThan(0);
      for (const [relPath, content] of files) {
        expect(relPath.length).toBeGreaterThan(0);
        // Scaffold paths must be repo-relative (no leading slash, no `..`).
        expect(relPath.startsWith('/')).toBe(false);
        expect(relPath.includes('..')).toBe(false);
        expect(typeof content).toBe('string');
      }

      // A positive turn cap.
      expect(task.maxTurns).toBeGreaterThan(0);

      // A well-formed success check.
      const check = task.success;
      if (check.kind === 'command') {
        expect(check.cmd.trim().length).toBeGreaterThan(0);
      } else {
        expect(check.kind).toBe('fileContains');
        expect(check.path.length).toBeGreaterThan(0);
        expect(check.needle.length).toBeGreaterThan(0);
      }
    }
  });

  test('covers the required task categories via tags', () => {
    const allTags = new Set<string>();
    for (const t of GOLDEN_TASKS) {
      for (const tag of t.tags) allTags.add(tag);
    }
    for (const expected of [
      'implement',
      'fix',
      'refactor',
      'test',
      'types',
      'error-handling',
      'export',
      'rename',
    ]) {
      expect(allTags.has(expected)).toBe(true);
    }
  });

  test('command success checks use offline runners only', () => {
    // Guard against accidentally introducing a network-dependent check.
    const networkTokens = ['curl', 'wget', 'http://', 'https://', 'npm install'];
    for (const task of GOLDEN_TASKS) {
      if (task.success.kind !== 'command') continue;
      const cmd = task.success.cmd;
      for (const token of networkTokens) {
        expect(cmd.includes(token)).toBe(false);
      }
    }
  });

  test('findTaskById returns a task by id and null otherwise', () => {
    const first = GOLDEN_TASKS[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(findTaskById(first.id)?.id).toBe(first.id);
    // Whitespace is trimmed.
    expect(findTaskById(`  ${first.id}  `)?.id).toBe(first.id);
    expect(findTaskById('does-not-exist')).toBeNull();
  });

  test('listTaskIds returns every id in catalog order', () => {
    expect(listTaskIds()).toEqual(GOLDEN_TASKS.map((t) => t.id));
  });
});
