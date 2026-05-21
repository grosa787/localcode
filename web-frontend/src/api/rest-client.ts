/**
 * Typed REST client for the LocalCode `--web` SPA.
 *
 * Thin `fetch` wrapper:
 *   - injects `X-LocalCode-CSRF` on mutating requests
 *   - JSON-encodes bodies, JSON-decodes responses
 *   - throws `RestError` on non-2xx with the raw body for diagnostics
 *   - throws `RestAuthError` on 401/403 so callers (App.tsx) can detect
 *     a stale CSRF token and surface a recovery banner.
 *
 * Same dormancy caveat as `ws-client.ts`: Agent D will set up the proper
 * tsconfig + path alias under `web-frontend/`. Until then this file is
 * not part of the root build.
 */

import type {
  AddSkillRequest,
  AddSkillResponse,
  Backend,
  GetAgentsConfigResponse,
  SetAgentsConfigRequest,
  SetAgentsConfigResponse,
  CleanupProjectsResponse,
  CreateProjectRequest,
  GetUsageRequest,
  GetUsageResponse,
  ListPluginsResponse,
  ListSkillsResponse,
  ToggleSkillRequest,
  ToggleSkillResponse,
  CreateProjectResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteProjectResponse,
  DeleteSessionResponse,
  FileReadRequest,
  FileReadResponse,
  FileTreeRequest,
  FileTreeResponse,
  GetConfigResponse,
  ListCommandsResponse,
  ListProvidersConfigResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  ListProjectsResponse,
  ListSessionsRequest,
  PickFolderRequest,
  PickFolderResponse,
  ListSessionsResponse,
  RefreshModelsResponse,
  SearchSessionsRequest,
  SearchSessionsResponse,
  SetGenerationRequest,
  SetGenerationResponse,
  SetModelRequest,
  SetModelResponse,
  SetOutputStyleRequest,
  SetOutputStyleResponse,
  SetProfileRequest,
  SetProfileResponse,
  SetProviderRequest,
  SetProviderResponse,
  ListMemoryResponse,
  WriteMemoryRequest,
  WriteMemoryResponse,
  DeleteMemoryResponse,
  DeleteSkillResponse,
} from '../../../src/web/protocol/rest-types.js';

/** Mutating verbs that require the CSRF header. */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

export class RestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'RestError';
  }
}

/**
 * Thrown when the server rejects the request with `401`/`403`. In the
 * `--web` flow the only realistic cause is a stale CSRF token: the
 * server boot rotates the token on every restart, but the browser tab
 * keeps the old value in `sessionStorage` until the user re-opens the
 * URL printed in the terminal. App.tsx catches this on bootstrap and
 * surfaces a recovery banner.
 */
export class RestAuthError extends RestError {
  constructor(status: number, body: string) {
    super(status, body);
    this.name = 'RestAuthError';
  }
}

