/**
 * Tools barrel — re-exports every tool and builds the handler map consumed
 * by the LLM tool-executor (Agent 2).
 *
 * Handler shape (matches what Agent 2's `ToolExecutor` expects):
 *   {
 *     preview: (args, ctx) => ToolResult  // always runs; may set requiresApproval
 *     commit?: (args, ctx) => ToolResult  // present for destructive tools
 *   }
 *
 * Read-only tools (`read_file`, `list_dir`, `glob_search`) only define
 * `preview` — the preview itself does the work.
 * Mutating tools (`write_file`, `run_command`) define both:
 *   - `preview` computes the diff / describes the action and flags
 *     `requiresApproval: true`,
 *   - `commit` actually performs the action after approval.
 */

import type { ToolContext, ToolResult } from './types';

import { readFile } from './read-file';
import { commitWrite, writeFile } from './write-file';
import { executeCommand, previewCommand } from './run-command';
import { listDir } from './list-dir';
import { globSearch } from './glob-search';
import { commitEdit, editFile } from './edit-file';
import { commitMultiEdit, multiEdit } from './multi-edit';
import { fetchImage } from './fetch-image';
import { lintFile } from './lint-file';
import { findSymbol } from './find-symbol';
import {
  spawnAgent,
  agentStatus,
  awaitAgent,
  teamSend,
  teamRead,
  type AgentToolContext,
} from './agent';
import { webFetch } from './web-fetch';
import { webSearch } from './web-search';
import { todoWrite } from './todo-write';
import { gitStatus, type GitToolContext } from './git-status';
import { gitLog } from './git-log';
import { gitBranch } from './git-branch';
import { gitDiff } from './git-diff';
import { commitGitCommit, previewGitCommit } from './git-commit';
import { readNotebook } from './notebook-read';
import { commitEditNotebook, editNotebook } from './notebook-edit';
import { monitorTask } from './monitor';
import { scheduleWakeup } from './schedule-wakeup';
import { readPdf } from './pdf-read';
// ONTOLOGY-TOOL-SECTION — `find_call_sites`, `impacts_of`, `type_hierarchy`.
// Coordinate edits here with `src/llm/tools-schema.ts` and the matching
// entries in `KNOWN_TOOL_NAMES` (see `src/types/message.ts`).
import { findCallSitesTool } from './find-call-sites';
import { impactsOfTool } from './impacts-of';
import { typeHierarchyTool } from './type-hierarchy';
// ONTOLOGY-TOOL-SECTION-END
// PROCESS-STATUS-TOOL-SECTION — `process_status` read-only inspection tool.
// Mirror updates in `src/llm/tools-schema.ts` and `src/types/message.ts`
// (`KNOWN_TOOL_NAMES`).
import { processStatus, type ProcessStatusContext } from './process-status';
// PROCESS-STATUS-TOOL-SECTION-END
import { createBrowserSession } from '@/browser/session';
import type { BrowserSession } from '@/browser/types';
import { createBrowserToolHandlers } from '@/browser/tools';

export type { ToolContext, ToolResult } from './types';
export type {
  ReadFileArgs,
  WriteFileArgs,
  RunCommandArgs,
  ListDirArgs,
  GlobSearchArgs,
  EditFileArgs,
  FetchImageArgs,
  LintFileArgs,
  LintDiagnostic,
  FindSymbolArgs,
} from './types';

