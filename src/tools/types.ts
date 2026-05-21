/**
 * Tool-specific argument types and shared context for the tools layer.
 *
 * These types narrow the `ToolResult` contract declared in `@/types/global`
 * into per-tool argument shapes. The shared `ToolResult` is re-exported so
 * downstream consumers (the LLM tool-executor, tests) can import everything
 * from a single module.
 */

import type { ToolResult } from '@/types/global';

export type { ToolResult };

/** Execution context shared by every tool handler. */
export interface ToolContext {
  /** Absolute path to the user's project root — all relative paths resolve here. */
  projectRoot: string;
  /**
   * When true, the tool-executor will skip approval prompts for destructive
   * operations (`write_file`, `run_command`). Tools themselves still report
   * `requiresApproval: true` on their preview results — it is the executor's
   * job to honour (or bypass) that flag.
   */
  dangerouslyAllowAll: boolean;
  /**
   * Optional multi-agent orchestrator. When set, agent-* tool handlers
   * (spawn_agent, agent_status, await_agent, team_send, team_read) can
   * reach the lifecycle manager. Typed as `unknown` here to avoid a
   * cyclic import (`@/agents/orchestrator` → `@/tools` chain). The
   * `AgentToolContext` in `src/tools/agent.ts` re-narrows it.
   */
  agents?: unknown;
  /**
   * The lead's session id when agents are enabled. Same value for the
   * lead AND for every worker spawned under it — it keys the team-bus.
   */
  parentSessionId?: string;
  /**
   * Identity of the agent CALLING the tool. `'lead'` for the parent
   * session; `<agentId>` for a worker. Used by spawn_agent for the
   * lead-only access guard and by team_* for sender / recipient scope.
   */
  callerAgentId?: string;

  // TODO-WRITE-SECTION — fields added for the todo_write tool.
  // Do NOT remove this marker comment: it prevents merge conflicts with
  // other agents that extend ToolContext in adjacent sections.

  /**
   * The session id for the currently active chat session. Required by
   * `todo_write` to persist todos to the correct session row.
   */
  sessionId?: string;

  /**
   * Reference to the session manager singleton. Required by `todo_write`
   * to call `getTodos`/`setTodos`. Typed as `unknown` here to avoid a
   * circular import chain; `todo-write.ts` re-narrows it via an
   * interface check at runtime.
   */
  sessionManager?: unknown;

  /**
   * In-session wakeup scheduler. Required by `schedule_wakeup` to defer
   * the model's own continuation. Typed as `unknown` here to avoid an
   * import cycle (`@/scheduling` is consumed exclusively by the tool
   * implementation and the composition root); the handler re-narrows it
   * structurally at runtime. NOT persistent — every wakeup vanishes on
   * process restart.
   */
  wakeupRegistry?: unknown;

  // ONTOLOGY-TOOL-CTX-SECTION — fields added for the ontology tools
  // (`find_call_sites`, `impacts_of`, `type_hierarchy`). Optional so
  // existing call sites that build a ToolContext literal without the
  // indexer keep compiling. Typed as `unknown` here to avoid the
  // `@/tools → @/ontology` import cycle; handlers re-narrow via the
  // `OntologyToolContext` interface in `src/tools/find-call-sites.ts`.
  /**
   * Reference to the process-wide ontology indexer when wired by the
   * host (TUI app.tsx, web/index.ts). Tools read `.current` for the
   * live graph snapshot and `.isIndexing` for status. Absence means
   * the tool returns `{ success: false, error: 'Ontology not ready' }`.
   */
  ontology?: unknown;
  // ONTOLOGY-TOOL-CTX-SECTION-END
}

/** Arguments for `read_file`. */
export interface ReadFileArgs {
  /** Path to read, relative to `ToolContext.projectRoot`. */
  path: string;
  /**
   * Optional 1-based line offset. When set, reading starts at line
   * `offset` (inclusive). Combine with `limit` to fetch a window. The
   * large-file auto-paginate footer suggests the next `offset`.
   */
  offset?: number;
  /**
   * Optional cap on lines returned when `offset` is supplied. Defaults
   * to the file's remaining lines from `offset`, capped at an internal
   * upper bound to keep payloads bounded.
   */
  limit?: number;
  /**
   * When true, return a summary (line count, byte size, first 20 + last
   * 5 lines) instead of the file body. Useful for an instant grep-style
   * overview without dumping the whole file.
   */
  respondWithSummary?: boolean;
}

