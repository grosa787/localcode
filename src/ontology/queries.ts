/**
 * Pure read queries over an `Ontology` graph. Each function is a
 * deterministic, side-effect-free transform — easy to test in isolation
 * and easy to memoise at the host layer when call sites accumulate.
 *
 * Conventions:
 *   - All queries accept a bare symbol name (`"foo"`) or a
 *     fully-qualified id (`"src/x.ts#foo"`).
 *   - Match cap is 100 hits. When more matches exist the function
 *     trims the array and sets `truncated: true` on the result.
 */

import type {
  ImpactNode,
  ImpactReport,
  Ontology,
  OntologySymbol,
  SymbolSite,
  TypeHierarchyReport,
} from './types';

/** Default cap on result rows. */
export const MAX_QUERY_HITS = 100;

export interface FindCallSitesOpts {
  /** Optional file-path filter (substring match). */
  filePath?: string;
  /** Cap on returned rows; defaults to {@link MAX_QUERY_HITS}. */
  limit?: number;
}

export interface FindCallSitesResult {
  matches: SymbolSite[];
  truncated?: boolean;
  totalCount: number;
}

/**
 * All call sites of `symbolName`. Matches either a bare name (last
 * `.`-segment of the symbol id after `#`) or the full id verbatim.
 *
 * Edge sources are deduped — if the LSP reported the same call site
 * for two overlapping ranges we collapse them.
 */
