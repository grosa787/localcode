/**
 * `diagnose_image` tool — turn an error SCREENSHOT (Slack capture, photo of
 * a monitor, CI-log screengrab) into a grounded, trustworthy stack-trace.
 *
 * The differentiator over generic OCR+LLM: every file/symbol the vision
 * model claims to have read off the image is VERIFIED against LocalCode's
 * on-device TypeScript ontology before the agent is allowed to act on it.
 * That kills the classic "the model confidently 'fixed' a file that doesn't
 * exist" failure mode — an OCR misread of `srv/handeler.ts` is caught and
 * either corrected (did-you-mean → `src/handler.ts`) or dropped.
 *
 * ── Why two phases (and how model extraction is wired) ───────────────────
 * Tool handlers in LocalCode CANNOT call the LLM directly — `ToolContext`
 * exposes no adapter / `streamChat`. So extraction is a deliberate
 * agent-loop dance:
 *
 *   PASS 1 (no `frames` arg): load the image, sanity-check it, and return
 *   it as an OpenAI-shaped `MessageContentPart[]` (an `image_url` data-URI
 *   part + a strict "extract stack frames as JSON" text part). The main
 *   agent loop forwards this to the active multimodal model, which does the
 *   OCR and emits the JSON frames.
 *
 *   PASS 2 (`frames` supplied): the agent calls `diagnose_image` again with
 *   the frames it extracted. We GROUND them against the ontology and return
 *   a structured diagnosis (verified frames first, dropped/unverified
 *   flagged so the agent never edits a hallucinated path).
 *
 * `groundFrames` is a pure, dependency-injected function so the grounding
 * logic is unit-testable without an LLM, a filesystem, or a real indexer.
 *
 * Read-only, single-phase, no approval (it reads one image off disk + the
 * in-memory ontology; it mutates nothing).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { Backend } from '@/types/global';
import type { MessageContentPart } from '@/types/message';
import { supportsVision } from '@/llm/model-capabilities';
import type { Ontology, OntologySymbol } from '@/ontology/types';

import { narrowOntologyContext } from './find-call-sites';
import { resolveSafePathStrict } from './path-safety';
import type { ToolContext, ToolResult } from './types';

/** 10 MB cap on the on-disk image — matches `fetch_image`'s decode cap. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Max stack frames we ground in a single call (bounds the payload). */
const MAX_FRAMES = 50;

/**
 * Levenshtein edit-distance threshold for a did-you-mean suggestion. A
 * near-miss is only surfaced when the correction is within this many
 * single-character edits of the OCR'd token AND no exact match exists.
 */
const DID_YOU_MEAN_MAX_DISTANCE = 2;

/** File extensions whose declarations live in the TS ontology. */
const TS_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx']);

/** Image MIME types vision models universally accept. Keyed by extension. */
const EXT_TO_MIME: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

// ── Args ─────────────────────────────────────────────────────────────────

/**
 * A single stack frame as extracted from the screenshot by the vision
 * model. All fields optional except none — the model fills what it can
 * read; grounding tolerates partial frames.
 */
export const StackFrameSchema = z.object({
  /** Project-relative (or as-read) file path, e.g. `src/handler.ts`. */
  file: z.string().optional(),
  /** 1-based line number, when visible in the trace. */
  line: z.number().int().min(1).optional(),
  /** Symbol / function name at this frame, when visible. */
  symbol: z.string().optional(),
  /** The error message text, when this frame carries it. */
  message: z.string().optional(),
});

export type StackFrame = z.infer<typeof StackFrameSchema>;

export const DiagnoseImageArgsSchema = z.object({
  /** Path to the screenshot, relative to `ToolContext.projectRoot`. */
  path: z.string().min(1, 'path must be a non-empty string'),
  /** Optional hint to steer extraction (e.g. "TypeError near top"). */
  hint: z.string().optional(),
  /**
   * PASS-2 input: the stack frames the agent extracted from the image in
   * pass 1. When present, the tool skips image loading entirely and runs
   * the grounding pass over these frames.
   */
  frames: z.array(StackFrameSchema).optional(),
});

export type DiagnoseImageArgs = z.infer<typeof DiagnoseImageArgsSchema>;

// ── Grounding result types ────────────────────────────────────────────────

/** Verification verdict for a single grounded frame. */
export type FrameStatus = 'verified' | 'corrected' | 'unverified';