/** Arguments for `write_file`. */
export interface WriteFileArgs {
  /** Target path, relative to `ToolContext.projectRoot`. */
  path: string;
  /** Complete file contents to write. */
  content: string;
}

/** Arguments for `run_command`. */
export interface RunCommandArgs {
  /** Shell command to execute (run via `sh -c <command>`). */
  command: string;
  /**
   * Optional working directory. Absolute paths are used as-is; relative
   * paths resolve against `ToolContext.projectRoot`. Defaults to
   * `ToolContext.projectRoot` when omitted.
   */
  cwd?: string;
  /**
   * Async mode flag. When true, the executor spawns the command and
   * returns a `taskId` immediately instead of waiting for it to exit.
   * The model is expected to poll status via the `monitor` tool.
   * Approval gating is unchanged.
   */
  runInBackground?: boolean;
}

/** Arguments for `list_dir`. */
export interface ListDirArgs {
  /**
   * Optional subdirectory to list, relative to `ToolContext.projectRoot`.
   * Defaults to the project root.
   */
  path?: string;
}

/** Arguments for `glob_search`. */
export interface GlobSearchArgs {
  /** Glob pattern, e.g. `**\/*.ts` (use double-star + extension). */
  pattern: string;
  /**
   * Optional working directory for the glob operation. Absolute paths are
   * used as-is; relative paths resolve against `ToolContext.projectRoot`.
   */
  cwd?: string;
}

/** Arguments for `edit_file`. */
export interface EditFileArgs {
  /** Target path, relative to `ToolContext.projectRoot`. */
  path: string;
  /**
   * Exact text to find in the file. Must appear exactly once — include
   * surrounding context (whitespace, adjacent lines) to disambiguate.
   */
  find_text: string;
  /** Text that replaces the single match of `find_text`. */
  replace_text: string;
}

/** Arguments for `lint_file`. */
export interface LintFileArgs {
  /**
   * Path to lint, relative to `ToolContext.projectRoot`. Language is
   * detected from the file extension (.ts/.tsx/.js/.jsx/.py/.go/.rs).
   * Any other extension is a no-op and returns a friendly skip message.
   */
  path: string;
}

/**
 * A single diagnostic emitted by a language-native linter. Normalised into
 * this shape by `lint_file` regardless of the underlying tool (tsc, ruff,
 * go vet, rustc, …). Line and column are 1-based.
 */
export interface LintDiagnostic {
  /** 1-based line number of the diagnostic. */
  line: number;
  /** 1-based column number of the diagnostic. */
  column: number;
  /** Severity as reported by the linter. */
  severity: 'error' | 'warning' | 'info';
  /** Human-readable diagnostic message. */
  message: string;
  /**
   * Optional linter-specific code, e.g. `TS2322` for TypeScript or
   * `E0308` for Rust. Absent for linters that don't emit codes.
   */
  code?: string;
}

/**
 * Arguments for `find_symbol` (ROADMAP #11). A regex-based,
 * read-only search for declarations matching `name` across the project.
 *
 * `kind` narrows the search to a specific declaration form. Omit it (or
 * set `'any'`) to search every supported form for the file's language.
 * Unknown languages always fall back to a plain word-boundary match.
 */
export interface FindSymbolArgs {
  /** Symbol name to find. Treated as an identifier; word-boundary anchored. */
  name: string;
  /**
   * Optional declaration kind. Recognised values:
   *   `'function'`, `'class'`, `'interface'`, `'type'`, `'const'`,
   *   `'variable'`, `'any'`. Defaults to `'any'`.
   */
  kind?: 'function' | 'class' | 'interface' | 'type' | 'const' | 'variable' | 'any';
}

/** Arguments for `fetch_image`. */
export interface FetchImageArgs {
  /**
   * Image source — must start with `http://`, `https://`, or a
   * `data:image/<type>;base64,` URI. Relative paths and `file://` are
   * rejected by the Zod schema.
   */
  url: string;
  /**
   * Optional hint describing what the model should look for in the image.
   * Not used by the tool itself; it is passed through so downstream
   * multimodal assembly can include it alongside the image part.
   */
  description?: string;
}
