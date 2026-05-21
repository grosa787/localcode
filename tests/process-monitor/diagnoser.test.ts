/**
 * Diagnoser — pattern matcher tests covering every category plus
 * false-positive guards. The matcher is stateless so each case just
 * passes a synthetic line array through `diagnose()` and asserts the
 * resulting `DiagnosticSignal` shape.
 */

import { describe, expect, test } from 'bun:test';

import { diagnose } from '@/process-monitor';

describe('TypeScript pattern', () => {
  test('paren form: src/foo.ts(12,5): error TS2322: ...', () => {
    const sig = diagnose({
      processId: 'p',
      lines: [
        "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      ],
    });
    expect(sig).not.toBeNull();
    expect(sig?.source).toBe('typescript');
    expect(sig?.file).toBe('src/foo.ts');
    expect(sig?.line).toBe(12);
    expect(sig?.column).toBe(5);
    expect(sig?.severity).toBe('error');
  });

  test('colon form: src/foo.ts:12:5 - error TS2322: ...', () => {
    const sig = diagnose({
      processId: 'p',
      lines: [
        "src/foo.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
      ],
    });
    expect(sig).not.toBeNull();
    expect(sig?.source).toBe('typescript');
    expect(sig?.file).toBe('src/foo.ts');
    expect(sig?.line).toBe(12);
    expect(sig?.column).toBe(5);
  });

  test('captures TS error code in the digest', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['src/bar.tsx(3,1): error TS6133: \'x\' is declared but never used.'],
    });
    expect(sig?.digest).toContain('TS6133');
    expect(sig?.digest).toContain('src/bar.tsx');
  });
});

describe('Runtime pattern', () => {
  test('SyntaxError sans stack', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ["SyntaxError: Unexpected token '}'"],
    });
    expect(sig).not.toBeNull();
    expect(sig?.source).toBe('runtime');
    expect(sig?.digest).toContain('SyntaxError');
  });

  test('TypeError + stack frame back-fills file/line/column', () => {
    const sig = diagnose({
      processId: 'p',
      lines: [
        'TypeError: undefined is not a function',
        '    at handler (file:///abs/path/foo.js:12:5)',
      ],
    });
    expect(sig).not.toBeNull();
    expect(sig?.source).toBe('runtime');
    expect(sig?.file).toBe('/abs/path/foo.js');
    expect(sig?.line).toBe(12);
    expect(sig?.column).toBe(5);
  });

  test('RangeError matches', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['RangeError: Maximum call stack size exceeded'],
    });
    expect(sig?.source).toBe('runtime');
  });
});

describe('Test-failure pattern', () => {
  test('bun test (fail) marker', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['(fail) tests/foo.test.ts > my test'],
    });
    expect(sig).not.toBeNull();
    expect(sig?.source).toBe('test');
    expect(sig?.digest).toContain('test failed');
    expect(sig?.digest).toContain('tests/foo.test.ts');
  });

  test('vitest/jest FAIL marker carries the file path', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['FAIL tests/foo.test.ts'],
    });
    expect(sig?.source).toBe('test');
    expect(sig?.file).toBe('tests/foo.test.ts');
  });

  test('AssertionError matches', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['AssertionError [ERR_ASSERTION]: Expected 2 but got 1'],
    });
    expect(sig?.source).toBe('test');
    expect(sig?.digest).toContain('AssertionError');
  });
});

describe('Vite pattern', () => {
  test('Failed to compile marker', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['Failed to compile'],
    });
    expect(sig?.source).toBe('vite');
  });

  test('vite internal server error', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['[vite] Internal server error: Could not resolve "./foo"'],
    });
    expect(sig?.source).toBe('vite');
    expect(sig?.digest).toContain('vite internal error');
  });

  test('module not found message', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['Module not found: foo'],
    });
    expect(sig?.source).toBe('vite');
  });
});

describe('Generic pattern', () => {
  test('Error: <msg>', () => {
    const sig = diagnose({
      processId: 'p',
      lines: ['Error: Something blew up'],
    });
    expect(sig?.source).toBe('generic');
    expect(sig?.digest).toContain('Something blew up');
  });

  test('first matching pattern wins (TS beats generic)', () => {
    const sig = diagnose({
      processId: 'p',
      lines: [
        'Error: bootstrap failed',
        'src/foo.ts(12,5): error TS2322: ...',
      ],
    });
    expect(sig?.source).toBe('typescript');
  });
});

describe('False-positive guards', () => {
  test('plain English log lines do not match', () => {
    expect(
      diagnose({
        processId: 'p',
        lines: [
          'starting build',
          'see also: error handling chapter',
          'done in 1.2s',
        ],
      }),
    ).toBeNull();
  });

  test('lowercase "error" does not trigger generic', () => {
    expect(
      diagnose({
        processId: 'p',
        lines: ['error: maybe?'],
      }),
    ).toBeNull();
  });

  test('empty input returns null', () => {
    expect(diagnose({ processId: 'p', lines: [] })).toBeNull();
  });

  test('whitespace-only lines are ignored', () => {
    expect(
      diagnose({
        processId: 'p',
        lines: ['   ', '\t\t'],
      }),
    ).toBeNull();
  });
});

describe('Signature stability', () => {
  test('same error in the same place produces the same signature', () => {
    const a = diagnose({
      processId: 'p',
      lines: ["src/foo.ts(12,5): error TS2322: ouch"],
    });
    const b = diagnose({
      processId: 'p',
      lines: [
        '... unrelated noise',
        "src/foo.ts(12,5): error TS2322: ouch",
      ],
    });
    expect(a?.signature).toBe(b?.signature ?? '');
  });

  test('different file produces a different signature', () => {
    const a = diagnose({
      processId: 'p',
      lines: ["src/foo.ts(12,5): error TS2322: ouch"],
    });
    const b = diagnose({
      processId: 'p',
      lines: ["src/bar.ts(12,5): error TS2322: ouch"],
    });
    expect(a?.signature).not.toBe(b?.signature);
  });
});
