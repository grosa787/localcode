/**
 * OntologyIndexer tests — use a hand-rolled fake `LspClient` factory
 * so we never spawn a real `typescript-language-server` child.
 *
 * Covers:
 *   - Full scan over a fixture project (3 cross-importing files)
 *     produces module + symbol entries and the expected edge mix.
 *   - Incremental re-index: bumping a file's mtime triggers a rescan;
 *     unchanged files are skipped.
 *   - Gzipped snapshot round-trips (`persist` then `loadPersisted`).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  OntologyIndexer,
  ontologyPersistPath,
  type LspClientFactory,
} from '@/ontology';
import type {
  LspCallHierarchyItem,
  LspDocumentSymbol,
  LspIncomingCall,
  LspLocation,
  LspOutgoingCall,
  LspPosition,
} from '@/ontology/lsp-client';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-onto-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

/**
 * Build a minimal fake LSP client that:
 *   - Acknowledges `start()` immediately.
 *   - Returns a hard-coded `documentSymbol` map keyed by URI.
 *   - Returns an empty result for everything else.
 *
 * The shape mirrors the real `LspClient` only for the methods the
 * indexer calls. We intentionally keep this typed loose with
 * `unknown`-narrowing — the indexer cares about behaviour, not class
 * identity.
 */
function makeFakeFactory(
  perFileSymbols: Map<string, LspDocumentSymbol[]>,
): LspClientFactory {
  return (_cwd: string) => {
    const client = {
      start: async (): Promise<void> => {},
      didOpen: async (
        _uri: string,
        _text: string,
        _languageId: string,
      ): Promise<void> => {},
      didClose: async (_uri: string): Promise<void> => {},
      documentSymbol: async (uri: string): Promise<LspDocumentSymbol[]> =>
        perFileSymbols.get(uri) ?? [],
      references: async (
        _uri: string,
        _pos: LspPosition,
      ): Promise<LspLocation[]> => [],
      definition: async (
        _uri: string,
        _pos: LspPosition,
      ): Promise<LspLocation[]> => [],
      prepareCallHierarchy: async (
        _uri: string,
        _pos: LspPosition,
      ): Promise<LspCallHierarchyItem[]> => [],
      incomingCalls: async (
        _item: LspCallHierarchyItem,
      ): Promise<LspIncomingCall[]> => [],
      outgoingCalls: async (
        _item: LspCallHierarchyItem,
      ): Promise<LspOutgoingCall[]> => [],
      close: async (): Promise<void> => {},
      request: async (_m: string, _p: unknown): Promise<unknown> => null,
      notify: async (_m: string, _p: unknown): Promise<void> => {},
      get rawInitializeResult(): unknown { return null; },
    };
    // Structural cast — the indexer only calls the methods listed above.
    return client as unknown as ReturnType<LspClientFactory>;
  };
}

/** Helper: build a hierarchical doc symbol for a function declaration. */
function fnSymbol(name: string, line: number, character = 9): LspDocumentSymbol {
  return {
    name,
    kind: 12,
    range: { start: { line: line - 1, character: 0 }, end: { line, character: 0 } },
    selectionRange: {
      start: { line: line - 1, character },
      end: { line: line - 1, character: character + name.length },
    },
  };
}

function classSymbol(name: string, line: number, character = 6): LspDocumentSymbol {
  return {
    name,
    kind: 5,
    range: { start: { line: line - 1, character: 0 }, end: { line, character: 0 } },
    selectionRange: {
      start: { line: line - 1, character },
      end: { line: line - 1, character: character + name.length },
    },
  };
}

describe('OntologyIndexer — full scan', () => {
  test('captures symbols + import edges across cross-importing files', async () => {
    await write('src/a.ts', 'import { b } from "./b";\nexport function a() { return b(); }\n');
    await write('src/b.ts', 'import { c } from "./c";\nexport function b() { return c(); }\n');
    await write('src/c.ts', 'export function c() { return 3; }\n');

    const symbols = new Map<string, LspDocumentSymbol[]>();
    const aUri = `file://${path.join(tmpRoot, 'src/a.ts')}`;
    const bUri = `file://${path.join(tmpRoot, 'src/b.ts')}`;
    const cUri = `file://${path.join(tmpRoot, 'src/c.ts')}`;
    symbols.set(encodeURI(aUri), [fnSymbol('a', 2, 16)]);
    symbols.set(encodeURI(bUri), [fnSymbol('b', 2, 16)]);
    symbols.set(encodeURI(cUri), [fnSymbol('c', 1, 16)]);

    const indexer = new OntologyIndexer({
      projectRoot: tmpRoot,
      clientFactory: makeFakeFactory(symbols),
    });

    const ok = await indexer.indexProject();
    expect(ok).toBe(true);

    const ont = indexer.current;
    // 3 modules + 3 functions
    expect(ont.symbols.size).toBeGreaterThanOrEqual(6);
    const moduleIds = [...ont.symbols.values()]
      .filter((s) => s.kind === 'module')
      .map((s) => s.file)
      .sort();
    expect(moduleIds).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);

    const importEdges = ont.edges.filter((e) => e.kind === 'imports');
    expect(importEdges.length).toBeGreaterThanOrEqual(2);
    expect(importEdges.some((e) => e.to === './b')).toBe(true);
    expect(importEdges.some((e) => e.to === './c')).toBe(true);

    await indexer.dispose();
  });
});