/** A frame after grounding against the ontology. */
export interface GroundedFrame {
  /** The original frame as extracted. */
  original: StackFrame;
  status: FrameStatus;
  /**
   * The file the frame resolved to. Equals `original.file` for `verified`,
   * the suggested correction for `corrected`, undefined for `unverified`.
   */
  resolvedFile?: string;
  /** Resolved symbol name, when the symbol verified or was corrected. */
  resolvedSymbol?: string;
  /** Human-readable reason for the verdict (esp. for unverified/corrected). */
  note: string;
}

export interface GroundingResult {
  /** Frames that verified or were corrected, ordered verified-first. */
  trusted: GroundedFrame[];
  /** Frames dropped because nothing in the ontology backed them. */
  dropped: GroundedFrame[];
  /**
   * True when grounding was skipped because the project is not TypeScript
   * (or the ontology is empty / unavailable). Frames pass through as
   * `unverified` with a note in that case.
   */
  skippedNonTs: boolean;
}

// ── Ontology lookup dependency (injected for testability) ─────────────────

/**
 * The slice of ontology knowledge `groundFrames` needs. Implemented over a
 * real `Ontology` by {@link ontologyLookup}; stubbed by a plain object in
 * tests so the grounding logic runs with zero I/O.
 */
export interface OntologyLookup {
  /** Project-relative paths of every file the ontology knows about. */
  knownFiles(): readonly string[];
  /** True when `file` (project-relative) appears in the ontology. */
  hasFile(file: string): boolean;
  /**
   * Symbols whose bare name equals `name`. Mirrors `find_symbol`/the
   * ontology `resolveSymbolIds` contract: an empty array means "no such
   * symbol".
   */
  symbolsByName(name: string): readonly OntologySymbol[];
}

/** Build an {@link OntologyLookup} backed by a live ontology graph. */
export function ontologyLookup(ont: Ontology): OntologyLookup {
  const files = new Set<string>();
  for (const sym of ont.symbols.values()) files.add(sym.file);
  return {
    knownFiles: () => [...files],
    hasFile: (file) => files.has(file),
    symbolsByName: (name) => {
      const out: OntologySymbol[] = [];
      for (const sym of ont.symbols.values()) {
        if (sym.name === name) out.push(sym);
      }
      return out;
    },
  };
}

// ── Pure grounding logic ──────────────────────────────────────────────────

/**
 * Levenshtein edit distance, capped: returns early once the running cost
 * exceeds `max` (we only care whether two tokens are *near*, not the exact
 * distance for far-apart ones). Case-insensitive comparison is the caller's
 * responsibility.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev: number[] = new Array<number>(bl + 1);
  let curr: number[] = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j += 1) prev[j] = j;

  for (let i = 1; i <= al; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j += 1) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? max + 1) + 1;
      const ins = (curr[j - 1] ?? max + 1) + 1;
      const sub = (prev[j - 1] ?? max + 1) + cost;
      const best = Math.min(del, ins, sub);
      curr[j] = best;
      if (best < rowMin) rowMin = best;
    }
    // Whole row exceeded the budget — the final distance can only grow.
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[bl] ?? max + 1;
}

/**
 * Find the single closest token in `candidates` to `needle` within
 * `DID_YOU_MEAN_MAX_DISTANCE` edits. Comparison is case-insensitive.
 * Returns `null` when nothing is close enough (no false-confidence
 * suggestions). Ties broken by the smaller distance, then lexicographically
 * for determinism.
 */
function closestMatch(
  needle: string,
  candidates: readonly string[],
): { value: string; distance: number } | null {
  const lowNeedle = needle.toLowerCase();
  let best: { value: string; distance: number } | null = null;
  for (const cand of candidates) {
    const d = boundedLevenshtein(lowNeedle, cand.toLowerCase(), DID_YOU_MEAN_MAX_DISTANCE);
    if (d > DID_YOU_MEAN_MAX_DISTANCE) continue;
    if (d === 0) continue; // exact match handled by the caller's hasFile/symbolsByName
    if (
      best === null ||
      d < best.distance ||
      (d === best.distance && cand < best.value)
    ) {
      best = { value: cand, distance: d };
    }
  }
  return best;
}

