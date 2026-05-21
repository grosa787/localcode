/**
 * `read_file` tool — safely reads a file from the project root.
 *
 * - Validates args with Zod.
 * - Blocks path traversal (the resolved absolute path must stay within
 *   `ctx.projectRoot`).
 * - For files <= 100 KB without any pagination args, returns the file
 *   verbatim. Truncates files larger than 100 KB to the first 500 lines
 *   and appends a clearly-marked truncation notice (legacy behaviour).
 *
 * Pagination + summary additions (ROADMAP — file context controls):
 *   - `offset` / `limit` (1-based line numbers) — explicit windowed read.
 *     When supplied, line accounting is exact: we slice the file by lines
 *     and stream back the chosen range. No size-based clamp is applied
 *     to explicit windows.
 *   - Large-file auto-paginate (> 1 MB without explicit offset): the
 *     handler returns the first MB clamped to the nearest line boundary
 *     and appends a two-line footer telling the model exactly how to ask
 *     for the next page (`read_file({ path, offset: <next-line> })`).
 *   - `respondWithSummary: true` — opt-in summary mode that returns the
 *     line count, byte size, first 20 lines, and last 5 lines. Useful
 *     for an instant grep-style overview without dumping the body.
 *
 * Side effect:
 *   On every successful read (full, paginated, summary) the
 *   `FileChangeTracker` records an mtime/size snapshot keyed by absolute
 *   path + session id. The tool-executor consults that snapshot before
 *   write_file / edit_file / multi_edit so the model is warned when the
 *   on-disk content changed externally between read and write.
 */

import { promises as fs } from 'node:fs';
import { z } from 'zod';

import { getProcessFileChangeTracker } from './file-tracker';
import { resolveSafePathStrict } from './path-safety';
import type { ToolContext, ToolResult } from './types';

/** Zod schema for the tool arguments (LLM payload arrives as `unknown`). */
export const ReadFileArgsSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  /**
   * Optional 1-based line offset. When set, the read starts at line
   * `offset` (inclusive). Values below 1 are clamped to 1.
   */
  offset: z.number().int().positive().optional(),
  /**
   * Optional cap on lines returned when `offset` is supplied. Defaults
   * to the file's remaining lines from `offset`. Capped internally at
   * a sane upper bound to keep payloads bounded.
   */
  limit: z.number().int().positive().optional(),
  /**
   * When true, return a summary (line count, byte size, first 20 + last
   * 5 lines) instead of the file body. Mutually exclusive with explicit
   * offset/limit pagination — when both are set, summary wins (it's
   * cheaper than dumping the body the model didn't actually want).
   */
  respondWithSummary: z.boolean().optional(),
});

const LEGACY_MAX_INLINE_BYTES = 100 * 1024;
const LEGACY_MAX_INLINE_LINES = 500;

/** Auto-paginate threshold for large files when no offset is supplied. */
const LARGE_FILE_BYTES = 1024 * 1024; // 1 MB

/**
 * Hard cap on explicit window size — protects against a runaway
 * `limit: 10_000_000` from the model. Tuned to be roughly the same
 * upper bound as the legacy 500-line truncation, but liberal enough
 * for real source files (most under 2k lines).
 */
const MAX_EXPLICIT_LIMIT_LINES = 5000;

/** Page size used by the auto-paginate clamp. */
const AUTO_PAGE_BYTES = LARGE_FILE_BYTES;

/** Lines shown at top of a summary response. */
const SUMMARY_HEAD_LINES = 20;
/** Lines shown at tail of a summary response. */
const SUMMARY_TAIL_LINES = 5;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a summary block for `respondWithSummary` mode. Always cheap —
 * we already have the full content in memory because Node's `fs.readFile`
 * returned it as a single string.
 */
function buildSummary(content: string, totalSize: number, relPath: string): string {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const headCount = Math.min(SUMMARY_HEAD_LINES, totalLines);
  const tailCount = Math.min(
    SUMMARY_TAIL_LINES,
    Math.max(0, totalLines - headCount),
  );
  const head = lines.slice(0, headCount).join('\n');
  const tail = tailCount > 0
    ? lines.slice(totalLines - tailCount, totalLines).join('\n')
    : '';

  const headerLines: string[] = [
    `--- Summary of ${relPath} ---`,
    `Lines: ${totalLines}`,
    `Size: ${formatBytes(totalSize)} (${totalSize} bytes)`,
    `--- First ${headCount} lines ---`,
    head,
  ];
  if (tailCount > 0 && totalLines > headCount) {
    headerLines.push(
      `--- Last ${tailCount} lines (of ${totalLines}) ---`,
      tail,
    );
  }
  headerLines.push(
    `--- End summary; use offset/limit to read a window, or omit them to read fully ---`,
  );
  return headerLines.join('\n');
}

/**
 * Render the paginated tail-footer that tells the model how to fetch
 * the next page. The footer is intentionally easy to grep so we can
 * test it deterministically.
 */
