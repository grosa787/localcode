/**
 * Tests for `diagnose_image` — the error-screenshot → ontology-grounding
 * tool (Wave 16D).
 *
 * Coverage:
 *   - groundFrames: verified / corrected (did-you-mean) / dropped.
 *   - Non-multimodal model → graceful "no vision" message (pass 1).
 *   - Non-TS project (no ontology) → frames pass through unverified.
 *   - Image load via an injected fake fs → multimodal handoff envelope.
 *   - boundedLevenshtein behaviour.
 */

import { test, expect } from 'bun:test';

import {
  diagnoseImage,
  groundFrames,
  ontologyLookup,
  enrichLookup,
  boundedLevenshtein,
  type DiagnoseFs,
  type DiagnoseImageContext,
  type DiagnoseExtractEnvelope,
  type OntologyLookup,
  type StackFrame,
  type GroundingResult,
} from '@/tools/diagnose-image';
import { emptyOntology, makeSymbolId } from '@/ontology/types';
import type { Ontology, OntologySymbol, SymbolKind } from '@/ontology/types';

// ── Helpers ────────────────────────────────────────────────────────────────

function sym(
  file: string,
  name: string,
  kind: SymbolKind = 'function',
): OntologySymbol {
  return {
    id: makeSymbolId(file, name, null),
    name,
    kind,
    file,
    line: 1,
    column: 0,
    container: null,
  };
}

function ontologyWith(symbols: OntologySymbol[]): Ontology {
  const ont = emptyOntology('/proj');
  for (const s of symbols) ont.symbols.set(s.id, s);
  return ont;
}

function lookupWith(symbols: OntologySymbol[]): OntologyLookup {
  const ont = ontologyWith(symbols);
  return enrichLookup(ontologyLookup(ont), ont);
}

/** Parse the JSON ToolResult.output of a pass-2 grounding call. */
function parseGrounded(output: string): {
  kind: string;
  skippedNonTs: boolean;
  trusted: GroundingResult['trusted'];
  dropped: GroundingResult['dropped'];
  summary: string;
} {
  return JSON.parse(output) as ReturnType<typeof parseGrounded>;
}

// ── groundFrames: verified ───────────────────────────────────────────────

test('groundFrames marks a real file+symbol as verified', () => {
  const lookup = lookupWith([sym('src/handler.ts', 'handleRequest')]);
  const frames: StackFrame[] = [
    { file: 'src/handler.ts', line: 42, symbol: 'handleRequest', message: 'TypeError' },
  ];
  const result = groundFrames(frames, lookup);
  expect(result.skippedNonTs).toBe(false);
  expect(result.dropped).toHaveLength(0);
  expect(result.trusted).toHaveLength(1);
  expect(result.trusted[0]?.status).toBe('verified');
  expect(result.trusted[0]?.resolvedFile).toBe('src/handler.ts');
  expect(result.trusted[0]?.resolvedSymbol).toBe('handleRequest');
});

test('groundFrames verifies a file-only frame when the file exists', () => {
  const lookup = lookupWith([sym('src/server.ts', 'boot')]);
  const result = groundFrames([{ file: 'src/server.ts', line: 7 }], lookup);
  expect(result.trusted[0]?.status).toBe('verified');
  expect(result.dropped).toHaveLength(0);
});

test('groundFrames verifies a symbol-only frame and resolves its file', () => {
  const lookup = lookupWith([sym('src/db.ts', 'connect')]);
  const result = groundFrames([{ symbol: 'connect' }], lookup);
  expect(result.trusted[0]?.status).toBe('verified');
  expect(result.trusted[0]?.resolvedFile).toBe('src/db.ts');
});

// ── groundFrames: dropped (bogus) ────────────────────────────────────────

test('groundFrames drops a frame whose file does not exist (no near-miss)', () => {
  const lookup = lookupWith([sym('src/handler.ts', 'handleRequest')]);
  const result = groundFrames(
    [{ file: 'src/totally-made-up-xyz.ts', symbol: 'ghost', line: 9 }],
    lookup,
  );
  expect(result.trusted).toHaveLength(0);
  expect(result.dropped).toHaveLength(1);
  expect(result.dropped[0]?.status).toBe('unverified');
});

test('groundFrames drops a bogus symbol with no file claim', () => {
  const lookup = lookupWith([sym('src/handler.ts', 'handleRequest')]);
  const result = groundFrames([{ symbol: 'zzzNopeNope' }], lookup);
  expect(result.dropped).toHaveLength(1);
  expect(result.dropped[0]?.status).toBe('unverified');
});

// ── groundFrames: corrected (did-you-mean) ───────────────────────────────

test('groundFrames corrects a near-miss FILE (did-you-mean)', () => {
  const lookup = lookupWith([sym('src/handler.ts', 'handleRequest')]);
  // One-char transposition / typo: `handeler` → `handler`.
  const result = groundFrames(
    [{ file: 'src/handeler.ts', symbol: 'handleRequest' }],
    lookup,
  );
  expect(result.dropped).toHaveLength(0);
  expect(result.trusted).toHaveLength(1);
  expect(result.trusted[0]?.status).toBe('corrected');
  expect(result.trusted[0]?.resolvedFile).toBe('src/handler.ts');
  expect(result.trusted[0]?.note.toLowerCase()).toContain('did-you-mean');
});

