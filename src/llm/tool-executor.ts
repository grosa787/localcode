/**
 * ToolExecutor — dispatches tool calls from the model to concrete handlers.
 *
 * Contract:
 *   - Constructed with a map of handlers (one per tool name), an optional
 *     approvalCallback, and a `dangerouslyAllowAll` escape hatch.
 *   - For write_file and run_command, approval is *always* required unless
 *     `dangerouslyAllowAll` is true.
 *   - Unknown tools and missing handlers produce a structured ToolResult
 *     rather than a thrown exception — callers should never crash because
 *     the model hallucinated a tool name.
 *
 * R4 additions (FIX #27 — auto-lint post-tool hook):
 *   - `autoLintAfterWrite` (default `true`): after a successful write_file /
 *     edit_file commit on a source file with a lintable extension, the
 *     executor invokes the `lint_file` handler and surfaces a synthetic
 *     tool-message to the caller via `onAutoCheckResult`.
 *   - `setPostCommitHook(fn)`: inject a custom post-commit hook that can
 *     return a synthetic `ToolResult` (or `null` for no-op). The default
 *     hook is the auto-lint behaviour.
 *   - `onAutoCheckResult(msg)`: optional callback receiving the synthetic
 *     `Message` to append to context. The underlying ToolResult returned
 *     to the main `execute()` caller is the ORIGINAL tool result — the
 *     auto-check message is additive, not a replacement.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  Message,
  PermissionProfile,
  ToolCall,
  ToolResult,
} from '@/types/global';
import {
  APPROVAL_REQUIRED_TOOLS,
  KNOWN_TOOL_NAMES,
  type ApprovalCallback,
  // BATCH-APPROVAL-SECTION
  type BatchApprovalCallback,
  type BatchApprovalDecision,
  type BatchApprovalItem,
  // BATCH-APPROVAL-SECTION-END
  type ToolExecutorOptions,
  type ToolExecutorHookBridge,
  type ToolHandlerMap,
  type PostCommitHook,
} from '@/types/message';
// FILE-WATCHER-SECTION
import { getProcessFileChangeTracker } from '@/tools/file-tracker';
import type { FileChangeTracker } from '@/tools/file-tracker';
// FILE-WATCHER-SECTION-END
// ARCH-RULES-SECTION
import type { ArchConfig, ArchViolation } from '@/architecture';
import { loadArchConfig, validateFile } from '@/architecture';
// ARCH-RULES-SECTION-END
// SENSITIVE-FILES-SECTION
import {
  extractToolPaths,
  isSensitivePath,
  loadSensitiveFiles,
  type SensitiveConfig,
} from '@/security/sensitive-files';
// SENSITIVE-FILES-SECTION-END

// APPROVAL-BATCH-SECTION
/**
 * Result returned by the `approvalCallback`. Historically the callback
 * resolved to a plain `boolean`; we keep that shape supported via a
 * narrowing in `resolveApprovalDecision` so existing wiring (tests,
 * web runtime) continues to compile.
 *
 * The richer object form lets the UI signal:
 *   - `approveAllInTurn`  — every subsequent matching tool call this turn
 *                          auto-approves (matches `[A]` button).
 *   - `approveForSession` — for `run_command`, the exact `command` arg
 *                          is added to the session allow-list so future
 *                          identical invocations auto-approve (`[S]`).
 *
 * Both flags imply `approved: true`. They never imply rejection.
 */
export interface ApprovalDecision {
  readonly approved: boolean;
  readonly approveAllInTurn?: boolean;
  readonly approveForSession?: boolean;
}

/**
 * Narrow either the legacy boolean shape or the new {@link ApprovalDecision}
 * shape into a single decision object. Lets `approvalCallback` consumers
 * upgrade incrementally — the tests and web runtime still return `boolean`.
 */
function toApprovalDecision(value: unknown): ApprovalDecision {
  if (typeof value === 'boolean') {
    return { approved: value };
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as { approved?: unknown; approveAllInTurn?: unknown; approveForSession?: unknown };
    if (typeof obj.approved === 'boolean') {
      return {
        approved: obj.approved,
        ...(obj.approveAllInTurn === true ? { approveAllInTurn: true } : {}),
        ...(obj.approveForSession === true ? { approveForSession: true } : {}),
      };
    }
  }
  return { approved: false };
}
// APPROVAL-BATCH-SECTION-END

/**
 * Browser-sandbox tool names registered by `src/browser/tools.ts`.
 * Treated as known names alongside `KNOWN_TOOL_NAMES` from
 * `@/types/message` so the executor doesn't reject them as
 * "Unknown tool". Most are read-only; `browser_evaluate` requires
 * approval because it executes arbitrary JS in the page context (see
 * `APPROVAL_REQUIRED_TOOLS` extension below).
 */
const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_evaluate',
  'browser_console_messages',
  'browser_reload',
]);

/**
 * Extension of `APPROVAL_REQUIRED_TOOLS` for browser-sandbox tools.
 * Defined locally (rather than in `@/types/message`) so the browser
 * module remains a leaf — only the executor needs to know which
 * browser tools are dangerous. `browser_evaluate` runs arbitrary
 * JavaScript inside the page context, which can exfiltrate cookies
 * / localStorage / DOM and trigger cross-origin requests; treat it
 * exactly like `run_command`.
 */
const APPROVAL_REQUIRED_TOOLS_EXTRA: ReadonlySet<string> = new Set([
  'browser_evaluate',
]);

/**
 * Tools the executor may fire speculatively in parallel with the
 * approval prompt of a sibling mutating call. Every entry MUST be a
 * pure read of project state — no filesystem mutations, no shell
 * execution, no network side-effects whose result is order-dependent
 * with the rest of the batch. Mirrors the `readOnly: true` markers on
 * `createToolHandlerMap` in `src/tools/index.ts`.
 *
 * Adding to this catalogue is a contract change — every name added
 * here must have:
 *   1. A `readOnly: true` marker on its handler entry, AND
 *   2. A speculative-safety review (no shared state with other tools
 *      in the same batch, no LLM-observable ordering with mutations).
 *
 * Conservative omissions: `git_status`, `git_log`, `git_branch`,
 * `git_diff`, `web_fetch`, `web_search`, `notebook_read`, `read_pdf`,
 * `monitor`, `process_status`, ontology queries, and MCP tools are
 * effectively read-only at the executor layer but are NOT listed here
 * because they were not part of the original task's marked set. Future
 * passes can extend the catalogue once each name is audited.
 */
const SPECULATIVE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'glob_search',
  'lint_file',
  'find_symbol',
  'fetch_image',
]);

/** Extensions we know how to lint. Keep in sync with `lint-file.ts`. */
const LINTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.rs',
]);

/**
 * Tools whose successful commit triggers the post-commit hook. Only mutating
 * file-writing tools are eligible — shell commands, reads, and list ops do
 * not produce a source file that would benefit from a syntax check.
 */
const POST_COMMIT_HOOK_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  // notebook_edit is two-phase mutating; the post-commit hook (auto-lint)
  // will short-circuit on the `.ipynb` extension because it's not in
  // LINTABLE_EXTENSIONS, but the hook still fires uniformly. Listing it
  // here keeps the post-commit pipeline consistent with multi_edit.
  'notebook_edit',
]);

// FILE-WATCHER-SECTION
/**
 * Tools that consult the FileChangeTracker BEFORE running. If the
 * model has read the target path earlier and the on-disk content has
 * since been modified externally, the executor synthesises a warning
 * message via `onAutoCheckResult` so the model re-reads before
 * proceeding. The actual write/edit still runs — the warning is
 * additive, not a hard block (the model may have an intentional
 * reason to overwrite). Surface, not safety net.
 */
const FILE_WATCH_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
]);
// FILE-WATCHER-SECTION-END

// ARCH-RULES-SECTION
/**
 * Tools that participate in the architecture-rule PreToolUse check.
 * Each produces (or would produce) a TypeScript/JavaScript source
 * file whose imports we can statically analyse.
 */
const ARCH_CHECKED_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
]);

