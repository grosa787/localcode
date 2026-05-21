/**
 * Pure-function tests for the ontology query layer. We build small
 * hand-rolled `Ontology` graphs and assert behaviour — no LSP, no
 * filesystem.
 */

import { describe, expect, test } from 'bun:test';

import { findCallSites, impactsOf, typeHierarchy } from '@/ontology/queries';
import {
  emptyOntology,
  makeSymbolId,
  type Ontology,
  type OntologyEdge,
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

function buildOntology(
  symbols: OntologySymbol[],
  edges: OntologyEdge[],
): Ontology {
  const ont = emptyOntology('/proj');
  for (const s of symbols) ont.symbols.set(s.id, s);
  ont.edges = edges;
  return ont;
}

describe('findCallSites', () => {
  test('matches by bare name', () => {
    const target = fnSym('src/util.ts', 'doThing');
    const callerA = fnSym('src/a.ts', 'callerA', 10);
    const callerB = fnSym('src/b.ts', 'callerB', 20);
    const ont = buildOntology(
      [target, callerA, callerB],
      [
        { from: callerA.id, to: target.id, kind: 'calls', file: 'src/a.ts', line: 11 },
        { from: callerB.id, to: target.id, kind: 'calls', file: 'src/b.ts', line: 21 },
      ],
    );
    const result = findCallSites(ont, 'doThing');
    expect(result.matches.length).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.matches.map((m) => m.callerName).sort()).toEqual(['callerA', 'callerB']);
  });

  test('filePath filter narrows the result set', () => {
    const target = fnSym('src/util.ts', 'doThing');
    const callerA = fnSym('src/a.ts', 'callerA', 10);
    const callerB = fnSym('src/b.ts', 'callerB', 20);
    const ont = buildOntology(
      [target, callerA, callerB],
      [
        { from: callerA.id, to: target.id, kind: 'calls', file: 'src/a.ts', line: 11 },
        { from: callerB.id, to: target.id, kind: 'calls', file: 'src/b.ts', line: 21 },
      ],
    );
    const filtered = findCallSites(ont, 'doThing', { filePath: 'src/a' });
    expect(filtered.matches.length).toBe(1);
    expect(filtered.matches[0]?.file).toBe('src/a.ts');
  });

  test('returns empty result when symbol is unknown', () => {
    const ont = buildOntology([fnSym('src/x.ts', 'x')], []);
    const result = findCallSites(ont, 'nope');
    expect(result.matches.length).toBe(0);
    expect(result.totalCount).toBe(0);
  });
});

describe('impactsOf', () => {
  test('walks transitive callers across depths', () => {
    const target = fnSym('src/util.ts', 'doThing');
    const direct = fnSym('src/a.ts', 'direct', 5);
    const indirect = fnSym('src/b.ts', 'indirect', 6);
    const farAway = fnSym('src/c.ts', 'farAway', 7);
    const ont = buildOntology(
      [target, direct, indirect, farAway],
      [
        { from: direct.id, to: target.id, kind: 'calls', file: 'src/a.ts', line: 6 },
        { from: indirect.id, to: direct.id, kind: 'calls', file: 'src/b.ts', line: 7 },
        { from: farAway.id, to: indirect.id, kind: 'calls', file: 'src/c.ts', line: 8 },
      ],
    );
    const report = impactsOf(ont, 'doThing', { maxDepth: 3 });
    const names = report.affected.map((a) => a.name).sort();
    expect(names).toEqual(['direct', 'farAway', 'indirect']);
    expect(report.totalCount).toBe(3);
    const directHit = report.affected.find((a) => a.name === 'direct');
    expect(directHit?.depth).toBe(1);
    const farHit = report.affected.find((a) => a.name === 'farAway');
    expect(farHit?.depth).toBe(3);
  });

  test('maxDepth caps the search', () => {
    const target = fnSym('src/util.ts', 'doThing');
    const direct = fnSym('src/a.ts', 'direct', 5);
    const indirect = fnSym('src/b.ts', 'indirect', 6);
    const ont = buildOntology(
      [target, direct, indirect],
      [
        { from: direct.id, to: target.id, kind: 'calls', file: 'src/a.ts', line: 6 },
        { from: indirect.id, to: direct.id, kind: 'calls', file: 'src/b.ts', line: 7 },
      ],
    );
    const report = impactsOf(ont, 'doThing', { maxDepth: 1 });
    const names = report.affected.map((a) => a.name);
    expect(names).toEqual(['direct']);
  });
});

describe('typeHierarchy', () => {
  test('ancestors and descendants for class extends', () => {
    const animal = classSym('src/types.ts', 'Animal');
    const dog = classSym('src/dog.ts', 'Dog');
    const puppy = classSym('src/puppy.ts', 'Puppy');
    const cat = classSym('src/cat.ts', 'Cat');
    const ont = buildOntology(
      [animal, dog, puppy, cat],
      [
        { from: dog.id, to: '*#Animal', kind: 'extends' },
        { from: cat.id, to: '*#Animal', kind: 'extends' },
        { from: puppy.id, to: '*#Dog', kind: 'extends' },
      ],
    );

    const dogReport = typeHierarchy(ont, 'Dog');
    expect(dogReport.ancestors.map((s) => s.name)).toContain('Animal');
    expect(dogReport.descendants.map((s) => s.name)).toContain('Puppy');
    expect(dogReport.siblings.map((s) => s.name)).toContain('Cat');
  });

  test('interface implements relations', () => {
    const pet = classSym('src/types.ts', 'Pet');
    const dog = classSym('src/dog.ts', 'Dog');
    const ont = buildOntology(
      [pet, dog],
      [{ from: dog.id, to: '*#Pet', kind: 'implements' }],
    );
    const petReport = typeHierarchy(ont, 'Pet');
    expect(petReport.descendants.map((s) => s.name)).toContain('Dog');
  });
});
