/**
 * Wire protocol — REST request / response shapes for the `--web` server.
 *
 * Pure TypeScript: no runtime imports beyond Zod for schema generation.
 * Each endpoint exports:
 *   - `<Endpoint>Request`  (when there is a body or non-trivial query)
 *   - `<Endpoint>Response`
 *   - `<Endpoint>ResponseSchema` for runtime validation on receive
 *
 * The `WorkspaceRecord` shape mirrors `~/.localcode/workspaces.json`.
 * `SessionSummaryWire` is re-exported here so REST consumers don't have
 * to dual-import from `messages.ts`.
 */

import { z } from 'zod';

import type { AppConfig, Backend, PermissionProfile } from '../../types/global.js';
import type { SessionSummaryWire, WireChatMessage } from './messages.js';
import { BackendSchema, WireChatMessageSchema } from './messages.js';

export type { Backend, PermissionProfile, SessionSummaryWire, WireChatMessage };

// ---------- Workspaces ----------

export interface WorkspaceRecord {
  /** uuidv7. */
  id: string;
  /** Absolute filesystem path. */
  root: string;
  /** Display label — defaults to basename of `root`. */
  label: string;
  /** Epoch ms; updated whenever a session under this workspace is touched. */
  lastUsedAt: number;
}

export const WorkspaceRecordSchema: z.ZodType<WorkspaceRecord> = z.object({
  id: z.string(),
  root: z.string(),
  label: z.string(),
  lastUsedAt: z.number(),
});

// ---------- /api/projects ----------

export interface ListProjectsResponse {
  projects: WorkspaceRecord[];
}

export const ListProjectsResponseSchema: z.ZodType<ListProjectsResponse> =
  z.object({
    projects: z.array(WorkspaceRecordSchema),
  });

export interface CreateProjectRequest {
  /** Absolute filesystem path. The server validates that it exists. */
  root: string;
  /** Optional display label. Falls back to the basename of `root`. */
  label?: string;
}

export interface CreateProjectResponse {
  project: WorkspaceRecord;
}

export const CreateProjectResponseSchema: z.ZodType<CreateProjectResponse> =
  z.object({
    project: WorkspaceRecordSchema,
  });

export interface DeleteProjectResponse {
  ok: true;
  /** Number of sessions cascade-deleted from `sessions.db`. */
  removedSessions: number;
}

export const DeleteProjectResponseSchema: z.ZodType<DeleteProjectResponse> =
  z.object({
    ok: z.literal(true),
    removedSessions: z.number(),
  });

export interface CleanupProjectsResponse {
  /** Number of junk entries removed from `workspaces.json`. */
  removed: number;
}

export const CleanupProjectsResponseSchema: z.ZodType<CleanupProjectsResponse> =
  z.object({
    removed: z.number(),
  });

// ---------- /api/pick-folder ----------

export interface PickFolderRequest {
  /** Optional dialog title. Backend sanitises before passing to the OS. */
  prompt?: string;
}

export interface PickFolderResponse {
  /** Absolute path the user picked, or null on cancel / unsupported. */
  path: string | null;
  cancelled: boolean;
  /** `darwin` | `linux` | `win32` | `unsupported`. */
  platform: string;
}

export const PickFolderResponseSchema: z.ZodType<PickFolderResponse> = z.object({
  path: z.string().nullable(),
  cancelled: z.boolean(),
  platform: z.string(),
});

// ---------- /api/sessions ----------

export interface ListSessionsRequest {
  projectId: string;
}

export interface ListSessionsResponse {
  sessions: SessionSummaryWire[];
}

const SessionSummaryWireSchema: z.ZodType<SessionSummaryWire> = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  model: z.string(),
  backend: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
});

export const ListSessionsResponseSchema: z.ZodType<ListSessionsResponse> =
  z.object({
    sessions: z.array(SessionSummaryWireSchema),
  });

export interface CreateSessionRequest {
  projectId: string;
  /** Optional human-readable title. */
  title?: string;
  /** Optional initial model override. */
  model?: string;
}

export interface CreateSessionResponse {
  session: SessionSummaryWire;
}

export const CreateSessionResponseSchema: z.ZodType<CreateSessionResponse> =
  z.object({
    session: SessionSummaryWireSchema,
  });

export interface DeleteSessionResponse {
  ok: true;
}

export const DeleteSessionResponseSchema: z.ZodType<DeleteSessionResponse> =
  z.object({
    ok: z.literal(true),
  });

// ---------- /api/sessions/:id/fork-at-message ----------