/** Extensions whose import surface arch-rules covers. */
const ARCH_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
]);
// ARCH-RULES-SECTION-END

/**
 * Tools that the permission profile classifies as "edit" — file
 * mutations that produce a diff. `acceptEdits` bypasses approval for
 * these. `edit_file` is intentionally NOT in `APPROVAL_REQUIRED_TOOLS`
 * (it uses the two-phase preview/commit flow where the approval is
 * implicit in the diff confirmation), so the executor only needs to
 * recognise it here for the `acceptEdits` short-circuit and for the
 * `plan` block.
 */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  // notebook_edit shares the same two-phase preview/commit flow as
  // edit_file — its diff IS the approval surface. Listed here so
  // `acceptEdits`/`plan` treat it as an edit-class mutator.
  'notebook_edit',
]);

// PLAN-MODE-BLOCK-SECTION
/**
 * Plan-mode reject message. Surfaced as the `error` field (NOT `output`)
 * so the model treats it as instruction rather than tool output. Same
 * wording is used for all blocked tools so the model can reliably
 * pattern-match.
 *
 * The block decision itself lives in `resolveApprovalPolicy` (rule 2)
 * and the short-circuit point is `execute()` — both are wrapped in
 * PLAN-MODE-BLOCK-SECTION markers below so parallel agents touching
 * this file know where the plan-mode pipeline lives.
 */
const PLAN_MODE_BLOCK_ERROR =
  'Plan mode active — summarize your plan and exit Plan Mode (/profile default) to execute.';
// PLAN-MODE-BLOCK-SECTION-END

/**
 * Approval-policy decision for a single tool call. Drives the `execute`
 * dispatcher's gating logic BEFORE any preview / hook / approval IO.
 */
type ApprovalPolicy = 'block' | 'auto' | 'prompt';

export class ToolExecutor {
  private readonly handlers: ToolHandlerMap;
  private readonly approvalCallback: ApprovalCallback | undefined;
  private readonly dangerouslyAllowAll: boolean;
  private readonly autoApproveTools: ReadonlySet<string>;
  private readonly autoLintAfterWrite: boolean;
  private readonly onAutoCheckResult:
    | ((syntheticMsg: Message) => void)
    | undefined;
  private postCommitHook: PostCommitHook;
  private hookBridge: ToolExecutorHookBridge | undefined;
  private onHookEvent: ((syntheticMsg: Message) => void) | undefined;
  private readonly projectRoot: string;
  private sessionId: string | undefined;
  // APPROVAL-BATCH-SECTION
  /**
   * Tools the user batch-approved for the current turn via the `[A]`
   * button in `<ApprovalPrompt>`. Reset by `resetTurnAutoApprove()`
   * which the runtime calls on every new user message. The set is
   * mutable so the in-flight approval callback can extend it without
   * rebuilding the executor.
   */
  private turnAutoApprove: Set<string> = new Set();
  /**
   * Session-scoped allow-list of exact `run_command` command strings
   * approved via the `[S]` button. Survives multiple turns within the
   * same process but is NOT persisted to disk — restarting LocalCode
   * drops it. Future identical `run_command` invocations auto-approve.
   */
  private autoApproveCommands: Set<string> = new Set();
  /**
   * Snapshot hook invoked just before a successful `write_file` /
   * `edit_file` / `multi_edit` commit. Lets the composition root push
   * a pre-mutation snapshot onto the `FileSnapshotStack` so `/undo`
   * can roll back. Optional — when undefined, no snapshot is taken.
   */
  private snapshotHook:
    | ((toolName: string, args: Record<string, unknown>) => Promise<void> | void)
    | undefined;
  // APPROVAL-BATCH-SECTION-END
  // FILE-WATCHER-SECTION
  /**
   * Process-wide file-change tracker. Resolved lazily so tests can
   * inject a fresh instance via {@link setFileChangeTracker}. Default
   * is the singleton from `getProcessFileChangeTracker()`.
   */
  private fileTracker: FileChangeTracker;
  // FILE-WATCHER-SECTION-END
  // ARCH-RULES-SECTION
  /**
   * Cached architecture-rule config. Loaded lazily from
   * `<projectRoot>/.localcode/arch.toml`. `undefined` until first read;
   * `null` when the file is absent or fails to parse (the failure is
   * surfaced once via console.warn and then suppressed — we don't want
   * a broken arch.toml to make every tool call noisy).
   *
   * Tests inject a config directly via {@link setArchConfig}. Resetting
   * by writing the cache to `undefined` re-triggers the disk read on
   * the next invocation.
   */
  private archConfig: ArchConfig | null | undefined = undefined;
  // ARCH-RULES-SECTION-END
  // SENSITIVE-FILES-SECTION
  /**
   * Cached sensitive-files config. Loaded lazily from
   * `~/.localcode/sensitive-files.toml` + `<projectRoot>/.localcode/sensitive-files.toml`
   * with the built-in defaults catalog always merged in.
   *
   * `undefined` means "load on next access"; a concrete `SensitiveConfig`
   * means "already loaded". The loader never returns null — defaults
   * always populate at least a baseline. Tests inject pre-built configs
   * via {@link setSensitiveConfig}.
   */
  private sensitiveConfig: SensitiveConfig | undefined = undefined;
  // SENSITIVE-FILES-SECTION-END
  /**
   * Active permission profile. Layered on top of `autoApproveTools` /
   * `dangerouslyAllowAll`. See `resolveApprovalPolicy` for the
   * precedence rules. Default `'default'` keeps the legacy behaviour
   * (read-only auto, edit + command prompt) so existing tests that
   * construct ToolExecutor without `profile` continue to pass.
   *
   * `dangerouslyAllowAll: true` is preserved for back-compat — it maps
   * onto `dontAsk` semantics inside `resolveApprovalPolicy`. When BOTH
   * are supplied, `dangerouslyAllowAll` wins (matches the historical
   * "global escape hatch" contract).
   */
  private readonly profile: PermissionProfile;
  // BATCH-APPROVAL-SECTION
  /**
   * Unified batch-approval callback. Fired ONCE per `executeAll`
   * invocation when the mutating-call count meets the configured
   * threshold. When undefined, the executor falls back to the per-call
   * approval flow.
   */
  private readonly batchApprovalCallback: BatchApprovalCallback | undefined;
  /**
   * Threshold at which `executeAll` routes its mutating calls through
   * the batch callback. Default 3 — matches the typed default in
   * `permissions.batchApprovalThreshold`. Below the threshold, the
   * executor uses sequential single-call approval (existing flow).
   */
  private readonly batchApprovalThreshold: number;
  /**
   * One-shot per-call-ID bypass populated by the batch flow BEFORE
   * invoking `execute()` per approved item. `execute()` consults this
   * set and skips the per-call approval prompt for IDs present here
   * (atomically removing the id so re-entry can't double-bypass).
   *
   * Rejected items are NOT pre-stamped — `executeAll` synthesises a
   * "User rejected" ToolResult for them directly so they bypass the
   * speculative-reads chain (whose "prior rejection cascades to
   * subsequent mutators" rule would otherwise override the user's
   * explicit per-item decisions).
   */
  private batchApprovedCallIds: Set<string> = new Set();
  // BATCH-APPROVAL-SECTION-END

  constructor(options: ToolExecutorOptions) {
    this.handlers = options.handlers;
    this.approvalCallback = options.approvalCallback;
    this.dangerouslyAllowAll = options.dangerouslyAllowAll ?? false;
    this.autoApproveTools = new Set(options.autoApproveTools ?? []);
    this.autoLintAfterWrite = options.autoLintAfterWrite ?? true;
    this.onAutoCheckResult = options.onAutoCheckResult;
    // Default hook: auto-lint. Can be swapped at runtime via setPostCommitHook().
    this.postCommitHook = this.defaultAutoLintHook.bind(this);
    this.hookBridge = options.hookBridge;
    this.onHookEvent = options.onHookEvent;
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.sessionId = options.sessionId;
    this.profile = options.profile ?? 'default';
    // BATCH-APPROVAL-SECTION
    this.batchApprovalCallback = options.batchApprovalCallback;
    // Clamp the threshold to the schema-enforced range (1..99). Callers
    // upstream already validate via Zod; this guard exists so a direct
    // ToolExecutor instantiation (tests, ad-hoc tooling) that supplies
    // an out-of-range value still degrades to the default.
    const t = options.batchApprovalThreshold;
    this.batchApprovalThreshold =
      typeof t === 'number' && Number.isFinite(t) && t >= 1 && t <= 99
        ? Math.floor(t)
        : 3;
    // BATCH-APPROVAL-SECTION-END
    // FILE-WATCHER-SECTION
    this.fileTracker = getProcessFileChangeTracker();
    // FILE-WATCHER-SECTION-END
  }

