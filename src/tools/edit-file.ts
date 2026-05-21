/**
 * `edit_file` tool — surgical search/replace inside an existing file.
 *
 * Two-phase with approval (like `write_file`):
 *   Phase 1 (`editFile`)    → preview as unified diff; does not touch disk.
 *   Phase 2 (`commitEdit`)  → re-reads the file, re-validates that
 *                             `find_text` is still unique, then writes.
 *
 * Why this tool exists: the model can mutate large files by sending only
 * the affected lines instead of rewriting the whole file through
 * `write_file`, which saves a lot of output tokens per turn.
 *
 * Invariants:
 *   - `find_text` must appear EXACTLY once in the file. Zero matches and
 *     two-or-more matches both return an actionable error.
 *   - Path traversal is blocked (same guard as read-file / write-file).
 *   - Args are validated with Zod. Nothing is written until `commitEdit`.
 *   - Commit re-reads and re-validates, so a file changing between
 *     preview and commit is surfaced, not silently corrupted.
 *
 * Fuzzy fallback (ROADMAP #8 — simplified):
 *   When the exact `find_text` is not present, three lightweight
 *   strategies kick in, in order:
 *     1. Whitespace-normalised match (collapse runs of whitespace) —
 *        used to *resolve* the edit when exactly one match found.
 *     2. Token-overlap candidate listing — never resolves, only reports
 *        up to three lookalike snippets to the model so it can retry.
 *     3. Anchor-based search — when `find_text` starts with a recognised
 *        declaration prefix (`function NAME`, `class NAME`, `const NAME =`),
 *        we surface the matching block (anchor → balanced closing brace)
 *        as a candidate.
 *   Fuzzy strategies only enrich the *error message* unless exactly one
 *   whitespace-normalised match exists; in that case we resolve the edit
 *   against the original (un-normalised) span we matched.
 */

import { promises as fs } from 'node:fs';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';

import { resolveSafePathStrict } from './path-safety';
import type { EditFileArgs, ToolContext, ToolResult } from './types';

/** Zod schema for `edit_file` arguments. */
export const EditFileArgsSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  find_text: z.string().min(1, 'find_text must be a non-empty string'),
  replace_text: z.string(),
});

/**
 * Counts non-overlapping occurrences of `needle` in `haystack`.
 * `needle` is guaranteed non-empty by the Zod schema.
 */
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

/** Total line count of a string (split on \n; matches our editor convention). */
function lineCount(text: string): number {
  return text.split('\n').length;
}

// ───────────────────────────────────────────────────────────────────────
// Fuzzy fallback helpers (ROADMAP #8 simplified)
// ───────────────────────────────────────────────────────────────────────

/**
 * Result of attempting a fuzzy whitespace-normalised match. When exactly
 * one match is found we resolve the edit against the *original* span
 * (start..end indices into the source haystack), so the diff still
 * preserves the file's whitespace verbatim.
 */
interface WhitespaceMatch {
  /** Number of normalised matches found. */
  count: number;
  /** Original text slice of the unique match (only set when `count === 1`). */
  span?: { start: number; end: number; text: string };
}

/**
 * Build a normalised version of `text` and a parallel index map back to
 * the source character positions. The normalisation rules:
 *   - Trim leading/trailing whitespace on every line.
 *   - Collapse internal runs of any whitespace (spaces, tabs, newlines)
 *     into a single space.
 * The returned `srcIndex[i]` is the offset in the original `text` of the
 * i-th character in the normalised string. `srcIndex[normalised.length]`
 * holds the source offset just past the last consumed character so a
 * caller can reconstruct an end-exclusive slice.
 */
