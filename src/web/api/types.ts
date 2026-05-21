/**
 * Shared dependency / helper types for the REST handlers.
 *
 * `ApiDeps` is the only structural contract between Agent A's server
 * core and Agent B's handlers. Concrete instances are constructed by
 * the server bootstrap and threaded through `createApiHandler` —
 * handlers never reach for module-level singletons.
 */

import type { Backend } from '@/types/global';

import type { ConfigManager } from '@/config/config-manager';
import type { SessionManager } from '@/sessions/session-manager';
import type { WorkspaceRegistry } from '../workspace/workspace-registry.js';

/** Minimal LLM-adapter surface needed by `/api/models/refresh` + `/api/config/provider`. */
export interface ProviderAdapter {
  getModels(): Promise<readonly string[]>;
}

/**
 * Factory for an LLM adapter scoped to a single backend. The
 * implementation lives in Agent A's bootstrap (mirrors `createAdapter`
 * from `app.tsx`); handlers stay backend-agnostic.
 */
export type AdapterFactory = (
  backend: Backend,
  baseUrl: string,
  apiKey?: string,
) => ProviderAdapter;

/**
 * Hook for releasing the per-session ChatRuntime from the pool when the
 * session row is deleted (audit L4). Optional so existing API tests that
 * never delete sessions don't need to inject a stub.
 */
export type ReleaseSessionHook = (sessionId: string) => void;

export interface ApiDeps {
  workspaceRegistry: WorkspaceRegistry;
  sessionManager: SessionManager;
  configManager: ConfigManager;
  /** Build an adapter for the given backend + URL. */
  createAdapterForBackend: AdapterFactory;
  /**
   * Audit L4 — invoked from `DELETE /api/sessions/:id` so the runtime
   * (browser session, agent team, etc.) is torn down alongside the row.
   * Optional: callers without a RuntimePool (REST-only tests) can omit it.
   */
  releaseSession?: ReleaseSessionHook;
}