  // FILE-WATCHER-SECTION
  /**
   * Test/diagnostic accessor for the file-change tracker. Production
   * callers should NOT touch this — the tracker is a process-wide
   * singleton and reaching into the executor to reset it would mask
   * real cross-tool bugs. Tests use this to inject a fresh tracker
   * after `setProcessFileChangeTracker(...)`.
   */
  setFileChangeTracker(next: FileChangeTracker): void {
    this.fileTracker = next;
  }
  // FILE-WATCHER-SECTION-END

  /**
   * Late-bind / swap the settings-driven hook bridge. The composition
   * root wires the engine in once at construction; tests use this to
   * inject fakes after the fact without rebuilding the whole executor.
   */
  setHookBridge(bridge: ToolExecutorHookBridge | undefined): void {
    this.hookBridge = bridge;
  }

  /**
   * Late-bind the hook-event observer. Mirrors `setHookBridge` —
   * lets the runtime wire up after construction.
   */
  setOnHookEvent(handler: ((syntheticMsg: Message) => void) | undefined): void {
    this.onHookEvent = handler;
  }

  /**
   * Update the session id forwarded into HookContext after construction.
   * Useful for the web runtime which builds the executor before knowing
   * the active session.
   */
  setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  /**
   * Resolve the approval policy for a tool call. Returns:
   *   - `'block'`  — the call is rejected at the executor (Plan Mode
   *                  for edit/command tools). No preview, no hook,
   *                  no approval IO.
   *   - `'auto'`   — the call runs without prompting (read-only tools,
   *                  the legacy `dangerouslyAllowAll` flag, or one of
   *                  `acceptEdits`/`dontAsk`/`bypassPermissions`
   *                  bypassing approval for the relevant category).
   *   - `'prompt'` — the call must pass `approvalCallback` first
   *                  (`default` for edit/command, `acceptEdits` for
   *                  command tools).
   *
   * Precedence (top wins):
   *   1. `dangerouslyAllowAll` — historical global escape hatch.
   *      Returns `'auto'` for every tool, including those that would
   *      otherwise be blocked by `plan`. Existing callers / tests that
   *      pass `dangerouslyAllowAll: true` keep working unchanged.
   *   2. Plan-mode block for edit-or-command tools.
   *   3. Per-tool `autoApproveTools` allow-list. Profile-agnostic
   *      EXCEPT under `plan` (rule 2 already returned).
   *   4. Profile-specific bypass:
   *        - `acceptEdits`       → auto for EDIT_TOOLS.
   *        - `dontAsk`           → auto for every gated tool.
   *        - `bypassPermissions` → auto for every gated tool.
   *   5. Otherwise: `'prompt'` if the tool is in
   *      `APPROVAL_REQUIRED_TOOLS` / `APPROVAL_REQUIRED_TOOLS_EXTRA`,
   *      else `'auto'` (read-only tools).
   */
  resolveApprovalPolicy(toolName: string): ApprovalPolicy {
    // Rule 1 — legacy global escape hatch wins over every profile.
    if (this.dangerouslyAllowAll) return 'auto';

    const requiresGate =
      APPROVAL_REQUIRED_TOOLS.has(toolName) ||
      APPROVAL_REQUIRED_TOOLS_EXTRA.has(toolName);
    const isEditTool = EDIT_TOOLS.has(toolName);

    // Rule 2 — Plan mode blocks edit AND command tools. Read-only
    // tools (everything outside the gate AND outside the edit set)
    // continue to run so the model can still investigate before
    // summarising its plan.
    if (this.profile === 'plan' && (requiresGate || isEditTool)) {
      return 'block';
    }

    // Read-only tools always run.
    if (!requiresGate && !isEditTool) return 'auto';

    // APPROVAL-BATCH-SECTION
    // Rule 3.a — turn-scoped batch approval. Cleared by `resetTurnAutoApprove`
    // at the start of every new user message.
    if (this.turnAutoApprove.has(toolName)) return 'auto';
    // APPROVAL-BATCH-SECTION-END

    // Rule 3 — per-tool allow-list. Honoured in every profile except
    // `plan` (already handled above).
    if (this.autoApproveTools.has(toolName)) return 'auto';

    // Rule 4 — profile-specific bypass.
    switch (this.profile) {
      case 'acceptEdits':
        if (isEditTool) return 'auto';
        break;
      case 'dontAsk':
      case 'bypassPermissions':
        return 'auto';
      case 'default':
      case 'plan':
      default:
        break;
    }

    // Rule 5 — fall back to the gate. `edit_file` is NOT in
    // `APPROVAL_REQUIRED_TOOLS` (it uses two-phase preview/commit) so
    // it returns `'auto'` here; the diff confirmation in the UI
    // serves as the implicit approval. Only `write_file` /
    // `run_command` / `git_commit` / `browser_evaluate` actually
    // prompt by default.
    return requiresGate ? 'prompt' : 'auto';
  }

  /**
   * True when this tool call must pass approvalCallback before running.
   *
   * Kept for back-compat with callers that introspect the executor
   * (existing tests, debug consoles). Delegates to
   * `resolveApprovalPolicy` so the legacy boolean keeps reflecting the
   * full profile-aware policy.
   */
  requiresApproval(toolName: string): boolean {
    return this.resolveApprovalPolicy(toolName) === 'prompt';
  }

  /**
   * Swap the post-commit hook with a custom implementation. Passing a
   * no-op hook disables auto-lint. Agent 8 may use this to inject a
   * richer policy (e.g. lint + format + test) without forking the class.
   */
  setPostCommitHook(hook: PostCommitHook): void {
    this.postCommitHook = hook;
  }

  /**
   * Late-bind the synthetic-tool-message observer for the auto-lint
   * (post-commit) hook. Mirrors the constructor option of the same
   * name; useful when the composition root only wires the runtime
   * AFTER constructing the executor (web runtime).
   */
  setOnAutoCheckResult(handler: ((syntheticMsg: Message) => void) | undefined): void {
    // `onAutoCheckResult` is private; we keep the constructor-injected
    // path the source of truth and only allow a late bind through this
    // setter. Mutating a private field from within the class is fine.
    (this as unknown as { onAutoCheckResult: ((m: Message) => void) | undefined })
      .onAutoCheckResult = handler;
  }

  // APPROVAL-BATCH-SECTION
  /**
   * Late-bind the pre-commit snapshot hook. The composition root wires
   * a function that captures the file's pre-mutation content into the
   * `FileSnapshotStack` so `/undo` can roll it back.
   */
  setSnapshotHook(
    hook:
      | ((toolName: string, args: Record<string, unknown>) => Promise<void> | void)
      | undefined,
  ): void {
    this.snapshotHook = hook;
  }

  /**
   * Reset the turn-scoped batch approval set. The runtime calls this at
   * the start of every new user message so a previous turn's `[A]`
   * decision doesn't leak into the next turn.
   */
  resetTurnAutoApprove(): void {
    this.turnAutoApprove.clear();
  }

  /** Test/diagnostic accessor — current turn-scoped batch approvals. */
  getTurnAutoApprove(): ReadonlySet<string> {
    return this.turnAutoApprove;
  }