test('groundFrames corrects a near-miss SYMBOL within the resolved file', () => {
  const lookup = lookupWith([sym('src/handler.ts', 'handleRequest')]);
  // `handleReqest` (missing the second 'u') → `handleRequest`.
  const result = groundFrames(
    [{ file: 'src/handler.ts', symbol: 'handleReqest' }],
    lookup,
  );
  expect(result.trusted).toHaveLength(1);
  expect(result.trusted[0]?.status).toBe('corrected');
  expect(result.trusted[0]?.resolvedSymbol).toBe('handleRequest');
});

test('groundFrames orders verified frames before corrected ones', () => {
  const lookup = lookupWith([
    sym('src/a.ts', 'alpha'),
    sym('src/b.ts', 'beta'),
  ]);
  const result = groundFrames(
    [
      { file: 'src/b.ts', symbol: 'beta' }, // verified
      { file: 'src/aa.ts', symbol: 'alpha' }, // corrected: aa.ts → a.ts
    ],
    lookup,
  );
  expect(result.trusted).toHaveLength(2);
  expect(result.trusted[0]?.status).toBe('verified');
  expect(result.trusted[1]?.status).toBe('corrected');
});

test('groundFrames flags a verified file whose named symbol is absent', () => {
  const lookup = lookupWith([sym('src/handler.ts', 'handleRequest')]);
  const result = groundFrames(
    [{ file: 'src/handler.ts', symbol: 'somethingFarAway123' }],
    lookup,
  );
  // File is real, so we keep it as 'corrected' (trusted) and tell the agent
  // to re-read the file for the symbol rather than dropping the whole frame.
  expect(result.dropped).toHaveLength(0);
  expect(result.trusted[0]?.status).toBe('corrected');
  expect(result.trusted[0]?.resolvedFile).toBe('src/handler.ts');
});

// ── groundFrames: non-TS / empty ontology ────────────────────────────────

test('groundFrames passes frames through unverified when ontology is null', () => {
  const frames: StackFrame[] = [{ file: 'main.go', symbol: 'main', line: 3 }];
  const result = groundFrames(frames, null);
  expect(result.skippedNonTs).toBe(true);
  expect(result.dropped).toHaveLength(0);
  expect(result.trusted).toHaveLength(1);
  expect(result.trusted[0]?.status).toBe('unverified');
});

test('groundFrames passes frames through unverified when ontology is empty', () => {
  const empty = enrichLookup(ontologyLookup(emptyOntology('/proj')), emptyOntology('/proj'));
  const result = groundFrames([{ file: 'src/x.ts', symbol: 'y' }], empty);
  expect(result.skippedNonTs).toBe(true);
  expect(result.trusted[0]?.status).toBe('unverified');
});

test('groundFrames flags a non-TS file as unverified even with a TS ontology', () => {
  const lookup = lookupWith([sym('src/handler.ts', 'handleRequest')]);
  const result = groundFrames([{ file: 'server.py', symbol: 'handler' }], lookup);
  expect(result.dropped).toHaveLength(1);
  expect(result.dropped[0]?.note.toLowerCase()).toContain('typescript');
});

// ── boundedLevenshtein ───────────────────────────────────────────────────

test('boundedLevenshtein returns 0 for identical strings', () => {
  expect(boundedLevenshtein('handler', 'handler', 2)).toBe(0);
});

test('boundedLevenshtein measures single edits', () => {
  expect(boundedLevenshtein('handler', 'handeler', 3)).toBe(1); // one insert
  expect(boundedLevenshtein('connect', 'conect', 3)).toBe(1); // one delete
});

test('boundedLevenshtein bails past the budget', () => {
  // Far apart — must exceed the cap (returns max+1).
  expect(boundedLevenshtein('alpha', 'omega-zeta-far', 2)).toBeGreaterThan(2);
});

// ── diagnoseImage pass 1: vision gate ────────────────────────────────────

function ctxWith(over: Partial<DiagnoseImageContext>): DiagnoseImageContext {
  return {
    projectRoot: '/proj',
    dangerouslyAllowAll: false,
    ...over,
  };
}

test('diagnoseImage refuses pass-1 on a known non-vision model', async () => {
  const ctx = ctxWith({ backend: 'openai', modelName: 'gpt-3.5-turbo' });
  const res = await diagnoseImage({ path: 'shot.png' }, ctx);
  expect(res.success).toBe(false);
  expect(res.error?.toLowerCase()).toContain('vision');
});

test('diagnoseImage allows pass-1 when forceVision overrides a weak model', async () => {
  const fakeFs: DiagnoseFs = {
    stat: async () => ({ isFile: () => true, size: 4 }),
    readFile: async () => Buffer.from('PNG!'),
  };
  const ctx = ctxWith({
    backend: 'ollama',
    modelName: 'mystery-model',
    forceVision: true,
    diagnoseFs: fakeFs,
  });
  const res = await diagnoseImage({ path: 'shot.png' }, ctx);
  expect(res.success).toBe(true);
});