function paginationFooter(
  relPath: string,
  shownLines: number,
  totalLines: number,
  shownBytes: number,
  totalBytes: number,
  nextOffset: number,
): string {
  return [
    '',
    `--- File truncated at line ${shownLines} of ${totalLines} (${formatBytes(shownBytes)} of ${formatBytes(totalBytes)}) ---`,
    `--- Continue: read_file({ path: "${relPath}", offset: ${nextOffset} }) ---`,
  ].join('\n');
}

/**
 * Take the first `MAX_BYTES` of `content` and round DOWN to the
 * nearest newline so we don't cut a line in half. Returns the slice
 * (string) and the count of lines in that slice.
 */
function clampToLineBoundary(content: string, maxBytes: number): {
  text: string;
  shownLines: number;
} {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { text: content, shownLines: content.split('\n').length };
  }
  // Build a slice <= maxBytes, then trim back to the last newline.
  let slice = content.slice(0, maxBytes);
  // Adjust for multi-byte UTF-8: slicing by characters may produce a
  // slightly different byte-length. We trim until <= maxBytes.
  while (Buffer.byteLength(slice, 'utf8') > maxBytes && slice.length > 0) {
    slice = slice.slice(0, slice.length - 1);
  }
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline >= 0) {
    slice = slice.slice(0, lastNewline);
  }
  const shownLines = slice.length === 0 ? 0 : slice.split('\n').length;
  return { text: slice, shownLines };
}

export async function readFile(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ReadFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  // H6 — `resolveSafePathStrict` rejects both lexical traversal (`..`,
  // absolute inputs) AND symlink traversal (e.g. `link/passwd` where
  // `link → /etc`). The realpath check is what closes the symlink hole.
  const absolutePath = resolveSafePathStrict(ctx.projectRoot, parsed.data.path);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${parsed.data.path}' escapes project root`,
    };
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return {
        success: false,
        output: '',
        error: `Not a file: '${parsed.data.path}'`,
      };
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    const tracker = getProcessFileChangeTracker();

    // Record the read snapshot regardless of which response shape we
    // return. The write-side check only cares that SOMETHING was read.
    tracker.markRead(absolutePath, stat.mtimeMs, stat.size, ctx.sessionId);

    // Summary mode wins over explicit offset/limit — it's cheaper and
    // also serves as a "what's in this file?" probe.
    if (parsed.data.respondWithSummary === true) {
      return {
        success: true,
        output: buildSummary(content, stat.size, parsed.data.path),
      };
    }

    const totalLines = content.split('\n').length;

    // Explicit window: user asked for a specific offset/limit pair.
    if (parsed.data.offset !== undefined) {
      const allLines = content.split('\n');
      const requestedStart = Math.max(1, parsed.data.offset);
      const startIdx = Math.min(requestedStart - 1, allLines.length);

      const rawLimit =
        parsed.data.limit !== undefined
          ? Math.min(parsed.data.limit, MAX_EXPLICIT_LIMIT_LINES)
          : MAX_EXPLICIT_LIMIT_LINES;
      const endIdx = Math.min(startIdx + rawLimit, allLines.length);
      const windowLines = allLines.slice(startIdx, endIdx);
      const windowText = windowLines.join('\n');
      const shownLines = windowLines.length;

      // Footer hint only when there's more file past the window.
      const hasMore = endIdx < allLines.length;
      if (hasMore) {
        const nextOffset = endIdx + 1; // 1-based line for next page
        const footer = paginationFooter(
          parsed.data.path,
          startIdx + shownLines,
          totalLines,
          Buffer.byteLength(windowText, 'utf8'),
          stat.size,
          nextOffset,
        );
        return { success: true, output: `${windowText}${footer}` };
      }
      // Final window — no footer needed.
      return { success: true, output: windowText };
    }

    // Auto-paginate path: file > 1 MB and no explicit offset was given.
    if (stat.size > LARGE_FILE_BYTES) {
      const clamped = clampToLineBoundary(content, AUTO_PAGE_BYTES);
      const nextOffset = clamped.shownLines + 1;
      const footer = paginationFooter(
        parsed.data.path,
        clamped.shownLines,
        totalLines,
        Buffer.byteLength(clamped.text, 'utf8'),
        stat.size,
        nextOffset,
      );
      return { success: true, output: `${clamped.text}${footer}` };
    }

    // Legacy 100 KB / 500-line truncation — preserved verbatim so prior
    // behaviour and the existing tests stay green.
    if (stat.size > LEGACY_MAX_INLINE_BYTES) {
      const allLines = content.split('\n');
      const shown = allLines.slice(0, LEGACY_MAX_INLINE_LINES).join('\n');
      const kb = Math.round(stat.size / 1024);
      const truncated =
        `${shown}\n\n[... file truncated: showing first ${LEGACY_MAX_INLINE_LINES} lines of ${allLines.length} total, ${kb} KB total size ...]`;
      return { success: true, output: truncated };
    }

    return { success: true, output: content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to read '${parsed.data.path}': ${message}`,
    };
  }
}