function normaliseWithMap(text: string): {
  normalised: string;
  srcIndex: number[];
} {
  // Pre-strip per-line leading/trailing whitespace, joined with `\n`.
  // We then collapse all whitespace runs to a single space. Doing it in
  // a single pass keeps the parallel index map simple.
  //
  // The parallel `map` array satisfies:
  //   srcIndex[i]                   → source offset of normalised char i
  //   srcIndex[normalised.length]   → source offset just past the last
  //                                   *consumed* non-whitespace character
  //                                   (end-exclusive). This is critical:
  //                                   any trailing whitespace in `text`
  //                                   beyond the last meaningful char must
  //                                   NOT be included in spans we report,
  //                                   otherwise replacements would eat
  //                                   newlines/indentation belonging to
  //                                   surrounding content.
  const out: string[] = [];
  const map: number[] = [];

  let i = 0;
  let prevWasSpace = true; // emit no leading space
  // Track the end-exclusive source offset for the most recently emitted
  // *non-space* character. Trailing whitespace will not move this past
  // the last real char.
  let lastRealEnd = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    const isWhitespace = /\s/.test(ch);
    if (isWhitespace) {
      if (!prevWasSpace) {
        out.push(' ');
        map.push(i);
        prevWasSpace = true;
      }
      i += 1;
      continue;
    }
    out.push(ch);
    map.push(i);
    lastRealEnd = i + 1;
    prevWasSpace = false;
    i += 1;
  }

  // Trim a single trailing space if present (mirrors strip-trailing rule).
  if (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }

  // End-exclusive sentinel: just past the last real character so spans
  // never accidentally swallow trailing whitespace.
  map.push(lastRealEnd);
  return { normalised: out.join(''), srcIndex: map };
}

/**
 * Attempt to locate `needle` inside `haystack` via whitespace-normalised
 * matching. Returns the count of matches; when exactly one, also fills
 * in `span` with the *original* (un-normalised) coordinates so the
 * caller can perform an exact slice/replace on the source text.
 */
function findWhitespaceMatches(
  haystack: string,
  needle: string,
): WhitespaceMatch {
  const hay = normaliseWithMap(haystack);
  const needleNorm = normaliseWithMap(needle).normalised;

  if (needleNorm.length === 0) return { count: 0 };

  const matches: Array<{ start: number; end: number; text: string }> = [];
  let from = 0;
  while (true) {
    const idx = hay.normalised.indexOf(needleNorm, from);
    if (idx === -1) break;
    const start = hay.srcIndex[idx] ?? 0;
    // End-exclusive index in source: take srcIndex of the position just
    // past the last matched normalised char.
    const end = hay.srcIndex[idx + needleNorm.length] ?? haystack.length;
    matches.push({
      start,
      end,
      text: haystack.slice(start, end),
    });
    from = idx + needleNorm.length;
  }

  if (matches.length === 1) {
    return { count: 1, span: matches[0] };
  }
  return { count: matches.length };
}

/**
 * Splits a string into lower-cased tokens — runs of word characters.
 * Tokens shorter than 2 characters are dropped (they add noise without
 * disambiguation power).
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 2) tokens.push(raw);
  }
  return tokens;
}

interface TokenCandidate {
  startLine: number;
  endLine: number;
  snippet: string;
  /** Number of overlapping tokens (used as score). */
  overlap: number;
}

/**
 * Build up to three token-overlap candidates. We slide a window over
 * the file's lines, sized roughly to the line count of `find_text`,
 * and pick windows whose token set covers ≥ 80% of `find_text`'s
 * tokens. Candidates are sorted by overlap (desc) and deduplicated by
 * starting line.
 */
