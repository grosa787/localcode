/**
 * Check #10 — Hooks engine syntax-validates each configured hook script.
 *
 * "Syntax-validate" is intentionally cheap: we ensure each hook entry
 * has a non-empty `command` (Zod has already enforced shape). For
 * shell-script hooks pointing at a file (commands containing `.sh` or
 * `.bash`), the file is also checked for existence so a wrong path is
 * surfaced before the first trigger.
 */

import { existsSync } from 'node:fs';
import type { Config } from '@/config/types';
import type { DoctorCheckResult } from './types';

function extractScriptPath(command: string): string | null {
  // Best-effort: the first whitespace-separated token that looks like
  // a path ending in `.sh` / `.bash` / `.js` / `.ts`. Anything else is
  // treated as an inline shell command (no file to verify).
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    if (/\.(sh|bash|zsh|fish|js|ts|py)$/i.test(tok)) {
      return tok;
    }
  }
  return null;
}

export async function checkHooks(
  config: Config | null,
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  if (config === null) {
    return {
      name: 'Hooks',
      status: 'warn',
      message: 'Skipped — no parsed config.',
      durationMs: Date.now() - startedAt,
    };
  }
  const hooks = config.hooks ?? [];
  if (hooks.length === 0) {
    return {
      name: 'Hooks',
      status: 'ok',
      message: 'No hooks configured.',
      durationMs: Date.now() - startedAt,
    };
  }
  const issues: string[] = [];
  for (let i = 0; i < hooks.length; i += 1) {
    const h = hooks[i];
    if (h === undefined) continue;
    if (h.builtin !== undefined) continue;
    if (h.command.trim().length === 0) {
      issues.push(`[${i}] empty command`);
      continue;
    }
    const scriptPath = extractScriptPath(h.command);
    if (scriptPath !== null && scriptPath.startsWith('/') && !existsSync(scriptPath)) {
      issues.push(`[${i}] script missing: ${scriptPath}`);
    }
  }
  const durationMs = Date.now() - startedAt;
  if (issues.length === 0) {
    return {
      name: 'Hooks',
      status: 'ok',
      message: `${hooks.length} hook${hooks.length === 1 ? '' : 's'} configured.`,
      durationMs,
    };
  }
  return {
    name: 'Hooks',
    status: 'warn',
    message: `${hooks.length} hook${hooks.length === 1 ? '' : 's'} configured, ${issues.length} issue${issues.length === 1 ? '' : 's'}.`,
    durationMs,
    detail: issues.join('; '),
  };
}
