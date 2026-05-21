/**
 * `read_notebook` tool — read a Jupyter `.ipynb` notebook and return a
 * structured summary of its cells.
 *
 * Single-phase, read-only (mirrors `read_file`). Output is JSON: cells
 * array with `index`, `id`, `cell_type`, `source` (string), `outputs`
 * (text/plain only, trimmed), plus a top-level `metadata` block carrying
 * the kernel + language hint when present.
 *
 * Why a dedicated tool rather than `read_file`: notebooks are JSON
 * blobs where `source` and `outputs` are usually arrays of strings —
 * raw `read_file` is noisy and image / binary outputs blow up token
 * budgets fast. This tool flattens source to a string and strips
 * everything that isn't `text/plain`.
 *
 * Invariants:
 *   - nbformat 4 only — older formats are rejected with an actionable
 *     error rather than silently coerced.
 *   - Path is resolved with `resolveSafePathStrict` (same guard as
 *     other read-side tools).
 *   - Args validated with Zod. Unknown / extra cell metadata is passed
 *     through unchanged (`metadata` field is preserved verbatim in the
 *     parsed form; we just don't surface it in the trimmed output).
 *   - Per-cell output cap: max 5 outputs, each trimmed to 2000 chars.
 *     This is purely about token budget — `edit_notebook` does not use
 *     the trimmed form.
 */

import { promises as fs } from 'node:fs';
import { z } from 'zod';

import { resolveSafePathStrict } from './path-safety';
import type { ToolContext, ToolResult } from './types';

/** Zod schema for `read_notebook` arguments. */
export const ReadNotebookArgsSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  includeOutputs: z.boolean().optional(),
});

export type ReadNotebookArgs = z.infer<typeof ReadNotebookArgsSchema>;

/** Maximum characters per individual output stream/data field we surface. */
const MAX_OUTPUT_CHARS = 2000;
/** Maximum outputs surfaced per cell. */
const MAX_OUTPUTS_PER_CELL = 5;

// ─── Notebook JSON schemas (nbformat 4) ────────────────────────────────

/**
 * `source` is canonically an array of strings (one per line, each
 * including its trailing newline). nbformat 4 also permits a single
 * string for convenience. We accept both and normalise on output.
 */
const SourceSchema = z.union([z.string(), z.array(z.string())]);

const StreamOutputSchema = z.object({
  output_type: z.literal('stream'),
  name: z.string().optional(),
  text: SourceSchema,
});

const DisplayDataLikeSchema = z.object({
  output_type: z.union([
    z.literal('display_data'),
    z.literal('execute_result'),
    z.literal('update_display_data'),
  ]),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  execution_count: z.number().int().nullable().optional(),
});

const ErrorOutputSchema = z.object({
  output_type: z.literal('error'),
  ename: z.string().optional(),
  evalue: z.string().optional(),
  traceback: z.array(z.string()).optional(),
});

/**
 * Permissive cell-output schema — we accept ANY object whose
 * `output_type` is a string. The three known shapes above are the
 * happy paths; anything else (custom Jupyter extensions) is preserved
 * verbatim as "unknown output". `edit_notebook` round-trips outputs
 * untouched, so we never need to interpret them precisely.
 */
const OutputSchema = z.union([
  StreamOutputSchema,
  DisplayDataLikeSchema,
  ErrorOutputSchema,
  z
    .object({ output_type: z.string() })
    .passthrough(),
]);

const CellSchema = z
  .object({
    cell_type: z.union([
      z.literal('code'),
      z.literal('markdown'),
      z.literal('raw'),
    ]),
    id: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    source: SourceSchema,
    execution_count: z.number().int().nullable().optional(),
    outputs: z.array(OutputSchema).optional(),
  })
  .passthrough();

/**
 * Top-level notebook schema. `nbformat` MUST be 4; older notebooks are
 * rejected with a clear message at parse time (see `parseNotebook`).
 */