describe('OntologyIndexer — incremental re-index', () => {
  test('skips files whose mtime is unchanged', async () => {
    await write('src/x.ts', 'export function x() { return 1; }\n');
    const symbols = new Map<string, LspDocumentSymbol[]>();
    const xUri = encodeURI(`file://${path.join(tmpRoot, 'src/x.ts')}`);
    symbols.set(xUri, [fnSymbol('x', 1, 16)]);

    let docSymbolCalls = 0;
    const indexer = new OntologyIndexer({
      projectRoot: tmpRoot,
      clientFactory: (_cwd) => {
        const inner = makeFakeFactory(symbols)(_cwd);
        const wrapper = Object.create(inner) as typeof inner & {
          documentSymbol: (uri: string) => Promise<LspDocumentSymbol[]>;
        };
        wrapper.documentSymbol = async (uri: string): Promise<LspDocumentSymbol[]> => {
          docSymbolCalls += 1;
          return inner.documentSymbol(uri);
        };
        return wrapper;
      },
    });

    await indexer.indexProject();
    const callsAfterFirst = docSymbolCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Re-run without changing anything → no new documentSymbol calls.
    await indexer.indexProject();
    expect(docSymbolCalls).toBe(callsAfterFirst);

    // Bump mtime → should re-index the file.
    const stat = await fs.stat(path.join(tmpRoot, 'src/x.ts'));
    await fs.utimes(
      path.join(tmpRoot, 'src/x.ts'),
      stat.atime,
      new Date(stat.mtimeMs + 5_000),
    );
    await indexer.indexProject();
    expect(docSymbolCalls).toBe(callsAfterFirst + 1);

    await indexer.dispose();
  });
});

describe('OntologyIndexer — persistence round-trip', () => {
  test('persist + loadPersisted preserves symbols + edges', async () => {
    await write('src/q.ts', 'export function q() { return 1; }\n');
    const symbols = new Map<string, LspDocumentSymbol[]>();
    const qUri = encodeURI(`file://${path.join(tmpRoot, 'src/q.ts')}`);
    symbols.set(qUri, [fnSymbol('q', 1, 16)]);

    const indexer = new OntologyIndexer({
      projectRoot: tmpRoot,
      clientFactory: makeFakeFactory(symbols),
    });
    await indexer.indexProject();
    await indexer.persist();
    await indexer.dispose();

    // Sanity-check the on-disk path exists.
    const persistPath = ontologyPersistPath(tmpRoot);
    const stat = await fs.stat(persistPath);
    expect(stat.size).toBeGreaterThan(0);

    const reloader = new OntologyIndexer({
      projectRoot: tmpRoot,
      clientFactory: makeFakeFactory(symbols),
    });
    const loaded = await reloader.loadPersisted();
    expect(loaded).toBe(true);
    expect(reloader.current.symbols.size).toBe(indexerCountBefore(indexer));
    await reloader.dispose();
  });
});

describe('OntologyIndexer — extends edges', () => {
  test('class extends + interface implements parsed into edges', async () => {
    await write(
      'src/types.ts',
      'export interface Animal {}\nexport class Dog extends Animal implements Pet {}\nexport interface Pet {}\n',
    );
    const symbols = new Map<string, LspDocumentSymbol[]>();
    const uri = encodeURI(`file://${path.join(tmpRoot, 'src/types.ts')}`);
    symbols.set(uri, [classSymbol('Dog', 2, 13)]);

    const indexer = new OntologyIndexer({
      projectRoot: tmpRoot,
      clientFactory: makeFakeFactory(symbols),
    });
    await indexer.indexProject();
    const ont = indexer.current;
    const extEdges = ont.edges.filter((e) => e.kind === 'extends');
    const implEdges = ont.edges.filter((e) => e.kind === 'implements');
    expect(extEdges.some((e) => e.to === '*#Animal')).toBe(true);
    expect(implEdges.some((e) => e.to === '*#Pet')).toBe(true);
    await indexer.dispose();
  });
});

function indexerCountBefore(indexer: OntologyIndexer): number {
  return indexer.current.symbols.size;
}