// FORK-AT-MESSAGE-SECTION
/**
 * Fork the session at a specific assistant message, replacing that
 * message's text with `editedContent`. The new session inherits the
 * project / model / backend of the parent, copies every earlier
 * message, and appends the edited assistant message in the original
 * position. Subsequent messages from the parent are intentionally NOT
 * copied — the new branch diverges at the edit.
 */
export interface ForkAtMessageRequest {
  messageId: string;
  editedContent: string;
}

export interface ForkAtMessageResponse {
  session: SessionSummaryWire;
  /** Id of the newly inserted edited assistant message inside the branch. */
  editedMessageId: string;
}

export const ForkAtMessageRequestSchema: z.ZodType<ForkAtMessageRequest> =
  z.object({
    messageId: z.string().min(1),
    editedContent: z.string(),
  });

export const ForkAtMessageResponseSchema: z.ZodType<ForkAtMessageResponse> =
  z.object({
    session: z.object({
      id: z.string(),
      projectId: z.string(),
      title: z.string().nullable(),
      summary: z.string().nullable(),
      model: z.string(),
      backend: z.string(),
      createdAt: z.number(),
      updatedAt: z.number(),
      messageCount: z.number(),
    }),
    editedMessageId: z.string(),
  });
// FORK-AT-MESSAGE-SECTION-END

// ---------- /api/sessions/:id/messages ----------

export interface ListMessagesRequest {
  /** Opaque cursor returned by a previous response, or omitted for the first page. */
  cursor?: string;
  /** Page size. Server clamps to a sane max (default 100). */
  limit?: number;
}

export interface ListMessagesResponse {
  messages: WireChatMessage[];
  /** Cursor for the next page, or null when at the start of history. */
  nextCursor: string | null;
}

export const ListMessagesResponseSchema: z.ZodType<ListMessagesResponse> =
  z.object({
    messages: z.array(WireChatMessageSchema),
    nextCursor: z.string().nullable(),
  });

// ---------- /api/search ----------

/**
 * Cross-session message search hit. Mirrors `SearchMessageResult` from
 * `@/sessions/session-manager`, but uses the `projectId` (workspace
 * UUID) surface so the SPA never has to handle absolute filesystem
 * paths directly.
 *
 * - `snippet` carries `<mark>token</mark>` HTML around matched tokens.
 *   FTS5 only emits the literal mark tags we configured — render via
 *   `dangerouslySetInnerHTML` is safe with content escaping at the
 *   server (`m.content` is already TEXT-stored).
 * - `rank` is the BM25 score (smaller = better). Surfaced for clients
 *   that want to render a relative confidence indicator.
 * - `projectId` / `projectLabel` are `null` when the source session's
 *   workspace no longer exists in the registry (rare — the user
 *   removed the project but the chat history survives).
 */
export interface SearchResultWire {
  sessionId: string;
  messageId: string;
  role: string;
  snippet: string;
  rank: number;
  createdAt: number;
  sessionTitle: string | null;
  projectId: string | null;
  projectLabel: string | null;
}

export interface SearchSessionsRequest {
  /** Free-text query. Whitespace and FTS operators are sanitised server-side. */
  q: string;
  /** Restrict to one project's sessions. Omitted → search everywhere. */
  projectId?: string;
  /** Max results per page. Server clamps to [1, 100]; default 20. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
}

export interface SearchSessionsResponse {
  /** Hits, ranked by BM25 (best first). */
  results: SearchResultWire[];
  /** Total estimated number of hits for the same query/filter. */
  total: number;
  /** Echo of the original query, for debugging. */
  query: string;
}

const SearchResultWireSchema: z.ZodType<SearchResultWire> = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  role: z.string(),
  snippet: z.string(),
  rank: z.number(),
  createdAt: z.number(),
  sessionTitle: z.string().nullable(),
  projectId: z.string().nullable(),
  projectLabel: z.string().nullable(),
});

export const SearchSessionsResponseSchema: z.ZodType<SearchSessionsResponse> =
  z.object({
    results: z.array(SearchResultWireSchema),
    total: z.number(),
    query: z.string(),
  });

// ---------- /api/files/tree ----------

