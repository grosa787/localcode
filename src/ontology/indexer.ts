/**
 * OntologyIndexer — drives the LSP client to build / refresh an
 * `Ontology` for a project root. Supports:
 *
 *   - Full + incremental scans (mtimes drive skip logic).
 *   - Atomic gzipped persistence at
 *     `<projectRoot>/.localcode/ontology.json.gz`.
 *   - Background re-index on an interval + chokidar-debounced watch.
 *
 * The indexer never throws into the host: every LSP call is wrapped in
 * a try/catch and a failure on one file simply leaves that file's
 * symbols absent from the graph. This keeps the indexer best-effort —
 * the worst case is a partial graph; the host UI still works.
 */

import { promises as fs } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';

import fg from 'fast-glob';

import {
  emptyOntology,
  fromSnapshot,
  makeSymbolId,
  OntologySnapshotSchema,
  toSnapshot,
  type Ontology,
  type OntologyEdge,
  type OntologySymbol,
  type SymbolKind,
} from './types';
import {
  LspClient,
  pathToUri,
  uriToPath,
  type LspClientOpts,
  type LspDocumentSymbol,
  type LspLocation,
  type LspSymbolKind,
} from './lsp-client';

/** Hard cap on files scanned — refuses huge monorepos to keep boot fast. */
const MAX_INDEXED_FILES = 5000;

/** Default extensions the indexer walks. */
const DEFAULT_EXTENSIONS: readonly string[] = ['ts', 'tsx', 'cts', 'mts'];

/** Glob ignore set — mirrors the project's other tools. */
const DEFAULT_IGNORE: readonly string[] = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'dist-web/**',
  'build/**',
  '.cache/**',
  '.localcode/**',
  '.next/**',
  '**/*.min.js',
  'bun.lock',
  'package-lock.json',
];

/** On-disk path of the persisted ontology snapshot (gzipped). */
export function ontologyPersistPath(projectRoot: string): string {
  return path.join(projectRoot, '.localcode', 'ontology.json.gz');
}

/** Factory used by the indexer to build an LSP client (override in tests). */
export type LspClientFactory = (cwd: string) => LspClient;

/** Default factory — spawns `typescript-language-server --stdio` via bunx. */
export const defaultLspClientFactory: LspClientFactory = (cwd) =>
  new LspClient({
    command: 'bunx',
    args: ['--bun', 'typescript-language-server', '--stdio'],
    cwd,
  });

export interface OntologyIndexerOpts {
  projectRoot: string;
  /** Factory for the LSP client. Defaults to `defaultLspClientFactory`. */
  clientFactory?: LspClientFactory;
  /** Optional extension allow-list. Defaults to TS/TSX (+cts/mts). */
  extensions?: readonly string[];
  /** Optional callback fired whenever the ontology is rebuilt/refreshed. */
  onUpdate?: (ont: Ontology) => void;
  /** Optional diagnostics sink. */
  onLog?: (message: string) => void;
  /**
   * Optional file-cap override (defaults to {@link MAX_INDEXED_FILES}).
   * Exposed for tests; production callers should not raise it.
   */
  maxFiles?: number;
  /**
   * When true, the indexer caps how many files it parses per pass to
   * keep boot under a few seconds on large repos. Default is the hard
   * cap above; tests usually keep the default.
   */
  injectSpawn?: LspClientOpts['spawn'];
}

/**
 * Build + maintain the ontology graph for a single project root.
 */
