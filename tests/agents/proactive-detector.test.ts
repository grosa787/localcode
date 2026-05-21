/**
 * ProactiveDetector unit tests.
 *
 * Each heuristic rule has at least one positive case (fires) and one
 * negative case (does not fire). We also verify:
 *   - Confidence threshold gating.
 *   - Ordering by descending confidence.
 *   - `top()` convenience returns the highest-confidence suggestion.
 *   - Helpers (`isTestPath`, `stripCode`) honour expected contracts.
 */

import { describe, expect, test } from 'bun:test';

import {
  ProactiveDetector,
  PROACTIVE_CONFIDENCE_THRESHOLD,
  __test__,
  type DetectorInput,
  type ToolCallObservation,
} from '@/agents/proactive-detector';

const { isTestPath, stripCode } = __test__;

function input(partial: Partial<DetectorInput>): DetectorInput {
  return {
    recentUserMessages: partial.recentUserMessages ?? [],
    recentToolCalls: partial.recentToolCalls ?? [],
  };
}

describe('ProactiveDetector — debugger heuristic', () => {
  test('fires on "stack trace"', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({ recentUserMessages: ['I got this stack trace from production'] }),
    );
    const found = result.find((s) => s.templateId === 'debugger');
    expect(found).toBeDefined();
    expect(found?.confidence).toBeGreaterThanOrEqual(PROACTIVE_CONFIDENCE_THRESHOLD);
  });

  test('fires on exception + error keywords combined', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({ recentUserMessages: ['Unhandled exception thrown — error keeps repeating'] }),
    );
    const found = result.find((s) => s.templateId === 'debugger');
    expect(found).toBeDefined();
  });

  test('fires on TypeError keyword', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({
        recentUserMessages: ['Getting an uncaught TypeError when calling foo()'],
      }),
    );
    const found = result.find((s) => s.templateId === 'debugger');
    expect(found).toBeDefined();
  });

  test('does not fire on neutral conversation', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({ recentUserMessages: ['Hi, what can you do?'] }),
    );
    expect(result.find((s) => s.templateId === 'debugger')).toBeUndefined();
  });
});

describe('ProactiveDetector — performance-optimizer heuristic', () => {
  test('fires on "slow performance"', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({ recentUserMessages: ['The tests are slow, performance is bad'] }),
    );
    const found = result.find((s) => s.templateId === 'performance-optimizer');
    expect(found).toBeDefined();
  });

  test('fires on Russian "слишком медленно"', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({ recentUserMessages: ['Эта функция работает слишком медленно'] }),
    );
    const found = result.find((s) => s.templateId === 'performance-optimizer');
    expect(found).toBeDefined();
  });

  test('fires on "bottleneck"', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({
        recentUserMessages: ['I think there is a bottleneck in the render loop'],
      }),
    );
    const found = result.find((s) => s.templateId === 'performance-optimizer');
    expect(found).toBeDefined();
  });

  test('does not fire when no perf signal present', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({ recentUserMessages: ['What does this function do'] }),
    );
    expect(result.find((s) => s.templateId === 'performance-optimizer')).toBeUndefined();
  });
});

describe('ProactiveDetector — architect heuristic', () => {
  test('fires after many read_file calls without writes', () => {
    const det = new ProactiveDetector();
    const calls: ToolCallObservation[] = [
      { toolName: 'read_file', path: 'src/a.ts' },
      { toolName: 'read_file', path: 'src/b.ts' },
      { toolName: 'read_file', path: 'src/c.ts' },
      { toolName: 'list_dir', path: 'src/' },
      { toolName: 'read_file', path: 'src/d.ts' },
      { toolName: 'glob_search', path: 'src/**/*.ts' },
      { toolName: 'read_file', path: 'src/e.ts' },
    ];
    const result = det.detect(input({ recentToolCalls: calls }));
    const found = result.find((s) => s.templateId === 'architect');
    expect(found).toBeDefined();
  });

  test('does not fire when there are many writes', () => {
    const det = new ProactiveDetector();
    const calls: ToolCallObservation[] = [
      { toolName: 'read_file', path: 'a.ts' },
      { toolName: 'edit_file', path: 'a.ts' },
      { toolName: 'edit_file', path: 'a.ts' },
    ];
    const result = det.detect(input({ recentToolCalls: calls }));
    expect(result.find((s) => s.templateId === 'architect')).toBeUndefined();
  });

  test('does not fire on a small number of reads', () => {
    const det = new ProactiveDetector();
    const calls: ToolCallObservation[] = [
      { toolName: 'read_file', path: 'a.ts' },
      { toolName: 'read_file', path: 'b.ts' },
    ];
    const result = det.detect(input({ recentToolCalls: calls }));
    expect(result.find((s) => s.templateId === 'architect')).toBeUndefined();
  });
});

