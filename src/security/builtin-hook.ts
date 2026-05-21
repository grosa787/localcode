/**
 * Built-in PreToolUse hook for `git_commit`. Spawned by the hook engine
 * when `HookConfig.builtin === 'secret-scanner'`.
 *
 * Contract mirrors the engine's shell-hook outcome: return an object the
 * engine wraps into a `HookOutcome`. A non-zero exit code on a blocking
 * hook tells the executor to reject the tool call; the embedded stderr
 * is surfaced verbatim (with redacted findings).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyAllowlist, loadAllowlist } from './allowlist';
import {
  formatFinding,
  scanCommitDiff,
  type Finding,
} from './secret-scanner';

/**
 * Local mirror of `HookConfig` to avoid a circular import with
 * `@/hooks` (which imports this file for builtin dispatch). The shape
 * is intentionally structural — anything matching this mirror also
 * matches the real `HookConfig`.
 */
interface HookConfigShape {
  trigger:
    | 'PreToolUse'
    | 'PostToolUse'
    | 'UserPromptSubmit'
    | 'SessionStart'
    | 'PreCompact'
    | 'SessionEnd'
    | 'Stop';
  toolPattern?: string;
  command: string;
  builtin?: string;
  timeout?: number;
  blocking?: boolean;
  description?: string;
}

export interface BuiltinHookContext {
  projectRoot: string;
}

export interface BuiltinHookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Identifier used by `HookConfig.builtin` to route to this handler.
 * Centralized so the engine + auto-registration agree on the name.
 */
export const SECRET_SCANNER_BUILTIN = 'secret-scanner' as const;

/**
 * Concrete `HookConfig`-shaped entry the auto-registrar prepends to
 * the user's hook list. Kept separate from the runtime engine so
 * wire-up sites import a single helper instead of duplicating shape.
 *
 * `command` is mandatory on the underlying `HookConfig` so we set it
 * to a synthetic label — the engine's builtin dispatcher short-circuits
 * before any shell expansion happens, so the value is never executed.
 */
export interface BuiltinScannerHookEntry {
  trigger: 'PreToolUse';
  toolPattern: 'git_commit';
  builtin: typeof SECRET_SCANNER_BUILTIN;
  command: string;
  blocking: true;
  description: string;
}

export const SECRET_SCANNER_HOOK: BuiltinScannerHookEntry = {
  trigger: 'PreToolUse',
  toolPattern: 'git_commit',
  builtin: SECRET_SCANNER_BUILTIN,
  command: '(builtin: secret-scanner)',
  blocking: true,
  description: 'Block git_commit when staged diff contains unredacted secrets.',
};

/**
 * Read the security config and decide whether to prepend the built-in
 * secret scanner hook to the user's hook list. Defaults to ON when the
 * config is absent / silent — keeps the security floor intact for
 * users who never touched the section.
 *
 * Returns `HookConfig`-compatible entries: structurally a superset of
 * the schema's `HookConfigEntry` (only the `builtin` field differs;
 * the schema has been widened to accept it).
 */
export function withBuiltinSecurityHooks<T extends HookConfigShape>(
  existing: readonly T[] | undefined,
  opts: { enabled?: boolean } = {},
): T[] {
  const list: T[] = existing === undefined ? [] : [...existing];
  if (opts.enabled === false) return list;
  // Prepend so the scanner runs first in the parallel batch — order
  // doesn't matter for correctness (engine runs in parallel + collects
  // outcomes) but it's marginally nicer for debugging.
  // Structural cast: SECRET_SCANNER_HOOK satisfies HookConfigShape; T is
  // any subtype the caller supplied (e.g. HookConfig from @/hooks).
  const entry: HookConfigShape = SECRET_SCANNER_HOOK;
  list.unshift(entry as T);
  return list;
}

/**
 * Get the staged diff via `git diff --cached --no-color`. Returns the
 * empty string when not inside a git repo (or git is missing) so the
 * scanner becomes a no-op rather than failing the commit attempt.
 *
 * Injectable for tests.
 */
export interface DiffSource {
  (projectRoot: string): string;
}

export const defaultDiffSource: DiffSource = (projectRoot: string): string => {
  try {
    if (!fs.existsSync(path.join(projectRoot, '.git'))) {
      // Maybe inside a worktree — still attempt git, but be quick to
      // bail. The execFileSync below will throw on non-repos and we
      // return ''.
    }
    const out = execFileSync('git', ['diff', '--cached', '--no-color'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out;
  } catch {
    return '';
  }
};

/**
 * Run the built-in secret scanner against the staged diff. Returns a
 * shape the engine can wrap into a `HookOutcome`.
 *
 * Exit codes:
 *   - `0` — no findings (or all allowlisted).
 *   - `2` — one or more findings remained after the allowlist; commit blocked.
 */
export function runSecretScannerBuiltin(
  ctx: BuiltinHookContext,
  diffSource: DiffSource = defaultDiffSource,
): BuiltinHookResult {
  const diff = diffSource(ctx.projectRoot);
  if (diff.length === 0) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  const raw = scanCommitDiff(diff);
  const { entries, errors } = loadAllowlist(ctx.projectRoot);
  if (errors.length > 0) {
    // Malformed allowlist — fail closed: behave as if no allowlist
    // existed so we don't accidentally let secrets through.
    const filtered = applyAllowlist(raw, []);
    if (filtered.length === 0) return { exitCode: 0, stdout: '', stderr: '' };
    return blockResult(filtered, errors);
  }
  const findings = applyAllowlist(raw, entries);
  if (findings.length === 0) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  return blockResult(findings, []);
}

function blockResult(findings: readonly Finding[], extraNotes: readonly string[]): BuiltinHookResult {
  const header = 'Secret scanner blocked git_commit:';
  const lines: string[] = [header];
  for (const f of findings) {
    lines.push(`  - ${formatFinding(f)}`);
  }
  if (extraNotes.length > 0) {
    lines.push('');
    lines.push('allowlist load issues (fail-closed):');
    for (const n of extraNotes) lines.push(`  - ${n}`);
  }
  lines.push('');
  lines.push(
    'Edit .localcode/secret-allowlist.toml to whitelist false positives, or remove the secret from the staged diff.',
  );
  return {
    exitCode: 2,
    stdout: '',
    stderr: lines.join('\n'),
  };
}
