/**
 * Claude Code → LocalCode tool name mapping.
 *
 * Claude Code (Anthropic's CLI) and LocalCode expose conceptually
 * overlapping builtin tools under slightly different names. The
 * migration importer rewrites Claude Code tool_use / tool_result rows
 * onto LocalCode's vocabulary so resumed sessions can be replayed and
 * referenced by name without surprising the user.
 *
 * Mapping policy:
 *  - Direct equivalents map 1:1 (`Read` → `read_file`).
 *  - Tools without a direct LocalCode equivalent are best-effort mapped
 *    to the closest builtin and the warning is surfaced via
 *    `toolMapWarnings` in the importer return value.
 *  - Unknown tools are preserved verbatim AND added to the warnings
 *    array so the user sees what was kept as-is.
 *
 * Everything here is pure data — no I/O, no schema validation. The
 * importer composes this with `bun:sqlite` writes downstream.
 */

/**
 * Known direct equivalents. Keep alphabetically sorted by Claude Code
 * tool name so adding a new row is a stable diff.
 */
export const CLAUDE_CODE_TOOL_MAP: Readonly<Record<string, string>> = {
  Bash: 'run_command',
  Edit: 'edit_file',
  Glob: 'glob_search',
  MultiEdit: 'multi_edit',
  Read: 'read_file',
  Write: 'write_file',
} as const;

/**
 * Tools that Claude Code exposes but LocalCode does not have a direct
 * builtin for. These map to the closest LocalCode tool and the importer
 * emits a warning so the user knows the call was rewritten.
 *
 *  - `Grep` → routed through `run_command` (shells out to ripgrep/grep).
 *  - `Task` → no equivalent (sub-agent dispatch); preserved as a text
 *    note in the assistant content. Importer treats this specially.
 */
export const CLAUDE_CODE_TOOL_FALLBACK: Readonly<
  Record<string, { mappedName: string; warning: string }>
> = {
  Grep: {
    mappedName: 'run_command',
    warning:
      "tool 'Grep' has no direct LocalCode equivalent; rewritten as `run_command` (use ripgrep/grep)",
  },
  Task: {
    mappedName: 'run_command',
    warning:
      "tool 'Task' has no LocalCode equivalent (sub-agent dispatch); preserved as text note",
  },
} as const;

/**
 * Result of mapping a single Claude Code tool name.
 *
 * - `mappedName` — the LocalCode tool id to persist (always defined).
 * - `warning`    — non-empty when the mapping was non-trivial (fallback
 *                  or unknown). Empty string when the mapping was a
 *                  direct, known equivalent.
 * - `isUnknown`  — true when no entry exists in either table. The
 *                  caller persists the row but flags the user.
 */
export interface MappedTool {
  readonly mappedName: string;
  readonly warning: string;
  readonly isUnknown: boolean;
}

/**
 * Map a Claude Code tool name onto its LocalCode equivalent.
 *
 * Resolution order:
 *   1. Direct equivalent table → no warning.
 *   2. Fallback table → carries the canonical warning.
 *   3. Unknown → preserved verbatim, generic warning.
 *
 * The function is pure and never throws.
 */
export function mapClaudeCodeTool(claudeCodeName: string): MappedTool {
  const trimmed = claudeCodeName.trim();
  if (trimmed.length === 0) {
    return {
      mappedName: '',
      warning: 'empty tool name (skipped)',
      isUnknown: true,
    };
  }

  const direct = CLAUDE_CODE_TOOL_MAP[trimmed];
  if (direct !== undefined) {
    return { mappedName: direct, warning: '', isUnknown: false };
  }

  const fallback = CLAUDE_CODE_TOOL_FALLBACK[trimmed];
  if (fallback !== undefined) {
    return {
      mappedName: fallback.mappedName,
      warning: fallback.warning,
      isUnknown: false,
    };
  }

  return {
    mappedName: trimmed,
    warning: `tool '${trimmed}' is unknown to LocalCode; preserved as-is`,
    isUnknown: true,
  };
}

/**
 * Count of statically-known direct + fallback tool names. Used by the
 * importer's progress / summary surface and by tests as a regression
 * guard so accidental table shrinkage is detected.
 */
export function knownToolCount(): number {
  return (
    Object.keys(CLAUDE_CODE_TOOL_MAP).length +
    Object.keys(CLAUDE_CODE_TOOL_FALLBACK).length
  );
}