describe('ProactiveDetector — test-engineer heuristic', () => {
  test('fires on multiple edits to test files', () => {
    const det = new ProactiveDetector();
    const calls: ToolCallObservation[] = [
      { toolName: 'edit_file', path: 'tests/foo.test.ts' },
      { toolName: 'edit_file', path: 'tests/bar.test.ts' },
      { toolName: 'edit_file', path: '__tests__/baz.test.tsx' },
    ];
    const result = det.detect(input({ recentToolCalls: calls }));
    const found = result.find((s) => s.templateId === 'test-engineer');
    expect(found).toBeDefined();
  });

  test('does not fire on edits to non-test paths', () => {
    const det = new ProactiveDetector();
    const calls: ToolCallObservation[] = [
      { toolName: 'edit_file', path: 'src/foo.ts' },
      { toolName: 'edit_file', path: 'src/bar.ts' },
      { toolName: 'edit_file', path: 'src/baz.ts' },
    ];
    const result = det.detect(input({ recentToolCalls: calls }));
    expect(result.find((s) => s.templateId === 'test-engineer')).toBeUndefined();
  });

  test('does not fire on fewer than 3 test edits', () => {
    const det = new ProactiveDetector();
    const calls: ToolCallObservation[] = [
      { toolName: 'edit_file', path: 'tests/foo.test.ts' },
      { toolName: 'edit_file', path: 'tests/bar.test.ts' },
    ];
    const result = det.detect(input({ recentToolCalls: calls }));
    expect(result.find((s) => s.templateId === 'test-engineer')).toBeUndefined();
  });
});

describe('ProactiveDetector — security-reviewer heuristic', () => {
  test('fires on "auth" keyword', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({
        recentUserMessages: ['Need to add auth to this endpoint with credentials'],
      }),
    );
    const found = result.find((s) => s.templateId === 'security-reviewer');
    expect(found).toBeDefined();
  });

  test('fires strongly on "sql injection"', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({ recentUserMessages: ['Is this code safe from SQL injection?'] }),
    );
    const found = result.find((s) => s.templateId === 'security-reviewer');
    expect(found).toBeDefined();
    expect(found?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('does not fire on neutral text', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({ recentUserMessages: ['Hello world'] }),
    );
    expect(result.find((s) => s.templateId === 'security-reviewer')).toBeUndefined();
  });
});

describe('ProactiveDetector — confidence + ordering', () => {
  test('respects minimum confidence threshold', () => {
    // Single weak signal should NOT cross 0.6.
    const det = new ProactiveDetector();
    const result = det.detect(input({ recentUserMessages: ['just a tiny bug'] }));
    // "bug" weight is 0.2 → below threshold, should not surface.
    expect(result.find((s) => s.templateId === 'debugger')).toBeUndefined();
  });

  test('returns suggestions sorted by descending confidence', () => {
    // Force two high-confidence rules to fire and verify order.
    const det = new ProactiveDetector();
    const result = det.detect(
      input({
        recentUserMessages: [
          'I got a stack trace with TypeError uncaught exception',
          'Also slow performance bottleneck optimization needed',
        ],
      }),
    );
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < result.length; i += 1) {
      const prev = result[i - 1];
      const cur = result[i];
      if (prev !== undefined && cur !== undefined) {
        expect(prev.confidence).toBeGreaterThanOrEqual(cur.confidence);
      }
    }
  });

  test('top() returns the highest-confidence suggestion', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({
        recentUserMessages: ['stack trace TypeError exception'],
      }),
    );
    const topResult = det.top(
      input({
        recentUserMessages: ['stack trace TypeError exception'],
      }),
    );
    expect(topResult).toBeDefined();
    expect(topResult?.confidence).toBe(result[0]?.confidence);
  });

  test('top() returns null when nothing qualifies', () => {
    const det = new ProactiveDetector();
    const result = det.top(input({ recentUserMessages: ['hello world'] }));
    expect(result).toBeNull();
  });

  test('custom minConfidence allows lower-confidence suggestions through', () => {
    const det = new ProactiveDetector({ minConfidence: 0.1 });
    const result = det.detect(input({ recentUserMessages: ['a bug somewhere'] }));
    expect(result.find((s) => s.templateId === 'debugger')).toBeDefined();
  });
});

describe('ProactiveDetector — code-block guard', () => {
  test('does not fire on keywords found only in fenced code blocks', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({
        recentUserMessages: [
          'Here is a snippet:\n```python\n# stack trace handling\nraise Exception()\n```\nThanks',
        ],
      }),
    );
    // Code stripped → no debugger signal in the plain prose.
    expect(result.find((s) => s.templateId === 'debugger')).toBeUndefined();
  });

  test('still fires when keywords appear outside code blocks', () => {
    const det = new ProactiveDetector();
    const result = det.detect(
      input({
        recentUserMessages: [
          'I keep hitting a TypeError exception in production. The traceback shows:\n```py\nfoo()\n```',
        ],
      }),
    );
    const found = result.find((s) => s.templateId === 'debugger');
    expect(found).toBeDefined();
  });
});

describe('ProactiveDetector — helpers', () => {
  test('isTestPath recognises tests/ prefix', () => {
    expect(isTestPath('tests/foo.test.ts')).toBe(true);
    expect(isTestPath('test/foo.spec.ts')).toBe(true);
    expect(isTestPath('a/__tests__/foo.tsx')).toBe(true);
    expect(isTestPath('foo.test.tsx')).toBe(true);
    expect(isTestPath('foo.spec.js')).toBe(true);
  });

  test('isTestPath rejects non-test paths', () => {
    expect(isTestPath('src/foo.ts')).toBe(false);
    expect(isTestPath('lib/main.js')).toBe(false);
    expect(isTestPath(undefined)).toBe(false);
    expect(isTestPath('')).toBe(false);
  });

  test('stripCode removes fenced blocks', () => {
    const out = stripCode('hello\n```\nworld\n```\nend');
    expect(out).not.toContain('world');
    expect(out).toContain('hello');
    expect(out).toContain('end');
  });
});