export interface FileTreeRequest {
  projectId: string;
  /** Path relative to the project root. Empty / "." means the root itself. */
  path?: string;
  /**
   * Subdirectory under the project root to list. Alias for `path` — both
   * are accepted server-side so older callers (and tests) keep working
   * while the new file-browser standardises on `subpath`.
   */
  subpath?: string;
  /**
   * Listing depth. `0` returns only the directory metadata (no
   * entries) — useful as a cheap existence check. `1` (default) returns
   * the immediate children, sorted dirs-first.
   */
  depth?: 0 | 1;
  /**
   * When true, dotfiles AND build directories (`node_modules`, `.git`,
   * `dist`, …) are included so the SPA's "show hidden" toggle can
   * reveal them in a collapsed state.
   */
  showHidden?: boolean;
}

export interface FileTreeEntry {
  name: string;
  /** Path relative to the project root. */
  path: string;
  kind: 'file' | 'dir';
  /** Bytes — only present for files. */
  size?: number;
  /** Epoch ms — last modified. */
  mtime?: number;
}

export interface FileTreeResponse {
  /** Directory the listing was taken from, relative to the project root. */
  path: string;
  entries: FileTreeEntry[];
}

const FileTreeEntrySchema: z.ZodType<FileTreeEntry> = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().optional(),
  mtime: z.number().optional(),
});

export const FileTreeResponseSchema: z.ZodType<FileTreeResponse> = z.object({
  path: z.string(),
  entries: z.array(FileTreeEntrySchema),
});

// ---------- /api/files/read ----------

export interface FileReadRequest {
  projectId: string;
  /** Path relative to the project root. Resolved under the workspace only. */
  path: string;
}

export type FileReadEncoding = 'utf-8' | 'image' | 'binary';

export interface FileReadResponse {
  path: string;
  /**
   * For `encoding='utf-8'` → the file's text content.
   * For `encoding='image'` → base64-encoded bytes (suitable for an
   * `<img src="data:…;base64,…">` element).
   * For `encoding='binary'` → empty string; the SPA shows a placeholder.
   * Non-image binary files are rejected with HTTP 415 instead of
   * returning here, but the field is still typed to admit a future
   * permissive variant.
   */
  content: string;
  size: number;
  mtime: number;
  /** Hint for the client. `utf-8` keeps the legacy text behaviour. */
  encoding?: FileReadEncoding;
  /** MIME type — only populated for `encoding='image'`. */
  mimeType?: string;
}

export const FileReadResponseSchema: z.ZodType<FileReadResponse> = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number(),
  mtime: z.number(),
  encoding: z.enum(['utf-8', 'image', 'binary']).optional(),
  mimeType: z.string().optional(),
});

// ---------- /api/config ----------

/**
 * Mirror of `AppConfig` from the domain layer. Re-exported as the
 * config-GET response so callers don't have to know it's the same shape.
 */
export type GetConfigResponse = AppConfig;

/**
 * Schema for `AppConfig`. Hand-rolled rather than auto-derived to keep
 * the wire validation independent of any internal type tweaks. Loose by
 * design — the SPA only renders fields it understands and ignores the
 * rest, so we use `passthrough` semantics via `z.object(...)`.
 */
export const GetConfigResponseSchema: z.ZodType<GetConfigResponse> = z.object({
  backend: z.object({
    type: z.enum([
      'ollama',
      'lmstudio',
      'openai',
      'anthropic',
      'openrouter',
      'google',
      'custom',
    ]),
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    customHeaders: z.record(z.string()).optional(),
  }),
  model: z.object({
    current: z.string(),
    available: z.array(z.string()),
  }),
  onboarding: z.object({ completed: z.boolean() }),
  permissions: z.object({
    autoApprove: z.array(
      z.enum([
        'read_file',
        'write_file',
        'run_command',
        'list_dir',
        'glob_search',
      ]),
    ),
    profile: z.enum([
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ]),
  }),
  context: z.object({
    maxTokens: z.number(),
    keepAliveSeconds: z.number(),
    responseTimeoutSeconds: z.number(),
    trimToolResultsAfter: z.number(),
    autoCompressPercent: z.number(),
    maxRecentMessages: z.number(),
  }),
  sound: z.object({
    enabled: z.boolean(),
    onCompletion: z.boolean(),
    onApproval: z.boolean(),
    onError: z.boolean(),
    volume: z.number(),
    completionFile: z.string().nullable(),
    approvalFile: z.string().nullable(),
    errorFile: z.string().nullable(),
  }),
  generation: z.object({
    temperature: z.number(),
    topP: z.number(),
    repeatPenalty: z.number(),
    maxTokens: z.number(),
  }),
  outputStyle: z.enum(['concise', 'explanatory', 'verbose']),
});

// ---------- /api/config/model ----------

export interface SetModelRequest {
  model: string;
}