function tokenCandidates(
  haystack: string,
  needle: string,
  maxCandidates: number,
): TokenCandidate[] {
  const needleTokens = tokenize(needle);
  if (needleTokens.length === 0) return [];

  const haystackLines = haystack.split('\n');
  const needleLineCount = Math.max(1, needle.split('\n').length);
  const requiredOverlap = Math.ceil(needleTokens.length * 0.8);

  // Pre-tokenise every line once.
  const linesTokens = haystackLines.map((line) => new Set(tokenize(line)));

  const seenStarts = new Set<number>();
  const found: TokenCandidate[] = [];

  // Slide a window the size of the needle's line count over the file.
  for (
    let start = 0;
    start <= haystackLines.length - needleLineCount;
    start += 1
  ) {
    const windowTokens = new Set<string>();
    for (let off = 0; off < needleLineCount; off += 1) {
      const lineSet = linesTokens[start + off];
      if (lineSet === undefined) continue;
      for (const tok of lineSet) windowTokens.add(tok);
    }
    let overlap = 0;
    for (const tok of needleTokens) {
      if (windowTokens.has(tok)) overlap += 1;
    }
    if (overlap >= requiredOverlap && !seenStarts.has(start)) {
      seenStarts.add(start);
      const endLine = start + needleLineCount - 1;
      const snippet = haystackLines.slice(start, endLine + 1).join('\n');
      found.push({
        startLine: start + 1, // 1-based for human display
        endLine: endLine + 1,
        snippet,
        overlap,
      });
    }
  }

  found.sort((a, b) => b.overlap - a.overlap);
  return found.slice(0, maxCandidates);
}

/**
 * Heuristic: detect whether `find_text` opens with a recognisable
 * declaration anchor we can locate by name + balanced-brace scan.
 * Returns the symbol kind + name, or null when no anchor is detected.
 */
interface AnchorInfo {
  kind: 'function' | 'class' | 'const' | 'let' | 'var';
  name: string;
}

function detectAnchor(needle: string): AnchorInfo | null {
  // Strip leading whitespace lines so anchors with indent still match.
  const trimmed = needle.replace(/^\s+/, '');
  // Order matters — `function NAME(` must beat plain identifiers.
  const patterns: ReadonlyArray<{ re: RegExp; kind: AnchorInfo['kind'] }> = [
    { re: /^function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^const\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'const' },
    { re: /^let\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'let' },
    { re: /^var\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'var' },
  ];
  for (const { re, kind } of patterns) {
    const m = trimmed.match(re);
    if (m && typeof m[1] === 'string') {
      return { kind, name: m[1] };
    }
  }
  return null;
}

/**
 * Locate the source span starting at the anchor declaration and ending
 * at the balanced closing brace of the first `{...}` block on or after
 * the declaration. Returns null when the anchor isn't found or the
 * braces are unbalanced.
 *
 * Naive brace counter — strings, comments, regexes, template literals
 * are NOT skipped. Good enough for surfacing a "did you mean" snippet,
 * but never used to actually mutate the file (we only show it as a
 * candidate in the error message).
 */
function findAnchorSpan(
  haystack: string,
  anchor: AnchorInfo,
): { start: number; end: number; startLine: number; endLine: number } | null {
  // Build a regex anchored to the start of a line (or file).
  const escName = anchor.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = (() => {
    switch (anchor.kind) {
      case 'function':
        return new RegExp(`(^|\\n)\\s*function\\s+${escName}\\b`);
      case 'class':
        return new RegExp(`(^|\\n)\\s*class\\s+${escName}\\b`);
      case 'const':
        return new RegExp(`(^|\\n)\\s*const\\s+${escName}\\s*=`);
      case 'let':
        return new RegExp(`(^|\\n)\\s*let\\s+${escName}\\s*=`);
      case 'var':
        return new RegExp(`(^|\\n)\\s*var\\s+${escName}\\s*=`);
    }
  })();

  const m = haystack.match(re);
  if (!m || m.index === undefined) return null;
  // m.index points at the leading newline (or 0). Skip it for the
  // declaration start.
  const declStart =
    m[0].startsWith('\n') ? m.index + 1 : m.index;

  // Walk forward to the first `{`, then balanced-count braces to the
  // matching close.
  const openIdx = haystack.indexOf('{', declStart);
  if (openIdx === -1) return null;

  let depth = 0;
  let i = openIdx;
  while (i < haystack.length) {
    const ch = haystack[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const end = i + 1;
        const startLine = haystack.slice(0, declStart).split('\n').length;
        const endLine = haystack.slice(0, end).split('\n').length;
        return { start: declStart, end, startLine, endLine };
      }
    }
    i += 1;
  }
  return null;
}

