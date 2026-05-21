/**
 * `lint_file` tool — language-native syntax/type check for a single file.
 *
 * This tool is PREVIEW-ONLY: the work happens in `preview`; there is no
 * `commit` step because the tool is read-only / side-effect free (it only
 * spawns short-lived linter subprocesses with `reject: false`).
 *
 * The tool's purpose is to give the model an error-check loop: after
 * `write_file` or `edit_file`, the agent harness (Agent 2's post-tool hook)
 * can call `lint_file` and feed diagnostics back so the model auto-fixes
 * syntax / type errors.
 *
 * Dispatch is by file extension:
 *   .ts / .tsx / .js / .jsx  →  `bunx tsc --noEmit` (project-wide, filtered)
 *   .py                      →  `ruff check … --output-format json`
 *                               fallback `python -m py_compile`
 *   .go                      →  `go vet` + `gofmt -l`
 *   .rs                      →  `rustc --edition 2021 --emit=dep-info …`
 *   anything else            →  skip with a friendly message
 *
 * Return shape:
 *   - `success: true` always, unless invalid args or path traversal.
 *     "success" means "the linter ran (or was skipped)"; diagnostics are
 *     embedded in `output` for the model to read.
 *   - If the linter binary is missing, `output` says so and the tool
 *     still succeeds — never block the model on a missing toolchain.
 *
 * Invariants:
 *   - Path traversal is blocked (same guard as other tools).
 *   - Args are validated with Zod.
 *   - Each subprocess has a 15s timeout (via execa).
 *   - Binary availability is probed via `command -v …` before invocation.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';

import type { LintDiagnostic, LintFileArgs, ToolContext, ToolResult } from './types';

/** Zod schema for `lint_file` arguments. */
export const LintFileArgsSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
});

/** Per-subprocess timeout. Kept short so the model's loop stays responsive. */
const LINT_TIMEOUT_MS = 15_000;

