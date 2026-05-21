/**
 * Pattern matcher for `ProcessMonitor`.
 *
 * Given a batch of recent stdout/stderr lines, the diagnoser classifies
 * the most-recent failure into one of six canonical categories
 * (TypeScript, Bun/Node runtime, test failure, Vite, webpack, generic
 * `Error: ...`) and returns a single `DiagnosticSignal` carrying a
 * stable signature so duplicate signals can be throttled by the
 * registry.
 *
 * Design constraints:
 *   - Stateless. The matcher never mutates anything; the registry holds
 *     the throttle map.
 *   - Conservative. False positives are worse than missed signals here
 *     because every signal turns into a synthetic system message the
 *     model sees. We require enough surrounding context to avoid
 *     matching e.g. the word "Error" in a benign log line.
 *   - Deterministic. Same input → same digest + signature, so the
 *     throttle key works across separate calls.
 */

import type {
  DiagnosticSeverity,
  DiagnosticSignal,
  DiagnosticSource,
} from './types';

/** How many trailing lines to attach as `contextLines` after a match. */
const CONTEXT_TRAIL_LINES = 3;

/**
 * A pattern definition. The matcher walks `lines` from newest to
 * oldest and the FIRST pattern that hits wins. Categories listed
 * earlier therefore take precedence.
 */
interface DiagPattern {
  readonly source: DiagnosticSource;
  readonly severity: DiagnosticSeverity;
  /** Try to match a single line. */
  readonly match: (line: string) => DiagMatchResult | null;
}

interface DiagMatchResult {
  /** Optional file path. */
  readonly file: string | null;
  /** Optional 1-based line. */
  readonly line: number | null;
  /** Optional 1-based column. */
  readonly column: number | null;
  /** Short single-line summary suitable for the chat injection. */
  readonly digest: string;
}

// ---------- Pattern implementations ----------

/**
 * TypeScript compiler output, e.g.
 *   src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
 *   src/foo.ts:12:5 - error TS2322: ...
 *
 * Both `()` and `:` location forms are accepted.
 */
const TS_PATTERN: DiagPattern = {
  source: 'typescript',
  severity: 'error',
  match(line): DiagMatchResult | null {
    // `src/foo.ts(12,5): error TS2322: msg`
    const paren = /^(\S+?\.[a-zA-Z]+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s*(.+)$/.exec(line);
    if (paren !== null) {
      const file = paren[1];
      const lineStr = paren[2];
      const colStr = paren[3];
      const code = paren[4];
      const msg = paren[5];
      if (file === undefined || lineStr === undefined || colStr === undefined || code === undefined || msg === undefined) return null;
      return {
        file,
        line: Number.parseInt(lineStr, 10),
        column: Number.parseInt(colStr, 10),
        digest: `tsc ${code} ${file}:${lineStr}:${colStr} ${msg.trim()}`,
      };
    }
    // `src/foo.ts:12:5 - error TS2322: msg`
    const colon = /^(\S+?\.[a-zA-Z]+):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.+)$/.exec(line);
    if (colon !== null) {
      const file = colon[1];
      const lineStr = colon[2];
      const colStr = colon[3];
      const code = colon[4];
      const msg = colon[5];
      if (file === undefined || lineStr === undefined || colStr === undefined || code === undefined || msg === undefined) return null;
      return {
        file,
        line: Number.parseInt(lineStr, 10),
        column: Number.parseInt(colStr, 10),
        digest: `tsc ${code} ${file}:${lineStr}:${colStr} ${msg.trim()}`,
      };
    }
    return null;
  },
};

/**
 * Bun / Node runtime errors. Matches `SyntaxError`, `ReferenceError`,
 * `TypeError` etc. followed by a message and (usually) a stack frame.
 *
 * Form variants:
 *   SyntaxError: Unexpected token '}'
 *   ReferenceError: foo is not defined
 *   TypeError: undefined is not a function
 *       at file:///abs/path/foo.js:12:5
 */
