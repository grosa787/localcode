/**
 * Tests for the syntax-highlight helpers powering ROADMAP #3.
 *
 * These tests focus on PURE-FUNCTION behaviour: language normalisation,
 * heuristic detection, line-count reconciliation, and graceful fallback.
 * The React layer (`<CodeBlock>`) is tested separately — here we just
 * make sure the engine plumbing is bullet-proof so the visual layer
 * has stable inputs.
 *
 * Why no snapshot of ANSI output? Because cli-highlight's escape
 * sequences are version-sensitive (a future highlight.js bump can
 * legitimately reorder span boundaries) and we don't want the CI to
 * red-flag aesthetic drift. We assert on *structural* properties:
 *   - returns a string,
 *   - line count matches the input,
 *   - contains ANSI escape sequences when a language was applied,
 *   - does NOT contain escape sequences in the unconditional plain
 *     fallback case for an empty string.
 */

import { describe, test, expect } from 'bun:test';
import {
  detectLanguage,
  highlightCode,
  normaliseLanguage,
  resolveLanguage,
  __TEST_THEME,
} from '@/ui/highlighting/syntax-highlight';

const ESC = '\x1b';
const hasAnsi = (s: string): boolean => s.includes(ESC + '[');

describe('normaliseLanguage', () => {
  test('returns undefined for undefined / empty input', () => {
    expect(normaliseLanguage(undefined)).toBeUndefined();
    expect(normaliseLanguage('')).toBeUndefined();
    expect(normaliseLanguage('   ')).toBeUndefined();
  });

  test('lowercases and trims fence labels', () => {
    expect(normaliseLanguage('  TypeScript  ')).toBe('typescript');
    expect(normaliseLanguage('Python')).toBe('python');
  });

  test('resolves common aliases', () => {
    expect(normaliseLanguage('ts')).toBe('typescript');
    expect(normaliseLanguage('tsx')).toBe('typescript');
    expect(normaliseLanguage('js')).toBe('javascript');
    expect(normaliseLanguage('py')).toBe('python');
    expect(normaliseLanguage('rs')).toBe('rust');
    expect(normaliseLanguage('golang')).toBe('go');
    expect(normaliseLanguage('sh')).toBe('bash');
    expect(normaliseLanguage('zsh')).toBe('bash');
    expect(normaliseLanguage('yml')).toBe('yaml');
  });

  test('passes through native highlight.js ids', () => {
    expect(normaliseLanguage('typescript')).toBe('typescript');
    expect(normaliseLanguage('rust')).toBe('rust');
    expect(normaliseLanguage('python')).toBe('python');
    expect(normaliseLanguage('go')).toBe('go');
  });

  test('returns undefined for unsupported labels', () => {
    expect(normaliseLanguage('totally-not-a-real-language-12345')).toBeUndefined();
  });
});

describe('detectLanguage — confident hits', () => {
  test('detects TypeScript by interface + import shape', () => {
    const code = `
import { Foo } from './foo';

interface Bar {
  name: string;
  count: number;
}

const x: Bar = { name: 'hi', count: 42 };
`;
    expect(detectLanguage(code)).toBe('typescript');
  });

  test('detects Python by def + self', () => {
    const code = `
def hello(name):
    print("Hello, " + name)
    return self.value
`;
    expect(detectLanguage(code)).toBe('python');
  });

  test('detects Go by package + func + fmt.Print', () => {
    const code = `
package main

import "fmt"

func main() {
    fmt.Println("Hello, World!")
}
`;
    expect(detectLanguage(code)).toBe('go');
  });

  test('detects Rust by fn + let mut + Result', () => {
    const code = `
fn main() -> Result<(), Error> {
    let mut x = 10;
    println!("{}", x);
    Ok(())
}
`;
    expect(detectLanguage(code)).toBe('rust');
  });

  test('detects bash by shebang + pipe', () => {
    const code = `#!/usr/bin/env bash
echo hello | grep h
`;
    expect(detectLanguage(code)).toBe('bash');
  });

  test('detects SQL by SELECT + FROM + WHERE + JOIN', () => {
    const code = `SELECT u.id, u.name FROM users u
JOIN orders o ON o.user_id = u.id
WHERE o.total > 100
`;
    expect(detectLanguage(code)).toBe('sql');
  });
});