export interface SetModelResponse {
  /** New active model after the switch. */
  model: string;
}

export const SetModelResponseSchema: z.ZodType<SetModelResponse> = z.object({
  model: z.string(),
});

// ---------- /api/config/provider ----------

export interface SetProviderRequest {
  type: Backend;
  baseUrl?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
}

export interface SetProviderResponse {
  ok: true;
  backend: Backend;
  baseUrl: string;
  models: readonly string[];
  currentModel: string;
}

export const SetProviderResponseSchema: z.ZodType<SetProviderResponse> =
  z.object({
    ok: z.literal(true),
    backend: BackendSchema,
    baseUrl: z.string(),
    models: z.array(z.string()).readonly(),
    currentModel: z.string(),
  });

// ---------- /api/config/providers ----------

/**
 * Per-provider config snapshot. Returned by `GET /api/config/providers`.
 * For the active provider, `baseUrl` and `hasApiKey` reflect what's
 * persisted in `~/.localcode/config.toml`; for the others, only the
 * default `baseUrl` is reported and `hasApiKey` is always `false`
 * (the SPA prefills the URL but the user can override before saving).
 *
 * Audit M4 — the literal API key is NEVER returned over the wire. The
 * server reports only its presence (`hasApiKey: true|false`). The SPA
 * keeps the input field for SETTING a new key (POST /api/config/provider
 * accepts `apiKey`); it cannot READ the existing one.
 */
export interface PerProviderEntry {
  /** Always populated — defaults if no persisted value. */
  baseUrl: string;
  /**
   * Whether an API key is persisted for this backend. The literal
   * value is intentionally NOT exposed (audit M4). To rotate, the user
   * POSTs a new `apiKey` to `/api/config/provider`.
   */
  hasApiKey: boolean;
  /** Custom request headers if any were persisted. */
  customHeaders?: Record<string, string>;
}

export interface PerProviderConfig {
  /** The currently active backend `type`. */
  current: Backend;
  /** Saved (or defaulted) per-provider config, keyed by backend type. */
  byType: Record<Backend, PerProviderEntry>;
}

export type ListProvidersConfigResponse = PerProviderConfig;

const PerProviderEntrySchema: z.ZodType<PerProviderEntry> = z.object({
  baseUrl: z.string(),
  hasApiKey: z.boolean(),
  customHeaders: z.record(z.string()).optional(),
});

export const ListProvidersConfigResponseSchema: z.ZodType<ListProvidersConfigResponse> =
  z.object({
    current: BackendSchema,
    byType: z.object({
      ollama: PerProviderEntrySchema,
      lmstudio: PerProviderEntrySchema,
      openai: PerProviderEntrySchema,
      anthropic: PerProviderEntrySchema,
      openrouter: PerProviderEntrySchema,
      google: PerProviderEntrySchema,
      custom: PerProviderEntrySchema,
    }),
  });

// ---------- /api/config/output-style ----------

/**
 * Switch the active output style. Server validates the value against
 * `OutputStyleSchema` before persisting. Mirrors the SetProfile shape.
 */
export type OutputStyleWire = 'concise' | 'explanatory' | 'verbose';

export interface SetOutputStyleRequest {
  outputStyle: OutputStyleWire;
}

export interface SetOutputStyleResponse {
  ok: true;
  outputStyle: OutputStyleWire;
}

export const SetOutputStyleRequestSchema: z.ZodType<SetOutputStyleRequest> =
  z.object({
    outputStyle: z.enum(['concise', 'explanatory', 'verbose']),
  });

export const SetOutputStyleResponseSchema: z.ZodType<SetOutputStyleResponse> =
  z.object({
    ok: z.literal(true),
    outputStyle: z.enum(['concise', 'explanatory', 'verbose']),
  });

// ---------- /api/config/profile ----------

/**
 * Switch the active permission profile. The full enum
 * (`default | acceptEdits | plan | dontAsk | bypassPermissions`) is
 * validated server-side via `PermissionProfileSchema`.
 */
export interface SetProfileRequest {
  profile: PermissionProfile;
}

export interface SetProfileResponse {
  ok: true;
  profile: PermissionProfile;
}

export const SetProfileResponseSchema: z.ZodType<SetProfileResponse> =
  z.object({
    ok: z.literal(true),
    profile: z.enum([
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ]),
  });

// ---------- /api/config/generation ----------

export interface SetGenerationRequest {
  temperature: number;
  topP: number;
  repeatPenalty: number;
  maxTokens: number;
}