// ── diagnoseImage pass 1: image load + multimodal handoff ────────────────

test('diagnoseImage pass 1 returns a multimodal extraction envelope', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fakeFs: DiagnoseFs = {
    stat: async () => ({ isFile: () => true, size: bytes.byteLength }),
    readFile: async () => bytes,
  };
  const ctx = ctxWith({
    backend: 'anthropic',
    modelName: 'claude-3-5-sonnet',
    diagnoseFs: fakeFs,
  });
  const res = await diagnoseImage({ path: 'err.png', hint: 'top frame' }, ctx);
  expect(res.success).toBe(true);
  const env = JSON.parse(res.output) as DiagnoseExtractEnvelope;
  expect(env.kind).toBe('diagnose-image-extract');
  expect(env.mimeType).toBe('image/png');
  expect(env.parts).toHaveLength(2);
  expect(env.parts[0]?.type).toBe('image_url');
  const imagePart = env.parts[0];
  if (imagePart?.type === 'image_url') {
    expect(imagePart.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  }
  expect(env.parts[1]?.type).toBe('text');
  expect(env.instruction).toContain('top frame'); // hint threaded through
  expect(env.instruction.toLowerCase()).toContain('frames');
});

test('diagnoseImage pass 1 rejects an unsupported extension', async () => {
  const ctx = ctxWith({ modelName: 'claude-3-5-sonnet', backend: 'anthropic' });
  const res = await diagnoseImage({ path: 'notes.txt' }, ctx);
  expect(res.success).toBe(false);
  expect(res.error?.toLowerCase()).toContain('unsupported image extension');
});

test('diagnoseImage pass 1 rejects an empty file', async () => {
  const fakeFs: DiagnoseFs = {
    stat: async () => ({ isFile: () => true, size: 0 }),
    readFile: async () => Buffer.alloc(0),
  };
  const ctx = ctxWith({ modelName: 'claude-3-5-sonnet', backend: 'anthropic', diagnoseFs: fakeFs });
  const res = await diagnoseImage({ path: 'empty.png' }, ctx);
  expect(res.success).toBe(false);
  expect(res.error?.toLowerCase()).toContain('empty');
});

test('diagnoseImage pass 1 rejects an oversized image', async () => {
  const fakeFs: DiagnoseFs = {
    stat: async () => ({ isFile: () => true, size: 11 * 1024 * 1024 }),
    readFile: async () => Buffer.alloc(0),
  };
  const ctx = ctxWith({ modelName: 'claude-3-5-sonnet', backend: 'anthropic', diagnoseFs: fakeFs });
  const res = await diagnoseImage({ path: 'huge.png' }, ctx);
  expect(res.success).toBe(false);
  expect(res.error?.toLowerCase()).toContain('too large');
});

test('diagnoseImage pass 1 blocks path traversal', async () => {
  const ctx = ctxWith({ modelName: 'claude-3-5-sonnet', backend: 'anthropic' });
  const res = await diagnoseImage({ path: '../../etc/passwd.png' }, ctx);
  expect(res.success).toBe(false);
  expect(res.error?.toLowerCase()).toContain('traversal');
});

// ── diagnoseImage pass 2: grounding through the tool entry point ──────────

test('diagnoseImage pass 2 grounds frames against the wired ontology', async () => {
  const ont = ontologyWith([sym('src/handler.ts', 'handleRequest')]);
  const ctx = ctxWith({
    ontology: { current: ont, isIndexing: false },
  });
  const res = await diagnoseImage(
    {
      path: 'err.png',
      frames: [
        { file: 'src/handler.ts', symbol: 'handleRequest', line: 42 }, // verified
        { file: 'src/ghost.ts', symbol: 'nope', line: 1 }, // dropped
      ],
    },
    ctx,
  );
  expect(res.success).toBe(true);
  const env = parseGrounded(res.output);
  expect(env.kind).toBe('diagnose-image-grounded');
  expect(env.skippedNonTs).toBe(false);
  expect(env.trusted).toHaveLength(1);
  expect(env.trusted[0]?.status).toBe('verified');
  expect(env.dropped).toHaveLength(1);
  expect(env.summary.toLowerCase()).toContain('trusted');
});

test('diagnoseImage pass 2 reports skippedNonTs when no ontology is wired', async () => {
  const ctx = ctxWith({}); // no ontology in context
  const res = await diagnoseImage(
    { path: 'err.png', frames: [{ file: 'main.rs', symbol: 'main' }] },
    ctx,
  );
  expect(res.success).toBe(true);
  const env = parseGrounded(res.output);
  expect(env.skippedNonTs).toBe(true);
  expect(env.trusted[0]?.status).toBe('unverified');
});

// ── arg validation ───────────────────────────────────────────────────────

test('diagnoseImage rejects a missing path', async () => {
  const ctx = ctxWith({});
  const res = await diagnoseImage({ hint: 'x' }, ctx);
  expect(res.success).toBe(false);
  expect(res.error?.toLowerCase()).toContain('invalid args');
});