export { readFile, ReadFileArgsSchema } from './read-file';
export { writeFile, commitWrite, WriteFileArgsSchema } from './write-file';
export {
  previewCommand,
  executeCommand,
  RunCommandArgsSchema,
} from './run-command';
export { listDir, ListDirArgsSchema } from './list-dir';
export { globSearch, GlobSearchArgsSchema } from './glob-search';
export { editFile, commitEdit, EditFileArgsSchema } from './edit-file';
export {
  multiEdit,
  commitMultiEdit,
  MultiEditArgsSchema,
  MultiEditOperationSchema,
} from './multi-edit';
export type { MultiEditArgs, MultiEditOperation } from './multi-edit';
export { fetchImage, FetchImageArgsSchema } from './fetch-image';
export { lintFile, LintFileArgsSchema } from './lint-file';
export {
  findSymbol,
  FindSymbolArgsSchema,
  FIND_SYMBOL_KINDS,
} from './find-symbol';
export {
  spawnAgent,
  agentStatus,
  awaitAgent,
  teamSend,
  teamRead,
  SpawnAgentArgsSchema,
  AgentStatusArgsSchema,
  AwaitAgentArgsSchema,
  TeamSendArgsSchema,
  TeamReadArgsSchema,
} from './agent';
export type { AgentToolContext } from './agent';
export { webFetch, WebFetchArgsSchema } from './web-fetch';
export { webSearch, WebSearchArgsSchema } from './web-search';
export { todoWrite, TodoWriteArgsSchema } from './todo-write';
export type { TodoItem, TodoWriteArgs } from './todo-write';
export type { WebFetchArgs, WebFetchEnvelope } from './web-fetch';
export type { WebSearchArgs, WebSearchEnvelope, WebSearchHit } from './web-search';
export {
  gitStatus,
  GitStatusArgsSchema,
  isGitRepo,
  runGit,
} from './git-status';
export type {
  GitStatusArgs,
  GitStatusEnvelope,
  GitToolContext,
  SpawnFn,
  SpawnedProc,
} from './git-status';
export { gitLog, GitLogArgsSchema } from './git-log';
export type { GitLogArgs, GitLogEntry } from './git-log';
export { gitBranch, GitBranchArgsSchema } from './git-branch';
export type { GitBranchArgs, GitBranchEnvelope } from './git-branch';
export { gitDiff, GitDiffArgsSchema } from './git-diff';
export type { GitDiffArgs, GitDiffEnvelope } from './git-diff';
export {
  previewGitCommit,
  commitGitCommit,
  GitCommitArgsSchema,
} from './git-commit';
export type { GitCommitArgs } from './git-commit';
export { readNotebook, ReadNotebookArgsSchema } from './notebook-read';
export type { ReadNotebookArgs } from './notebook-read';
export {
  editNotebook,
  commitEditNotebook,
  EditNotebookArgsSchema,
} from './notebook-edit';
export type { EditNotebookArgs } from './notebook-edit';
export { monitorTask, MonitorArgsSchema } from './monitor';
export type { MonitorArgs, MonitorContext } from './monitor';
export { scheduleWakeup, ScheduleWakeupArgsSchema } from './schedule-wakeup';
export type { ScheduleWakeupArgs } from './schedule-wakeup';
export { readPdf, ReadPdfArgsSchema } from './pdf-read';
export type { ReadPdfArgs, ReadPdfEnvelope, ReadPdfPage } from './pdf-read';
// ONTOLOGY-TOOL-SECTION
export {
  findCallSitesTool,
  FindCallSitesArgsSchema,
  narrowOntologyContext,
} from './find-call-sites';
export type { FindCallSitesArgs, OntologyIndexerLike } from './find-call-sites';
export { impactsOfTool, ImpactsOfArgsSchema } from './impacts-of';
export type { ImpactsOfArgs } from './impacts-of';
export { typeHierarchyTool, TypeHierarchyArgsSchema } from './type-hierarchy';
export type { TypeHierarchyArgs } from './type-hierarchy';
// ONTOLOGY-TOOL-SECTION-END
// PROCESS-STATUS-TOOL-SECTION
export { processStatus, ProcessStatusArgsSchema } from './process-status';
export type { ProcessStatusArgs, ProcessStatusContext } from './process-status';
// PROCESS-STATUS-TOOL-SECTION-END
export {
  BackgroundTaskRegistry,
  getProcessBackgroundTaskRegistry,
  setProcessBackgroundTaskRegistry,
} from './background-tasks';
export type {
  BackgroundTaskSnapshot,
  BackgroundTaskStatus,
} from './background-tasks';

/** A single tool handler. `commit` is set only for destructive tools. */
export interface ToolHandler {
  preview: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
  commit?: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * Marks the handler as a pure read of project state — no filesystem
   * mutations, no shell execution, no network side-effects whose result
   * is order-dependent. The tool-executor uses this to fire the call
   * speculatively in parallel with mutating tools that are waiting on
   * the UI approval prompt, shaving 100–300ms per turn when the model
   * batches reads with a write. When omitted, the tool is treated as
   * non-speculative (the conservative default).
   */
  readOnly?: boolean;
}