  /**
   * Test/diagnostic accessor — current session-scoped command allow-list.
   * The set is kept process-private; callers reading it MUST treat it as
   * read-only.
   */
  getAutoApproveCommands(): ReadonlySet<string> {
    return this.autoApproveCommands;
  }
  // APPROVAL-BATCH-SECTION-END

  /**
   * Execute a single tool call. Never throws — any failure (unknown tool,
   * rejected approval, handler exception) becomes a `ToolResult` with
   * `success: false`.
   *
   * Post-commit hook side-effect: on a successful write_file / edit_file
   * commit whose `path` has a lintable extension, fire the configured
   * post-commit hook (default: auto-lint). The synthetic Message produced
   * is delivered to `onAutoCheckResult` — the caller is responsible for
   * appending it to the `ContextManager`. Errors from the hook are
   * swallowed (logged via console.warn) so a failing auto-check never
   * breaks the main tool flow.
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const { name, arguments: args } = toolCall;

    if (!KNOWN_TOOL_NAMES.has(name) && !BROWSER_TOOL_NAMES.has(name)) {
      // Permit any handler the caller actually registered — plugins
      // contribute names not in the static known-set, and the browser
      // sandbox registers eight extra `browser_*` tools.
      if (!Object.prototype.hasOwnProperty.call(this.handlers, name)) {
        return {
          success: false,
          output: '',
          error: `Unknown tool: ${name}`,
        };
      }
    }

    const handler = this.handlers[name];
    if (!handler) {
      return {
        success: false,
        output: '',
        error: `No handler registered for tool: ${name}`,
      };
    }

    // PLAN-MODE-BLOCK-SECTION
    // Profile-aware policy resolution. Plan-mode block MUST short-
    // circuit BEFORE the PreToolUse hook fires and BEFORE preview, so
    // the executor never invokes any side-effecting code path for a
    // blocked tool. The decision is centralised in
    // `resolveApprovalPolicy` (rule 2: `profile === 'plan'` AND the
    // tool is an edit-or-command tool); only the short-circuit /
    // error-shape lives here.
    const basePolicy = this.resolveApprovalPolicy(name);
    if (basePolicy === 'block') {
      return {
        success: false,
        output: '',
        error: PLAN_MODE_BLOCK_ERROR,
      };
    }
    // PLAN-MODE-BLOCK-SECTION-END
    // SENSITIVE-FILES-SECTION
    // Sensitive-files override: if ANY referenced path matches the
    // catalog (defaults + global + project), force the approval prompt
    // even when policy was 'auto'. This overrides:
    //   - `dontAsk` / `bypassPermissions` profiles
    //   - `dangerouslyAllowAll` flag
    //   - per-tool `autoApproveTools` allow-list
    //   - turn-scoped batch approval (`[A]` button)
    // The approval args are enriched with `__sensitive` so the UI can
    // render the `🛡 Sensitive: <reason>` banner.
    const sensitiveMatch = this.detectSensitivePath(name, args);
    let policy: ApprovalPolicy = basePolicy;
    let sensitiveArgsExtra: Record<string, unknown> = {};
    if (sensitiveMatch !== null) {
      policy = 'prompt';
      sensitiveArgsExtra = {
        __sensitive: `🛡 Sensitive: ${sensitiveMatch.reason}`,
        __sensitivePattern: sensitiveMatch.pattern,
        __sensitivePath: sensitiveMatch.absolutePath,
      };
    }
    // SENSITIVE-FILES-SECTION-END
    if (policy === 'prompt') {
      // BATCH-APPROVAL-SECTION
      // One-shot per-call-ID bypass set by `executeAll` after the
      // batch approval modal resolved (approved item). Sensitive
      // matches are NEVER pre-stamped (they take the per-call
      // sensitive prompt), so it is safe to skip the gate without
      // re-checking sensitivity here. Consuming the id (delete-then-
      // proceed) makes the bypass strictly one-shot.
      if (this.batchApprovedCallIds.has(toolCall.id) && sensitiveMatch === null) {
        this.batchApprovedCallIds.delete(toolCall.id);
      } else
      // BATCH-APPROVAL-SECTION-END
      // APPROVAL-BATCH-SECTION
      // Session-scoped run_command allow-list — if the model invoked an
      // identical command earlier in this session AND the user pressed
      // `[S]`, skip the approval prompt entirely. Bypass is gated on
      // exact string match (no globbing) for safety.
      //
      // SENSITIVE-FILES-SECTION
      // The sensitive-files override (sensitiveMatch !== null) MUST NOT
      // honour the session allow-list either — exact-command memoisation
      // does not constitute consent for a file the user marked sensitive.
      // SENSITIVE-FILES-SECTION-END
      if (name === 'run_command' && sensitiveMatch === null) {
        const cmd = extractCommand(args);
        if (cmd !== null && this.autoApproveCommands.has(cmd)) {
          // Fall through to the handler call below — no approval IO.
        } else {
          const approvalErr = await this.runApprovalGate(name, args, sensitiveArgsExtra);
          if (approvalErr !== null) return approvalErr;
        }
      } else {
        const approvalErr = await this.runApprovalGate(name, args, sensitiveArgsExtra);
        if (approvalErr !== null) return approvalErr;
      }
      // APPROVAL-BATCH-SECTION-END
    }

    // ARCH-RULES-SECTION
    // Architecture-rule PreToolUse check. Runs only for the
    // file-mutating tools that produce a static import surface. When
    // the projected file content violates a layering rule, we surface
    // the violations via `onAutoCheckResult` AND force an approval
    // prompt — overriding `acceptEdits` so the user can intervene
    // before a forbidden cross-layer import lands on disk. Errors in
    // arch loading degrade silently (the warning is best-effort).
    if (
      policy === 'auto' &&
      ARCH_CHECKED_TOOLS.has(name)
    ) {
      const archResult = await this.runArchCheck(name, args);
      if (archResult !== null) return archResult;
    }
    // ARCH-RULES-SECTION-END

    // Settings-driven PreToolUse hooks (fires AFTER approval, BEFORE
    // the handler runs). A blocking hook with a non-zero exit aborts
    // the tool call entirely — the resulting ToolResult carries the
    // hook's stderr so the model can react.
    if (this.hookBridge !== undefined && this.hookBridge.hasHooksFor('PreToolUse')) {
      try {
        const outcomes = await this.hookBridge.run({
          trigger: 'PreToolUse',
          toolName: name,
          toolArgs: args,
          projectRoot: this.projectRoot,
          ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
        });
        const blocker = outcomes.find((o) => o.blocked);
        if (blocker !== undefined) {
          this.emitHookNote(
            name,
            args,
            'PreToolUse',
            blocker,
            true,
          );
          const stderrTrimmed = blocker.stderr.trim();
          return {
            success: false,
            output: '',
            error:
              stderrTrimmed.length > 0
                ? `PreToolUse hook blocked ${name}: ${stderrTrimmed}`
                : `PreToolUse hook blocked ${name} (exit ${blocker.exitCode})`,
          };
        }
      } catch (error) {
        // Surface engine failures in stderr but DO NOT block the tool —
        // a broken hook engine shouldn't be a hard rejection.
        // eslint-disable-next-line no-console
        console.warn(
          `[ToolExecutor] PreToolUse hook engine failed for "${name}": ${errorMessage(error)}`,
        );
      }
    }

    // APPROVAL-BATCH-SECTION
    // Snapshot the pre-mutation file contents BEFORE the handler runs
    // its commit phase. This lets `/undo` roll back the most recent
    // write_file / edit_file / multi_edit calls.
    if (this.snapshotHook !== undefined && POST_COMMIT_HOOK_TOOLS.has(name)) {
      try {
        await this.snapshotHook(name, args);
      } catch (error) {
        // Snapshot failure must never abort the tool — it's a best-effort
        // recovery aid. Log for diagnostics; the tool call proceeds.
        // eslint-disable-next-line no-console
        console.warn(
          `[ToolExecutor] snapshot hook for "${name}" failed: ${errorMessage(error)}`,
        );
      }
    }
    // APPROVAL-BATCH-SECTION-END

    // FILE-WATCHER-SECTION
    // External-modification guard. Runs only for the file-mutating
    // tools (`write_file`, `edit_file`, `multi_edit`). If the model
    // previously `read_file`-d this path AND the on-disk content has
    // changed since (different mtime OR size), emit a synthetic
    // warning message via `onAutoCheckResult`. The mutation itself
    // still proceeds — the warning is a nudge for the model's next
    // turn, NOT a hard veto. We mirror the auto-lint hook's pattern
    // (synthetic tool-role Message, additive to the main result) so
    // call sites only need one wiring.
    if (FILE_WATCH_TOOLS.has(name)) {
      try {
        await this.checkExternalChange(name, args);
      } catch (error) {
        // A buggy file-tracker check must never affect the mutation.
        // eslint-disable-next-line no-console
        console.warn(
          `[ToolExecutor] file-watcher check for "${name}" failed: ${errorMessage(error)}`,
        );
      }
    }
    // FILE-WATCHER-SECTION-END

    let result: ToolResult;
    try {
      result = await handler(args);
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `Tool "${name}" threw: ${errorMessage(error)}`,
      };
    }

    // Fire post-commit hook on eligible, successful mutations. Never let a
    // hook failure affect the primary result returned to the caller.
    if (result.success && POST_COMMIT_HOOK_TOOLS.has(name)) {
      try {
        const hookResult = await this.postCommitHook(name, args, result);
        if (hookResult !== null) {
          this.emitAutoCheck(name, args, hookResult);
        }
      } catch (error) {
        // Keep auto-check silent to the user but visible to developers.
        // eslint-disable-next-line no-console
        console.warn(
          `[ToolExecutor] post-commit hook for "${name}" failed: ${errorMessage(error)}`,
        );
      }
    }

    // Settings-driven PostToolUse hooks. These never undo the result —
    // a blocking failure just adds a system note via `onHookEvent`.
    if (this.hookBridge !== undefined && this.hookBridge.hasHooksFor('PostToolUse')) {
      try {
        const outcomes = await this.hookBridge.run({
          trigger: 'PostToolUse',
          toolName: name,
          toolArgs: args,
          projectRoot: this.projectRoot,
          ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
        });
        for (const o of outcomes) {
          // Emit a note for blocking failures so the model sees that
          // the post-action check disapproved. Non-blocking hooks are
          // fire-and-forget — their output is intentionally silent
          // unless the user wired their own observability into the
          // hook command itself.
          if (o.blocked) {
            this.emitHookNote(name, args, 'PostToolUse', o, false);
          }
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ToolExecutor] PostToolUse hook engine failed for "${name}": ${errorMessage(error)}`,
        );
      }
    }

    return result;
  }

  /**
   * Execute a batch of tool calls. Read-only calls (see
   * {@link SPECULATIVE_READ_ONLY_TOOLS}) fire immediately and run in
   * parallel with any mutating call that is blocked on the approval
   * prompt — saving 100–300ms per turn when the model batches reads
   * with a write. Mutating calls still serialise relative to each
   * other so the approval UI stays deterministic and filesystem
   * mutations preserve their declared order.
   *
   * Result ordering: the returned array always mirrors the input
   * `toolCalls` order — the LLM correlates results to calls by index,
   * so any reorder would corrupt the conversation.
   *
   * Speculative-safety predicate: a call participates in the parallel
   * fast-path iff its tool name is in `SPECULATIVE_READ_ONLY_TOOLS`
   * AND the call's args do NOT match the sensitive-files catalog. The
   * sensitive override forces every match through the approval prompt,
   * so speculation would race the prompt and surface stale results.
   *
   * Rejection semantics: if a mutating tool's approval is rejected,
   * any subsequent MUTATING tools in the batch are skipped (the user
   * already declined intent for the mutation series). Already-fired
   * reads still resolve into the results array. Reads requested AFTER
   * the rejected mutator have already started; they complete normally.
   */
  async executeAll(
    toolCalls: readonly ToolCall[]
  ): Promise<Array<{ toolCall: ToolCall; result: ToolResult }>> {
    if (toolCalls.length === 0) return [];

    // BATCH-APPROVAL-SECTION
    // When the count of mutating, non-sensitive, prompt-policy calls
    // meets the configured threshold AND a batchApprovalCallback is
    // configured, fire the unified batch modal upfront and short-circuit
    // the speculative-reads dispatcher path: rejected items resolve to
    // a synthetic "User rejected" ToolResult WITHOUT going through the
    // chain (so the chain's "prior rejection cascades to subsequent
    // mutators" rule doesn't override the user's explicit per-item
    // decisions). Approved items get a one-shot per-id bypass so their
    // `execute()` call skips the per-call approval prompt. Read-only
    // and sensitive siblings flow through the standard path below.
    if (this.batchApprovalCallback !== undefined) {
      const eligible = this.collectBatchEligible(toolCalls);
      if (eligible.length >= this.batchApprovalThreshold) {
        const items: BatchApprovalItem[] = eligible.map((call) => ({
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
        }));
        let decisions: ReadonlyMap<string, BatchApprovalDecision>;
        try {
          decisions = await this.batchApprovalCallback({ items });
        } catch {
          // Treat dialog failure as a full rejection — every eligible
          // mutator becomes a "User rejected" result.
          decisions = new Map(
            eligible.map((c) => [c.id, 'rejected' as BatchApprovalDecision]),
          );
        }
        // Bypass the speculative-reads chain entirely: drive each call
        // serially, returning a synthetic rejection for the items the
        // user declined and pre-stamping the approved ones so the
        // single-call `execute()` skips its per-call prompt.
        //
        // Membership in `eligibleIds` is the discriminator: every
        // eligible item is in scope of the batch dialog (even when the
        // decision map omits it — Esc / cancel coerces missing items
        // to rejected per the spec). Non-eligible items (read-only,
        // sensitive) flow through `execute()` normally.
        const eligibleIds = new Set<string>(items.map((it) => it.toolCallId));
        const out: Array<{ toolCall: ToolCall; result: ToolResult }> = [];
        for (const call of toolCalls) {
          if (eligibleIds.has(call.id)) {
            const d = decisions.get(call.id);
            if (d === 'approved') {
              this.batchApprovedCallIds.add(call.id);
              const result = await this.execute(call);
              out.push({ toolCall: call, result });
            } else {
              // 'rejected' OR missing from the decision map — both
              // coerce to a synthetic rejection.
              out.push({
                toolCall: call,
                result: {
                  success: false,
                  output: '',
                  error: `User rejected ${call.name} call`,
                },
              });
            }
            continue;
          }
          // Non-batched item (read-only sibling, sensitive, etc.) —
          // run normally through `execute()`.
          const result = await this.execute(call);
          out.push({ toolCall: call, result });
        }
        return out;
      }
    }
    // BATCH-APPROVAL-SECTION-END

    // Per-index promise that resolves to that call's `ToolResult`.
    // Read-only calls start immediately. Mutating calls chain off a
    // single sentinel (`mutationChain`) so the UI only ever shows ONE
    // approval prompt at a time and filesystem mutations stay in
    // declared order. The reads still race against the mutation chain
    // because they don't await it.
    const resultPromises: Array<Promise<ToolResult>> = new Array<
      Promise<ToolResult>
    >(toolCalls.length);

    // Tracks the "previous mutating call finished" boundary. A new
    // mutating call awaits this before starting so two approval
    // prompts never overlap and `runApprovalGate`'s turn-scoped /
    // session-scoped allow-list mutations stay race-free. The chain
    // ALSO carries a flag indicating whether the user rejected the
    // previous mutation, which short-circuits subsequent mutators
    // (see `executeAll` doc-comment for the consent rationale).
    let mutationChain: Promise<{ rejected: boolean }> = Promise.resolve({
      rejected: false,
    });

    for (let i = 0; i < toolCalls.length; i += 1) {
      const call = toolCalls[i];
      if (call === undefined) continue;
      if (this.isSpeculativeReadOnly(call)) {
        // Speculative path — fire immediately. The `.catch` re-wraps
        // any thrown error (rare; `execute` itself wraps thrown
        // handler errors) into a structured ToolResult so the result
        // array is uniform and no unhandled rejection escapes.
        resultPromises[i] = this.execute(call).catch(
          (err: unknown): ToolResult => ({
            success: false,
            output: '',
            error: `Tool "${call.name}" threw: ${errorMessage(err)}`,
          }),
        );
        continue;
      }

      // Mutating path — chain off the previous mutation so approval
      // prompts and FS writes serialise. `mutationChain` resolves
      // with `{ rejected }`; if true we synthesise a "skipped"
      // result without ever calling the handler.
      const callForChain = call;
      const next = mutationChain.then(async ({ rejected }) => {
        if (rejected) {
          return {
            success: false,
            output: '',
            error: `Skipped ${callForChain.name}: prior approval was rejected this turn`,
          } satisfies ToolResult;
        }
        return this.execute(callForChain);
      });
      resultPromises[i] = next;
      // Advance the chain. Use `.then` not `.catch` because `execute`
      // already returns structured errors; the only way `next` can
      // reject is a bug inside `execute`, in which case we propagate.
      mutationChain = next.then((r) => ({ rejected: isApprovalRejection(r) }));
    }

    // Await every index in input order. `Promise.all` on the array
    // preserves index ordering by construction.
    const settled = await Promise.all(resultPromises);
    const out: Array<{ toolCall: ToolCall; result: ToolResult }> = [];
    for (let i = 0; i < toolCalls.length; i += 1) {
      const call = toolCalls[i];
      const result = settled[i];
      if (call === undefined || result === undefined) continue;
      out.push({ toolCall: call, result });
    }
    return out;
  }