export class RestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly csrf: string,
  ) {}

  // ---------- Projects ----------

  listProjects(): Promise<ListProjectsResponse> {
    return this.request<ListProjectsResponse>('GET', '/api/projects');
  }

  createProject(req: CreateProjectRequest): Promise<CreateProjectResponse> {
    return this.request<CreateProjectResponse>('POST', '/api/projects', req);
  }

  deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    return this.request<DeleteProjectResponse>(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
  }

  /**
   * Bulk-remove junk workspace entries (temp dirs, integration-test
   * fixtures, dead paths) from the server's `workspaces.json`.
   * Returns the number of rows removed.
   */
  cleanupProjects(): Promise<CleanupProjectsResponse> {
    return this.request<CleanupProjectsResponse>('POST', '/api/projects/cleanup');
  }

  /**
   * Ask the backend to spawn the OS-native folder picker. Resolves with
   * the chosen path, or `{ path: null, cancelled: true }` if the user
   * dismissed the dialog. `platform: 'unsupported'` means the host has
   * no usable folder dialog.
   */
  pickFolder(req: PickFolderRequest = {}): Promise<PickFolderResponse> {
    return this.request<PickFolderResponse>('POST', '/api/pick-folder', req);
  }

  // ---------- Sessions ----------

  listSessions(req: ListSessionsRequest): Promise<ListSessionsResponse> {
    const qs = new URLSearchParams({ projectId: req.projectId }).toString();
    return this.request<ListSessionsResponse>('GET', `/api/sessions?${qs}`);
  }

  createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>('POST', '/api/sessions', req);
  }

  deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    return this.request<DeleteSessionResponse>(
      'DELETE',
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  listMessages(
    sessionId: string,
    req: ListMessagesRequest = {},
  ): Promise<ListMessagesResponse> {
    const params = new URLSearchParams();
    if (req.cursor !== undefined) params.set('cursor', req.cursor);
    if (req.limit !== undefined) params.set('limit', String(req.limit));
    const qs = params.toString();
    const path =
      `/api/sessions/${encodeURIComponent(sessionId)}/messages` +
      (qs.length > 0 ? `?${qs}` : '');
    return this.request<ListMessagesResponse>('GET', path);
  }

  // ---------- Files ----------

  fileTree(req: FileTreeRequest): Promise<FileTreeResponse> {
    const params = new URLSearchParams({ projectId: req.projectId });
    if (req.path !== undefined) params.set('path', req.path);
    if (req.subpath !== undefined) params.set('subpath', req.subpath);
    if (req.depth !== undefined) params.set('depth', String(req.depth));
    if (req.showHidden === true) params.set('showHidden', '1');
    return this.request<FileTreeResponse>(
      'GET',
      `/api/files/tree?${params.toString()}`,
    );
  }

  fileRead(req: FileReadRequest): Promise<FileReadResponse> {
    const qs = new URLSearchParams({
      projectId: req.projectId,
      path: req.path,
    }).toString();
    return this.request<FileReadResponse>('GET', `/api/files/read?${qs}`);
  }

  // ---------- Config ----------

  getConfig(): Promise<GetConfigResponse> {
    return this.request<GetConfigResponse>('GET', '/api/config');
  }

  setModel(req: SetModelRequest): Promise<SetModelResponse> {
    return this.request<SetModelResponse>('POST', '/api/config/model', req);
  }

  setProvider(req: SetProviderRequest): Promise<SetProviderResponse> {
    return this.request<SetProviderResponse>(
      'POST',
      '/api/config/provider',
      req,
    );
  }

  /**
   * Read the per-provider config snapshot. Used by the BackendServer
   * overlay to prefill base URL / API key fields per backend type.
   */
  listProvidersConfig(): Promise<ListProvidersConfigResponse> {
    return this.request<ListProvidersConfigResponse>(
      'GET',
      '/api/config/providers',
    );
  }

  getAgentsConfig(): Promise<GetAgentsConfigResponse> {
    return this.request<GetAgentsConfigResponse>('GET', '/api/config/agents');
  }

  setAgentsConfig(req: SetAgentsConfigRequest): Promise<SetAgentsConfigResponse> {
    return this.request<SetAgentsConfigResponse>(
      'POST',
      '/api/config/agents',
      req,
    );
  }

  setGeneration(req: SetGenerationRequest): Promise<SetGenerationResponse> {
    return this.request<SetGenerationResponse>(
      'POST',
      '/api/config/generation',
      req,
    );
  }

  /**
   * Switch the active permission profile. Server validates the value
   * against `PermissionProfileSchema` before persisting.
   */
  setProfile(req: SetProfileRequest): Promise<SetProfileResponse> {
    return this.request<SetProfileResponse>(
      'POST',
      '/api/config/profile',
      req,
    );
  }

  /**
   * Switch the active output style preamble. Server validates the
   * value against `OutputStyleSchema` before persisting.
   */
  setOutputStyle(req: SetOutputStyleRequest): Promise<SetOutputStyleResponse> {
    return this.request<SetOutputStyleResponse>(
      'POST',
      '/api/config/output-style',
      req,
    );
  }

  // ---------- Models ----------

  /**
   * Refresh the model list for a provider. When `provider` is omitted
   * the server returns the active backend's models.
   */
  refreshModels(provider?: Backend): Promise<RefreshModelsResponse> {
    const path =
      provider === undefined
        ? '/api/models/refresh'
        : `/api/models/refresh?provider=${encodeURIComponent(provider)}`;
    return this.request<RefreshModelsResponse>('GET', path);
  }

  // ---------- Commands ----------

  /** Read-only metadata listing of registered slash commands. */
  listCommands(): Promise<ListCommandsResponse> {
    return this.request<ListCommandsResponse>('GET', '/api/commands');
  }

  // ---------- Skills ----------

  listSkills(projectId?: string): Promise<ListSkillsResponse> {
    const path =
      projectId !== undefined && projectId.length > 0
        ? `/api/skills?projectId=${encodeURIComponent(projectId)}`
        : '/api/skills';
    return this.request<ListSkillsResponse>('GET', path);
  }

  toggleSkill(
    id: string,
    active: boolean,
    projectId?: string,
  ): Promise<ToggleSkillResponse> {
    const qs =
      projectId !== undefined && projectId.length > 0
        ? `?projectId=${encodeURIComponent(projectId)}`
        : '';
    const body: ToggleSkillRequest = { active };
    return this.request<ToggleSkillResponse>(
      'POST',
      `/api/skills/${encodeURIComponent(id)}/toggle${qs}`,
      body,
    );
  }

  // MEMORY-SKILL-WRITE-SECTION
  addSkill(
    req: AddSkillRequest,
    projectId?: string,
  ): Promise<AddSkillResponse> {
    const qs =
      projectId !== undefined && projectId.length > 0
        ? `?projectId=${encodeURIComponent(projectId)}`
        : '';
    return this.request<AddSkillResponse>(
      'POST',
      `/api/skills${qs}`,
      req,
    );
  }

  /**
   * Alias for `addSkill` — semantically the server accepts the same
   * payload for upsert (create-or-overwrite). The wizard editor calls
   * this on Save regardless of whether the skill already exists.
   */
  writeSkill(
    req: AddSkillRequest,
    projectId?: string,
  ): Promise<AddSkillResponse> {
    return this.addSkill(req, projectId);
  }

  deleteSkill(id: string, projectId?: string): Promise<DeleteSkillResponse> {
    const qs =
      projectId !== undefined && projectId.length > 0
        ? `?projectId=${encodeURIComponent(projectId)}`
        : '';
    return this.request<DeleteSkillResponse>(
      'DELETE',
      `/api/skills/${encodeURIComponent(id)}${qs}`,
    );
  }
  // MEMORY-SKILL-WRITE-SECTION-END

  // ---------- Plugins ----------

  listPlugins(projectId?: string): Promise<ListPluginsResponse> {
    const path =
      projectId !== undefined && projectId.length > 0
        ? `/api/plugins?projectId=${encodeURIComponent(projectId)}`
        : '/api/plugins';
    return this.request<ListPluginsResponse>('GET', path);
  }

  // ---------- Search ----------

  /**
   * Cross-session full-text message search. Read-only — no CSRF.
   * Empty / whitespace queries return `{ results: [], total: 0 }`
   * so the SPA can call this on every keystroke (debounced) without
   * special-casing the empty state in the client.
   */
  searchSessions(req: SearchSessionsRequest): Promise<SearchSessionsResponse> {
    const params = new URLSearchParams({ q: req.q });
    if (req.projectId !== undefined && req.projectId.length > 0) {
      params.set('projectId', req.projectId);
    }
    if (req.limit !== undefined) params.set('limit', String(req.limit));
    if (req.offset !== undefined) params.set('offset', String(req.offset));
    return this.request<SearchSessionsResponse>(
      'GET',
      `/api/search?${params.toString()}`,
    );
  }

  // ---------- Usage ----------

  /**
   * Read aggregated usage telemetry — tokens, cost, per-model rollup,
   * per-day chart series, and top sessions. Read-only; no CSRF gate.
   */
  getUsage(req: GetUsageRequest = {}): Promise<GetUsageResponse> {
    const params = new URLSearchParams();
    if (req.projectId !== undefined && req.projectId.length > 0) {
      params.set('projectId', req.projectId);
    }
    if (req.sinceMs !== undefined) {
      params.set('sinceMs', String(req.sinceMs));
    }
    if (req.modelFilter !== undefined && req.modelFilter.length > 0) {
      params.set('modelFilter', req.modelFilter);
    }
    const qs = params.toString();
    const path = qs.length > 0 ? `/api/usage?${qs}` : '/api/usage';
    return this.request<GetUsageResponse>('GET', path);
  }

  // ---------- Hooks ----------

  /**
   * Read-only list of configured hooks. Mirrors `GET /api/hooks`.
   * Returns the raw config entries; UI components map these to a
   * display-friendly summary.
   */
  listHooks(): Promise<{
    hooks: ReadonlyArray<{
      trigger: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart';
      toolPattern?: string;
      command: string;
      timeout?: number;
      blocking?: boolean;
      description?: string;
    }>;
  }> {
    return this.request('GET', '/api/hooks');
  }

  // ---------- Memory ----------

  listMemory(projectId: string): Promise<ListMemoryResponse> {
    return this.request<ListMemoryResponse>(
      'GET',
      `/api/memory?projectId=${encodeURIComponent(projectId)}`,
    );
  }

  writeMemory(
    projectId: string,
    req: WriteMemoryRequest,
  ): Promise<WriteMemoryResponse> {
    return this.request<WriteMemoryResponse>(
      'POST',
      `/api/memory?projectId=${encodeURIComponent(projectId)}`,
      req,
    );
  }

  deleteMemory(projectId: string, name: string): Promise<DeleteMemoryResponse> {
    return this.request<DeleteMemoryResponse>(
      'DELETE',
      `/api/memory/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    );
  }

  // ---------- Internals ----------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (MUTATING_METHODS.has(method)) {
      headers['X-LocalCode-CSRF'] = this.csrf;
    }

    const init: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(this.baseUrl + path, init);
    if (!res.ok) {
      const text = await res.text();
      // 401/403 almost always means the CSRF token printed in the URL
      // hash no longer matches the server's per-boot secret. Throw a
      // distinct subclass so the App-level handler can detect it.
      if (res.status === 401 || res.status === 403) {
        throw new RestAuthError(res.status, text);
      }
      throw new RestError(res.status, text);
    }
    // The server always responds with JSON — even error-shaped 2xx are
    // JSON. We use a JSON.parse + cast rather than `res.json()` only to
    // keep the path explicit for tests that mock `text()`.
    const text = await res.text();
    return JSON.parse(text) as T;
  }
}
