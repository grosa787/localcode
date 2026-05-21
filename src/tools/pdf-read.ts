/**
 * `read_pdf` tool — extracts text from a PDF, page by page.
 *
 * Single-phase, read-only:
 *   - Path safety: resolved under `projectRoot` via `resolveSafePathStrict`.
 *   - Max file size: 50 MB. Larger files are rejected with a clear error.
 *   - Page selection: optional `pages` spec like `'1-3,5'`. Omitted = all.
 *   - Per-page text capped at 8 KB; an `--- (more text on page N omitted) ---`
 *     footer is appended when truncated.
 *
 * Output is a JSON-serialised envelope `{ totalPages, pages: [{ page, text }] }`
 * so downstream consumers (chat, summariser) can index into specific pages
 * without re-parsing.
 *
 * pdfjs-dist `legacy` build is used because the default ESM build assumes
 * a browser worker entry; the legacy build can run in plain Node with the
 * worker pointed at the matching .mjs file via `require.resolve`.
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { resolveSafePathStrict } from './path-safety';
import type { ToolContext, ToolResult } from './types';

/** Hard cap on the on-disk size of a PDF the tool will accept. */
const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Per-page UTF-8 byte cap before we append the truncation footer. */
const PER_PAGE_BYTE_CAP = 8 * 1024;

/** Hard cap on the number of pages we will process in a single call. */
const MAX_PAGES_PER_CALL = 500;

export const ReadPdfArgsSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  /**
   * Optional page selector. Comma-separated list of single pages or
   * ranges, e.g. `'1-3,5,7-9'`. Pages are 1-based. Whitespace ignored.
   */
  pages: z.string().min(1).optional(),
  /**
   * Reserved for a future image-extraction pass. Currently inert —
   * surfaces a flag in the envelope so callers can detect support.
   */
  includeImages: z.boolean().optional(),
});

export type ReadPdfArgs = z.infer<typeof ReadPdfArgsSchema>;

export interface ReadPdfPage {
  page: number;
  text: string;
}

export interface ReadPdfEnvelope {
  kind: 'pdf';
  path: string;
  totalPages: number;
  pages: ReadPdfPage[];
  /** Echo of the includeImages flag; image extraction not yet implemented. */
  includeImagesRequested: boolean;
  /** True when image extraction was skipped (always true today). */
  imagesOmitted: boolean;
}

/**
 * Parse a `pages` spec like `'1-3,5'` into a sorted, deduplicated list of
 * 1-based page numbers. Returns `null` on a malformed input. An empty spec
 * (after trimming) is treated as malformed — pass `undefined` for "all".
 */
export function parsePageRange(
  spec: string,
  totalPages: number,
): number[] | null {
  if (totalPages <= 0) return [];
  const trimmed = spec.trim();
  if (trimmed.length === 0) return null;

  const out = new Set<number>();
  const parts = trimmed.split(',');
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch !== null) {
      const startStr = rangeMatch[1];
      const endStr = rangeMatch[2];
      if (startStr === undefined || endStr === undefined) return null;
      const start = Number.parseInt(startStr, 10);
      const end = Number.parseInt(endStr, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      if (start < 1 || end < 1 || start > end) return null;
      const lo = Math.max(1, start);
      const hi = Math.min(totalPages, end);
      for (let p = lo; p <= hi; p += 1) out.add(p);
      continue;
    }
    const single = Number.parseInt(part, 10);
    if (!Number.isFinite(single) || String(single) !== part) return null;
    if (single < 1) return null;
    if (single <= totalPages) out.add(single);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Truncate `text` to fit within `PER_PAGE_BYTE_CAP` UTF-8 bytes. When the
 * input exceeds the cap, append a clearly-marked omission footer naming
 * the page. The footer counts toward the cap so the final byte length is
 * bounded.
 */
function clampPageText(text: string, pageNum: number): string {
  const fullBytes = Buffer.byteLength(text, 'utf8');
  if (fullBytes <= PER_PAGE_BYTE_CAP) return text;

  const footer = `\n--- (more text on page ${pageNum} omitted) ---`;
  const footerBytes = Buffer.byteLength(footer, 'utf8');
  const budget = Math.max(0, PER_PAGE_BYTE_CAP - footerBytes);

  // Slice carefully so we don't cut a multibyte UTF-8 code unit in half.
  let slice = text;
  while (Buffer.byteLength(slice, 'utf8') > budget && slice.length > 0) {
    slice = slice.slice(0, slice.length - 1);
  }
  return slice + footer;
}

/**
 * Concatenate text items from a single page into a string that preserves
 * rough layout: newlines whenever an item carries `hasEOL`, or whenever
 * the y-coordinate of the next item moves backwards (new line on page).
 *
 * The shape of each item we care about:
 *   `{ str: string; hasEOL?: boolean; transform?: number[] }`
 * — narrowed structurally because pdfjs-dist's TextItem type is heavy
 *   and we can't `any` here.
 */
export function joinTextItems(items: ReadonlyArray<unknown>): string {
  const lines: string[] = [];
  let currentLine = '';
  let lastY: number | null = null;
  let justFlushed = false;

  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue;
    const obj = raw as {
      readonly str?: unknown;
      readonly hasEOL?: unknown;
      readonly transform?: unknown;
    };
    if (typeof obj.str !== 'string') continue;
    const text = obj.str;
    const hasEOL = obj.hasEOL === true;

    let y: number | null = null;
    if (Array.isArray(obj.transform) && obj.transform.length >= 6) {
      const ty = obj.transform[5];
      if (typeof ty === 'number') y = ty;
    }
    if (
      !justFlushed
      && lastY !== null
      && y !== null
      && Math.abs(y - lastY) > 4
    ) {
      // New visual line — flush the buffer (unless we just did so via hasEOL).
      lines.push(currentLine);
      currentLine = '';
    }
    if (y !== null) lastY = y;
    justFlushed = false;

    currentLine += text;
    if (hasEOL) {
      lines.push(currentLine);
      currentLine = '';
      justFlushed = true;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);
  return lines.join('\n').trimEnd();
}

interface PdfDocumentLike {
  readonly numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: ReadonlyArray<unknown> }>;
  }>;
  destroy(): Promise<void>;
}