/** True when the file path looks like a TypeScript source file. */
function isTsFile(file: string): boolean {
  return TS_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Ground extracted stack frames against the ontology.
 *
 * Verdicts per frame:
 *   - `verified`   — the file exists in the ontology AND (if a symbol was
 *                    given) that symbol resolves to that file.
 *   - `corrected`  — the file/symbol didn't match exactly but a near-miss
 *                    (≤ {@link DID_YOU_MEAN_MAX_DISTANCE} edits) does —
 *                    `resolvedFile`/`resolvedSymbol` carry the did-you-mean.
 *   - `unverified` — nothing in the ontology backs the frame → DROPPED so
 *                    the agent doesn't act on an OCR misread.
 *
 * Non-TS projects (and empty/absent ontologies) skip grounding entirely:
 * every frame passes through as `unverified` with `skippedNonTs: true`, so
 * the agent gets the extracted frames but is told they're unverified.
 *
 * Pure: all ontology knowledge arrives via the injected `lookup`.
 */
export function groundFrames(
  frames: readonly StackFrame[],
  lookup: OntologyLookup | null,
): GroundingResult {
  // No ontology (non-TS project, indexer not ready, etc.) → pass through.
  if (lookup === null || lookup.knownFiles().length === 0) {
    const trusted: GroundedFrame[] = frames.map((f) => ({
      original: f,
      status: 'unverified' as const,
      note: 'ontology unavailable — frame not grounded (TS ontology is TypeScript-only)',
    }));
    return { trusted, dropped: [], skippedNonTs: true };
  }

  const knownFiles = lookup.knownFiles();
  const trusted: GroundedFrame[] = [];
  const dropped: GroundedFrame[] = [];

  for (const frame of frames.slice(0, MAX_FRAMES)) {
    const grounded = groundOneFrame(frame, lookup, knownFiles);
    if (grounded.status === 'unverified') dropped.push(grounded);
    else trusted.push(grounded);
  }

  // Verified ahead of corrected so the agent reads the most-trusted first.
  trusted.sort((a, b) => statusRank(a.status) - statusRank(b.status));
  return { trusted, dropped, skippedNonTs: false };
}

function statusRank(status: FrameStatus): number {
  if (status === 'verified') return 0;
  if (status === 'corrected') return 1;
  return 2;
}

function groundOneFrame(
  frame: StackFrame,
  lookup: OntologyLookup,
  knownFiles: readonly string[],
): GroundedFrame {
  const file = frame.file?.trim();
  const symbol = frame.symbol?.trim();

  // A frame with neither a file nor a symbol carries only a message —
  // nothing to ground against the symbol graph. Keep it but flag it.
  if ((file === undefined || file.length === 0) && (symbol === undefined || symbol.length === 0)) {
    return {
      original: frame,
      status: 'unverified',
      note: 'no file or symbol to verify against the ontology',
    };
  }

  // Frames whose file is plainly not TypeScript can't be in the TS
  // ontology — don't drop on a false negative, flag as unverified.
  if (file !== undefined && file.length > 0 && !isTsFile(file)) {
    return {
      original: frame,
      status: 'unverified',
      note: `file '${file}' is not a TypeScript source — outside the TS ontology`,
    };
  }

  let resolvedFile: string | undefined;
  let fileStatus: 'exact' | 'corrected' | 'missing' = 'missing';

  if (file !== undefined && file.length > 0) {
    if (lookup.hasFile(file)) {
      resolvedFile = file;
      fileStatus = 'exact';
    } else {
      const near = closestMatch(file, knownFiles);
      if (near !== null) {
        resolvedFile = near.value;
        fileStatus = 'corrected';
      } else {
        fileStatus = 'missing';
      }
    }
  }

  // Symbol resolution. We only treat a symbol as verified when it resolves
  // to the file we ended up trusting (exact or corrected). This is the
  // guard that catches an OCR'd symbol that exists somewhere ELSE in the
  // tree but not in the file the trace claims.
  let resolvedSymbol: string | undefined;
  let symbolStatus: 'exact' | 'corrected' | 'missing' | 'absent' = 'absent';

  if (symbol !== undefined && symbol.length > 0) {
    const exactHits = lookup.symbolsByName(symbol);
    const inFile =
      resolvedFile !== undefined
        ? exactHits.filter((s) => s.file === resolvedFile)
        : exactHits;
    if (inFile.length > 0) {
      resolvedSymbol = symbol;
      symbolStatus = 'exact';
      // Symbol-only frame: anchor the resolved file to where it actually
      // lives so the agent gets a file:line to read.
      if (resolvedFile === undefined) resolvedFile = inFile[0]?.file;
    } else {
      // Try a did-you-mean over every symbol name in the (resolved) file,
      // or over all symbol names when no file anchor exists.
      const candidateNames = symbolCandidateNames(lookup, knownFiles, resolvedFile);
      const near = closestMatch(symbol, candidateNames);
      if (near !== null) {
        resolvedSymbol = near.value;
        symbolStatus = 'corrected';
        if (resolvedFile === undefined) {
          const hit = lookup.symbolsByName(near.value)[0];
          if (hit !== undefined) resolvedFile = hit.file;
        }
      } else {
        symbolStatus = 'missing';
      }
    }
  }

  return finalizeVerdict(frame, {
    file,
    symbol,
    resolvedFile,
    resolvedSymbol,
    fileStatus,
    symbolStatus,
  });
}

/**
 * Collect symbol-name candidates for the did-you-mean over a frame's
 * symbol. When a file anchor is known we restrict to that file's symbols
 * (sharper suggestions); otherwise we offer every symbol name.
 */
function symbolCandidateNames(
  lookup: OntologyLookup,
  _knownFiles: readonly string[],
  resolvedFile: string | undefined,
): string[] {
  // We can only enumerate names via the lookup's symbolsByName, which is
  // name-keyed — so we accumulate from the file's symbols when anchored.
  // Without a name list the lookup can't enumerate all names cheaply, so
  // callers that want file-scoped suggestions inject a richer lookup. Here
  // we approximate: when anchored, harvest names from the lookup by probing
  // is not possible; instead we rely on the real `ontologyLookup` which can
  // be extended. For the injected/test lookups we expose `knownSymbolNames`.
  const enriched = lookup as OntologyLookup & {
    knownSymbolNames?: (file?: string) => readonly string[];
  };
  if (typeof enriched.knownSymbolNames === 'function') {
    return [...enriched.knownSymbolNames(resolvedFile)];
  }
  return [];
}

interface VerdictInput {
  file: string | undefined;
  symbol: string | undefined;
  resolvedFile: string | undefined;
  resolvedSymbol: string | undefined;
  fileStatus: 'exact' | 'corrected' | 'missing';
  symbolStatus: 'exact' | 'corrected' | 'missing' | 'absent';
}

function finalizeVerdict(frame: StackFrame, v: VerdictInput): GroundedFrame {
  const base: GroundedFrame = { original: frame, status: 'unverified', note: '' };
  if (v.resolvedFile !== undefined) base.resolvedFile = v.resolvedFile;
  if (v.resolvedSymbol !== undefined) base.resolvedSymbol = v.resolvedSymbol;

  const hasFileClaim = v.file !== undefined && v.file.length > 0;
  const hasSymbolClaim = v.symbol !== undefined && v.symbol.length > 0;

  // File verified exactly and (no symbol claim OR symbol verified exactly).
  if (
    v.fileStatus === 'exact' &&
    (!hasSymbolClaim || v.symbolStatus === 'exact')
  ) {
    base.status = 'verified';
    base.note =
      hasSymbolClaim
        ? `file '${v.resolvedFile}' and symbol '${v.resolvedSymbol}' verified in ontology`
        : `file '${v.resolvedFile}' verified in ontology`;
    return base;
  }

  // Symbol-only frame (no file claim) that verified.
  if (!hasFileClaim && hasSymbolClaim && v.symbolStatus === 'exact') {
    base.status = 'verified';
    base.note = `symbol '${v.resolvedSymbol}' verified in ontology (${v.resolvedFile})`;
    return base;
  }

  // Any correction in play (file or symbol) with a resolution → corrected.
  if (
    (v.fileStatus === 'corrected' || v.symbolStatus === 'corrected') &&
    (v.resolvedFile !== undefined || v.resolvedSymbol !== undefined)
  ) {
    const parts: string[] = ['did-you-mean'];
    if (v.fileStatus === 'corrected') parts.push(`file '${v.file}' → '${v.resolvedFile}'`);
    if (v.symbolStatus === 'corrected') parts.push(`symbol '${v.symbol}' → '${v.resolvedSymbol}'`);
    base.status = 'corrected';
    base.note = parts.join('; ');
    return base;
  }

  // File verified but its named symbol is missing in that file → corrected-ish
  // but we cannot trust the symbol. Surface as corrected when we at least
  // trust the file; the agent can re-read the file to locate the symbol.
  if (v.fileStatus === 'exact' && hasSymbolClaim && v.symbolStatus === 'missing') {
    base.status = 'corrected';
    base.note = `file '${v.resolvedFile}' verified but symbol '${v.symbol}' not found there — re-read the file`;
    return base;
  }

  // Nothing held up.
  const reason = hasFileClaim
    ? `file '${v.file}' not found in ontology and no near-miss within ${DID_YOU_MEAN_MAX_DISTANCE} edits`
    : `symbol '${v.symbol}' not found in ontology`;
  base.status = 'unverified';
  base.note = reason;
  return base;
}

// ── Image loading (pass 1) ────────────────────────────────────────────────

/**
 * Pluggable filesystem slice so tests can load images without touching
 * disk. Mirrors the subset of `node:fs/promises` we use.
 */
export interface DiagnoseFs {
  stat(p: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(p: string): Promise<Buffer>;
}

const realFs: DiagnoseFs = {
  stat: (p) => fs.stat(p),
  readFile: (p) => fs.readFile(p),
};

/** Augmented context — none of these are on the shared `ToolContext`. */
export interface DiagnoseImageContext extends ToolContext {
  /** Active model id, for the vision-capability gate. */
  modelName?: string;
  /** Active backend, for the vision-capability gate. */
  backend?: Backend;
  /** When true, force the vision gate open (user knows their model). */
  forceVision?: boolean;
  /** Injectable fs for tests. */
  diagnoseFs?: DiagnoseFs;
}

/** The instruction we hand the multimodal model in pass 1. */
function buildExtractionInstruction(hint: string | undefined): string {
  const lines = [
    'This image is a screenshot of an error / stack trace. Read it carefully',
    'and extract the stack frames. Respond by calling `diagnose_image` AGAIN',
    'with the SAME `path` plus a `frames` array. Each frame is an object:',
    '  { "file": "<path as shown>", "line": <number>, "symbol": "<fn name>", "message": "<error text>" }',
    'Include only fields you can actually read from the image — omit the rest.',
    'Do NOT invent file paths or symbol names; transcribe exactly what is shown,',
    'mistakes and all. The second pass will verify each frame against the',
    'project ontology and correct OCR misreads.',
  ];
  if (hint !== undefined && hint.trim().length > 0) {
    lines.push(`User hint: ${hint.trim()}`);
  }
  return lines.join('\n');
}

/**
 * Envelope returned by pass 1. `kind: 'diagnose-image-extract'` lets the
 * agent loop / web UI recognise the multimodal handoff. `parts` is the
 * OpenAI-shaped `MessageContentPart[]` ready to splice into a user turn.
 */
export interface DiagnoseExtractEnvelope {
  kind: 'diagnose-image-extract';
  path: string;
  mimeType: string;
  byteLength: number;
  instruction: string;
  parts: MessageContentPart[];
}

function loadImageResult(
  relPath: string,
  mimeType: string,
  base64: string,
  byteLength: number,
  hint: string | undefined,
): ToolResult {
  const instruction = buildExtractionInstruction(hint);
  const envelope: DiagnoseExtractEnvelope = {
    kind: 'diagnose-image-extract',
    path: relPath,
    mimeType,
    byteLength,
    instruction,
    parts: [
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
      { type: 'text', text: instruction },
    ],
  };
  return { success: true, output: JSON.stringify(envelope) };
}

// ── Tool entry point ──────────────────────────────────────────────────────

/**
 * Resolve the ontology lookup from the context, or `null` when the project
 * isn't TypeScript / the indexer isn't ready / the graph is empty.
 */
function resolveLookup(ctx: ToolContext): OntologyLookup | null {
  const indexer = narrowOntologyContext(ctx.ontology);
  if (indexer === null) return null;
  const ont = indexer.current;
  if (ont.symbols.size === 0) return null;
  return enrichLookup(ontologyLookup(ont), ont);
}

/**
 * Add `knownSymbolNames` to a base lookup so the symbol did-you-mean can
 * enumerate candidate names (optionally file-scoped). Kept separate from
 * `ontologyLookup` so the injected test lookup can opt in independently.
 */
export function enrichLookup(base: OntologyLookup, ont: Ontology): OntologyLookup {
  return {
    ...base,
    knownSymbolNames: (file?: string): readonly string[] => {
      const names = new Set<string>();
      for (const sym of ont.symbols.values()) {
        if (file === undefined || sym.file === file) names.add(sym.name);
      }
      return [...names];
    },
  } as OntologyLookup & { knownSymbolNames: (file?: string) => readonly string[] };
}

/** Render the grounding result into a model-friendly text diagnosis. */
function renderDiagnosis(result: GroundingResult): string {
  const lines: string[] = [];
  if (result.skippedNonTs) {
    lines.push(
      'Ontology grounding SKIPPED (project is not TypeScript, or the index is not ready).',
      'Extracted frames are returned UNVERIFIED — treat file/symbol names with caution:',
    );
    for (const f of result.trusted) lines.push(`  - ${renderFrame(f)}`);
    return lines.join('\n');
  }

  lines.push(`Grounded diagnosis: ${result.trusted.length} trusted, ${result.dropped.length} dropped.`);
  if (result.trusted.length > 0) {
    lines.push('Trusted frames (verified first):');
    for (const f of result.trusted) lines.push(`  - ${renderFrame(f)}`);
  }
  if (result.dropped.length > 0) {
    lines.push('Dropped/unverified frames (do NOT act on these — likely OCR misreads):');
    for (const f of result.dropped) lines.push(`  - ${renderFrame(f)}`);
  }
  return lines.join('\n');
}

function renderFrame(f: GroundedFrame): string {
  const loc =
    f.resolvedFile !== undefined
      ? `${f.resolvedFile}${f.original.line !== undefined ? `:${f.original.line}` : ''}`
      : f.original.file ?? '(no file)';
  const sym = f.resolvedSymbol ?? f.original.symbol;
  const symPart = sym !== undefined ? ` ${sym}` : '';
  return `[${f.status}] ${loc}${symPart} — ${f.note}`;
}

export async function diagnoseImage(
  args: unknown,
  ctx: DiagnoseImageContext,
): Promise<ToolResult> {
  const parsed = DiagnoseImageArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const { path: relPath, hint, frames } = parsed.data;

  // ── PASS 2: grounding. `frames` present → verify against the ontology.
  if (frames !== undefined) {
    const lookup = resolveLookup(ctx);
    const result = groundFrames(frames, lookup);
    const envelope = {
      kind: 'diagnose-image-grounded' as const,
      path: relPath,
      skippedNonTs: result.skippedNonTs,
      trusted: result.trusted,
      dropped: result.dropped,
      summary: renderDiagnosis(result),
    };
    return { success: true, output: JSON.stringify(envelope) };
  }

  // ── PASS 1: vision gate, then load image + emit the extraction handoff.
  const model = ctx.modelName;
  if (model !== undefined && model.length > 0) {
    if (!supportsVision(ctx.backend, model, ctx.forceVision)) {
      return {
        success: false,
        output: '',
        error:
          `Active model '${model}' has no vision capability. ` +
          'Switch to a multimodal model (e.g. a *-vision / *-vl / gpt-4o / claude-3+ / gemini build) ' +
          'or paste the stack trace as text and call read tools / find_symbol directly.',
      };
    }
  }

  const diagFs = ctx.diagnoseFs ?? realFs;
  const absolutePath = resolveSafePathStrict(ctx.projectRoot, relPath);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${relPath}' escapes project root`,
    };
  }

  const ext = path.extname(relPath).toLowerCase();
  const mimeType = EXT_TO_MIME.get(ext);
  if (mimeType === undefined) {
    return {
      success: false,
      output: '',
      error:
        `Unsupported image extension '${ext || '(none)'}'. ` +
        `Supported: ${[...EXT_TO_MIME.keys()].join(', ')}.`,
    };
  }

  let stat: { isFile(): boolean; size: number };
  try {
    stat = await diagFs.stat(absolutePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: `Failed to stat '${relPath}': ${message}` };
  }
  if (!stat.isFile()) {
    return { success: false, output: '', error: `Not a file: '${relPath}'` };
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    return { success: false, output: '', error: `Image too large: ${mb} MB exceeds 10 MB cap` };
  }
  if (stat.size === 0) {
    return { success: false, output: '', error: `Image is empty: '${relPath}'` };
  }

  let buf: Buffer;
  try {
    buf = await diagFs.readFile(absolutePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: `Failed to read '${relPath}': ${message}` };
  }
  if (buf.byteLength === 0) {
    return { success: false, output: '', error: `Image is empty: '${relPath}'` };
  }
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return { success: false, output: '', error: 'Image too large (>10MB)' };
  }

  return loadImageResult(relPath, mimeType, buf.toString('base64'), buf.byteLength, hint);
}
