/**
 * Ontology types — the queryable knowledge graph built from an LSP-driven
 * scan of the project. A `Symbol` is a single named code entity (module,
 * class, function, method, type, etc.) and an `Edge` is a directed
 * relation between two symbols. The whole graph lives in `Ontology`.
 *
 * The graph is intentionally small + flat — no nesting beyond `Map<id,
 * Symbol>` and a flat `Edge[]` — so reads (`findCallSites`, `impactsOf`,
 * `typeHierarchy`) can iterate without allocating intermediate structures.
 */

import { z } from 'zod';

/**
 * Classification of a single declared entity. Mirrors the LSP
 * `SymbolKind` enum but trimmed to the kinds we actually surface to the
 * model.
 */
export type SymbolKind =
  | 'module'
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable';

export const SymbolKindSchema = z.enum([
  'module',
  'class',
  'function',
  'method',
  'interface',
  'type',
  'enum',
  'variable',
]);

/**
 * A single symbol. Identifier shape is
 * `<relativeFilePath>#<containerPath>.<name>` (container is empty for
 * module-level declarations) — stable across re-indexes because we
 * derive it from file path + name, not from LSP-assigned ids.
 */
export interface OntologySymbol {
  /** Fully-qualified id — see module docstring. */
  id: string;
  /** Short, human-friendly name (last `.`-separated segment). */
  name: string;
  kind: SymbolKind;
  /** Project-relative path of the declaration file. */
  file: string;
  /** 1-based start line. */
  line: number;
  /** 0-based start column. */
  column: number;
  /**
   * Container id, when the symbol is nested inside another (e.g. a
   * method's container is its class). `null` for top-level declarations.
   */
  container?: string | null;
}

export const OntologySymbolSchema: z.ZodType<OntologySymbol> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: SymbolKindSchema,
  file: z.string().min(1),
  line: z.number().int().min(1),
  column: z.number().int().min(0),
  container: z.string().nullable().optional(),
});

/**
 * Relation kinds between symbols. `imports` is module-to-module;
 * everything else is symbol-to-symbol.
 *
 * - `imports`     — module A imports module B.
 * - `calls`       — callable A's body invokes callable B.
 * - `extends`     — class A extends class B (or interface A extends B).
 * - `implements`  — class A implements interface B.
 * - `uses-type`   — symbol A references type B in a signature / type ref.
 * - `references`  — generic "A mentions B" fallback for non-call uses.
 */
export type EdgeKind =
  | 'imports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'uses-type'
  | 'references';

export const EdgeKindSchema = z.enum([
  'imports',
  'calls',
  'extends',
  'implements',
  'uses-type',
  'references',
]);

/** Directed edge in the ontology graph. */
export interface OntologyEdge {
  /** Source symbol id. */
  from: string;
  /** Target symbol id. May refer to a symbol not in the graph (external). */
  to: string;
  kind: EdgeKind;
  /** Optional file:line of the reference site (for `calls`/`references`). */
  file?: string;
  line?: number;
}

export const OntologyEdgeSchema: z.ZodType<OntologyEdge> = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: EdgeKindSchema,
  file: z.string().optional(),
  line: z.number().int().min(1).optional(),
});

/**
 * The queryable knowledge graph for a project. Keeps file mtimes so the
 * incremental indexer can skip unchanged files on a re-index pass.
 *
 * `version` increments on every persisted snapshot so consumers can
 * detect changes and re-render UI without diffing the full graph.
 */
export interface Ontology {
  /** Schema version of the on-disk JSON envelope. */
  version: number;
  /** Project root the graph was built for (absolute path). */
  projectRoot: string;
  /** UTC timestamp (ms) of the last full index pass. */
  builtAt: number;
  /** Symbol map keyed by `OntologySymbol.id`. */
  symbols: Map<string, OntologySymbol>;
  /** Edge list — duplicates eliminated by `from|to|kind` triple. */
  edges: OntologyEdge[];
  /** File-modification times (ms) so the indexer can skip unchanged files. */
  fileMtimes: Map<string, number>;
}

/** Empty graph for a given project root. */
export function emptyOntology(projectRoot: string): Ontology {
  return {
    version: 1,
    projectRoot,
    builtAt: 0,
    symbols: new Map(),
    edges: [],
    fileMtimes: new Map(),
  };
}

/**
 * Persisted form of an `Ontology`. Maps become arrays of [key, value]
 * tuples so JSON.stringify round-trips losslessly.
 */
export interface OntologySnapshot {
  version: number;
  projectRoot: string;
  builtAt: number;
  symbols: Array<[string, OntologySymbol]>;
  edges: OntologyEdge[];
  fileMtimes: Array<[string, number]>;
}

export const OntologySnapshotSchema = z.object({
  version: z.number().int().min(1),
  projectRoot: z.string().min(1),
  builtAt: z.number().int().min(0),
  symbols: z.array(z.tuple([z.string(), OntologySymbolSchema])),
  edges: z.array(OntologyEdgeSchema),
  fileMtimes: z.array(z.tuple([z.string(), z.number()])),
});

/** Round-trip a live Ontology to its snapshot form. */
export function toSnapshot(ont: Ontology): OntologySnapshot {
  return {
    version: ont.version,
    projectRoot: ont.projectRoot,
    builtAt: ont.builtAt,
    symbols: Array.from(ont.symbols.entries()),
    edges: ont.edges,
    fileMtimes: Array.from(ont.fileMtimes.entries()),
  };
}

/** Round-trip a snapshot back into a live Ontology. */
export function fromSnapshot(snap: OntologySnapshot): Ontology {
  return {
    version: snap.version,
    projectRoot: snap.projectRoot,
    builtAt: snap.builtAt,
    symbols: new Map(snap.symbols),
    edges: snap.edges,
    fileMtimes: new Map(snap.fileMtimes),
  };
}

/** A single result row from `findCallSites`. */
export interface SymbolSite {
  /** Caller symbol id (or the bare symbol id when no caller could be resolved). */
  callerId: string;
  /** Caller symbol name (sugar for callers that want a label). */
  callerName: string;
  /** File of the call site. */
  file: string;
  /** 1-based line of the call site. */
  line: number;
}

/** A node in the impact graph returned by `impactsOf`. */
export interface ImpactNode {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  file: string;
  /** Distance (hops) from the root symbol. Root has distance 0. */
  depth: number;
}

/** Report returned by `impactsOf`. */
export interface ImpactReport {
  rootSymbol: string;
  affected: ImpactNode[];
  totalCount: number;
  truncated?: boolean;
}

/** Report returned by `typeHierarchy`. */
export interface TypeHierarchyReport {
  typeName: string;
  /** Symbols this type extends/implements (its supertypes), nearest first. */
  ancestors: OntologySymbol[];
  /** Symbols that extend/implement this type (its subtypes). */
  descendants: OntologySymbol[];
  /** Other types that share at least one direct ancestor with this one. */
  siblings: OntologySymbol[];
}

/** Build a deterministic fully-qualified id for a symbol. */
export function makeSymbolId(
  file: string,
  name: string,
  container: string | null | undefined,
): string {
  const containerSegment =
    container !== null && container !== undefined && container.length > 0
      ? `${container}.`
      : '';
  return `${file}#${containerSegment}${name}`;
}
