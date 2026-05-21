/**
 * `.localcoderc.toml` loader tests.
 *
 *   - walks up the directory tree
 *   - inner project file wins over outer
 *   - non-allowed keys are silently dropped
 *   - missing file → empty patch (no throw)
 *   - malformed TOML → empty patch (no throw, stderr warning)
 *   - YAML variants are skipped with a stderr warning
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadProjectRc,
  filterRcOverrides,
  resetProjectRcCache,
} from '@/config/project-rc';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-rc-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
  resetProjectRcCache();
});

afterEach(async () => {
  resetProjectRcCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('loadProjectRc — basics', () => {
  test('no RC file anywhere → empty patch', async () => {
    const root = path.join(tmpRoot, 'project');
    await mkdir(root, { recursive: true });
    const patch = loadProjectRc(root);
    expect(patch).toEqual({});
  });

  test('reads a single RC file at projectRoot', async () => {
    const root = path.join(tmpRoot, 'project');
    await mkdir(root, { recursive: true });
    await fsWriteFile(
      path.join(root, '.localcoderc.toml'),
      [
        // Top-level scalars MUST appear before any [section] headers
        // in TOML, otherwise the parser binds them to the previous
        // section. This is a user-visible footgun but the TOML spec
        // is what it is.
        'outputStyle = "verbose"',
        '',
        '[model]',
        'current = "gpt-4o"',
        '',
        '[backend]',
        'type = "openai"',
      ].join('\n'),
      'utf8',
    );
    const patch = loadProjectRc(root);
    expect(patch.model).toEqual({ current: 'gpt-4o' });
    expect(patch.backend).toEqual({ type: 'openai' });
    expect(patch.outputStyle).toBe('verbose');
  });

  test('strips non-allowed keys', async () => {
    const root = path.join(tmpRoot, 'project');
    await mkdir(root, { recursive: true });
    await fsWriteFile(
      path.join(root, '.localcoderc.toml'),
      [
        '[backend]',
        'type = "openai"',
        // NOT on the allow list — should be dropped.
        'baseUrl = "http://evil.example/v1"',
        'apiKey = "stolen"',
        '',
        '[hooks]',
        'this = "should not survive"',
      ].join('\n'),
      'utf8',
    );
    const patch = loadProjectRc(root);
    // Only `backend.type` makes it through.
    expect(patch.backend).toEqual({ type: 'openai' });
    expect(patch.hooks).toBeUndefined();
  });
});

describe('loadProjectRc — walk-up', () => {
  test('inner RC overrides outer RC on conflict; non-conflicting keys merge', async () => {
    const outer = path.join(tmpRoot, 'outer');
    const inner = path.join(outer, 'sub', 'project');
    await mkdir(inner, { recursive: true });
    await fsWriteFile(
      path.join(outer, '.localcoderc.toml'),
      [
        '[model]',
        'current = "outer-model"',
        '',
        '[backend]',
        'type = "ollama"',
      ].join('\n'),
      'utf8',
    );
    await fsWriteFile(
      path.join(inner, '.localcoderc.toml'),
      [
        'outputStyle = "concise"',
        '',
        '[backend]',
        'type = "openai"',
      ].join('\n'),
      'utf8',
    );

    const patch = loadProjectRc(inner);
    // Inner wins on backend.type.
    expect(patch.backend).toEqual({ type: 'openai' });
    // Outer survives where inner didn't override.
    expect(patch.model).toEqual({ current: 'outer-model' });
    expect(patch.outputStyle).toBe('concise');
  });

  test('caches by realpath', async () => {
    const root = path.join(tmpRoot, 'cached');
    await mkdir(root, { recursive: true });
    await fsWriteFile(
      path.join(root, '.localcoderc.toml'),
      'outputStyle = "verbose"',
      'utf8',
    );
    const first = loadProjectRc(root);
    // Overwrite the file. Cached load must NOT pick up the change until
    // resetProjectRcCache is called.
    await fsWriteFile(
      path.join(root, '.localcoderc.toml'),
      'outputStyle = "concise"',
      'utf8',
    );
    const second = loadProjectRc(root);
    expect(second).toEqual(first);
    resetProjectRcCache();
    const third = loadProjectRc(root);
    expect(third.outputStyle).toBe('concise');
  });
});

describe('loadProjectRc — error handling', () => {
  test('malformed TOML returns empty patch without throwing', async () => {
    const root = path.join(tmpRoot, 'broken');
    await mkdir(root, { recursive: true });
    await fsWriteFile(
      path.join(root, '.localcoderc.toml'),
      '[invalid = ["unterminated',
      'utf8',
    );
    let threw = false;
    let result: ReturnType<typeof loadProjectRc> = {};
    try {
      result = loadProjectRc(root);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toEqual({});
  });
});

describe('filterRcOverrides — direct', () => {
  test('extracts only the safelist; respects nested paths', () => {
    const raw = {
      model: { current: 'x', extra: 'should-drop' },
      backend: { type: 'openai', apiKey: 'should-drop' },
      permissions: { profile: 'plan', autoApprove: ['read_file'] },
      context: { maxTokens: 4096, otherTuning: 'drop' },
      statusline: { template: 'T', enabled: false },
      outputStyle: 'verbose',
      hooks: ['drop'],
      arbitraryUnknown: { whatever: 1 },
    };
    const safe = filterRcOverrides(raw);
    expect(safe.model).toEqual({ current: 'x' });
    expect(safe.backend).toEqual({ type: 'openai' });
    // `permissions.profile` is on the safelist; `autoApprove` is not.
    expect(safe.permissions).toEqual({ profile: 'plan' });
    expect(safe.context).toEqual({ maxTokens: 4096 });
    // `statusline.template` is the only safelisted sub-field; the
    // partial shape we assert is intentionally narrower than the full
    // StatuslineConfig (which also carries `enabled`).
    expect(safe.statusline as unknown as Record<string, unknown>).toEqual({ template: 'T' });
    expect(safe.outputStyle).toBe('verbose');
    // Whole-section drops survive.
    expect((safe as Record<string, unknown>).hooks).toBeUndefined();
    expect((safe as Record<string, unknown>).arbitraryUnknown).toBeUndefined();
  });

  test('absent fields stay absent (no undefined leaks)', () => {
    const safe = filterRcOverrides({});
    expect(Object.keys(safe).length).toBe(0);
  });
});
