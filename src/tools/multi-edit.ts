/**
 * `multi_edit` tool — atomic batch of find/replace edits on a single file.
 *
 * Two-phase with approval (mirrors `edit_file`):
 *   Phase 1 (`multiEdit`)        → cumulative preview as unified diff; no
 *                                   disk side-effects.
 *   Phase 2 (`commitMultiEdit`)  → re-reads file, re-applies the same edit
 *                                   sequence, then writes atomically
 *                                   (tmp file + rename).
 *
 * Semantics:
 *   - Edits apply SEQUENTIALLY: edit N operates on the result of edit N-1.
 *   - For each edit:
 *       * `replaceAll === true`  → every occurrence of `oldString` is
 *                                   replaced. Fails when there are zero
 *                                   occurrences.
 *       * otherwise              → `oldString` must occur exactly once in
 *                                   the current intermediate content.
 *                                   Fails on zero matches and on two-or-
 *                                   more matches.
 *       * `oldString === newString` → rejected before any edit runs.
 *   - ALL-OR-NOTHING: if any edit fails, NO bytes are written.
 *
 * Why a tmp+rename atomic write: the spec mandates the file must never be
 * left half-written. POSIX `rename(2)` is atomic on the same filesystem.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';

import { resolveSafePathStrict } from './path-safety';
import type { ToolContext, ToolResult } from './types';

/** Single edit operation. Zod-validated; fields renamed to snake_case at
 *  the wire boundary by the LLM tools schema (see `tools-schema.ts`). */
export const MultiEditOperationSchema = z.object({
  oldString: z.string().min(1, 'oldString must be a non-empty string'),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

/** Zod schema for `multi_edit` arguments. */
export const MultiEditArgsSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  edits: z
    .array(MultiEditOperationSchema)
    .min(1, 'edits must contain at least one operation'),
});

export type MultiEditOperation = z.infer<typeof MultiEditOperationSchema>;
export type MultiEditArgs = z.infer<typeof MultiEditArgsSchema>;

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/** Total line count of a string (split on \n). */
function lineCount(text: string): number {
  return text.split('\n').length;
}

/** Replace EVERY occurrence of `needle` with `replacement` using a left-
 *  to-right scan. Does NOT use `String.prototype.replaceAll` so the result
 *  is identical even when `needle` contains regex meta-characters. */
function replaceEvery(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  if (needle.length === 0) return haystack;
  let out = '';
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) {
      out += haystack.slice(from);
      return out;
    }
    out += haystack.slice(from, idx) + replacement;
    from = idx + needle.length;
  }
}

interface ApplyResolution {
  ok: boolean;
  newContent?: string;
  error?: string;
}

/**
 * Apply the sequence of edits to `original`. Returns the cumulative
 * result, or a structured failure with the 1-based index of the offending
 * edit. Pure — does not touch the filesystem.
 */
function applyEdits(
  original: string,
  edits: readonly MultiEditOperation[],
  relPath: string,
): ApplyResolution {
  let current = original;
  for (let i = 0; i < edits.length; i += 1) {
    const e = edits[i];
    if (e === undefined) {
      // Unreachable: Zod ensures min length 1 and array elements are
      // present, but `noUncheckedIndexedAccess` requires the guard.
      return {
        ok: false,
        error: `Edit #${i + 1} is missing (internal error)`,
      };
    }
    if (e.oldString === e.newString) {
      return {
        ok: false,
        error: `Edit #${i + 1} for ${relPath} has identical oldString and newString — no-op edits are rejected`,
      };
    }

    const matches = countOccurrences(current, e.oldString);
    if (matches === 0) {
      return {
        ok: false,
        error:
          `Edit #${i + 1} for ${relPath}: oldString not found in the file ` +
          `(after applying ${i} prior edit${i === 1 ? '' : 's'}). ` +
          `Tip: matches are exact — include surrounding whitespace and indentation.`,
      };
    }

    if (e.replaceAll === true) {
      current = replaceEvery(current, e.oldString, e.newString);
      continue;
    }

    if (matches > 1) {
      return {
        ok: false,
        error:
          `Edit #${i + 1} for ${relPath}: oldString matches ${matches} locations; ` +
          `it must be unique (or pass replaceAll: true). Include more context to disambiguate.`,
      };
    }

    // Exactly one match — replace it.
    const idx = current.indexOf(e.oldString);
    current =
      current.slice(0, idx) + e.newString + current.slice(idx + e.oldString.length);
  }
  return { ok: true, newContent: current };
}

