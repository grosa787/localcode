/**
 * Tests for the three ontology tools: `find_call_sites`, `impacts_of`,
 * `type_hierarchy`. We build a hand-rolled in-memory ontology + a
 * minimal stub indexer object, then drive each tool through the
 * standard `(args, ctx)` contract.
 *
 * Each suite also asserts the "ontology not ready" path so the model
 * gets a deterministic error when the indexer hasn't surfaced any
 * symbols yet.
 */

import { describe, expect, test } from 'bun:test';

import { findCallSitesTool } from '@/tools/find-call-sites';
import { impactsOfTool } from '@/tools/impacts-of';
import { typeHierarchyTool } from '@/tools/type-hierarchy';
import {
  emptyOntology,
  makeSymbolId,
  type Ontology,
  type OntologySymbol,
} from '@/ontology/types';

function fnSym(file: string, name: string, line = 1): OntologySymbol {
  return {
    id: makeSymbolId(file, name, null),
    name,
    kind: 'function',
    file,
    line,
    column: 0,
    container: null,
  };
}

function classSym(file: string, name: string, line = 1): OntologySymbol {
  return {
    id: makeSymbolId(file, name, null),
    name,
    kind: 'class',
    file,
    line,
    column: 0,
    container: null,
  };
}

interface StubIndexer {
  readonly current: Ontology;
  readonly isIndexing: boolean;
}

function makeStub(symbols: OntologySymbol[], edges: Ontology['edges']): StubIndexer {
  const ont = emptyOntology('/proj');
  for (const s of symbols) ont.symbols.set(s.id, s);
  ont.edges = edges;
  return { current: ont, isIndexing: false };
}

const baseCtx = { projectRoot: '/proj', dangerouslyAllowAll: false };

describe('find_call_sites', () => {
  test('returns matches as JSON envelope', async () => {
    const target = fnSym('src/util.ts', 'doThing');
    const caller = fnSym('src/a.ts', 'caller', 10);
    const stub = makeStub(
      [target, caller],
      [{ from: caller.id, to: target.id, kind: 'calls', file: 'src/a.ts', line: 11 }],
    );
    const res = await findCallSitesTool(
      { symbol: 'doThing' },
      { ...baseCtx, ontology: stub },
    );
    expect(res.success).toBe(true);
    const payload = JSON.parse(res.output) as {
      matches: Array<{ callerName: string; file: string; line: number }>;
      truncated: boolean;
      totalCount: number;
    };
    expect(payload.matches.length).toBe(1);
    expect(payload.matches[0]?.callerName).toBe('caller');
    expect(payload.totalCount).toBe(1);
  });

  test('returns "Ontology not ready" when context lacks an indexer', async () => {
    const res = await findCallSitesTool({ symbol: 'doThing' }, baseCtx);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Ontology not ready');
  });

  test('returns "Ontology not ready" when graph is empty', async () => {
    const stub: StubIndexer = { current: emptyOntology('/proj'), isIndexing: false };
    const res = await findCallSitesTool(
      { symbol: 'doThing' },
      { ...baseCtx, ontology: stub },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('Ontology not ready');
  });

  test('rejects invalid args', async () => {
    const stub = makeStub([fnSym('src/x.ts', 'x')], []);
    const res = await findCallSitesTool({}, { ...baseCtx, ontology: stub });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid args');
  });
});

describe('impacts_of', () => {
  test('walks transitive callers', async () => {
    const target = fnSym('src/util.ts', 'doThing');
    const direct = fnSym('src/a.ts', 'direct');
    const indirect = fnSym('src/b.ts', 'indirect');
    const stub = makeStub(
      [target, direct, indirect],
      [
        { from: direct.id, to: target.id, kind: 'calls', file: 'src/a.ts', line: 5 },
        { from: indirect.id, to: direct.id, kind: 'calls', file: 'src/b.ts', line: 6 },
      ],
    );
    const res = await impactsOfTool(
      { symbol: 'doThing', maxDepth: 3 },
      { ...baseCtx, ontology: stub },
    );
    expect(res.success).toBe(true);
    const payload = JSON.parse(res.output) as { affected: Array<{ name: string }> };
    const names = payload.affected.map((a) => a.name).sort();
    expect(names).toEqual(['direct', 'indirect']);
  });

  test('"Ontology not ready" when context missing', async () => {
    const res = await impactsOfTool({ symbol: 'x' }, baseCtx);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Ontology not ready');
  });
});

describe('type_hierarchy', () => {
  test('reports ancestors / descendants / siblings', async () => {
    const animal = classSym('src/types.ts', 'Animal');
    const dog = classSym('src/dog.ts', 'Dog');
    const cat = classSym('src/cat.ts', 'Cat');
    const stub = makeStub(
      [animal, dog, cat],
      [
        { from: dog.id, to: '*#Animal', kind: 'extends' },
        { from: cat.id, to: '*#Animal', kind: 'extends' },
      ],
    );
    const res = await typeHierarchyTool(
      { typeName: 'Dog' },
      { ...baseCtx, ontology: stub },
    );
    expect(res.success).toBe(true);
    const payload = JSON.parse(res.output) as {
      ancestors: Array<{ name: string }>;
      descendants: Array<{ name: string }>;
      siblings: Array<{ name: string }>;
    };
    expect(payload.ancestors.map((a) => a.name)).toContain('Animal');
    expect(payload.siblings.map((s) => s.name)).toContain('Cat');
  });

  test('"Ontology not ready" when context missing', async () => {
    const res = await typeHierarchyTool({ typeName: 'Dog' }, baseCtx);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Ontology not ready');
  });

  test('rejects invalid args', async () => {
    const stub = makeStub([], []);
    const res = await typeHierarchyTool({}, { ...baseCtx, ontology: stub });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid args');
  });
});
