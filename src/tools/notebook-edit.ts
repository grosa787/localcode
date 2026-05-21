/**
 * `edit_notebook` tool — two-phase edit of a single cell in a Jupyter
 * `.ipynb` notebook.
 *
 * Phase 1 (`editNotebook`)    → preview the change as a diff-style
 *                                summary. Does not touch disk.
 * Phase 2 (`commitEditNotebook`) → re-reads the notebook, re-validates
 *                                the operation, writes the file back as
 *                                pretty-printed JSON (2-space indent,
 *                                matching the Jupyter convention).
 *
 * Modes:
 *   - `replace`: overwrite `cells[cellIndex].source` with `newSource`.
 *     Clears `execution_count` and `outputs` on the touched cell — the
 *     existing outputs are stale once the source changes.
 *   - `insert`: insert a new cell at `cellIndex` with `cellType` +
 *     `newSource`. Cells at and after the index shift right by one.
 *   - `delete`: remove `cells[cellIndex]`. Subsequent cells shift left.
 *
 * Invariants:
 *   - nbformat 4 only (delegated to `parseNotebook`).
 *   - Cell metadata, top-level metadata, nbformat, nbformat_minor, and
 *     any unrecognised fields on cells are preserved verbatim — we
 *     never silently drop content we don't understand.
 *   - On `replace`, `outputs` is reset to `[]` and `execution_count`
 *     is set to `null`. (Source no longer matches the stored output —
 *     keeping the old outputs would be misleading.)
 *   - On `insert`, the new cell gets a fresh nanoid-style id so it
 *     plays nice with nbformat 4.5+ (id-aware) Jupyter clients.
 *   - Args validated with Zod; nothing is written until commit.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { resolveSafePathStrict } from './path-safety';
import type { ToolContext, ToolResult } from './types';
import {
  parseNotebook,
  sourceToString,
  type ParsedCell,
  type ParsedNotebook,
} from './notebook-read';

/** Zod schema for `edit_notebook` arguments. */
export const EditNotebookArgsSchema = z
  .object({
    path: z.string().min(1, 'path must be a non-empty string'),
    mode: z.union([
      z.literal('replace'),
      z.literal('insert'),
      z.literal('delete'),
    ]),
    cellIndex: z.number().int('cellIndex must be an integer').min(0, 'cellIndex must be >= 0'),
    cellType: z.union([z.literal('code'), z.literal('markdown')]).optional(),
    newSource: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === 'replace' && data.newSource === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mode 'replace' requires newSource",
        path: ['newSource'],
      });
    }
    if (data.mode === 'insert') {
      if (data.newSource === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mode 'insert' requires newSource",
          path: ['newSource'],
        });
      }
      if (data.cellType === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mode 'insert' requires cellType ('code' or 'markdown')",
          path: ['cellType'],
        });
      }
    }
  });

export type EditNotebookArgs = z.infer<typeof EditNotebookArgsSchema>;

/**
 * Generate a notebook cell id matching the nbformat 4.5 convention:
 * 8 lowercase alphanumeric characters. We don't depend on a uuid
 * library because the spec only requires "a string that uniquely
 * identifies the cell within the notebook" — a short random token
 * suffices.
 */
function generateCellId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

/**
 * Render a multi-line source string as ASCII-bordered block for the
 * preview output. Avoids fenced code (```), which would conflict with
 * markdown rendering downstream when the model echoes the diff.
 */
function previewBlock(label: string, body: string): string {
  const lines = body.split('\n');
  const indented = lines.map((l) => `  ${l}`).join('\n');
  return `${label}:\n${indented}`;
}

/**
 * Resolve the absolute path with the standard hardening, returning
 * either the path or an error string. Centralised so preview + commit
 * share the same defensive shape.
 */
function resolveOrError(
  ctx: ToolContext,
  relPath: string,
): { ok: true; absolutePath: string } | { ok: false; error: string } {
  const absolutePath = resolveSafePathStrict(ctx.projectRoot, relPath);
  if (absolutePath === null) {
    return {
      ok: false,
      error: `Path traversal blocked: '${relPath}' escapes project root`,
    };
  }
  return { ok: true, absolutePath };
}

/**
 * Read a notebook file from disk and parse it. Returns a discriminated
 * union so the caller can branch on success/failure cleanly.
 */
async function readAndParse(
  absolutePath: string,
  relPath: string,
): Promise<
  | { ok: true; raw: string; notebook: ReturnType<typeof parseNotebook> }
  | { ok: false; error: string }