export function findCallSites(
  ontology: Ontology,
  symbolName: string,
  opts: FindCallSitesOpts = {},
): FindCallSitesResult {
  const limit = opts.limit ?? MAX_QUERY_HITS;
  const targets = resolveSymbolIds(ontology, symbolName);
  if (targets.length === 0) {
    return { matches: [], totalCount: 0 };
  }
  const targetSet = new Set(targets);
  const seen = new Set<string>();
  const matches: SymbolSite[] = [];
  let totalCount = 0;
  for (const edge of ontology.edges) {
    if (edge.kind !== 'calls' && edge.kind !== 'references') continue;
    if (!targetSet.has(edge.to)) continue;
    if (
      opts.filePath !== undefined &&
      opts.filePath.length > 0 &&
      edge.file !== undefined &&
      !edge.file.includes(opts.filePath)
    ) {
      continue;
    }
    totalCount += 1;
    const callerSym = ontology.symbols.get(edge.from);
    const caller = callerSym ?? {
      id: edge.from,
      name: bareName(edge.from),
      kind: 'module' as const,
      file: edge.file ?? '',
      line: edge.line ?? 1,
      column: 0,
      container: null,
    };
    const dedupKey = `${caller.id}|${edge.file ?? ''}|${edge.line ?? 0}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    if (matches.length >= limit) continue;
    matches.push({
      callerId: caller.id,
      callerName: caller.name,
      file: edge.file ?? caller.file,
      line: edge.line ?? caller.line,
    });
  }
  const result: FindCallSitesResult = { matches, totalCount };
  if (matches.length < totalCount) result.truncated = true;
  return result;
}

export interface ImpactsOfOpts {
  /** Max BFS depth. Default 3. */
  maxDepth?: number;
  /** Cap on affected rows. Defaults to {@link MAX_QUERY_HITS}. */
  limit?: number;
}

/**
 * BFS over the inverse graph: starting from `symbolName`, follow every
 * `calls`, `references`, `extends`, `implements`, `uses-type` edge that
 * points TO any node currently in the frontier — those edges'
 * sources are "affected".
 *
 * Output is sorted by depth ascending (root → fringe).
 */
export function impactsOf(
  ontology: Ontology,
  symbolName: string,
  opts: ImpactsOfOpts = {},
): ImpactReport {
  const maxDepth = opts.maxDepth ?? 3;
  const limit = opts.limit ?? MAX_QUERY_HITS;
  const targets = resolveSymbolIds(ontology, symbolName);
  if (targets.length === 0) {
    return { rootSymbol: symbolName, affected: [], totalCount: 0 };
  }

  // Index edges by target so the BFS stays linear in graph size.
  const reverseIndex = new Map<string, string[]>();
  for (const edge of ontology.edges) {
    if (
      edge.kind !== 'calls' &&
      edge.kind !== 'references' &&
      edge.kind !== 'extends' &&
      edge.kind !== 'implements' &&
      edge.kind !== 'uses-type'
    ) {
      continue;
    }
    const list = reverseIndex.get(edge.to);
    if (list === undefined) reverseIndex.set(edge.to, [edge.from]);
    else list.push(edge.from);
  }

  const visited = new Set<string>(targets);
  const affected: ImpactNode[] = [];
  let frontier: string[] = [...targets];
  let depth = 0;
  let totalCount = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const nextFrontier: string[] = [];
    depth += 1;
    for (const node of frontier) {
      const callers = reverseIndex.get(node);
      if (callers === undefined) continue;
      for (const caller of callers) {
        if (visited.has(caller)) continue;
        visited.add(caller);
        totalCount += 1;
        if (affected.length < limit) {
          const sym = ontology.symbols.get(caller);
          affected.push({
            symbolId: caller,
            name: sym?.name ?? bareName(caller),
            kind: sym?.kind ?? 'module',
            file: sym?.file ?? caller.split('#')[0] ?? '',
            depth,
          });
        }
        nextFrontier.push(caller);
      }
    }
    frontier = nextFrontier;
  }

  const out: ImpactReport = {
    rootSymbol: targets[0] ?? symbolName,
    affected,
    totalCount,
  };
  if (affected.length < totalCount) out.truncated = true;
  return out;
}

/**
 * Ancestors / descendants / siblings of a given type. Walks
 * `extends`/`implements` edges (both directions). Uses bare-name
 * matching because the LSP doesn't always resolve cross-file type
 * targets to their canonical ids — we keep the wildcard form
 * (`*#Name`) emitted by the indexer's parser and treat it as a
 * name-only handle.
 */
export function typeHierarchy(
  ontology: Ontology,
  typeName: string,
): TypeHierarchyReport {
  const ancestors: OntologySymbol[] = [];
  const descendants: OntologySymbol[] = [];
  const siblings: OntologySymbol[] = [];

  const targets = resolveSymbolIds(ontology, typeName);
  if (targets.length === 0) {
    return { typeName, ancestors, descendants, siblings };
  }
  const targetSet = new Set(targets);
  const targetBareNames = new Set(targets.map((id) => bareName(id)));
  // Build forward + reverse indexes restricted to type edges.
  const supersByChild = new Map<string, Set<string>>(); // child -> superTypeNames
  const subsBySuper = new Map<string, Set<string>>(); // superName -> child symbol ids
  for (const edge of ontology.edges) {
    if (edge.kind !== 'extends' && edge.kind !== 'implements') continue;
    const supName = bareName(edge.to);
    const set = supersByChild.get(edge.from);
    if (set === undefined) supersByChild.set(edge.from, new Set([supName]));
    else set.add(supName);
    const childSet = subsBySuper.get(supName);
    if (childSet === undefined) subsBySuper.set(supName, new Set([edge.from]));
    else childSet.add(edge.from);
  }

  // Ancestors: walk supers of every matching symbol.
  const ancestorSet = new Set<string>();
  for (const tid of targetSet) {
    const supers = supersByChild.get(tid);
    if (supers === undefined) continue;
    for (const supName of supers) ancestorSet.add(supName);
  }
  for (const name of ancestorSet) {
    const sym = findSymbolByBareName(ontology, name);
    if (sym !== null) ancestors.push(sym);
  }

  // Descendants: every child whose super is one of our bare names.
  const descSet = new Set<string>();
  for (const bareN of targetBareNames) {
    const subs = subsBySuper.get(bareN);
    if (subs === undefined) continue;
    for (const sid of subs) {
      if (!targetSet.has(sid)) descSet.add(sid);
    }
  }
  for (const sid of descSet) {
    const sym = ontology.symbols.get(sid);
    if (sym !== undefined) descendants.push(sym);
  }

  // Siblings: another class sharing at least one of our ancestor names.
  const siblingSet = new Set<string>();
  for (const supName of ancestorSet) {
    const subs = subsBySuper.get(supName);
    if (subs === undefined) continue;
    for (const sid of subs) {
      if (!targetSet.has(sid)) siblingSet.add(sid);
    }
  }
  for (const sid of siblingSet) {
    const sym = ontology.symbols.get(sid);
    if (sym !== undefined && !descendants.some((d) => d.id === sid)) {
      siblings.push(sym);
    }
  }

  return { typeName, ancestors, descendants, siblings };
}

// ---------- Internal helpers ----------

/**
 * Resolve a user-typed name to one or more concrete symbol ids in the
 * ontology. Accepts:
 *   - Fully-qualified ids (returns `[name]` if present).
 *   - `*#Name` wildcards (matches by bare name).
 *   - Bare names (matches the last `.`-segment after `#`).
 */
function resolveSymbolIds(ontology: Ontology, name: string): string[] {
  if (ontology.symbols.has(name)) return [name];
  if (name.startsWith('*#')) {
    const bare = name.slice(2);
    return [...ontology.symbols.values()]
      .filter((s) => bareName(s.id) === bare)
      .map((s) => s.id);
  }
  if (name.includes('#')) {
    // Caller used a partial id — try suffix match.
    return [...ontology.symbols.keys()].filter((id) => id.endsWith(name));
  }
  return [...ontology.symbols.values()]
    .filter((s) => s.name === name || bareName(s.id) === name)
    .map((s) => s.id);
}

function findSymbolByBareName(
  ontology: Ontology,
  bare: string,
): OntologySymbol | null {
  for (const s of ontology.symbols.values()) {
    if (s.name === bare) return s;
  }
  return null;
}

/** Last `.`-segment after the `#` in a symbol id. */
function bareName(id: string): string {
  const hash = id.indexOf('#');
  const tail = hash === -1 ? id : id.slice(hash + 1);
  const dot = tail.lastIndexOf('.');
  return dot === -1 ? tail : tail.slice(dot + 1);
}