/**
 * Atomic write: stage content into a sibling tmp file on the same
 * filesystem, then `rename(2)` over the target. The target is replaced
 * atomically; on failure the original bytes are untouched.
 *
 * Best-effort cleanup: if the rename throws, we attempt to unlink the
 * tmp file so we don't leak `*.tmp-*` debris in the project.
 */
async function atomicWrite(absolutePath: string, content: string): Promise<void> {
  const dir = path.dirname(absolutePath);
  const base = path.basename(absolutePath);
  const tmpName = `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, absolutePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore cleanup failures
    }
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────

/**
 * Preview a multi-edit batch as a single unified diff (original vs.
 * cumulative). Returns `requiresApproval: true` so the executor surfaces
 * the diff to the user before commit. The file is NOT modified here.
 */
export async function multiEdit(
  args: MultiEditArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = MultiEditArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      requiresApproval: true,
    };
  }

  const { path: relPath, edits } = parsed.data;

  const absolutePath = resolveSafePathStrict(ctx.projectRoot, relPath);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${relPath}' escapes project root`,
      requiresApproval: true,
    };
  }

  let oldContent: string;
  try {
    oldContent = await fs.readFile(absolutePath, 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return {
        success: false,
        output: '',
        error: `File not found: ${relPath}. Use write_file to create it.`,
        requiresApproval: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to read '${relPath}': ${message}`,
      requiresApproval: true,
    };
  }

  const resolution = applyEdits(oldContent, edits, relPath);
  if (!resolution.ok || resolution.newContent === undefined) {
    return {
      success: false,
      output: '',
      error: resolution.error ?? 'Failed to apply edits',
      requiresApproval: true,
    };
  }

  try {
    const diff = createTwoFilesPatch(
      relPath,
      relPath,
      oldContent,
      resolution.newContent,
    );
    return {
      success: true,
      output: diff,
      requiresApproval: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to prepare diff for '${relPath}': ${message}`,
      requiresApproval: true,
    };
  }
}

/**
 * Commit a previously-previewed multi-edit batch. Re-reads the file and
 * re-applies the edit sequence (so a between-phase change in the file is
 * surfaced rather than silently merged). Writes the cumulative result
 * atomically.
 */
export async function commitMultiEdit(
  args: MultiEditArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = MultiEditArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const { path: relPath, edits } = parsed.data;

  const absolutePath = resolveSafePathStrict(ctx.projectRoot, relPath);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${relPath}' escapes project root`,
    };
  }

  let oldContent: string;
  try {
    oldContent = await fs.readFile(absolutePath, 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return {
        success: false,
        output: '',
        error: `File not found: ${relPath}. Use write_file to create it.`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to read '${relPath}': ${message}`,
    };
  }

  const resolution = applyEdits(oldContent, edits, relPath);
  if (!resolution.ok || resolution.newContent === undefined) {
    return {
      success: false,
      output: '',
      error:
        resolution.error !== undefined
          ? `File modified since preview or edit no longer applies: ${resolution.error}`
          : `Failed to apply edits for ${relPath}`,
    };
  }

  try {
    await atomicWrite(absolutePath, resolution.newContent);
    const oldLineCount = lineCount(oldContent);
    const newLineCount = lineCount(resolution.newContent);
    const delta = newLineCount - oldLineCount;
    const editsLabel = `${edits.length} edit${edits.length === 1 ? '' : 's'}`;
    const output =
      delta === 0
        ? `Multi-edited ${relPath}: ${editsLabel}, ${oldLineCount} lines (in-place)`
        : `Multi-edited ${relPath}: ${editsLabel}, ${oldLineCount} → ${newLineCount} lines (${delta > 0 ? '+' : ''}${delta})`;
    return {
      success: true,
      output,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to write '${relPath}': ${message}`,
    };
  }
}