/**
 * Format a single candidate snippet for the "did you mean" error
 * message. Limits each candidate to ~6 lines so the message stays
 * readable; the caller adds a 1-based ordinal.
 */
function formatCandidate(
  ordinal: number,
  startLine: number,
  endLine: number,
  snippet: string,
): string {
  const MAX_LINES = 6;
  const lines = snippet.split('\n');
  const shown = lines.length > MAX_LINES
    ? `${lines.slice(0, MAX_LINES).join('\n')}\n  … (${lines.length - MAX_LINES} more lines)`
    : snippet;
  // Indent the snippet so it visually stays grouped under the ordinal.
  const body = shown
    .split('\n')
    .map((l, idx) => (idx === 0 ? l : `      ${l}`))
    .join('\n');
  return `  [${ordinal}] line ${startLine}-${endLine}: ${body}`;
}

/**
 * Build the actionable "find_text not found verbatim" error string,
 * including up to three candidates from the token + anchor strategies.
 * Returns null when there is nothing useful to show — caller should
 * fall back to the original whitespace-tip error.
 */
function buildFuzzyErrorMessage(
  relPath: string,
  haystack: string,
  needle: string,
): string | null {
  const candidates: Array<{
    startLine: number;
    endLine: number;
    snippet: string;
    score: number;
  }> = [];

  // Anchor-based candidate (highest priority — declaration-aware).
  const anchor = detectAnchor(needle);
  if (anchor) {
    const span = findAnchorSpan(haystack, anchor);
    if (span) {
      candidates.push({
        startLine: span.startLine,
        endLine: span.endLine,
        snippet: haystack.slice(span.start, span.end),
        score: Number.MAX_SAFE_INTEGER,
      });
    }
  }

  // Token-overlap candidates fill the remaining slots.
  const tokenHits = tokenCandidates(haystack, needle, 3);
  for (const hit of tokenHits) {
    if (
      candidates.some(
        (c) => c.startLine === hit.startLine && c.endLine === hit.endLine,
      )
    ) {
      continue;
    }
    candidates.push({
      startLine: hit.startLine,
      endLine: hit.endLine,
      snippet: hit.snippet,
      score: hit.overlap,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 3);

  const formatted = top
    .map((c, i) => formatCandidate(i + 1, c.startLine, c.endLine, c.snippet))
    .join('\n');

  return (
    `find_text not found verbatim in ${relPath}. Did you mean:\n` +
    `${formatted}\n` +
    `Provide more context to disambiguate (or copy one of the candidates as the new find_text).`
  );
}

// ───────────────────────────────────────────────────────────────────────
// Edit resolution — returns the haystack with the replace applied, or
// an error describing what went wrong (with optional fuzzy candidates).
// ───────────────────────────────────────────────────────────────────────

interface EditResolution {
  ok: boolean;
  newContent?: string;
  /**
   * Indicates the resolved span was located via the whitespace-fuzzy
   * fallback. The resolution is still considered exact for output
   * purposes; we surface this so future callers (UI/tests) can flag
   * when a fuzzy path was taken.
   */
  fuzzy?: boolean;
  error?: string;
}

function resolveEdit(
  oldContent: string,
  find_text: string,
  replace_text: string,
  relPath: string,
): EditResolution {
  const matches = countOccurrences(oldContent, find_text);
  if (matches === 1) {
    return { ok: true, newContent: oldContent.replace(find_text, replace_text) };
  }
  if (matches > 1) {
    return {
      ok: false,
      error: `find_text matches ${matches} locations in ${relPath}; it must be unique. Include more surrounding context to disambiguate.`,
    };
  }

  // No exact match: try whitespace-normalised match first.
  const ws = findWhitespaceMatches(oldContent, find_text);
  if (ws.count === 1 && ws.span) {
    const { start, end } = ws.span;
    const newContent =
      oldContent.slice(0, start) + replace_text + oldContent.slice(end);
    return { ok: true, fuzzy: true, newContent };
  }
  if (ws.count > 1) {
    return {
      ok: false,
      error: `find_text matches ${ws.count} locations in ${relPath} (after whitespace normalisation); it must be unique. Include more surrounding context to disambiguate.`,
    };
  }

  // Still no match — synthesise an actionable "did you mean" error.
  const fuzzyMsg = buildFuzzyErrorMessage(relPath, oldContent, find_text);
  if (fuzzyMsg !== null) {
    return { ok: false, error: fuzzyMsg };
  }

  return {
    ok: false,
    error: `find_text not found in ${relPath}. Tip: the search is exact — include surrounding whitespace and indentation.`,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────

/**
 * Preview an edit as a unified diff. Returns `requiresApproval: true` so
 * the tool-executor prompts the user before commit. The file is NOT
 * modified here.
 */
export async function editFile(
  args: EditFileArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = EditFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      requiresApproval: true,
    };
  }

  const { path: relPath, find_text, replace_text } = parsed.data;

  // H6 — strict resolve also blocks symlinked path components.
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

  const resolution = resolveEdit(oldContent, find_text, replace_text, relPath);
  if (!resolution.ok || resolution.newContent === undefined) {
    return {
      success: false,
      output: '',
      error: resolution.error ?? 'Failed to resolve edit',
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
 * Commit a previously-previewed edit. Re-reads the file and re-validates
 * that `find_text` is still unique (file may have changed between preview
 * and commit); only then writes the mutated content.
 *
 * Mirrors the fuzzy whitespace fallback in `editFile` so that an edit
 * which previewed via the whitespace path still commits successfully
 * even if the file isn't perfectly stable. Token/anchor candidates are
 * NEVER auto-applied — they only enrich error messages.
 */
export async function commitEdit(
  args: EditFileArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = EditFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const { path: relPath, find_text, replace_text } = parsed.data;

  // H6 — strict resolve also blocks symlinked path components.
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

  const matches = countOccurrences(oldContent, find_text);
  if (matches > 1) {
    return {
      success: false,
      output: '',
      error: `File modified since preview; re-run edit (find_text is no longer unique in ${relPath} — now matches ${matches} locations)`,
    };
  }

  let newContent: string;
  if (matches === 1) {
    newContent = oldContent.replace(find_text, replace_text);
  } else {
    // No exact match — try the whitespace-normalised path that the
    // preview may have resolved through.
    const ws = findWhitespaceMatches(oldContent, find_text);
    if (ws.count === 1 && ws.span) {
      const { start, end } = ws.span;
      newContent =
        oldContent.slice(0, start) + replace_text + oldContent.slice(end);
    } else if (ws.count > 1) {
      return {
        success: false,
        output: '',
        error: `File modified since preview; re-run edit (find_text whitespace-fuzzy match is no longer unique in ${relPath} — now matches ${ws.count} locations)`,
      };
    } else {
      return {
        success: false,
        output: '',
        error: `File modified since preview; re-run edit (find_text no longer present in ${relPath})`,
      };
    }
  }

  try {
    await fs.writeFile(absolutePath, newContent, 'utf8');
    const oldLineCount = lineCount(oldContent);
    const newLineCount = lineCount(newContent);
    const delta = newLineCount - oldLineCount;
    const output =
      delta === 0
        ? `Edited ${relPath}: ${oldLineCount} lines (in-place edit)`
        : `Edited ${relPath}: ${oldLineCount} → ${newLineCount} lines (${delta > 0 ? '+' : ''}${delta})`;
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
