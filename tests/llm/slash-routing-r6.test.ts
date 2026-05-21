/**
 * R6 (Agent 8) — `isCommandShape` slash-routing classifier.
 *
 * `isCommandShape(trimmed)` is the defense-in-depth heuristic in
 * `src/app.tsx` that decides whether a slash-prefixed input is a
 * command (intercept, do NOT send to the LLM) or a file path / URL
 * (let through).
 *
 * Pre-conditions for the function (the caller in `app.tsx::submit`
 * already checks these):
 *   - `trimmed === text.trim()`
 *   - `trimmed.startsWith('/')`
 *   - `!trimmed.startsWith('//')` (escape form is handled separately)
 *
 * Behaviour:
 *   - Bare `/` → command-shape (true).
 *   - `/<clean-ident>` with NO further `/` → command-shape (true),
 *     even if there are space-separated args.
 *   - Anything containing a second `/` somewhere → path-shape (false).
 *   - First segment that is NOT a clean identifier (digits, dots, etc.
 *     leading the first word) → path-shape (false).
 *
 * The clean-identifier regex is `^[a-zA-Z][a-zA-Z0-9_-]*$` (must start
 * with an ASCII letter, then letters/digits/underscores/hyphens only).
 *
 * Coverage matrix:
 *   Command-shape (returns true):
 *     `/`                            (bare)
 *     `/permissions`
 *     `/permissions add write_file`  (clean ident + args)
 *     `/Settings`                    (mixed case)
 *     `/CTXSIZE 80000`
 *     `/help-me`                     (hyphen ok)
 *     `/foo_bar`                     (underscore ok)
 *
 *   Path-shape (returns false):
 *     `/Users/me/foo.png`
 *     `/var/log/system.log`
 *     `/usr/local/bin`
 *     `/etc/hosts`
 *     `/123abc`                      (digit-leading first segment)
 *     `/.localcode`                  (dot-leading)
 *     `/path with/space`             (second `/` after space)
 *     `/foo-bar/baz`                 (slash inside)
 */
import { describe, test, expect } from 'bun:test';
import { isCommandShape } from '@/app';

describe('isCommandShape — bare slash and clean-identifier commands (R6)', () => {
  test('bare `/` is command-shape', () => {
    expect(isCommandShape('/')).toBe(true);
  });

  test('`/permissions` is command-shape', () => {
    expect(isCommandShape('/permissions')).toBe(true);
  });

  test('`/permissions add write_file` is command-shape (args ok)', () => {
    expect(isCommandShape('/permissions add write_file')).toBe(true);
  });

  test('mixed-case `/Settings` is command-shape (case-insensitive ident)', () => {
    expect(isCommandShape('/Settings')).toBe(true);
  });

  test('all-uppercase `/CTXSIZE 80000` is command-shape', () => {
    expect(isCommandShape('/CTXSIZE 80000')).toBe(true);
  });

  test('underscore in name `/foo_bar` is command-shape', () => {
    expect(isCommandShape('/foo_bar')).toBe(true);
  });

  test('hyphen in name `/help-me` is command-shape', () => {
    expect(isCommandShape('/help-me')).toBe(true);
  });

  test('digits after first letter `/cmd1` are allowed', () => {
    expect(isCommandShape('/cmd1')).toBe(true);
  });

  test('whitespace-suffixed args do not break command-shape', () => {
    expect(isCommandShape('/compress')).toBe(true);
    expect(isCommandShape('/resume sess-abcd-1234')).toBe(true);
  });
});

describe('isCommandShape — paths flow through to LLM (R6)', () => {
  test('`/Users/...` is NOT command-shape', () => {
    expect(isCommandShape('/Users/me/foo.png')).toBe(false);
  });

  test('`/var/log/...` is NOT command-shape', () => {
    expect(isCommandShape('/var/log/system.log')).toBe(false);
  });

  test('`/usr/local/bin` is NOT command-shape', () => {
    expect(isCommandShape('/usr/local/bin')).toBe(false);
  });

  test('`/etc/hosts` is NOT command-shape', () => {
    expect(isCommandShape('/etc/hosts')).toBe(false);
  });

  test('`/home/foo` is NOT command-shape', () => {
    expect(isCommandShape('/home/foo')).toBe(false);
  });

  test('`/tmp/scratch.txt` is NOT command-shape', () => {
    expect(isCommandShape('/tmp/scratch.txt')).toBe(false);
  });

  test('any second `/` in the input → path-shape (no command match)', () => {
    expect(isCommandShape('/foo/bar')).toBe(false);
    expect(isCommandShape('/foo bar/baz')).toBe(false);
    expect(isCommandShape('/cmd-name/sub-arg')).toBe(false);
  });

  test('digit-leading first segment is path-shape', () => {
    // `/123abc` does not look like a command — it's an unusual path.
    expect(isCommandShape('/123abc')).toBe(false);
    expect(isCommandShape('/9foo')).toBe(false);
  });

  test('dot-leading first segment is path-shape', () => {
    expect(isCommandShape('/.localcode')).toBe(false);
    expect(isCommandShape('/.bashrc')).toBe(false);
  });

  test('special chars in the first segment make it path-shape', () => {
    expect(isCommandShape('/file.txt')).toBe(false);
    expect(isCommandShape('/foo$bar')).toBe(false);
    expect(isCommandShape('/(parens)')).toBe(false);
  });
});

describe('isCommandShape — clean-identifier rule (R6)', () => {
  test('letters-only first segment → command', () => {
    expect(isCommandShape('/abc')).toBe(true);
  });

  test('letters and digits (digits not leading) → command', () => {
    expect(isCommandShape('/cmd2024')).toBe(true);
    expect(isCommandShape('/version2')).toBe(true);
  });

  test('mixed underscores and hyphens are still a clean ident', () => {
    expect(isCommandShape('/a-b_c')).toBe(true);
    expect(isCommandShape('/A_B-C')).toBe(true);
  });

  test('dots in the first segment break clean-ident rule', () => {
    expect(isCommandShape('/foo.bar')).toBe(false);
    expect(isCommandShape('/v2.0')).toBe(false);
  });

  test('non-ASCII letters in first segment are not allowed', () => {
    // Cyrillic `привет` is a path-shape under the current heuristic
    // (the regex is ASCII-only). Documented behaviour.
    expect(isCommandShape('/привет')).toBe(false);
  });
});

describe('isCommandShape — args / second-slash interaction (R6)', () => {
  test('clean ident + space-separated args (no `/` in args) → command', () => {
    expect(isCommandShape('/permissions add write_file')).toBe(true);
    expect(isCommandShape('/ctxsize 32768')).toBe(true);
    expect(isCommandShape('/resume some-session-id')).toBe(true);
  });

  test('clean ident BUT a `/` appears later (anywhere) → path', () => {
    expect(isCommandShape('/cmd /sub')).toBe(false);
    expect(isCommandShape('/cmd arg/value')).toBe(false);
    expect(isCommandShape('/cmd arg with /slash')).toBe(false);
  });

  test('two-segment path even with hyphen-only chars → path', () => {
    expect(isCommandShape('/a-b/c-d')).toBe(false);
  });
});

describe('isCommandShape — never-throws contract (R6)', () => {
  test('does not throw on any reasonable string starting with /', () => {
    const inputs = [
      '/',
      '/a',
      '/a b',
      '/a/b/c',
      '/a-b-c',
      '/a_b_c',
      '/123',
      '/foo bar baz qux',
    ];
    for (const s of inputs) {
      expect(() => isCommandShape(s)).not.toThrow();
    }
  });
});