export class OntologyIndexer {
  private readonly opts: OntologyIndexerOpts;
  private readonly extensions: readonly string[];
  private readonly maxFiles: number;
  private client: LspClient | null = null;
  private ontology: Ontology;
  private indexing = false;
  private indexQueued = false;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: OntologyIndexerOpts) {
    this.opts = opts;
    this.extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
    this.maxFiles = opts.maxFiles ?? MAX_INDEXED_FILES;
    this.ontology = emptyOntology(opts.projectRoot);
  }

  /** Current graph snapshot (live reference — do not mutate). */
  get current(): Ontology {
    return this.ontology;
  }

  /** True while a scan is in flight. */
  get isIndexing(): boolean {
    return this.indexing;
  }

  /**
   * Load the persisted snapshot if it exists. Returns true when a
   * snapshot was successfully restored. Silent failures result in the
   * empty ontology being kept in place.
   */
  async loadPersisted(): Promise<boolean> {
    try {
      const buf = await fs.readFile(ontologyPersistPath(this.opts.projectRoot));
      const raw = gunzipSync(buf);
      const json = JSON.parse(raw.toString('utf8')) as unknown;
      const parsed = OntologySnapshotSchema.safeParse(json);
      if (!parsed.success) return false;
      this.ontology = fromSnapshot(parsed.data);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Persist the current ontology atomically (gzipped). Best-effort —
   * failures are logged via `onLog` but never thrown.
   */
  async persist(): Promise<void> {
    try {
      const dir = path.dirname(ontologyPersistPath(this.opts.projectRoot));
      await fs.mkdir(dir, { recursive: true });
      const json = JSON.stringify(toSnapshot(this.ontology));
      const gz = gzipSync(Buffer.from(json, 'utf8'));
      const finalPath = ontologyPersistPath(this.opts.projectRoot);
      const tmpPath = `${finalPath}.${Date.now()}.tmp`;
      await fs.writeFile(tmpPath, gz);
      await fs.rename(tmpPath, finalPath);
    } catch (err) {
      this.log(
        `persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Scan the project. Re-uses the existing LSP client when present.
   * Files whose mtime hasn't changed since the last pass are skipped.
   * Files removed since the last pass are dropped from the graph.
   *
   * Returns `false` when a scan is already in flight (the caller can
   * queue a follow-up via the indexer's debounce timer).
   */
  async indexProject(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.indexing) {
      this.indexQueued = true;
      return false;
    }
    this.indexing = true;
    try {
      const root = this.opts.projectRoot;
      const patterns = this.extensions.map((ext) => `**/*.${ext}`);
      const found = await fg(patterns, {
        cwd: root,
        ignore: [...DEFAULT_IGNORE],
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
      });
      if (found.length > this.maxFiles) {
        this.log(
          `project exceeds ${this.maxFiles} files (${found.length}) — skipping ontology index`,
        );
        return false;
      }

      // Detect deleted files vs the previous pass.
      const liveSet = new Set(found);
      for (const stale of [...this.ontology.fileMtimes.keys()]) {
        if (!liveSet.has(stale)) {
          this.ontology.fileMtimes.delete(stale);
          this.pruneSymbolsFor(stale);
        }
      }

      const client = await this.ensureClient();
      if (client === null) {
        return false;
      }

      // Phase 1 — collect new / changed files based on mtime.
      const changed: string[] = [];
      for (const rel of found) {
        const abs = path.join(root, rel);
        let mtime = 0;
        try {
          const stat = await fs.stat(abs);
          mtime = stat.mtimeMs;
        } catch {
          continue;
        }
        const prev = this.ontology.fileMtimes.get(rel);
        if (prev !== undefined && prev === mtime) continue;
        changed.push(rel);
        this.ontology.fileMtimes.set(rel, mtime);
      }

      // Phase 2 — re-index each changed file.
      for (const rel of changed) {
        const abs = path.join(root, rel);
        try {
          const text = await fs.readFile(abs, 'utf8');
          await this.reindexFile(client, rel, abs, text);
        } catch (err) {
          this.log(
            `reindex ${rel} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.ontology.builtAt = Date.now();
      this.opts.onUpdate?.(this.ontology);
      await this.persist();
      return true;
    } finally {
      this.indexing = false;
      if (this.indexQueued && !this.disposed) {
        this.indexQueued = false;
        setTimeout(() => {
          void this.indexProject();
        }, 0);
      }
    }
  }

  /**
   * Begin re-indexing on an interval. Returns a disposer to clear the
   * background timer. Safe to call once — multiple calls reset the
   * timer.
   *
   * @param intervalMs default 300_000 (5 minutes)
   */
  startBackgroundReindex(intervalMs = 300_000): () => void {
    if (this.backgroundTimer !== null) {
      clearInterval(this.backgroundTimer);
    }
    this.backgroundTimer = setInterval(() => {
      void this.indexProject();
    }, intervalMs);
    if (typeof (this.backgroundTimer as { unref?: () => void }).unref === 'function') {
      (this.backgroundTimer as { unref?: () => void }).unref?.();
    }
    return (): void => {
      if (this.backgroundTimer !== null) {
        clearInterval(this.backgroundTimer);
        this.backgroundTimer = null;
      }
    };
  }

  /**
   * Debounced single-file (or directory) re-index trigger. The host
   * wires this into a chokidar watcher so each saved edit kicks a
   * follow-up scan after 2s of quiet.
   */
  scheduleReindex(debounceMs = 2_000): void {
    if (this.disposed) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.indexProject();
    }, debounceMs);
    if (typeof (this.debounceTimer as { unref?: () => void }).unref === 'function') {
      (this.debounceTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Tear everything down — kills the LSP child and cancels timers. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.backgroundTimer !== null) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.client !== null) {
      try {
        await this.client.close();
      } catch {
        /* swallow */
      }
      this.client = null;
    }
  }

  // ---------- Internals ----------

  private log(msg: string): void {
    try {
      this.opts.onLog?.(msg);
    } catch {
      /* swallow */
    }
  }

  private async ensureClient(): Promise<LspClient | null> {
    if (this.client !== null) return this.client;
    try {
      const factory = this.opts.clientFactory ?? defaultLspClientFactory;
      const client = factory(this.opts.projectRoot);
      await client.start();
      this.client = client;
      return client;
    } catch (err) {
      this.log(
        `LSP client start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Pull symbols + edges for a single file. The previous incarnation's
   * symbols + edges are removed first, then we replay the LSP results
   * into the graph.
   */
  private async reindexFile(
    client: LspClient,
    rel: string,
    abs: string,
    text: string,
  ): Promise<void> {
    this.pruneSymbolsFor(rel);
    const uri = pathToUri(abs);
    const languageId = languageIdFor(rel);
    try {
      await client.didOpen(uri, text, languageId);
    } catch (err) {
      this.log(
        `didOpen ${rel} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // Always register a synthetic module symbol so import edges can
    // attach to a node.
    const moduleId = makeSymbolId(rel, '<module>', null);
    this.ontology.symbols.set(moduleId, {
      id: moduleId,
      name: rel,
      kind: 'module',
      file: rel,
      line: 1,
      column: 0,
      container: null,
    });

    let docSymbols: LspDocumentSymbol[] = [];
    try {
      docSymbols = await client.documentSymbol(uri);
    } catch (err) {
      this.log(
        `documentSymbol ${rel} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const collected: Array<{ sym: OntologySymbol; lspKind: LspSymbolKind }> = [];
    collectSymbols(docSymbols, rel, null, collected);
    for (const { sym } of collected) {
      this.ontology.symbols.set(sym.id, sym);
    }

    // Lightweight import scan — parses `import ... from '...'` statements.
    const importTargets = parseImportTargets(text);
    for (const target of importTargets) {
      this.addEdge({
        from: moduleId,
        to: target,
        kind: 'imports',
      });
    }

    // Call-hierarchy + reference edges for every callable.
    for (const { sym, lspKind } of collected) {
      if (lspKind !== 6 /* Method */ && lspKind !== 12 /* Function */) continue;
      const pos = { line: sym.line - 1, character: sym.column };
      let prep: Awaited<ReturnType<LspClient['prepareCallHierarchy']>> = [];
      try {
        prep = await client.prepareCallHierarchy(uri, pos);
      } catch (err) {
        this.log(
          `prepareCallHierarchy ${sym.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const item = prep[0];
      if (item === undefined) continue;

      // Outgoing → `calls` edges (sym calls X)
      try {
        const outgoing = await client.outgoingCalls(item);
        for (const o of outgoing) {
          const targetId = makeSymbolId(
            uriToProjectRel(o.to.uri, this.opts.projectRoot),
            o.to.name,
            null,
          );
          for (const r of o.fromRanges) {
            this.addEdge({
              from: sym.id,
              to: targetId,
              kind: 'calls',
              file: rel,
              line: r.start.line + 1,
            });
          }
        }
      } catch (err) {
        this.log(
          `outgoingCalls ${sym.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Incoming → `references` edges (Y references sym) — capture the
      // call site so consumers can show file:line.
      try {
        const refs = await client.references(uri, pos, false);
        for (const ref of refs) {
          const refRel = uriToProjectRel(ref.uri, this.opts.projectRoot);
          if (refRel === '') continue;
          this.addEdge({
            from: makeSymbolId(refRel, '<module>', null),
            to: sym.id,
            kind: 'references',
            file: refRel,
            line: ref.range.start.line + 1,
          });
        }
      } catch (err) {
        this.log(
          `references ${sym.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Extends / implements edges parsed from source — LSP doesn't have
    // a dedicated "type hierarchy" RPC we can lean on universally.
    const classEdges = parseClassRelations(text, rel);
    for (const e of classEdges) this.addEdge(e);

    try {
      await client.didClose(uri);
    } catch {
      /* swallow */
    }
  }

  private pruneSymbolsFor(rel: string): void {
    for (const [id, sym] of [...this.ontology.symbols]) {
      if (sym.file === rel) this.ontology.symbols.delete(id);
    }
    this.ontology.edges = this.ontology.edges.filter(
      (e) => e.file !== rel && !e.from.startsWith(`${rel}#`),
    );
  }

  private addEdge(edge: OntologyEdge): void {
    // Dedup: avoid identical from|to|kind|line triples.
    for (const existing of this.ontology.edges) {
      if (
        existing.from === edge.from &&
        existing.to === edge.to &&
        existing.kind === edge.kind &&
        existing.line === edge.line &&
        existing.file === edge.file
      ) {
        return;
      }
    }
    this.ontology.edges.push(edge);
  }
}

// ---------- Helpers ----------

/** Determine an LSP `languageId` from a project-relative path. */
function languageIdFor(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.jsx') return 'javascriptreact';
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return 'javascript';
  return 'typescript';
}

/** Resolve `file://` URI back to a project-relative path. */
function uriToProjectRel(uri: string, root: string): string {
  const abs = uriToPath(uri);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..')) return abs;
  return rel.replace(/\\/g, '/');
}

/** Translate an LSP SymbolKind to one of our `SymbolKind` literals. */
function mapKind(lsp: LspSymbolKind): SymbolKind {
  switch (lsp) {
    case 5:
      return 'class';
    case 6:
    case 9:
      return 'method';
    case 11:
      return 'interface';
    case 10:
    case 22:
      return 'enum';
    case 12:
      return 'function';
    case 26:
    case 23:
      return 'type';
    case 2:
    case 3:
    case 4:
      return 'module';
    case 13:
    case 14:
    case 7:
    case 8:
      return 'variable';
    default:
      return 'variable';
  }
}

/**
 * Flatten the hierarchical LSP `DocumentSymbol[]` into an array of
 * `OntologySymbol`s. Each symbol's `container` points at the parent's
 * fully-qualified id (or null for top-level).
 */
function collectSymbols(
  docSymbols: LspDocumentSymbol[],
  fileRel: string,
  containerId: string | null,
  out: Array<{ sym: OntologySymbol; lspKind: LspSymbolKind }>,
): void {
  for (const sym of docSymbols) {
    const id = makeSymbolId(fileRel, sym.name, containerId);
    const kind = mapKind(sym.kind as LspSymbolKind);
    out.push({
      sym: {
        id,
        name: sym.name,
        kind,
        file: fileRel,
        line: sym.selectionRange.start.line + 1,
        column: sym.selectionRange.start.character,
        container: containerId,
      },
      lspKind: sym.kind as LspSymbolKind,
    });
    if (sym.children !== undefined && sym.children.length > 0) {
      collectSymbols(sym.children, fileRel, id, out);
    }
  }
}

/**
 * Extract module identifiers from `import ... from '...'` and bare
 * `import '...'` statements in a TypeScript file. Returns the strings
 * as-given (e.g. `./foo`, `@/types/global`) — resolution to file paths
 * is intentionally out of scope; consumers compare by substring.
 */
function parseImportTargets(text: string): string[] {
  const out: string[] = [];
  const re = /import\s+(?:[^'"]*?\bfrom\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const target = m[1];
    if (typeof target === 'string' && target.length > 0) out.push(target);
  }
  return out;
}

/**
 * Pull `class X extends Y` and `class X implements I, J` declarations
 * from a TypeScript file. Returns extends / implements edges keyed by
 * symbol id (`<file>#X`).
 */
function parseClassRelations(text: string, fileRel: string): OntologyEdge[] {
  const out: OntologyEdge[] = [];
  const classRe =
    /\bclass\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*))?(?:\s+implements\s+([^\{]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(text)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    const from = makeSymbolId(fileRel, name, null);
    const ext = m[2];
    if (typeof ext === 'string' && ext.length > 0) {
      out.push({ from, to: `*#${ext}`, kind: 'extends' });
    }
    const impl = m[3];
    if (typeof impl === 'string' && impl.length > 0) {
      for (const piece of impl.split(',').map((p) => p.trim())) {
        const id = piece.split(/[<\s]/)[0];
        if (id !== undefined && id.length > 0) {
          out.push({ from, to: `*#${id}`, kind: 'implements' });
        }
      }
    }
  }
  const interfaceRe =
    /\binterface\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([^\{]+))?/g;
  while ((m = interfaceRe.exec(text)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    const from = makeSymbolId(fileRel, name, null);
    const ext = m[2];
    if (typeof ext === 'string' && ext.length > 0) {
      for (const piece of ext.split(',').map((p) => p.trim())) {
        const id = piece.split(/[<\s]/)[0];
        if (id !== undefined && id.length > 0) {
          out.push({ from, to: `*#${id}`, kind: 'extends' });
        }
      }
    }
  }
  return out;
}

/** Internal: convenience location-helper for tests + lookups. */
export function _locationToFileLine(loc: LspLocation, root: string): {
  file: string;
  line: number;
} {
  return {
    file: uriToProjectRel(loc.uri, root),
    line: loc.range.start.line + 1,
  };
}