export interface SetGenerationResponse {
  ok: true;
  generation: SetGenerationRequest;
}

export const SetGenerationResponseSchema: z.ZodType<SetGenerationResponse> =
  z.object({
    ok: z.literal(true),
    generation: z.object({
      temperature: z.number(),
      topP: z.number(),
      repeatPenalty: z.number(),
      maxTokens: z.number(),
    }),
  });

// ---------- /api/config/agents ----------

/**
 * Per-slot worker configuration. The frontend presents one row per
 * entry; persistence round-trips through `cfg.agents.workerSlots`.
 */
export interface AgentsWorkerSlotWire {
  model: string;
  skills?: string[];
  isolationOverride?: 'worktree' | 'shared';
  timeoutSec?: number;
}

/**
 * Snapshot of `cfg.agents` exposed to the SPA's settings overlay.
 * `leadModel` is `null` when the user wants to track the active model
 * (no override persisted on disk).
 */
export interface AgentsConfigSnapshot {
  leadModel: string | null;
  workerSlots: AgentsWorkerSlotWire[];
  isolation: 'worktree' | 'shared';
  maxConcurrent: number;
  approval: 'auto' | 'per-action';
  defaultTimeoutSec: number;
}

export interface GetAgentsConfigResponse {
  current: AgentsConfigSnapshot;
  /** Mirror of `cfg.model.available` so the picker has a populated list. */
  availableModels: string[];
}

const AgentsWorkerSlotSchemaWire: z.ZodType<AgentsWorkerSlotWire> = z.object({
  model: z.string().min(1),
  skills: z.array(z.string()).optional(),
  isolationOverride: z.enum(['worktree', 'shared']).optional(),
  timeoutSec: z.number().int().positive().optional(),
});

const AgentsConfigSnapshotSchema: z.ZodType<AgentsConfigSnapshot> = z.object({
  leadModel: z.string().nullable(),
  workerSlots: z.array(AgentsWorkerSlotSchemaWire).max(8),
  isolation: z.enum(['worktree', 'shared']),
  maxConcurrent: z.number().int().min(1).max(8),
  approval: z.enum(['auto', 'per-action']),
  defaultTimeoutSec: z.number().int().min(30).max(7200),
});

export const GetAgentsConfigResponseSchema: z.ZodType<GetAgentsConfigResponse> =
  z.object({
    current: AgentsConfigSnapshotSchema,
    availableModels: z.array(z.string()),
  });

export type SetAgentsConfigRequest = AgentsConfigSnapshot;
export const SetAgentsConfigRequestSchema = AgentsConfigSnapshotSchema;

export interface SetAgentsConfigResponse {
  ok: true;
  current: AgentsConfigSnapshot;
}

export const SetAgentsConfigResponseSchema: z.ZodType<SetAgentsConfigResponse> =
  z.object({
    ok: z.literal(true),
    current: AgentsConfigSnapshotSchema,
  });

// ---------- /api/models/refresh ----------

/**
 * Optional query for `GET /api/models/refresh`. When `provider` is
 * omitted the server refreshes the currently active backend.
 */
export interface RefreshModelsRequest {
  provider?: Backend;
}

export interface RefreshModelsResponse {
  models: readonly string[];
  currentModel: string;
  backend: Backend;
}

export const RefreshModelsResponseSchema: z.ZodType<RefreshModelsResponse> =
  z.object({
    models: z.array(z.string()).readonly(),
    currentModel: z.string(),
    backend: BackendSchema,
  });

// ---------- /api/commands ----------

export interface CommandSummary {
  name: string;
  description: string;
  usage?: string;
}

export interface ListCommandsResponse {
  commands: CommandSummary[];
}

const CommandSummarySchema: z.ZodType<CommandSummary> = z.object({
  name: z.string(),
  description: z.string(),
  usage: z.string().optional(),
});

export const ListCommandsResponseSchema: z.ZodType<ListCommandsResponse> =
  z.object({
    commands: z.array(CommandSummarySchema),
  });

// ---------- /api/skills ----------

export type SkillScope = 'project' | 'global';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: SkillScope;
  active: boolean;
}

export interface ListSkillsResponse {
  skills: SkillSummary[];
}

const SkillSummarySchema: z.ZodType<SkillSummary> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(['project', 'global']),
  active: z.boolean(),
});

export const ListSkillsResponseSchema: z.ZodType<ListSkillsResponse> = z.object(
  {
    skills: z.array(SkillSummarySchema),
  },
);

export interface ToggleSkillRequest {
  active: boolean;
}