> {
  let raw: string;
  try {
    raw = await fs.readFile(absolutePath, 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return { ok: false, error: `File not found: '${relPath}'` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read '${relPath}': ${message}` };
  }
  const parsed = parseNotebook(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  return { ok: true, raw, notebook: parsed };
}

/**
 * Index-bounds check, parameterised by mode. `insert` allows
 * `cellIndex === cells.length` (appending). The other modes require
 * `cellIndex < cells.length`.
 */
function checkIndex(
  mode: EditNotebookArgs['mode'],
  cellIndex: number,
  cellCount: number,
): string | null {
  if (mode === 'insert') {
    if (cellIndex < 0 || cellIndex > cellCount) {
      return `cellIndex ${cellIndex} out of range; valid insert positions are 0..${cellCount}`;
    }
    return null;
  }
  if (cellIndex < 0 || cellIndex >= cellCount) {
    return `cellIndex ${cellIndex} out of range; notebook has ${cellCount} cells (valid 0..${cellCount - 1})`;
  }
  return null;
}

/**
 * Build the human-readable preview string describing the pending
 * change. The model uses this verbatim in its tool-call narrative.
 */
function buildPreview(
  relPath: string,
  args: EditNotebookArgs,
  cells: readonly ParsedCell[],
): string {
  const { mode, cellIndex } = args;
  const total = cells.length;
  if (mode === 'replace') {
    const targetCell = cells[cellIndex];
    if (targetCell === undefined) {
      // Bounds were checked upstream; defensive guard for the type checker.
      return `${mode} cell ${cellIndex} in ${relPath}`;
    }
    const oldSource = sourceToString(targetCell.source);
    return (
      `Replace cell ${cellIndex}/${total - 1} (${targetCell.cell_type}) in ${relPath}\n\n` +
      `${previewBlock('--- old source', oldSource)}\n\n` +
      `${previewBlock('+++ new source', args.newSource ?? '')}`
    );
  }
  if (mode === 'insert') {
    return (
      `Insert ${args.cellType ?? '?'} cell at index ${cellIndex} in ${relPath} ` +
      `(notebook will grow ${total} → ${total + 1} cells)\n\n` +
      `${previewBlock('+++ new source', args.newSource ?? '')}`
    );
  }
  // delete
  const targetCell = cells[cellIndex];
  if (targetCell === undefined) {
    return `${mode} cell ${cellIndex} in ${relPath}`;
  }
  const oldSource = sourceToString(targetCell.source);
  return (
    `Delete cell ${cellIndex}/${total - 1} (${targetCell.cell_type}) from ${relPath} ` +
    `(notebook will shrink ${total} → ${total - 1} cells)\n\n` +
    `${previewBlock('--- removed source', oldSource)}`
  );
}

/**
 * Apply the requested edit to a clone of the cells array. Returns the
 * mutated cells (caller writes them back into the notebook envelope).
 *
 * IMPORTANT: works on a *shallow* copy of the cells array; each
 * touched cell is also shallow-cloned before mutation so we never
 * accidentally mutate the parser's output (which would surprise the
 * caller in tests that re-read the same notebook).
 */
function applyEdit(
  cells: ParsedCell[],
  args: EditNotebookArgs,
): ParsedCell[] {
  const next = cells.slice();
  if (args.mode === 'replace') {
    const orig = next[args.cellIndex];
    if (orig === undefined) return next;
    // newSource is guaranteed string by Zod superRefine when mode === 'replace'.
    const newSource = args.newSource ?? '';
    const replaced: ParsedCell = {
      ...orig,
      source: newSource,
      // Source changed → existing outputs/execution count are stale.
      outputs: orig.cell_type === 'code' ? [] : orig.outputs,
      ...(orig.cell_type === 'code'
        ? { execution_count: null }
        : {}),
    };
    next[args.cellIndex] = replaced;
    return next;
  }
  if (args.mode === 'insert') {
    const cellType = args.cellType;
    if (cellType === undefined) return next;
    const newSource = args.newSource ?? '';
    const inserted: ParsedCell = {
      cell_type: cellType,
      id: generateCellId(),
      metadata: {},
      source: newSource,
      ...(cellType === 'code'
        ? { execution_count: null, outputs: [] }
        : {}),
    };
    next.splice(args.cellIndex, 0, inserted);
    return next;
  }
  // delete
  next.splice(args.cellIndex, 1);
  return next;
}

/**
 * Serialise the notebook back to disk-ready JSON. Mirrors the
 * conventional Jupyter format: 2-space indent, trailing newline.
 */
function serializeNotebook(notebook: ParsedNotebook): string {
  return `${JSON.stringify(notebook, null, 2)}\n`;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Preview the notebook edit. Reports `requiresApproval: true` so the
 * tool-executor can prompt the user; the file is NOT modified here.
 */
export async function editNotebook(
  args: EditNotebookArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = EditNotebookArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      requiresApproval: true,
    };
  }

  const resolved = resolveOrError(ctx, parsed.data.path);
  if (!resolved.ok) {
    return {
      success: false,
      output: '',
      error: resolved.error,
      requiresApproval: true,
    };
  }

  // Quick sanity check: the tool is named edit_*NOTEBOOK*, so refuse
  // anything that doesn't look like an `.ipynb` file. The Zod schema
  // is permissive on extension so callers can target unusual paths,
  // but we want a friendly message rather than a JSON parse failure.
  if (path.extname(parsed.data.path).toLowerCase() !== '.ipynb') {
    return {
      success: false,
      output: '',
      error: `Not a Jupyter notebook: '${parsed.data.path}' (expected .ipynb extension)`,
      requiresApproval: true,
    };
  }

  const read = await readAndParse(resolved.absolutePath, parsed.data.path);
  if (!read.ok) {
    return {
      success: false,
      output: '',
      error: read.error,
      requiresApproval: true,
    };
  }
  if (!read.notebook.ok) {
    // Should be unreachable — readAndParse already widens this case.
    return {
      success: false,
      output: '',
      error: read.notebook.error,
      requiresApproval: true,
    };
  }

  const notebook = read.notebook.data;
  const boundsError = checkIndex(
    parsed.data.mode,
    parsed.data.cellIndex,
    notebook.cells.length,
  );
  if (boundsError !== null) {
    return {
      success: false,
      output: '',
      error: boundsError,
      requiresApproval: true,
    };
  }

  const preview = buildPreview(parsed.data.path, parsed.data, notebook.cells);
  return {
    success: true,
    output: preview,
    requiresApproval: true,
  };
}

/**
 * Commit a previously-previewed notebook edit. Re-reads the file and
 * re-validates bounds + nbformat (the file may have changed between
 * preview and commit); only then writes the mutated notebook back.
 */
export async function commitEditNotebook(
  args: EditNotebookArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = EditNotebookArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const resolved = resolveOrError(ctx, parsed.data.path);
  if (!resolved.ok) {
    return { success: false, output: '', error: resolved.error };
  }

  if (path.extname(parsed.data.path).toLowerCase() !== '.ipynb') {
    return {
      success: false,
      output: '',
      error: `Not a Jupyter notebook: '${parsed.data.path}' (expected .ipynb extension)`,
    };
  }

  const read = await readAndParse(resolved.absolutePath, parsed.data.path);
  if (!read.ok) {
    return { success: false, output: '', error: read.error };
  }
  if (!read.notebook.ok) {
    return { success: false, output: '', error: read.notebook.error };
  }

  const notebook = read.notebook.data;
  const boundsError = checkIndex(
    parsed.data.mode,
    parsed.data.cellIndex,
    notebook.cells.length,
  );
  if (boundsError !== null) {
    return {
      success: false,
      output: '',
      error: `File modified since preview; re-run edit (${boundsError})`,
    };
  }

  const newCells = applyEdit(notebook.cells.slice(), parsed.data);

  // Build the next notebook by replacing only the `cells` array — every
  // other top-level field (metadata, nbformat, nbformat_minor, plus
  // any unrecognised keys captured via `passthrough()`) survives
  // verbatim.
  const nextNotebook = { ...notebook, cells: newCells };

  try {
    await fs.writeFile(
      resolved.absolutePath,
      serializeNotebook(nextNotebook),
      'utf8',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to write '${parsed.data.path}': ${message}`,
    };
  }

  const oldCount = notebook.cells.length;
  const newCount = newCells.length;
  const summary = (() => {
    if (parsed.data.mode === 'replace') {
      return `Replaced cell ${parsed.data.cellIndex} in ${parsed.data.path} (${oldCount} cells, unchanged count)`;
    }
    if (parsed.data.mode === 'insert') {
      return `Inserted ${parsed.data.cellType} cell at ${parsed.data.cellIndex} in ${parsed.data.path} (${oldCount} → ${newCount} cells)`;
    }
    return `Deleted cell ${parsed.data.cellIndex} from ${parsed.data.path} (${oldCount} → ${newCount} cells)`;
  })();

  return { success: true, output: summary };
}