/** Registry keyed by tool name (matches `TOOLS_SCHEMA` function names). */
export type ToolHandlerMap = Record<string, ToolHandler>;

/**
 * Lazily-constructed shared `BrowserSession` for the eight `browser_*`
 * tools. We only ever spin up one Chromium per process — `createBrowserSession`
 * itself does NOT launch the browser, so this is cheap.
 */
let sharedBrowserSession: BrowserSession | null = null;
function getBrowserSession(): BrowserSession {
  if (sharedBrowserSession === null) {
    sharedBrowserSession = createBrowserSession();
  }
  return sharedBrowserSession;
}

/**
 * Test/teardown hook — release the shared browser session. Called by
 * tests; production callers go through `app.tsx`'s lifecycle.
 */
export async function disposeSharedBrowserSession(): Promise<void> {
  const s = sharedBrowserSession;
  sharedBrowserSession = null;
  if (s !== null) await s.close();
}

/** Accessor used by app.tsx / the web runtime to subscribe to events. */
export function getSharedBrowserSession(): BrowserSession {
  return getBrowserSession();
}

/**
 * Builds the handler map for a given context. Each handler receives `args`
 * as `unknown` and delegates validation to the per-tool Zod schema inside
 * its implementation.
 */
export function createToolHandlerMap(ctx: ToolContext): ToolHandlerMap {
  return {
    read_file: {
      preview: (args) => readFile(args as Parameters<typeof readFile>[0], ctx),
      readOnly: true,
    },
    list_dir: {
      preview: (args) => listDir(args as Parameters<typeof listDir>[0], ctx),
      readOnly: true,
    },
    glob_search: {
      preview: (args) =>
        globSearch(args as Parameters<typeof globSearch>[0], ctx),
      readOnly: true,
    },
    write_file: {
      preview: (args) =>
        writeFile(args as Parameters<typeof writeFile>[0], ctx),
      commit: (args) =>
        commitWrite(args as Parameters<typeof commitWrite>[0], ctx),
    },
    edit_file: {
      preview: (args) =>
        editFile(args as Parameters<typeof editFile>[0], ctx),
      commit: (args) =>
        commitEdit(args as Parameters<typeof commitEdit>[0], ctx),
    },
    multi_edit: {
      preview: (args) =>
        multiEdit(args as Parameters<typeof multiEdit>[0], ctx),
      commit: (args) =>
        commitMultiEdit(args as Parameters<typeof commitMultiEdit>[0], ctx),
    },
    run_command: {
      preview: (args) =>
        previewCommand(args as Parameters<typeof previewCommand>[0], ctx),
      commit: (args) =>
        executeCommand(args as Parameters<typeof executeCommand>[0], ctx),
    },
    fetch_image: {
      preview: (args) =>
        fetchImage(args as Parameters<typeof fetchImage>[0], ctx),
      readOnly: true,
    },
    lint_file: {
      preview: (args) => lintFile(args as Parameters<typeof lintFile>[0], ctx),
      readOnly: true,
    },
    // `find_symbol` is read-only — no commit step, no approval required.
    // Agent F registers the matching schema entry in `src/llm/tools-schema.ts`.
    find_symbol: {
      preview: (args) =>
        findSymbol(args as Parameters<typeof findSymbol>[0], ctx),
      readOnly: true,
    },
    // Agent-* tools — only effective when the runtime supplied an
    // `AgentOrchestrator` via the augmented context. Otherwise the
    // handlers reply "agents not enabled" which the model surfaces.
    spawn_agent: {
      preview: (args) =>
        spawnAgent(args as Parameters<typeof spawnAgent>[0], ctx as AgentToolContext),
    },
    agent_status: {
      preview: (args) =>
        agentStatus(args as Parameters<typeof agentStatus>[0], ctx as AgentToolContext),
    },
    await_agent: {
      preview: (args) =>
        awaitAgent(args as Parameters<typeof awaitAgent>[0], ctx as AgentToolContext),
    },
    team_send: {
      preview: (args) =>
        teamSend(args as Parameters<typeof teamSend>[0], ctx as AgentToolContext),
    },
    team_read: {
      preview: (args) =>
        teamRead(args as Parameters<typeof teamRead>[0], ctx as AgentToolContext),
    },
    // Read-only web fetcher — auto-approved (no filesystem side effects).
    web_fetch: {
      preview: (args) =>
        webFetch(args as Parameters<typeof webFetch>[0], ctx),
    },
    // Read-only web search — auto-approved. Returns top {title,url,snippet}
    // so the model can choose which URL to web_fetch in detail.
    web_search: {
      preview: (args) =>
        webSearch(args as Parameters<typeof webSearch>[0], ctx),
    },
    // todo_write — single-phase, no approval. Replaces the full task list
    // for the active session. Auto-approved; no commit step.
    todo_write: {
      preview: (args) => todoWrite(args, ctx),
    },
    // Read-only git inspection tools — auto-approved.
    git_status: {
      preview: (args) =>
        gitStatus(args as Parameters<typeof gitStatus>[0], ctx as GitToolContext),
    },
    git_log: {
      preview: (args) =>
        gitLog(args as Parameters<typeof gitLog>[0], ctx as GitToolContext),
    },
    git_branch: {
      preview: (args) =>
        gitBranch(args as Parameters<typeof gitBranch>[0], ctx as GitToolContext),
    },
    git_diff: {
      preview: (args) =>
        gitDiff(args as Parameters<typeof gitDiff>[0], ctx as GitToolContext),
    },
    // Two-phase mutating git tool — requires explicit user approval.
    git_commit: {
      preview: (args) =>
        previewGitCommit(args as Parameters<typeof previewGitCommit>[0], ctx as GitToolContext),
      commit: (args) =>
        commitGitCommit(args as Parameters<typeof commitGitCommit>[0], ctx as GitToolContext),
    },
    // Read-only Jupyter notebook reader — auto-approved.
    notebook_read: {
      preview: (args) =>
        readNotebook(args as Parameters<typeof readNotebook>[0], ctx),
    },
    // Two-phase notebook editor — preview returns diff, commit writes file.
    notebook_edit: {
      preview: (args) =>
        editNotebook(args as Parameters<typeof editNotebook>[0], ctx),
      commit: (args) =>
        commitEditNotebook(args as Parameters<typeof commitEditNotebook>[0], ctx),
    },
    // Read-only background-task monitor (auto-approved). The handler
    // resolves the process-wide BackgroundTaskRegistry internally when
    // the context doesn't supply one — both run_command (background
    // mode) and monitor must share the same registry instance.
    monitor: {
      preview: (args) => monitorTask(args, ctx),
    },
    // C2 — schedule_wakeup: model defers its own continuation via the
    // process-wide WakeupRegistry. Single-phase, no approval (the worst
    // case is a future self-prompt the user can cancel via `/wakeups`).
    schedule_wakeup: {
      preview: (args) => scheduleWakeup(args, ctx),
    },
    // PDF reader — single-phase, read-only. No commit step, no approval.
    read_pdf: {
      preview: (args) => readPdf(args, ctx),
    },
    // ONTOLOGY-TOOL-SECTION — ontology queries (read-only, single-phase).
    // Each handler returns `{ success: false, error: 'Ontology not ready' }`
    // when the indexer hasn't surfaced any symbols yet, so the model can
    // fall back to `find_symbol`.
    find_call_sites: {
      preview: (args) => findCallSitesTool(args, ctx),
    },
    impacts_of: {
      preview: (args) => impactsOfTool(args, ctx),
    },
    type_hierarchy: {
      preview: (args) => typeHierarchyTool(args, ctx),
    },
    // ONTOLOGY-TOOL-SECTION-END
    // PROCESS-STATUS-TOOL-SECTION — read-only inspection of `ProcessMonitor`.
    // Single-phase; auto-approved. Resolves the singleton internally when
    // the context does not supply an override (tests typically inject a
    // fresh monitor through the augmented `ProcessStatusContext`).
    process_status: {
      preview: (args) => processStatus(args, ctx as ProcessStatusContext),
    },
    // PROCESS-STATUS-TOOL-SECTION-END
    ...createBrowserToolHandlers(getBrowserSession()),
  };
}