/**
 * Lazily resolve pdfjs-dist legacy build + its worker path. The legacy
 * build is required because the default ESM build hard-assumes a browser
 * worker context.
 */
async function loadPdfjs(): Promise<{
  getDocument: (src: { data: Uint8Array; isEvalSupported: boolean; disableFontFace: boolean; useSystemFonts: boolean }) => { promise: Promise<PdfDocumentLike> };
}> {
  // Worker path resolved at runtime — works under both Node and Bun.
  const require = createRequire(import.meta.url);
  const workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

  // Dynamic import keeps the dependency lazy (cold-start friendly) and
  // avoids loading the worker before we have anything to parse.
  const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (src: { data: Uint8Array; isEvalSupported: boolean; disableFontFace: boolean; useSystemFonts: boolean }) => { promise: Promise<PdfDocumentLike> };
    GlobalWorkerOptions: { workerSrc: string };
  };
  mod.GlobalWorkerOptions.workerSrc = workerSrc;
  return { getDocument: mod.getDocument };
}

export async function readPdf(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ReadPdfArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const { path: relPath, pages: pageSpec, includeImages = false } = parsed.data;

  const absolutePath = resolveSafePathStrict(ctx.projectRoot, relPath);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${relPath}' escapes project root`,
    };
  }

  let stat: { isFile(): boolean; size: number };
  try {
    stat = await fs.stat(absolutePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to stat '${relPath}': ${message}`,
    };
  }
  if (!stat.isFile()) {
    return {
      success: false,
      output: '',
      error: `Not a file: '${relPath}'`,
    };
  }
  if (stat.size > MAX_PDF_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    return {
      success: false,
      output: '',
      error: `PDF too large: ${mb} MB exceeds 50 MB cap`,
    };
  }

  let bytes: Uint8Array;
  try {
    const buf = await fs.readFile(absolutePath);
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to read '${relPath}': ${message}`,
    };
  }

  let pdfjs: Awaited<ReturnType<typeof loadPdfjs>>;
  try {
    pdfjs = await loadPdfjs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to load pdfjs-dist: ${message}`,
    };
  }

  let doc: PdfDocumentLike;
  try {
    const task = pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    });
    doc = await task.promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to parse PDF '${relPath}': ${message}`,
    };
  }

  try {
    const totalPages = doc.numPages;
    let selected: number[];
    if (pageSpec !== undefined) {
      const parsedPages = parsePageRange(pageSpec, totalPages);
      if (parsedPages === null) {
        return {
          success: false,
          output: '',
          error: `Invalid pages spec: '${pageSpec}'. Use e.g. '1-3,5'.`,
        };
      }
      selected = parsedPages;
    } else {
      selected = [];
      for (let p = 1; p <= totalPages; p += 1) selected.push(p);
    }

    if (selected.length > MAX_PAGES_PER_CALL) {
      selected = selected.slice(0, MAX_PAGES_PER_CALL);
    }

    const pages: ReadPdfPage[] = [];
    for (const pageNum of selected) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const text = clampPageText(joinTextItems(content.items), pageNum);
      pages.push({ page: pageNum, text });
    }

    const envelope: ReadPdfEnvelope = {
      kind: 'pdf',
      path: relPath,
      totalPages,
      pages,
      includeImagesRequested: includeImages,
      imagesOmitted: true,
    };

    return { success: true, output: JSON.stringify(envelope) };
  } finally {
    try {
      await doc.destroy();
    } catch {
      // Ignore destroy failures — they don't affect the caller.
    }
  }
}