  /**
   * Decide whether a tool call can be fired speculatively in parallel
   * with the approval prompt of a sibling mutating call. True iff:
   *   - The tool name is in {@link SPECULATIVE_READ_ONLY_TOOLS}
   *     (the static catalogue of side-effect-free tools); AND
   *   - The call's args do NOT match the sensitive-files catalogue
   *     (sensitive matches force the approval prompt — speculating
   *     would race the prompt and surface a stale read).
   *
   * Kept conservative on purpose: false positives (treating a
   * mutating tool as read-only) corrupt state; false negatives (a
   * read-only tool slipping into the serial path) only forfeit
   * latency. The catalogue lists exactly the six tools the task
   * marks `readOnly: true` in `createToolHandlerMap`.
   */
  private isSpeculativeReadOnly(call: ToolCall): boolean {
    if (!SPECULATIVE_READ_ONLY_TOOLS.has(call.name)) return false;
    // Sensitive-path matches force the approval prompt regardless of
    // the read-only label; speculate-then-prompt is not the contract
    // the catalogue promises. Mirror the same loader the hot path
    // uses so the decision stays consistent with `execute()`.
    const sensitive = this.detectSensitivePath(call.name, call.arguments);
    return sensitive === null;
  }

  // BATCH-APPROVAL-SECTION
  /**
   * Compute the subset of tool calls eligible for the unified batch
   * approval flow. A call is eligible iff:
   *   - its current approval policy resolves to `'prompt'`, AND
   *   - its args do NOT match the sensitive-files catalog (sensitive
   *     matches force a per-call prompt regardless of profile).
   *
   * Read-only calls resolve to `'auto'` so they're excluded. Plan-mode
   * blocked calls resolve to `'block'` and are also excluded
   * (`execute()` rejects them upfront with the standard error).
   */
  private collectBatchEligible(
    toolCalls: readonly ToolCall[],
  ): readonly ToolCall[] {
    const out: ToolCall[] = [];
    for (const call of toolCalls) {
      if (call === undefined) continue;
      const policy = this.resolveApprovalPolicy(call.name);
      if (policy !== 'prompt') continue;
      const sensitive = this.detectSensitivePath(call.name, call.arguments);
      if (sensitive !== null) continue;
      out.push(call);
    }
    return out;
  }

