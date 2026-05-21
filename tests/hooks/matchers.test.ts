/**
 * Hook glob matcher tests. The matcher only handles a narrow shape
 * (single-segment tool names) so the test surface is small.
 */
import { describe, expect, test } from 'bun:test';
import { matchesGlob, globToRegex } from '@/hooks';

describe('matchesGlob', () => {
  test('`*` matches all', () => {
    expect(matchesGlob('*', 'write_file')).toBe(true);
    expect(matchesGlob('*', 'read_file')).toBe(true);
    expect(matchesGlob('*', '')).toBe(true);
  });

  test('omitted / empty pattern matches all (TOML "no pattern" path)', () => {
    expect(matchesGlob(undefined, 'write_file')).toBe(true);
    expect(matchesGlob('', 'write_file')).toBe(true);
  });

  test('exact name match', () => {
    expect(matchesGlob('write_file', 'write_file')).toBe(true);
    expect(matchesGlob('write_file', 'read_file')).toBe(false);
  });

  test('`write_*` matches write_file / write_anything (suffix glob)', () => {
    expect(matchesGlob('write_*', 'write_file')).toBe(true);
    expect(matchesGlob('write_*', 'write_anything')).toBe(true);
    expect(matchesGlob('write_*', 'write_')).toBe(true);
    expect(matchesGlob('write_*', 'read_file')).toBe(false);
  });

  test('`?` matches exactly one character', () => {
    expect(matchesGlob('git_lo?', 'git_log')).toBe(true);
    expect(matchesGlob('git_lo?', 'git_loop')).toBe(false);
    expect(matchesGlob('git_lo?', 'git_lo')).toBe(false);
  });

  test('character classes work', () => {
    expect(matchesGlob('git_l[ao]g', 'git_log')).toBe(true);
    expect(matchesGlob('git_l[ao]g', 'git_lag')).toBe(true);
    expect(matchesGlob('git_l[ao]g', 'git_lug')).toBe(false);
  });

  test('negated character classes work', () => {
    expect(matchesGlob('[!w]rite_file', 'frite_file')).toBe(true);
    expect(matchesGlob('[!w]rite_file', 'write_file')).toBe(false);
  });

  test('regex metacharacters are escaped', () => {
    // `.` should be a literal dot, not "any char".
    expect(matchesGlob('a.b', 'aXb')).toBe(false);
    expect(matchesGlob('a.b', 'a.b')).toBe(true);
    expect(matchesGlob('foo$', 'foo$')).toBe(true);
    expect(matchesGlob('foo$', 'foox')).toBe(false);
  });

  test('match is anchored end-to-end', () => {
    // `write` should match write only — not write_file.
    expect(matchesGlob('write', 'write')).toBe(true);
    expect(matchesGlob('write', 'write_file')).toBe(false);
  });
});

describe('globToRegex', () => {
  test('produces an anchored regex', () => {
    const re = globToRegex('git_*');
    expect(re.source.startsWith('^')).toBe(true);
    expect(re.source.endsWith('$')).toBe(true);
  });

  test('unclosed `[` is treated as literal', () => {
    const re = globToRegex('foo[bar');
    expect(re.test('foo[bar')).toBe(true);
    expect(re.test('foob')).toBe(false);
  });
});