export interface ToggleSkillResponse {
  ok: true;
}

export const ToggleSkillResponseSchema: z.ZodType<ToggleSkillResponse> =
  z.object({
    ok: z.literal(true),
  });

export interface AddSkillRequest {
  id: string;
  title: string;
  description?: string;
  body: string;
  scope: SkillScope;
}

export interface AddSkillResponse {
  skill: SkillSummary;
}

export const AddSkillResponseSchema: z.ZodType<AddSkillResponse> = z.object({
  skill: SkillSummarySchema,
});

export interface DeleteSkillResponse {
  ok: true;
}

export const DeleteSkillResponseSchema: z.ZodType<DeleteSkillResponse> =
  z.object({
    ok: z.literal(true),
  });

// ---------- /api/memory ----------

export interface MemoryEntryWire {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  body: string;
}

export interface ListMemoryResponse {
  entries: MemoryEntryWire[];
  index: string;
}

export interface WriteMemoryRequest {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  body: string;
}

export interface WriteMemoryResponse {
  entry: MemoryEntryWire;
}

export interface DeleteMemoryResponse {
  ok: true;
}

// ---------- /api/plugins ----------

export type PluginStatus = 'loaded' | 'failed' | 'disabled';

export interface PluginSummary {
  id: string;
  name: string;
  status: PluginStatus;
  source: SkillScope;
  toolCount: number;
  version?: string;
  description?: string;
}

export interface ListPluginsResponse {
  plugins: PluginSummary[];
}

const PluginSummarySchema: z.ZodType<PluginSummary> = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['loaded', 'failed', 'disabled']),
  source: z.enum(['project', 'global']),
  toolCount: z.number(),
  version: z.string().optional(),
  description: z.string().optional(),
});

export const ListPluginsResponseSchema: z.ZodType<ListPluginsResponse> =
  z.object({
    plugins: z.array(PluginSummarySchema),
  });

// ---------- /api/usage ----------

/**
 * Wire shape mirror of `UsageStats` from `SessionManager`. Kept as a
 * structurally-equivalent interface (rather than re-exporting the
 * runtime type) so the protocol module stays free of `bun:sqlite`
 * imports and the SPA can consume it directly.
 */
export interface UsagePerModelWire {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  turns: number;
}

export interface UsagePerDayWire {
  date: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export interface UsageTopSessionWire {
  sessionId: string;
  title: string | null;
  tokens: number;
  cost: number;
  lastUsedAt: number;
}

export interface UsageStatsWire {
  totalTokensIn: number;
  totalTokensOut: number;
  totalCachedTokens: number;
  totalDurationMs: number;
  totalCostUsd: number;
  sessionCount: number;
  turnCount: number;
  perModel: UsagePerModelWire[];
  perDay: UsagePerDayWire[];
  topSessions: UsageTopSessionWire[];
}

const UsagePerModelWireSchema: z.ZodType<UsagePerModelWire> = z.object({
  model: z.string(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  cost: z.number(),
  turns: z.number(),
});

const UsagePerDayWireSchema: z.ZodType<UsagePerDayWire> = z.object({
  date: z.string(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  cost: z.number(),
});

const UsageTopSessionWireSchema: z.ZodType<UsageTopSessionWire> = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  tokens: z.number(),
  cost: z.number(),
  lastUsedAt: z.number(),
});

export const UsageStatsWireSchema: z.ZodType<UsageStatsWire> = z.object({
  totalTokensIn: z.number(),
  totalTokensOut: z.number(),
  totalCachedTokens: z.number(),
  totalDurationMs: z.number(),
  totalCostUsd: z.number(),
  sessionCount: z.number(),
  turnCount: z.number(),
  perModel: z.array(UsagePerModelWireSchema),
  perDay: z.array(UsagePerDayWireSchema),
  topSessions: z.array(UsageTopSessionWireSchema),
});

/** Query for `GET /api/usage`. All fields optional; the server defaults to last-30-days, all projects, all models. */
export interface GetUsageRequest {
  projectId?: string;
  sinceMs?: number;
  modelFilter?: string;
}

export type GetUsageResponse = UsageStatsWire;

export const GetUsageResponseSchema = UsageStatsWireSchema;

// ---------- Generic error envelope ----------

export interface ApiErrorBody {
  error: string;
  /** Optional machine-readable code. */
  code?: string;
  /** Optional details — depends on the endpoint. */
  details?: unknown;
}

export const ApiErrorBodySchema: z.ZodType<ApiErrorBody> = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});