  /** Test/diagnostic accessor — current one-shot batch-approved set. */
  getBatchApprovedCallIds(): ReadonlySet<string> {
    return this.batchApprovedCallIds;
  }
  // BATCH-APPROVAL-SECTION-END

  // ---------- Internals ----------

  // FILE-WATCHER-SECTION
  /**
   * Inspect the on-disk file referenced by `args.path` against the
   * tracker's last `markRead` snapshot. When the file changed
   * externally, synthesise a tool-role Message describing the drift
   * and hand it to `onAutoCheckResult`. Silent on three branches:
   *   - the tool args don't carry a usable `path` (e.g. malformed
   *     payload — the handler will reject it with a clearer error),
   *   - the path can't be resolved or stat'd (write_file may be
   *     creating a brand-new file; nothing to compare against),
   *   - the tracker has no prior `markRead` for the (path, session)
   *     pair (the model never read this file — nothing to drift from).
   */
  private async checkExternalChange(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (this.onAutoCheckResult === undefined) return;
    const relPath = extractPath(args);
    if (relPath === null) return;
    const absolutePath = path.isAbsolute(relPath)
      ? relPath
      : path.resolve(this.projectRoot, relPath);

    let mtimeMs: number;
    let size: number;
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) return;
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      // ENOENT etc. — write_file may be creating a new file. Skip.
      return;
    }

    const status = this.fileTracker.checkChanged(
      absolutePath,
      mtimeMs,
      size,
      this.sessionId,
    );
    if (status === null || status.changed === false) return;

    const ageMs = Math.max(0, Date.now() - status.lastReadAt);
    const content = [
      `[file-watcher] ${relPath} was modified externally since your last read_file.`,
      `  - Last read: ${Math.round(ageMs / 1000)}s ago`,
      `  - Current mtime: ${new Date(status.currentMtime).toISOString()}`,
      '',
      `Re-read the file before relying on prior contents — your ${toolName} may be applied to stale context.`,
    ].join('\n');

    const syntheticCallId = `file-watcher-${shortRandomId()}`;
    const message: Message = {
      id: `file-watcher-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'tool',
      content,
      toolName: 'file_watcher',
      toolCallId: syntheticCallId,
      createdAt: Date.now(),
    };
    try {
      this.onAutoCheckResult(message);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] file-watcher onAutoCheckResult callback for "${toolName}" threw: ${errorMessage(error)}`,
      );
    }
  }
  // FILE-WATCHER-SECTION-END

  // ARCH-RULES-SECTION
  /**
   * Test/diagnostic accessor — inject a pre-loaded `ArchConfig` so the
   * hot path skips the disk read. Passing `null` disables arch checks
   * for this executor instance. Passing `undefined` re-arms lazy
   * loading on next invocation.
   */
  setArchConfig(config: ArchConfig | null | undefined): void {
    this.archConfig = config;
  }

  // SENSITIVE-FILES-SECTION
  /**
   * Test/diagnostic accessor — inject a pre-loaded `SensitiveConfig`.
   * Passing `undefined` re-arms lazy loading on next invocation.
   *
   * Production callers should NOT use this — the loader's three-layer
   * merge (defaults → global → project) IS the contract; bypassing it
   * defeats the baseline-protection promise.
   */
  setSensitiveConfig(config: SensitiveConfig | undefined): void {
    this.sensitiveConfig = config;
  }

  /**
   * Lazy-loader for the sensitive-files config. The loader never
   * throws — broken overlay files degrade silently to defaults with a
   * console.warn from inside the loader.
   */
  private getSensitiveConfig(): SensitiveConfig {
    if (this.sensitiveConfig !== undefined) return this.sensitiveConfig;
    const loaded = loadSensitiveFiles(this.projectRoot);
    this.sensitiveConfig = loaded;
    return loaded;
  }

  /**
   * Inspect a tool call against the sensitive-files catalog. Returns
   * the FIRST matched path (deterministic — defaults checked before
   * overlays) or `null` when nothing matched.
   *
   * Called from `execute()` BEFORE the profile-based policy resolution
   * even decides 'auto' / 'prompt' so the gate fires regardless of
   * profile, autoApproveTools list, or turn-scoped batch approval.
   */
  private detectSensitivePath(
    name: string,
    args: Record<string, unknown>,
  ): { absolutePath: string; pattern: string; reason: string } | null {
    const config = this.getSensitiveConfig();
    if (config.patterns.length === 0) return null;
    let paths: readonly string[];
    try {
      paths = extractToolPaths(name, args, this.projectRoot);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] sensitive-files path extraction for "${name}" failed: ${errorMessage(error)}`,
      );
      return null;
    }
    for (const p of paths) {
      const match = isSensitivePath(p, this.projectRoot, config);
      if (match.sensitive) {
        return { absolutePath: p, pattern: match.pattern, reason: match.reason };
      }
    }
    return null;
  }
  // SENSITIVE-FILES-SECTION-END

  /**
   * Lazy-loader for the per-project arch.toml. Reads once and caches
   * the result. A broken file logs once and then behaves as if the
   * file were absent (the loader returns null, the executor's hot
   * path short-circuits).
   */
  private getArchConfig(): ArchConfig | null {
    if (this.archConfig !== undefined) return this.archConfig;
    try {
      const cfg = loadArchConfig(this.projectRoot);
      this.archConfig = cfg;
      return cfg;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] arch.toml load failed: ${errorMessage(error)} — disabling arch checks for this session.`,
      );
      this.archConfig = null;
      return null;
    }
  }

  /**
   * Project the would-be file content for a write/edit/multi_edit call.
   * Returns `null` when projection isn't feasible (missing path,
   * unsupported extension, or unreadable existing file for an edit).
   * The arch validator runs against the projected content via
   * `extractImportsFromSource` so it sees the imports the model is
   * about to commit.
   */
  private async projectFileContent(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ absolutePath: string; content: string } | null> {
    const relPath = extractPath(args);
    if (relPath === null) return null;
    const ext = extensionOf(relPath);
    if (!ARCH_SOURCE_EXTENSIONS.has(ext)) return null;
    const absolutePath = path.isAbsolute(relPath)
      ? relPath
      : path.resolve(this.projectRoot, relPath);

    if (toolName === 'write_file') {
      const content = args['content'];
      if (typeof content !== 'string') return null;
      return { absolutePath, content };
    }

    // edit_file / multi_edit — apply the projected edits against the
    // current on-disk content. Best-effort: when the file is missing
    // or the find_text doesn't match, fall back to the on-disk content
    // so we still validate the existing import surface (and any new
    // imports the edit would introduce are checked once the handler
    // commits via the post-commit re-validation below).
    let existing = '';
    try {
      existing = await fs.readFile(absolutePath, 'utf8');
    } catch {
      // Treat missing source file as empty — a brand-new file via
      // edit_file is rare but possible.
    }

    if (toolName === 'edit_file') {
      const findText = args['find_text'];
      const replaceText = args['replace_text'];
      if (typeof findText !== 'string' || typeof replaceText !== 'string') {
        return { absolutePath, content: existing };
      }
      // Replace first occurrence — mirrors the edit_file tool semantics.
      const idx = existing.indexOf(findText);
      if (idx === -1) return { absolutePath, content: existing };
      const projected =
        existing.slice(0, idx) + replaceText + existing.slice(idx + findText.length);
      return { absolutePath, content: projected };
    }

    if (toolName === 'multi_edit') {
      const edits = args['edits'];
      let projected = existing;
      if (Array.isArray(edits)) {
        for (const e of edits) {
          if (e === null || typeof e !== 'object') continue;
          const find = (e as { find_text?: unknown }).find_text;
          const replace = (e as { replace_text?: unknown }).replace_text;
          if (typeof find !== 'string' || typeof replace !== 'string') continue;
          const idx = projected.indexOf(find);
          if (idx === -1) continue;
          projected =
            projected.slice(0, idx) + replace + projected.slice(idx + find.length);
        }
      }
      return { absolutePath, content: projected };
    }

    return { absolutePath, content: existing };
  }

  /**
   * Architecture-rule check entry point. Returns `null` when the call
   * may proceed (no violations OR no arch config loaded). Returns a
   * rejection `ToolResult` only when the user declines the override
   * approval prompt — otherwise emits a synthetic warning and lets the
   * tool run. The synthetic warning fires regardless of approval
   * outcome so the model sees what it tried.
   */
  private async runArchCheck(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult | null> {
    const config = this.getArchConfig();
    if (config === null || config.rule.length === 0) return null;
    let projected: { absolutePath: string; content: string } | null;
    try {
      projected = await this.projectFileContent(name, args);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] arch-check projection for "${name}" failed: ${errorMessage(error)}`,
      );
      return null;
    }
    if (projected === null) return null;
    let violations: ArchViolation[];
    try {
      violations = validateFile(
        projected.absolutePath,
        config,
        this.projectRoot,
        projected.content,
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] arch-check validate for "${name}" failed: ${errorMessage(error)}`,
      );
      return null;
    }
    if (violations.length === 0) return null;

    // Surface a synthetic warning so the model sees the violations
    // even if the user approves the override.
    this.emitArchViolations(name, violations);

    // Force an approval prompt regardless of profile. Override path
    // is intentional: an `acceptEdits` user still wants to be told
    // when their model crossed a layering boundary.
    if (this.approvalCallback === undefined) {
      // No approval callback wired — emit the warning and fall through
      // so the tool still runs. We've already nudged the model; a
      // headless/integration build (no UI) shouldn't deadlock here.
      return null;
    }
    let decision: ApprovalDecision;
    try {
      const raw = await this.approvalCallback(name, {
        ...args,
        __archViolations: violations.map((v) => `${v.ruleId}: ${v.importPath}`),
      });
      decision = toApprovalDecision(raw);
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `Arch-rules approval failed: ${errorMessage(error)}`,
      };
    }
    if (!decision.approved) {
      const summary = violations
        .map((v) => `${v.ruleId}: ${v.importPath}`)
        .join(', ');
      return {
        success: false,
        output: '',
        error: `User rejected ${name} call (architecture violations: ${summary})`,
      };
    }
    return null;
  }

  /**
   * Synthesise a `tool`-role Message describing every architecture
   * violation and hand it to `onAutoCheckResult`. Mirrors the auto-lint
   * hook's framing — single message per call, additive, never
   * replaces the primary ToolResult.
   */
  private emitArchViolations(
    toolName: string,
    violations: ArchViolation[],
  ): void {
    if (this.onAutoCheckResult === undefined) return;
    if (violations.length === 0) return;
    const lines = violations.map((v) => {
      const tail = v.resolvedTarget !== null ? ` (→ ${v.resolvedTarget})` : '';
      return `  - [${v.ruleId}] ${v.sourceFile}:${v.line} imports ${v.importPath}${tail}`;
    });
    const content = [
      `⚠ Architecture violation${violations.length === 1 ? '' : 's'} detected in ${toolName}:`,
      ...lines,
      '',
      'Run /arch rules to inspect declared layering, /arch check for a full project sweep.',
    ].join('\n');
    const message: Message = {
      id: `arch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'tool',
      content,
      toolName: 'arch_rules',
      toolCallId: `arch-${shortRandomId()}`,
      createdAt: Date.now(),
    };
    try {
      this.onAutoCheckResult(message);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] arch onAutoCheckResult callback for "${toolName}" threw: ${errorMessage(error)}`,
      );
    }
  }
  // ARCH-RULES-SECTION-END

  /**
   * Default post-commit hook — invokes `lint_file` on the written path and
   * returns a `ToolResult` whose `output` is a concise string the caller
   * can surface as a synthetic `tool`-role message. Returns `null` when:
   *   - `autoLintAfterWrite` is disabled,
   *   - no `lint_file` handler is registered (e.g. legacy tests),
   *   - the path is missing / non-string / not a lintable extension.
   */
  private async defaultAutoLintHook(
    toolName: string,
    args: Record<string, unknown>,
    _result: ToolResult,
  ): Promise<ToolResult | null> {
    if (!this.autoLintAfterWrite) return null;
    const path = extractPath(args);
    if (path === null) return null;
    const ext = extensionOf(path);
    if (!LINTABLE_EXTENSIONS.has(ext)) return null;

    const lintHandler = this.handlers['lint_file'];
    if (!lintHandler) return null;

    try {
      const lintResult = await lintHandler({ path });
      // Pass the raw lint result up — `emitAutoCheck` renders it into a
      // Message. We bubble both success and soft-failure results; only
      // hard crashes (caught in .catch below) yield null.
      return lintResult;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] auto-lint failed for "${toolName}": ${errorMessage(error)}`,
      );
      return null;
    }
  }

  // APPROVAL-BATCH-SECTION
  /**
   * Run the approval callback for a single tool call and process the
   * batching flags returned by the UI. Returns `null` on approval, or
   * a `ToolResult` describing the rejection/error when the call should
   * NOT proceed. Mutates `turnAutoApprove` / `autoApproveCommands` when
   * the user pressed `[A]` / `[S]`.
   */
  private async runApprovalGate(
    name: string,
    args: Record<string, unknown>,
    extraArgs: Record<string, unknown> = {},
  ): Promise<ToolResult | null> {
    if (!this.approvalCallback) {
      return {
        success: false,
        output: '',
        error: `Tool "${name}" requires approval but no approvalCallback is configured`,
      };
    }
    let decision: ApprovalDecision;
    try {
      const argsForApproval =
        Object.keys(extraArgs).length === 0 ? args : { ...args, ...extraArgs };
      const raw = await this.approvalCallback(name, argsForApproval);
      decision = toApprovalDecision(raw);
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `Approval failed: ${errorMessage(error)}`,
      };
    }
    if (!decision.approved) {
      return {
        success: false,
        output: '',
        error: `User rejected ${name} call`,
      };
    }
    // SENSITIVE-FILES-SECTION
    // For sensitive calls, do NOT honour batching flags. The whole
    // point of the catalog is that every sensitive access must be
    // approved individually; allowing the [A] or [S] button to skip
    // the next sensitive prompt would defeat the override.
    const isSensitive = extraArgs['__sensitive'] !== undefined;
    if (isSensitive) return null;
    // SENSITIVE-FILES-SECTION-END
    // Apply batching flags after a positive decision.
    if (decision.approveAllInTurn === true) {
      this.turnAutoApprove.add(name);
    }
    if (decision.approveForSession === true && name === 'run_command') {
      const cmd = extractCommand(args);
      if (cmd !== null) this.autoApproveCommands.add(cmd);
    }
    return null;
  }
  // APPROVAL-BATCH-SECTION-END

  /**
   * Render a settings-driven hook outcome as a synthetic tool-role
   * Message and hand it to `onHookEvent`. Used for both blocked
   * `PreToolUse` outcomes (returned to the caller as a rejected
   * ToolResult, but ALSO surfaced as a note) and any blocked
   * `PostToolUse` outcome (where the tool result is kept but the
   * model should still see the disapproval).
   *
   * Blocking PreToolUse calls pass `wasBlocking=true` so the rendered
   * note states the action was rejected; PostToolUse uses
   * `wasBlocking=false` because the action already happened.
   */
  private emitHookNote(
    toolName: string,
    _args: Record<string, unknown>,
    trigger: 'PreToolUse' | 'PostToolUse',
    outcome: {
      stderr: string;
      stdout: string;
      exitCode: number;
      hook: { command: string; description?: string };
    },
    wasBlocking: boolean,
  ): void {
    if (this.onHookEvent === undefined) return;
    const description =
      outcome.hook.description !== undefined && outcome.hook.description.length > 0
        ? outcome.hook.description
        : outcome.hook.command;
    const verbStatus = wasBlocking ? 'blocked' : 'failed';
    const detail =
      outcome.stderr.trim().length > 0
        ? outcome.stderr.trim()
        : outcome.stdout.trim().length > 0
          ? outcome.stdout.trim()
          : `exit ${outcome.exitCode}`;
    const content = [
      `[hooks] ${trigger} hook ${verbStatus} ${toolName}:`,
      `  ${description}`,
      `  ${detail}`,
    ].join('\n');
    const syntheticId = `hook-${trigger.toLowerCase()}-${shortRandomId()}`;
    const message: Message = {
      id: `hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'tool',
      content,
      toolName: 'hook',
      toolCallId: syntheticId,
      createdAt: Date.now(),
    };
    try {
      this.onHookEvent(message);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] onHookEvent callback for "${toolName}" threw: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Turn a post-commit hook result into a synthetic `tool`-role Message
   * and hand it to `onAutoCheckResult`. Kept here so every hook (default
   * or custom) gets consistent framing.
   */
  private emitAutoCheck(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): void {
    if (!this.onAutoCheckResult) return;
    const path = extractPath(args) ?? '(unknown path)';
    const raw = result.output.trim();
    const hasIssues =
      raw.length > 0 &&
      raw !== 'No issues found.' &&
      !raw.endsWith('; skipping check.') &&
      !raw.endsWith('; skipping.');

    const content = hasIssues
      ? [
          `[auto-lint] Post-edit check on ${path}:`,
          raw,
          '',
          'Note: please fix any diagnostics above before proceeding.',
        ].join('\n')
      : `[auto-lint] ${path} — ${raw.length > 0 ? raw : 'No issues found.'}`;

    // L5 — synthesise a `toolCallId` so the message stays `role: 'tool'`
    // on the wire instead of being demoted to `role: 'user'` with the
    // confusing `[orphan tool result, no call_id]` prefix that
    // `toWireMessage` applied. The synthetic id is namespaced
    // (`auto-lint-*`) so the sanitiser's pass-1 orphan-drop catches
    // it (no preceding assistant.tool_calls opens this id) and the
    // model never sees a wire message with an unknown id. The end
    // result is strictly better than the previous demotion path:
    // - on providers that run the sanitiser (we always do), the
    //   synthetic message is dropped before sending, so no orphan
    //   reaches the API,
    // - on local in-memory rendering, the message is correctly
    //   labelled `role: 'tool'` rather than masquerading as a user.
    const syntheticCallId = `auto-lint-${shortRandomId()}`;
    const message: Message = {
      id: `auto-lint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'tool',
      content,
      toolName: 'lint_file',
      toolCallId: syntheticCallId,
      createdAt: Date.now(),
    };
    try {
      this.onAutoCheckResult(message);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ToolExecutor] onAutoCheckResult callback for "${toolName}" threw: ${errorMessage(error)}`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * True iff the `ToolResult` describes a user-driven approval rejection.
 * Used by `executeAll` to short-circuit subsequent mutating tools in
 * the same batch after the user clicked "No" on a previous approval
 * prompt — running another mutator unsupervised would violate the
 * intent the user just declined.
 *
 * We match the error prefix the executor emits in `runApprovalGate`
 * and `runArchCheck`. Keeping the matcher local to the executor means
 * the contract is testable from a single spec file.
 */
function isApprovalRejection(result: ToolResult): boolean {
  if (result.success) return false;
  const err = result.error ?? '';
  return (
    err.startsWith('User rejected ') ||
    err.includes('(architecture violations:')
  );
}

/** Safely pull the `path` field out of arbitrary tool args. */
function extractPath(args: Record<string, unknown>): string | null {
  const raw = args['path'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// APPROVAL-BATCH-SECTION
/** Safely pull the `command` field out of `run_command` tool args. */
function extractCommand(args: Record<string, unknown>): string | null {
  const raw = args['command'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
// APPROVAL-BATCH-SECTION-END

/**
 * L5 — short random identifier used for synthetic auto-lint
 * `toolCallId`s. 8 hex chars is enough collision resistance for the
 * lifetime of a single chat turn (we only need to avoid colliding
 * with other auto-lint ids in the same turn).
 */
function shortRandomId(): string {
  // 32-bit random → hex. Math.random is fine here; this id is not a secret.
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
}

/** Lower-cased extension including the leading dot, or empty string. */
function extensionOf(filePath: string): string {
  const lastSlash = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\'),
  );
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}