const NotebookSchema = z
  .object({
    cells: z.array(CellSchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
    nbformat: z.number().int(),
    nbformat_minor: z.number().int().optional(),
  })
  .passthrough();

export type ParsedNotebook = z.infer<typeof NotebookSchema>;
export type ParsedCell = z.infer<typeof CellSchema>;
export type ParsedOutput = z.infer<typeof OutputSchema>;

/**
 * Parse and validate a notebook JSON string. Returns either the parsed
 * notebook or a human-readable error message. Used by both
 * `read_notebook` and `edit_notebook`.
 */
export function parseNotebook(
  raw: string,
): { ok: true; data: ParsedNotebook } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Notebook is not valid JSON: ${message}` };
  }

  const parsed = NotebookSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      error: `Notebook schema validation failed: ${issues}`,
    };
  }

  if (parsed.data.nbformat !== 4) {
    return {
      ok: false,
      error:
        `Unsupported nbformat ${parsed.data.nbformat}; only nbformat 4 is accepted. ` +
        `Use Jupyter to upgrade the file (File → Save and Export Notebook As).`,
    };
  }

  return { ok: true, data: parsed.data };
}

/** Flatten a `source` field (string or string[]) to a single string. */
export function sourceToString(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

/**
 * Truncate `text` to `MAX_OUTPUT_CHARS` and append a marker noting the
 * trimmed length. Avoids surprising the model with mid-line truncation.
 */
function trimOutputText(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const truncated = text.slice(0, MAX_OUTPUT_CHARS);
  const dropped = text.length - MAX_OUTPUT_CHARS;
  return `${truncated}\n[... ${dropped} chars truncated ...]`;
}

/**
 * Shape of a single output emitted by `read_notebook`. Only carries
 * text-shaped fields — image/binary outputs collapse to a stub.
 */
interface TrimmedOutput {
  output_type: string;
  /** Stream name (`stdout` / `stderr`), present for `stream` outputs. */
  name?: string;
  /** Flattened textual content (stream text, text/plain, or error trace). */
  text?: string;
  /** Stub note for outputs we deliberately drop (e.g. image/png). */
  note?: string;
}

/**
 * Build the trimmed-output array for a single cell. Only `text/plain`
 * MIME data is surfaced; any other MIME (image/png, image/jpeg, ...)
 * becomes a one-line stub so the model still knows there *was* an
 * output without paying the token cost of the binary.
 */
function trimCellOutputs(outputs: ParsedOutput[]): TrimmedOutput[] {
  const trimmed: TrimmedOutput[] = [];
  for (const output of outputs) {
    if (trimmed.length >= MAX_OUTPUTS_PER_CELL) {
      trimmed.push({
        output_type: 'note',
        note: `... ${outputs.length - trimmed.length + 1} more outputs omitted ...`,
      });
      break;
    }
    if (output.output_type === 'stream') {
      // Stream outputs have a `text` field with the canonical source shape.
      const stream = output as z.infer<typeof StreamOutputSchema>;
      trimmed.push({
        output_type: 'stream',
        ...(stream.name === undefined ? {} : { name: stream.name }),
        text: trimOutputText(sourceToString(stream.text)),
      });
      continue;
    }
    if (
      output.output_type === 'display_data' ||
      output.output_type === 'execute_result' ||
      output.output_type === 'update_display_data'
    ) {
      // Pull text/plain out of `data` if present; else stub the MIME list.
      const dd = output as z.infer<typeof DisplayDataLikeSchema>;
      const data = dd.data ?? {};
      const plain = data['text/plain'];
      if (plain !== undefined) {
        const flat = Array.isArray(plain)
          ? plain.filter((p): p is string => typeof p === 'string').join('')
          : typeof plain === 'string'
            ? plain
            : JSON.stringify(plain);
        trimmed.push({
          output_type: output.output_type,
          text: trimOutputText(flat),
        });
        continue;
      }
      const mimeKeys = Object.keys(data);
      trimmed.push({
        output_type: output.output_type,
        note:
          mimeKeys.length === 0
            ? 'no displayable data'
            : `non-text data omitted (mime: ${mimeKeys.join(', ')})`,
      });
      continue;
    }
    if (output.output_type === 'error') {
      const err = output as z.infer<typeof ErrorOutputSchema>;
      const tb = (err.traceback ?? []).join('\n');
      trimmed.push({
        output_type: 'error',
        text: trimOutputText(
          [err.ename, err.evalue].filter(Boolean).join(': ') +
            (tb.length > 0 ? `\n${tb}` : ''),
        ),
      });
      continue;
    }
    // Unknown output type — surface only its kind so the model knows.
    trimmed.push({
      output_type: output.output_type,
      note: 'unknown output kind; full payload omitted',
    });
  }
  return trimmed;
}

/**
 * Read a `.ipynb` notebook and return a JSON-encoded structured summary.
 * Output is stringified JSON inside `ToolResult.output` — callers should
 * `JSON.parse` it to inspect cells programmatically.
 */
export async function readNotebook(
  args: ReadNotebookArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ReadNotebookArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const absolutePath = resolveSafePathStrict(ctx.projectRoot, parsed.data.path);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${parsed.data.path}' escapes project root`,
    };
  }

  let raw: string;
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return {
        success: false,
        output: '',
        error: `Not a file: '${parsed.data.path}'`,
      };
    }
    raw = await fs.readFile(absolutePath, 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return {
        success: false,
        output: '',
        error: `File not found: '${parsed.data.path}'`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to read '${parsed.data.path}': ${message}`,
    };
  }

  const result = parseNotebook(raw);
  if (!result.ok) {
    return { success: false, output: '', error: result.error };
  }

  const notebook = result.data;
  const includeOutputs = parsed.data.includeOutputs ?? true;

  // Extract kernel + language from notebook metadata when present.
  // We type-guard each field individually so a partial/missing metadata
  // block doesn't crash — Jupyter sometimes omits kernelspec entirely.
  const meta = notebook.metadata ?? {};
  const kernelspecRaw = meta['kernelspec'];
  const langInfoRaw = meta['language_info'];
  const kernelspec =
    typeof kernelspecRaw === 'object' && kernelspecRaw !== null
      ? (kernelspecRaw as Record<string, unknown>)
      : null;
  const langInfo =
    typeof langInfoRaw === 'object' && langInfoRaw !== null
      ? (langInfoRaw as Record<string, unknown>)
      : null;

  const kernelName =
    kernelspec && typeof kernelspec['name'] === 'string'
      ? (kernelspec['name'] as string)
      : null;
  const language =
    langInfo && typeof langInfo['name'] === 'string'
      ? (langInfo['name'] as string)
      : null;

  const cells = notebook.cells.map((cell, index) => {
    const sourceString = sourceToString(cell.source);
    const outputs =
      includeOutputs && cell.outputs !== undefined && cell.outputs.length > 0
        ? trimCellOutputs(cell.outputs)
        : [];
    return {
      index,
      id: cell.id ?? null,
      cell_type: cell.cell_type,
      source: sourceString,
      outputs,
    };
  });

  const summary = {
    path: parsed.data.path,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor ?? null,
    kernel: kernelName,
    language,
    cellCount: cells.length,
    cells,
  };

  return {
    success: true,
    output: JSON.stringify(summary, null, 2),
  };
}