const RUNTIME_PATTERN: DiagPattern = {
  source: 'runtime',
  severity: 'error',
  match(line): DiagMatchResult | null {
    const m = /^(SyntaxError|ReferenceError|TypeError|RangeError|EvalError):\s*(.+)$/.exec(
      line,
    );
    if (m === null) return null;
    const kind = m[1];
    const msg = m[2];
    if (kind === undefined || msg === undefined) return null;
    return {
      file: null,
      line: null,
      column: null,
      digest: `${kind}: ${msg.trim()}`,
    };
  },
};

/**
 * Runtime-stack pattern that captures the file:line:column from a
 * stack-trace line ("    at <fn> (file:///abs/path.js:12:5)" or "    at
 * file:///abs/path.js:12:5"). Used after a `*Error:` line was matched
 * by `RUNTIME_PATTERN` to enrich the signal — handled in `diagnose`.
 */
const STACK_FRAME = /at\s+(?:\S+\s+\()?(?:file:\/\/)?(\/?[^:\s()]+):(\d+):(\d+)\)?/;

/**
 * Test failure markers from `bun test`, `vitest`, `jest`, etc. The
 * most reliable signal is `(fail)` (bun test) or a leading `FAIL` line
 * (vitest/jest). `AssertionError` lines from `assert` modules are also
 * matched.
 */
const TEST_PATTERN: DiagPattern = {
  source: 'test',
  severity: 'error',
  match(line): DiagMatchResult | null {
    // bun test failures: `(fail) tests/foo.test.ts > my test`
    const bun = /^\(fail\)\s+(.+)$/.exec(line);
    if (bun !== null) {
      const rest = bun[1];
      if (rest === undefined) return null;
      return {
        file: null,
        line: null,
        column: null,
        digest: `test failed: ${rest.trim()}`,
      };
    }
    // jest/vitest: `FAIL tests/foo.test.ts`
    const fail = /^(?:FAIL|✗|×)\s+(\S+\.test\.(?:tsx?|jsx?|mjs|cjs|py|go|rs))(.*)$/.exec(
      line,
    );
    if (fail !== null) {
      const file = fail[1];
      const tail = fail[2] ?? '';
      if (file === undefined) return null;
      return {
        file,
        line: null,
        column: null,
        digest: `test failed: ${file}${tail.trim().length > 0 ? ` — ${tail.trim()}` : ''}`,
      };
    }
    // Node assert AssertionError: `AssertionError [ERR_ASSERTION]: ...`
    const ae = /^AssertionError(?:\s+\[[^\]]+\])?:\s*(.+)$/.exec(line);
    if (ae !== null) {
      const msg = ae[1];
      if (msg === undefined) return null;
      return {
        file: null,
        line: null,
        column: null,
        digest: `AssertionError: ${msg.trim()}`,
      };
    }
    return null;
  },
};

/**
 * Vite dev-server failures. The most reliable markers are
 * `Failed to compile`, `Module not found`, and the `[vite] Internal
 * server error: ...` form.
 */
const VITE_PATTERN: DiagPattern = {
  source: 'vite',
  severity: 'error',
  match(line): DiagMatchResult | null {
    if (/Failed to compile/i.test(line)) {
      return {
        file: null,
        line: null,
        column: null,
        digest: `vite: failed to compile — ${line.trim()}`,
      };
    }
    const mn = /^(?:.*?\s)?Module not found:?\s*(.+)$/.exec(line);
    if (mn !== null && /module not found/i.test(line)) {
      const detail = mn[1];
      if (detail === undefined) return null;
      return {
        file: null,
        line: null,
        column: null,
        digest: `module not found: ${detail.trim()}`,
      };
    }
    const internal = /\[vite\]\s+Internal server error:\s*(.+)$/.exec(line);
    if (internal !== null) {
      const detail = internal[1];
      if (detail === undefined) return null;
      return {
        file: null,
        line: null,
        column: null,
        digest: `vite internal error: ${detail.trim()}`,
      };
    }
    return null;
  },
};

/**
 * Webpack-style compile output:
 *   ERROR in ./src/foo.ts
 *   Module not found: Error: Can't resolve 'bar'
 */