describe('detectLanguage — abstains when ambiguous', () => {
  test('returns undefined for empty input', () => {
    expect(detectLanguage('')).toBeUndefined();
  });

  test('returns undefined for one-liner with no signal', () => {
    expect(detectLanguage('hello world')).toBeUndefined();
  });

  test('returns undefined for a single ambiguous keyword', () => {
    // Lone `function` could be JS/TS but with no other signal we abstain.
    expect(detectLanguage('function')).toBeUndefined();
  });
});

describe('highlightCode', () => {
  test('empty string roundtrips unchanged', () => {
    expect(highlightCode('', 'typescript')).toBe('');
  });

  test('coloured output for known language', () => {
    const out = highlightCode('const x = 42;', 'typescript');
    expect(out.length).toBeGreaterThan('const x = 42;'.length);
    expect(hasAnsi(out)).toBe(true);
  });

  test('falls back to muted single-colour when language unknown', () => {
    const code = 'random text 123';
    const out = highlightCode(code, undefined);
    // muted colour DOES wrap the string in a chalk hex sequence
    expect(hasAnsi(out)).toBe(true);
    // strip the ANSI codes to recover the original text
    // eslint-disable-next-line no-control-regex
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toBe(code);
  });

  test('preserves line count for a multiline TypeScript snippet', () => {
    const code = [
      'function add(a: number, b: number): number {',
      '  // sum two numbers',
      '  return a + b;',
      '}',
    ].join('\n');
    const out = highlightCode(code, 'typescript');
    expect(out.split('\n').length).toBe(code.split('\n').length);
  });

  test('preserves blank lines (newline rhythm intact)', () => {
    const code = ['a', '', 'b', '', 'c'].join('\n');
    const out = highlightCode(code, 'plaintext');
    expect(out.split('\n').length).toBe(code.split('\n').length);
  });

  test('does not throw on illegal input for the chosen language', () => {
    // Valid Python tokens crammed into an invalid arrangement — the
    // ignoreIllegals flag must keep us from crashing.
    const garbage = 'def @@@ !!! """unclosed string';
    expect(() => highlightCode(garbage, 'python')).not.toThrow();
  });
});

describe('resolveLanguage', () => {
  test('explicit fence label wins over detection', () => {
    // Python-shaped code, explicit fence says "go" — we honour the
    // fence (model knows best, even if its choice looks weird).
    const code = 'def foo():\n  pass\n';
    expect(resolveLanguage('go', code)).toBe('go');
  });

  test('falls back to detection when fence is empty', () => {
    const code = 'def hello():\n  print("hi")\n  self.x = 1\n';
    expect(resolveLanguage(undefined, code)).toBe('python');
    expect(resolveLanguage('', code)).toBe('python');
  });

  test('returns undefined when neither fence nor detection match', () => {
    expect(resolveLanguage(undefined, 'one two three')).toBeUndefined();
    expect(resolveLanguage('', '   ')).toBeUndefined();
  });
});

describe('__TEST_THEME shape', () => {
  test('every key resolves to a callable formatter', () => {
    const t = __TEST_THEME as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(t)) {
      expect(typeof value).toBe('function');
      // each formatter must produce a string when called with a string
      const out = (value as (s: string) => string)('sample');
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThanOrEqual('sample'.length);
      // unused — just exercising the formatter path so we know it is wired
      expect(key.length).toBeGreaterThan(0);
    }
  });

  test('default formatter is a passthrough (no ANSI)', () => {
    const t = __TEST_THEME as unknown as Record<
      string,
      (s: string) => string
    >;
    const def = t['default'];
    expect(def).toBeDefined();
    if (def === undefined) return;
    expect(def('hello')).toBe('hello');
  });
});