/** Ensures `target` resolves inside `root`; returns null on traversal. */
function resolveInsideRoot(root: string, target: string): string | null {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(absoluteRoot, target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return absoluteTarget;
}

/**
 * Probe whether a binary is on PATH. Uses `command -v` (POSIX) because
 * `which` is not guaranteed on every platform. Failures are swallowed —
 * missing binary simply returns false.
 */
async function hasBinary(name: string): Promise<boolean> {
  try {
    const result = await execa('sh', ['-c', `command -v ${name}`], {
      reject: false,
      timeout: 5_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Formats a diagnostic list for model-friendly consumption. */
function formatDiagnostics(diags: LintDiagnostic[]): string {
  if (diags.length === 0) return 'No issues found.';
  const header = `Found ${diags.length} diagnostic${diags.length === 1 ? '' : 's'}:`;
  const lines = diags.map((d) => {
    const code = d.code ? ` [${d.code}]` : '';
    const sev = d.severity.toUpperCase();
    return `  ${sev} ${d.line}:${d.column}${code} ${d.message}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

/**
 * Parse `tsc` output lines like:
 *   src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to 'number'.
 * Returns only diagnostics whose file matches `targetAbs` (by basename
 * and relative-path suffix match — `tsc` emits relative paths).
 */
function parseTscOutput(stdout: string, targetAbs: string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  const lines = stdout.split('\n');
  // Regex: file(line,col): severity TSxxxx: message
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s+(.+)$/;
  const targetBase = path.basename(targetAbs);
  for (const rawLine of lines) {
    const match = pattern.exec(rawLine.trim());
    if (!match) continue;
    const [, file, lineStr, colStr, sev, code, message] = match;
    if (!file || !lineStr || !colStr || !sev || !code || !message) continue;
    // Only keep diagnostics for our target file. tsc emits paths
    // relative to the project root, so we accept either an exact
    // absolute match, a basename match, or a suffix match.
    const fileBase = path.basename(file);
    if (fileBase !== targetBase && !targetAbs.endsWith(file)) continue;
    const severity: LintDiagnostic['severity'] =
      sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'info';
    diags.push({
      line: Number.parseInt(lineStr, 10),
      column: Number.parseInt(colStr, 10),
      severity,
      message,
      code,
    });
  }
  return diags;
}

/** Parse ruff JSON output into our shared diagnostic shape. */
function parseRuffJson(stdout: string): LintDiagnostic[] {
  if (stdout.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const diags: LintDiagnostic[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const loc = rec['location'];
    const message = typeof rec['message'] === 'string' ? rec['message'] : '';
    const code = typeof rec['code'] === 'string' ? rec['code'] : undefined;
    if (loc === null || typeof loc !== 'object' || message.length === 0) continue;
    const locRec = loc as Record<string, unknown>;
    const line = typeof locRec['row'] === 'number' ? locRec['row'] : 0;
    const column = typeof locRec['column'] === 'number' ? locRec['column'] : 0;
    diags.push({
      line,
      column,
      severity: 'error',
      message,
      code,
    });
  }
  return diags;
}

/**
 * Lint a TypeScript or JavaScript file via `bunx tsc --noEmit`. We prefer
 * the project-wide invocation (so `tsconfig.json` paths/aliases resolve)
 * and filter the output down to diagnostics for our target file.
 */
async function lintTypescript(
  absolutePath: string,
  projectRoot: string,
): Promise<ToolResult> {
  const hasBunx = await hasBinary('bunx');
  if (!hasBunx) {
    return {
      success: true,
      output: 'Linter for ts/tsx/js/jsx not installed (bunx); skipping check.',
    };
  }

  // Prefer project-wide tsc so module resolution matches the real build.
  // If there's no tsconfig, fall back to a single-file check that still
  // honours strict defaults well enough for syntax/type checks.
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  let tsconfigExists = false;
  try {
    await fs.access(tsconfigPath);
    tsconfigExists = true;
  } catch {
    tsconfigExists = false;
  }

  const cmd = tsconfigExists
    ? ['tsc', '--noEmit', '--pretty', 'false', '--project', tsconfigPath]
    : ['tsc', '--noEmit', '--pretty', 'false', absolutePath];

  const result = await execa('bunx', cmd, {
    cwd: projectRoot,
    reject: false,
    timeout: LINT_TIMEOUT_MS,
    all: false,
  });

  if (result.timedOut) {
    return {
      success: true,
      output: `Linter timed out after ${LINT_TIMEOUT_MS / 1000}s (tsc); skipping check.`,
    };
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const combined = `${stdout}\n${stderr}`;
  const diags = parseTscOutput(combined, absolutePath);
  return {
    success: true,
    output: formatDiagnostics(diags),
  };
}

/** Lint a Python file via ruff (preferred) or `python -m py_compile` (fallback). */
async function lintPython(absolutePath: string, projectRoot: string): Promise<ToolResult> {
  if (await hasBinary('ruff')) {
    const result = await execa(
      'ruff',
      ['check', absolutePath, '--output-format', 'json'],
      {
        cwd: projectRoot,
        reject: false,
        timeout: LINT_TIMEOUT_MS,
        all: false,
      },
    );
    if (result.timedOut) {
      return {
        success: true,
        output: `Linter timed out after ${LINT_TIMEOUT_MS / 1000}s (ruff); skipping check.`,
      };
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const diags = parseRuffJson(stdout);
    return {
      success: true,
      output: formatDiagnostics(diags),
    };
  }

  const pyBin = (await hasBinary('python3'))
    ? 'python3'
    : (await hasBinary('python'))
      ? 'python'
      : null;
  if (pyBin === null) {
    return {
      success: true,
      output: 'Linter for py not installed (ruff/python); skipping check.',
    };
  }

  const result = await execa(pyBin, ['-m', 'py_compile', absolutePath], {
    cwd: projectRoot,
    reject: false,
    timeout: LINT_TIMEOUT_MS,
    all: false,
  });
  if (result.timedOut) {
    return {
      success: true,
      output: `Linter timed out after ${LINT_TIMEOUT_MS / 1000}s (py_compile); skipping check.`,
    };
  }
  if (result.exitCode === 0) {
    return { success: true, output: 'No issues found.' };
  }
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  // py_compile emits "File "x.py", line N" / SyntaxError: msg patterns.
  const lineMatch = /line\s+(\d+)/i.exec(stderr);
  const line = lineMatch && lineMatch[1] ? Number.parseInt(lineMatch[1], 10) : 1;
  const firstLine = stderr.split('\n').find((l) => l.trim().length > 0) ?? stderr;
  const diag: LintDiagnostic = {
    line,
    column: 1,
    severity: 'error',
    message: firstLine.trim() || 'py_compile failed',
  };
  return { success: true, output: formatDiagnostics([diag]) };
}

/** Lint a Go file via `go vet` and `gofmt -l`. Any output indicates an issue. */
async function lintGo(absolutePath: string, projectRoot: string): Promise<ToolResult> {
  if (!(await hasBinary('go'))) {
    return {
      success: true,
      output: 'Linter for go not installed (go); skipping check.',
    };
  }

  const diags: LintDiagnostic[] = [];

  // go vet requires a package path; pass the absolute file directly.
  const vetResult = await execa('go', ['vet', absolutePath], {
    cwd: projectRoot,
    reject: false,
    timeout: LINT_TIMEOUT_MS,
    all: false,
  });
  if (vetResult.timedOut) {
    return {
      success: true,
      output: `Linter timed out after ${LINT_TIMEOUT_MS / 1000}s (go vet); skipping check.`,
    };
  }
  const vetErr = typeof vetResult.stderr === 'string' ? vetResult.stderr : '';
  // go vet emits lines like: file.go:12:5: message
  const vetPattern = /^(.+?):(\d+):(\d+):\s+(.+)$/;
  for (const rawLine of vetErr.split('\n')) {
    const m = vetPattern.exec(rawLine.trim());
    if (!m) continue;
    const [, , lineStr, colStr, message] = m;
    if (!lineStr || !colStr || !message) continue;
    diags.push({
      line: Number.parseInt(lineStr, 10),
      column: Number.parseInt(colStr, 10),
      severity: 'error',
      message,
    });
  }

  // gofmt -l prints any file that needs reformatting — treat as a warning.
  if (await hasBinary('gofmt')) {
    const fmtResult = await execa('gofmt', ['-l', absolutePath], {
      cwd: projectRoot,
      reject: false,
      timeout: LINT_TIMEOUT_MS,
      all: false,
    });
    const fmtOut = typeof fmtResult.stdout === 'string' ? fmtResult.stdout : '';
    if (fmtOut.trim().length > 0) {
      diags.push({
        line: 1,
        column: 1,
        severity: 'warning',
        message: 'gofmt: file is not formatted',
      });
    }
  }

  return { success: true, output: formatDiagnostics(diags) };
}

/** Syntax-check a Rust file via `rustc --emit=dep-info`. */
async function lintRust(absolutePath: string, projectRoot: string): Promise<ToolResult> {
  if (!(await hasBinary('rustc'))) {
    return {
      success: true,
      output: 'Linter for rs not installed (rustc); skipping check.',
    };
  }

  // --emit=dep-info skips codegen but still parses & type-checks the file.
  // We route output to a temp location but mostly care about stderr.
  const result = await execa(
    'rustc',
    ['--edition', '2021', '--emit=dep-info', '-o', '/dev/null', absolutePath],
    {
      cwd: projectRoot,
      reject: false,
      timeout: LINT_TIMEOUT_MS,
      all: false,
    },
  );
  if (result.timedOut) {
    return {
      success: true,
      output: `Linter timed out after ${LINT_TIMEOUT_MS / 1000}s (rustc); skipping check.`,
    };
  }

  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (result.exitCode === 0 && stderr.trim().length === 0) {
    return { success: true, output: 'No issues found.' };
  }

  const diags: LintDiagnostic[] = [];
  // rustc standard format:
  //   error[E0308]: mismatched types
  //    --> src/foo.rs:3:5
  const errorPattern = /^(error|warning)(?:\[(E\d+)\])?:\s+(.+)$/;
  const locPattern = /-->\s+(.+?):(\d+):(\d+)/;
  const lines = stderr.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const headMatch = errorPattern.exec(rawLine.trim());
    if (!headMatch) continue;
    const [, sev, codeMaybe, message] = headMatch;
    if (!sev || !message) continue;
    // Look for the `--> file:line:col` line within the next few lines.
    let line = 0;
    let column = 0;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j += 1) {
      const next = lines[j];
      if (next === undefined) continue;
      const locMatch = locPattern.exec(next);
      if (locMatch && locMatch[2] && locMatch[3]) {
        line = Number.parseInt(locMatch[2], 10);
        column = Number.parseInt(locMatch[3], 10);
        break;
      }
    }
    diags.push({
      line,
      column,
      severity: sev === 'error' ? 'error' : 'warning',
      message,
      code: codeMaybe ?? undefined,
    });
  }

  // Fallback: rustc failed but we couldn't parse structured errors. Emit
  // a single diagnostic so the model still sees something useful.
  if (diags.length === 0 && result.exitCode !== 0) {
    const firstLine =
      stderr.split('\n').find((l) => l.trim().length > 0) ?? 'rustc failed';
    diags.push({
      line: 1,
      column: 1,
      severity: 'error',
      message: firstLine.trim(),
    });
  }

  return { success: true, output: formatDiagnostics(diags) };
}

/**
 * Preview a lint check. Detects language by extension, dispatches to the
 * appropriate linter, and formats diagnostics. Never throws. Never writes
 * to disk. Unknown extensions return `success: true` with a skip message.
 */
export async function lintFile(
  args: LintFileArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = LintFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const absolutePath = resolveInsideRoot(ctx.projectRoot, parsed.data.path);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${parsed.data.path}' escapes project root`,
    };
  }

  // Verify the file exists so the linter doesn't give a cryptic "file not
  // found" in its own format — we give a canonical error instead.
  try {
    const st = await fs.stat(absolutePath);
    if (!st.isFile()) {
      return {
        success: false,
        output: '',
        error: `Not a regular file: ${parsed.data.path}`,
      };
    }
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return {
        success: false,
        output: '',
        error: `File not found: ${parsed.data.path}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to stat '${parsed.data.path}': ${message}`,
    };
  }

  const ext = path.extname(absolutePath).toLowerCase();

  try {
    switch (ext) {
      case '.ts':
      case '.tsx':
      case '.js':
      case '.jsx':
        return await lintTypescript(absolutePath, ctx.projectRoot);
      case '.py':
        return await lintPython(absolutePath, ctx.projectRoot);
      case '.go':
        return await lintGo(absolutePath, ctx.projectRoot);
      case '.rs':
        return await lintRust(absolutePath, ctx.projectRoot);
      default: {
        const label = ext.length > 0 ? ext.slice(1) : '(no extension)';
        return {
          success: true,
          output: `No linter configured for ${label}; skipping.`,
        };
      }
    }
  } catch (err) {
    // Defensive — execa spawn errors, ENOENT on the binary itself, etc.
    // Always tell the model "tool didn't crash; linter unavailable".
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: true,
      output: `Linter for ${ext || '(unknown)'} failed to run: ${message}; skipping check.`,
    };
  }
}