const WEBPACK_PATTERN: DiagPattern = {
  source: 'webpack',
  severity: 'error',
  match(line): DiagMatchResult | null {
    const m = /^ERROR in\s+(\S+)(.*)$/.exec(line);
    if (m === null) return null;
    const file = m[1];
    const tail = m[2] ?? '';
    if (file === undefined) return null;
    return {
      file,
      line: null,
      column: null,
      digest: `webpack: ${file}${tail.trim().length > 0 ? ` ${tail.trim()}` : ''}`,
    };
  },
};

/**
 * Generic last-resort `Error: ...` matcher. Only fires when nothing
 * more specific did. We deliberately require a leading capital-E and a
 * colon so plain English log lines (e.g. "see also: error handling")
 * don't trigger.
 */
const GENERIC_PATTERN: DiagPattern = {
  source: 'generic',
  severity: 'error',
  match(line): DiagMatchResult | null {
    const m = /^Error:\s*(.+)$/.exec(line);
    if (m === null) return null;
    const msg = m[1];
    if (msg === undefined) return null;
    return {
      file: null,
      line: null,
      column: null,
      digest: `Error: ${msg.trim()}`,
    };
  },
};

/** Ordered list — highest-priority pattern first. */
const PATTERNS: readonly DiagPattern[] = [
  TS_PATTERN,
  TEST_PATTERN,
  VITE_PATTERN,
  WEBPACK_PATTERN,
  RUNTIME_PATTERN,
  GENERIC_PATTERN,
];

/**
 * Stable signature builder. Combines source + digest + file:line so
 * "same error in the same place" produces the SAME signature even if
 * the surrounding output churns. Used by the registry to drop
 * duplicate emissions inside the throttle window.
 */
function buildSignature(
  source: DiagnosticSource,
  digest: string,
  file: string | null,
  line: number | null,
): string {
  const locus = file === null ? '' : `@${file}:${line ?? '?'}`;
  return `${source}|${digest}${locus}`;
}

/**
 * Run the matcher over `lines` (newest-LAST is the convention used by
 * the registry — we walk from end to start so the most recent failure
 * wins). Returns `null` when nothing matches.
 *
 * `contextLines` collects up to `CONTEXT_TRAIL_LINES` lines immediately
 * AFTER the matched line (in original order). Surrounding context lets
 * the model see the matched line's neighbours when reasoning about
 * the failure.
 */
export function diagnose(args: {
  readonly processId: string;
  readonly lines: readonly string[];
  readonly at?: number;
}): DiagnosticSignal | null {
  const { processId, lines } = args;
  const at = args.at ?? Date.now();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line.length === 0) continue;
    for (const pat of PATTERNS) {
      const hit = pat.match(line);
      if (hit === null) continue;
      // Runtime errors often have a follow-up stack frame — try to
      // back-fill the file/line/column from the next few lines.
      let file: string | null = hit.file;
      let resolvedLine: number | null = hit.line;
      let column: number | null = hit.column;
      if (pat.source === 'runtime' && file === null) {
        for (let j = i + 1; j < lines.length && j <= i + 5; j += 1) {
          const next = lines[j];
          if (next === undefined) continue;
          const frame = STACK_FRAME.exec(next);
          if (frame === null) continue;
          const f = frame[1];
          const ln = frame[2];
          const col = frame[3];
          if (f === undefined || ln === undefined || col === undefined) continue;
          file = f;
          resolvedLine = Number.parseInt(ln, 10);
          column = Number.parseInt(col, 10);
          break;
        }
      }
      const trail: string[] = [];
      for (
        let j = i + 1;
        j < lines.length && trail.length < CONTEXT_TRAIL_LINES;
        j += 1
      ) {
        const candidate = lines[j];
        if (candidate === undefined) continue;
        trail.push(candidate);
      }
      const digest =
        file !== null && hit.digest.indexOf(file) === -1 && resolvedLine !== null
          ? `${hit.digest} @ ${file}:${resolvedLine}`
          : hit.digest;
      return {
        processId,
        severity: pat.severity,
        source: pat.source,
        digest,
        file,
        line: resolvedLine,
        column,
        message: line,
        contextLines: trail,
        signature: buildSignature(pat.source, hit.digest, file, resolvedLine),
        at,
      };
    }
  }
  return null;
}
