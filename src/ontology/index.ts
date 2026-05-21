/**
 * Ontology module barrel + process-wide singleton.
 *
 * `getProcessOntology()` returns the shared `OntologyIndexer` for the
 * current process — both the TUI composition root and the web runtime
 * register the same instance so background re-indexing isn't doubled
 * up. Tests construct fresh indexers directly with `new OntologyIndexer(...)`.
 */

export * from './types';
export {
  LspClient,
  pathToUri,
  uriToPath,
  type LspClientOpts,
  type LspSpawnFn,
  type LspDocumentSymbol,
  type LspLocation,
  type LspPosition,
  type LspRange,
  type LspIncomingCall,
  type LspOutgoingCall,
  type LspCallHierarchyItem,
} from './lsp-client';
export {
  OntologyIndexer,
  defaultLspClientFactory,
  ontologyPersistPath,
  type LspClientFactory,
  type OntologyIndexerOpts,
} from './indexer';
export {
  findCallSites,
  impactsOf,
  typeHierarchy,
  MAX_QUERY_HITS,
  type FindCallSitesOpts,
  type FindCallSitesResult,
  type ImpactsOfOpts,
} from './queries';

import { OntologyIndexer } from './indexer';

let processIndexer: OntologyIndexer | null = null;

/**
 * Lazily-constructed process-wide indexer. Hosts call this on boot,
 * pass the result through to tool handlers via the ToolContext, and
 * dispose it on shutdown.
 *
 * Tests must NOT call this — they should `new OntologyIndexer(...)`
 * directly so per-test state doesn't leak.
 */
export function getProcessOntologyIndexer(
  projectRoot?: string,
): OntologyIndexer | null {
  if (processIndexer === null) {
    if (projectRoot === undefined) return null;
    processIndexer = new OntologyIndexer({ projectRoot });
  }
  return processIndexer;
}

/** Replace the process-wide indexer (host bootstrap / test teardown). */
export function setProcessOntologyIndexer(
  indexer: OntologyIndexer | null,
): void {
  processIndexer = indexer;
}
