/**
 * Commands barrel — re-export every factory and provide a helper for
 * registering a pre-built set of `SlashCommand` instances into a
 * `SlashRegistry`.
 *
 * Agent 8's wiring layer constructs each command (feeding in its concrete
 * dependencies) and then hands the built commands here for registration.
 * This indirection keeps the commands module free of knowledge about
 * sessions/skills/config/LLM initialisation details.
 */

import type { SlashCommand } from '@/types/global';
import { SlashRegistry } from '@/commands/slash-registry';

export { SlashRegistry, SlashRegistryError } from '@/commands/slash-registry';

export { createInitCommand } from '@/commands/cmd-init';
export type { InitDeps, ScanResultShape } from '@/commands/cmd-init';

export { createModelCommand } from '@/commands/cmd-model';
export type { ModelDeps } from '@/commands/cmd-model';

export { createResumeCommand } from '@/commands/cmd-resume';
export type { ResumeDeps } from '@/commands/cmd-resume';

export { createContextCommand } from '@/commands/cmd-context';
export type { ContextDeps, LocalcodeMdStatus } from '@/commands/cmd-context';

export { createClearCommand } from '@/commands/cmd-clear';
export type { ClearDeps } from '@/commands/cmd-clear';

export { createPermissionsCommand } from '@/commands/cmd-permissions';
export type { PermissionsDeps } from '@/commands/cmd-permissions';

export { createProfileCommand } from '@/commands/cmd-profile';
export type { ProfileDeps } from '@/commands/cmd-profile';

export { createCtxSizeCommand } from '@/commands/cmd-ctxsize';
export type { CtxSizeDeps } from '@/commands/cmd-ctxsize';

export { createNewSkillCommand } from '@/commands/cmd-new-skill';
export type { NewSkillDeps } from '@/commands/cmd-new-skill';

export { createProviderCommand } from '@/commands/cmd-provider';
export type { ProviderDeps } from '@/commands/cmd-provider';

export { createCompressCommand } from '@/commands/cmd-compress';
export type {
  CompressDeps,
  CompressLLM,
  CompressContextManager,
} from '@/commands/cmd-compress';

export { createSettingsCommand } from '@/commands/cmd-settings';
export type { SettingsDeps } from '@/commands/cmd-settings';

export { createDiffCommand } from '@/commands/cmd-diff';
export type { DiffDeps, DiffEntry } from '@/commands/cmd-diff';

export { createReviewCommand, listDirSummary, looksLikeGitRange } from '@/commands/cmd-review';
export type { ReviewDeps, ReviewLLM } from '@/commands/cmd-review';

export { createPlanCommand } from '@/commands/cmd-plan';
export type {
  PlanDeps,
  PlanLLM,
  PlanContextManager,
} from '@/commands/cmd-plan';

export { createAgentCommand } from '@/commands/cmd-agent';

export { createTodosCommand } from '@/commands/cmd-todos';
export type { TodosDeps } from '@/commands/cmd-todos';

export { createSpawnCommand } from '@/commands/cmd-spawn';
export type { SpawnDeps, SpawnOrchestrator } from '@/commands/cmd-spawn';

export { createMemoryCommand } from '@/commands/memory';
export type { MemoryDeps } from '@/commands/memory';

// Wave 6 — self-evolution memory. `/memory-save <id>` consumes a
// staged feedback proposal produced by `AutoFeedbackDetector`.
export { createMemorySaveCommand } from '@/commands/cmd-memory-save';
export type { MemorySaveDeps } from '@/commands/cmd-memory-save';

export { createStatuslineCommand } from '@/commands/cmd-statusline';
export type { StatuslineDeps } from '@/commands/cmd-statusline';

export { createStyleCommand } from '@/commands/cmd-style';
export type { StyleDeps } from '@/commands/cmd-style';

export { createWakeupsCommand } from '@/commands/cmd-wakeups';
export type { WakeupsDeps } from '@/commands/cmd-wakeups';

export { createUndoCommand } from '@/commands/cmd-undo';
export type { UndoDeps } from '@/commands/cmd-undo';

export { createWorktreesCommand } from '@/commands/cmd-worktrees';
export type { WorktreesDeps } from '@/commands/cmd-worktrees';

export { createUsageCommand } from '@/commands/cmd-usage';
export type { UsageDeps } from '@/commands/cmd-usage';

export { createCostCommand } from '@/commands/cmd-cost';
export type { CostDeps } from '@/commands/cmd-cost';

// BRANCHES-REGISTRY-EXPORT — `/branch` command factory.
export { createBranchCommand, parseBranchArgs } from '@/commands/cmd-branch';
export type { BranchDeps } from '@/commands/cmd-branch';

export { createPerfCommand } from '@/commands/cmd-perf';

export { createFilterCommand } from '@/commands/cmd-filter';
export type { FilterDeps, OutputFiltersSnapshot } from '@/commands/cmd-filter';

// Automation: recordings + playback (D6).
export { createRecordCommand } from '@/commands/cmd-record';
export type { RecordDeps } from '@/commands/cmd-record';

export { createReplayCommand, parseReplayArgs } from '@/commands/cmd-replay';
export type { ReplayDeps } from '@/commands/cmd-replay';

// Automation: persistent cross-session crons (D6).
export { createCronCommand, parseCronAddArgs } from '@/commands/cmd-cron';
export type { CronDeps } from '@/commands/cmd-cron';

// PLUGIN-CMD-SECTION — Wave 6D `/plugin <subcommand>` slash command.
export { createPluginCommand } from '@/commands/cmd-plugin';
export type { PluginCommandDeps } from '@/commands/cmd-plugin';
// PLUGIN-CMD-SECTION-END

// CONV-CMD-SECTION — Wave 6D `/conv diff` slash command.
export { createConvCommand, parseConvArgs, resolveBranchByQuery } from '@/commands/cmd-conv';
export type { ConvDeps, ParsedConvArgs } from '@/commands/cmd-conv';
// CONV-CMD-SECTION-END

// ARCH-CMD-SECTION — `/arch` slash command for layering rules.
export { createArchCommand, appendIgnorePattern } from '@/commands/cmd-arch';
// ARCH-CMD-SECTION-END

// ONTOLOGY-CMD-SECTION — `/ontology` (status / refresh / graph).
export { createOntologyCommand } from '@/commands/cmd-ontology';
export type {
  OntologyCommandDeps,
  OntologyCommandIndexer,
} from '@/commands/cmd-ontology';
// ONTOLOGY-CMD-SECTION-END

// SECRETS-CMD-SECTION — `/secrets` (scan, scan-all, allow).
export { createSecretsCommand } from '@/commands/cmd-secrets';
export type { SecretsCommandDeps } from '@/commands/cmd-secrets';
// SECRETS-CMD-SECTION-END

// SENSITIVE-CMD-SECTION — `/sensitive` (list, add, check). Front-end for
// the sensitive-files catalog that gates approval prompts inside
// ToolExecutor — see `src/security/sensitive-files.ts`.
export { createSensitiveCommand } from '@/commands/cmd-sensitive';
// SENSITIVE-CMD-SECTION-END

// WATCH-COMMANDS-SECTION — `/watch` + `/diagnose` (process introspection).
// Both commands delegate to the process-wide `ProcessMonitor` singleton
// unless callers inject a custom monitor via the factory deps. The
// command pair powers the watch panel above the InputBar and lets the
// model see live diagnostic signals from long-running dev servers
// without the user having to paste log lines.
export { createWatchCommand } from '@/commands/cmd-watch';
export type { WatchDeps } from '@/commands/cmd-watch';
export {
  buildDiagnosticMessage,
  createDiagnoseCommand,
} from '@/commands/cmd-diagnose';
export type { DiagnoseDeps } from '@/commands/cmd-diagnose';
// WATCH-COMMANDS-SECTION-END

// WHITEBOARD-CMD-SECTION — `/whiteboard` web-only stub.
// The TUI doesn't host a drawing surface; this command exists so the
// web UI's slash autocomplete surfaces `/whiteboard` to the user. The
// actual handler lives in `Composer.tsx` and never invokes `execute`.
export { createWhiteboardCommand } from '@/commands/cmd-whiteboard';
// WHITEBOARD-CMD-SECTION-END

// LAN-SHARE-CMD-SECTION — `/share` (start, stop, peers, accept).
// Live LAN session sharing via mDNS discovery + HMAC-paired TCP sync.
// Off by default — opt-in via the `--lan` CLI flag.
export { createShareCommand } from '@/commands/cmd-share';
export type { ShareCommandDeps } from '@/commands/cmd-share';
// LAN-SHARE-CMD-SECTION-END

// LANGUAGE-CMD-SECTION — `/language` (alias `/lang`) UI language picker.
export { createLanguageCommand } from '@/commands/cmd-language';
export type { LanguageDeps } from '@/commands/cmd-language';
// LANGUAGE-CMD-SECTION-END

// SITE-CMD-SECTION — `/site` opens the landing page in the default browser.
export { createSiteCommand } from '@/commands/cmd-site';
// SITE-CMD-SECTION-END

// WEB-CMD-SECTION — `/web` (and `/web stop`) — boot the local web UI
// from the TUI and continue the same session in the browser.
export { createWebCommand } from '@/commands/cmd-web';
export type { WebCommandDeps, LaunchedWeb } from '@/commands/cmd-web';
// WEB-CMD-SECTION-END

// DEMO-TUTORIAL-CMD-SECTION — `/demo` replays the bundled quick-tour
// recording inside the active chat session; `/tutorial` re-opens the
// first-run interactive walkthrough overlay. Both are skippable.
export { createDemoCommand } from '@/commands/cmd-demo';
export type { DemoCmdDeps } from '@/commands/cmd-demo';
export { createTutorialCommand } from '@/commands/cmd-tutorial';
export type { TutorialDeps } from '@/commands/cmd-tutorial';
// DEMO-TUTORIAL-CMD-SECTION-END

// UPDATE-CMD-SECTION — `/update` wraps the auto-updater singleton so the
// user can check / download / apply / skip a new release without
// leaving the chat session.
export { createUpdateCommand } from '@/commands/cmd-update';
export type { UpdateCommandDeps, UpdaterFacade } from '@/commands/cmd-update';
// UPDATE-CMD-SECTION-END

// METRICS-CMD-SECTION — `/metrics` opens the opt-in local-only metrics
// dashboard (tool success rate, cache-hit %, avg turn duration, cost
// per model, top expensive sessions). Off by default; flip
// `[telemetry] enabled = true` in `~/.localcode/config.toml` to switch
// on the aggregator. `/metrics export` writes a JSON snapshot to
// `~/.localcode/metrics-<date>.json` for power users. Data NEVER leaves
// the user's machine.
export { createMetricsCommand } from '@/commands/cmd-metrics';
export type { MetricsCommandDeps } from '@/commands/cmd-metrics';
// METRICS-CMD-SECTION-END

// MARKETPLACE-CMD-SECTION — `/skills browse` + `/mcp browse` fetch +
// install entries from public upstream catalogs (Anthropic skills,
// modelcontextprotocol/servers). Both commands hand off to the shared
// `MarketplaceOverlay` UI when the host injects an opener.
export {
  createSkillsBrowseCommand,
  createMcpBrowseCommand,
} from '@/commands/cmd-marketplace';
export type {
  SkillsBrowseDeps,
  McpBrowseDeps,
} from '@/commands/cmd-marketplace';
// MARKETPLACE-CMD-SECTION-END

export type {
  AgentDeps,
  AgentLLM,
  AgentContextManager,
  AgentToolExecutor,
  AgentConfirm,
  AgentState,
  AgentStatus,
} from '@/commands/cmd-agent';

/**
 * Bundle of already-constructed built-in commands. Agent 8 passes this
 * into `registerBuiltinCommands` after wiring up each factory with its
 * concrete deps.
 *
 * Fields are optional so callers can register a subset (e.g. during tests
 * or partial wiring) — missing entries are simply skipped.
 */
export interface BuiltinCommandFactories {
  init?: SlashCommand;
  model?: SlashCommand;
  resume?: SlashCommand;
  context?: SlashCommand;
  clear?: SlashCommand;
  permissions?: SlashCommand;
  ctxsize?: SlashCommand;
  newSkill?: SlashCommand;
  /** Round-4 (FIX #33) — `/provider`. Optional so older wiring keeps working. */
  provider?: SlashCommand;
  /** Round-5 (FIX #34) — `/compress`. Optional. */
  compress?: SlashCommand;
  /** Round-5 (FIX #35) — `/settings`. Optional. */
  settings?: SlashCommand;
  /** Round-6 (FIX #36) — `/diff`. Pure git wrapper, no LLM call. Optional. */
  diff?: SlashCommand;
  /** Round-6 (FIX #36) — `/review`. One-shot model review. Optional. */
  review?: SlashCommand;
  /** ROADMAP #10 — `/plan`. Two-phase generation. Optional. */
  plan?: SlashCommand;
  /** ROADMAP #16 — `/agent`. Agentic loop. Optional. */
  agent?: SlashCommand;
  /** Memory system — `/memory`. Lists project memory entries. Optional. */
  memory?: SlashCommand;
  /**
   * Wave 6 — `/memory-save <id>`. Persists a staged feedback proposal
   * produced by `AutoFeedbackDetector`. Optional — only wired when
   * the host hands the command bag a `FeedbackStagingArea`.
   */
  memorySave?: SlashCommand;
  /** todo_write — `/todos`. Read-only session task list display. Optional. */
  todos?: SlashCommand;
  /**
   * `/profile` — switch the active permission profile. Optional so
   * older wiring (tests, partial harnesses) compiles unchanged.
   */
  profile?: SlashCommand;
  /**
   * `/spawn` — launch a sub-agent from the curated catalog. Optional —
   * wiring is only required when the agent orchestrator is enabled.
   */
  spawn?: SlashCommand;
  /** `/statusline` — view or edit the assistant footer template. */
  statusline?: SlashCommand;
  /** `/style` — switch the active output style preamble. */
  style?: SlashCommand;
  /**
   * `/wakeups` — list and cancel pending in-session wakeups scheduled
   * via the `schedule_wakeup` tool. Optional — wiring is only required
   * when the in-process wakeup registry is exposed to the command bag.
   */
  wakeups?: SlashCommand;
  /**
   * `/undo` — roll back recent file mutations from the in-memory
   * snapshot stack. Optional — wiring is only required when the host
   * exposes a `FileSnapshotStack` to the command bag.
   */
  undo?: SlashCommand;
  /**
   * `/worktrees` — inspect or prune sub-agent git worktrees. Optional —
   * wiring is only required when the host exposes the orchestrator's
   * `WorktreeGC` to the command bag.
   */
  worktrees?: SlashCommand;
  /** `/usage` — cross-session token/cost dashboard. */
  usage?: SlashCommand;
  /** `/cost` — current-session per-turn cost breakdown. */
  cost?: SlashCommand;
  /** `/perf` (alias `/tokens`) — live token visualiser overlay. */
  perf?: SlashCommand;
  /** `/tokens` — alias for `/perf`. */
  tokens?: SlashCommand;
  /** `/filter` — output visibility presets (6A2). */
  filter?: SlashCommand;
  // BRANCHES-REGISTRY-FIELD — `/branch` (fork / switch / delete).
  branch?: SlashCommand;
  /**
   * Automation D6 — `/record` (start|stop|save|list). Optional — only
   * wired when the host exposes a `Recorder` to the command bag.
   */
  record?: SlashCommand;
  /**
   * Automation D6 — `/replay <file>`. Optional — only wired when the
   * host exposes a `Player` + replay dispatch to the command bag.
   */
  replay?: SlashCommand;
  /**
   * Automation D6 — `/cron` (list|add|remove|enable|disable). Optional
   * — the persistent store path defaults to `~/.localcode/crons.json`
   * even without a scheduler wired.
   */
  cron?: SlashCommand;
  // PLUGIN-CMD-SECTION
  /**
   * Wave 6D — `/plugin <list|info|enable|disable|reload>`. Optional —
   * wired when the host exposes a `PluginRegistry` to the command bag.
   */
  plugin?: SlashCommand;
  // PLUGIN-CMD-SECTION-END
  // CONV-CMD-SECTION
  /**
   * Wave 6D — `/conv diff`. Optional — wired when the host has a
   * `SessionManager` available (any session-aware build).
   */
  conv?: SlashCommand;
  // CONV-CMD-SECTION-END
  // ARCH-CMD-SECTION
  /**
   * `/arch` — architecture rules check / scaffold. Optional — only
   * wired when the host wants layering enforcement.
   */
  arch?: SlashCommand;
  // ARCH-CMD-SECTION-END
  // ONTOLOGY-CMD-SECTION
  /**
   * `/ontology` — status / refresh / graph. Optional — wired when the
   * host exposes an `OntologyIndexer` to the command bag.
   */
  ontology?: SlashCommand;
  // ONTOLOGY-CMD-SECTION-END
  // SECRETS-CMD-SECTION
  /**
   * `/secrets` — scan staged diff or all tracked files for credentials.
   * Optional — always safe to wire even when the user disables the
   * built-in scanner via `security.secretScanner.enabled = false`.
   */
  secrets?: SlashCommand;
  // SECRETS-CMD-SECTION-END
  // SENSITIVE-CMD-SECTION
  /**
   * `/sensitive` — list / add / check the sensitive-files catalog.
   * Optional — always safe to wire; the underlying loader degrades to
   * the built-in defaults catalog when no overlay files are present.
   */
  sensitive?: SlashCommand;
  // SENSITIVE-CMD-SECTION-END
  // WATCH-COMMANDS-SECTION
  /**
   * `/watch` — register / list / tail / stop long-running processes the
   * model can observe. Optional — wired automatically by hosts that
   * include the process monitor in the runtime.
   */
  watch?: SlashCommand;
  /**
   * `/diagnose` — run the diagnoser against watched processes and
   * surface synthetic system messages describing the most recent
   * failure. Optional — pairs with `/watch`.
   */
  diagnose?: SlashCommand;
  // WATCH-COMMANDS-SECTION-END
  // WHITEBOARD-CMD-SECTION
  /**
   * `/whiteboard` — open the web whiteboard. Web-only feature; the TUI
   * registers a friendly stub so the command is discoverable from
   * `/help` and `/api/commands`.
   */
  whiteboard?: SlashCommand;
  // WHITEBOARD-CMD-SECTION-END
  // LAN-SHARE-CMD-SECTION
  /**
   * `/share` — LAN peer-to-peer session sharing. Subcommands: start /
   * stop / peers / accept. Off by default; opt-in via the `--lan` CLI
   * flag. Optional — wired only when the host injects a
   * `ShareCoordinator` into the command factory deps.
   */
  share?: SlashCommand;
  // LAN-SHARE-CMD-SECTION-END
  // LANGUAGE-CMD-SECTION
  /**
   * `/language` (alias `/lang`) — UI language picker / direct set.
   * Optional — wired by any host that owns the language-picker screen.
   */
  language?: SlashCommand;
  /** Alias for `/language`. */
  lang?: SlashCommand;
  // LANGUAGE-CMD-SECTION-END
  // SITE-CMD-SECTION
  /**
   * `/site` — open the LocalCode landing page in the user's default
   * browser. Pure local action — no LLM round-trip.
   */
  site?: SlashCommand;
  // SITE-CMD-SECTION-END
  // WEB-CMD-SECTION
  /**
   * `/web` — boot the local web UI from inside the TUI and load the
   * current session in the browser. Optional — wiring is only required
   * when the host can launch the embedded web server (which the
   * production composition root in `app.tsx` always can).
   */
  web?: SlashCommand;
  // WEB-CMD-SECTION-END
  // DEMO-TUTORIAL-CMD-SECTION
  /**
   * `/demo` — replay the bundled quick-tour recording inside the chat
   * log. Optional — wired only when the host can supply a
   * `Player` instance + dispatch sink.
   */
  demo?: SlashCommand;
  /**
   * `/tutorial` — re-open the first-run interactive walkthrough
   * overlay. Optional — wired only when the host owns the overlay
   * mount point (the TUI composition root in `src/app.tsx`).
   */
  tutorial?: SlashCommand;
  // DEMO-TUTORIAL-CMD-SECTION-END
  // UPDATE-CMD-SECTION
  /**
   * `/update` — in-session wrapper around the auto-updater singleton.
   * Subcommands: check (no-args), apply, download, skip <version>.
   * Optional — wired only when the host has booted the updater
   * singleton (which the TUI composition root in `src/app.tsx`
   * always does when `updater.enabled !== false`).
   */
  update?: SlashCommand;
  // UPDATE-CMD-SECTION-END
  // METRICS-CMD-SECTION
  /**
   * `/metrics` — opt-in local-only metrics dashboard. Aggregator pulls
   * from `messages` table + crash journals. Subcommand `export` writes
   * `~/.localcode/metrics-<date>.json`. Optional — wiring is only
   * required when the host wants the slash command available; the
   * aggregator itself respects `config.telemetry.enabled` regardless.
   */
  metrics?: SlashCommand;
  // METRICS-CMD-SECTION-END
  // MARKETPLACE-CMD-SECTION
  /**
   * `/skills browse` — fetch the Anthropic skills catalog and open the
   * marketplace overlay so the user can install entries with one
   * keypress. Optional — wired only when the host provides a
   * `MarketplaceOverlay` mount point.
   */
  skillsBrowse?: SlashCommand;
  /**
   * `/mcp browse` — fetch the modelcontextprotocol/servers catalog and
   * open the marketplace overlay for one-keypress install into
   * `~/.localcode/config.toml`. Optional.
   */
  mcpBrowse?: SlashCommand;
  // MARKETPLACE-CMD-SECTION-END
}

/**
 * Register the provided set of built-in commands into the given registry.
 * Returns the registry for chaining.
 */
export function registerBuiltinCommands(
  registry: SlashRegistry,
  factories: BuiltinCommandFactories,
): SlashRegistry {
  const ordered: Array<SlashCommand | undefined> = [
    factories.init,
    factories.model,
    factories.resume,
    factories.context,
    factories.clear,
    factories.permissions,
    factories.ctxsize,
    factories.newSkill,
    factories.provider,
    factories.compress,
    factories.settings,
    factories.diff,
    factories.review,
    factories.plan,
    factories.agent,
    factories.memory,
    factories.memorySave,
    factories.todos,
    factories.profile,
    factories.spawn,
    factories.statusline,
    factories.style,
    factories.wakeups,
    factories.undo,
    factories.worktrees,
    factories.usage,
    factories.cost,
    factories.perf,
    factories.tokens,
    factories.filter,
    // BRANCHES-REGISTRY-ORDER
    factories.branch,
    factories.record,
    factories.replay,
    factories.cron,
    // PLUGIN-CMD-SECTION
    factories.plugin,
    // PLUGIN-CMD-SECTION-END
    // CONV-CMD-SECTION
    factories.conv,
    // CONV-CMD-SECTION-END
    // ARCH-CMD-SECTION
    factories.arch,
    // ARCH-CMD-SECTION-END
    // ONTOLOGY-CMD-SECTION
    factories.ontology,
    // ONTOLOGY-CMD-SECTION-END
    // SECRETS-CMD-SECTION
    factories.secrets,
    // SECRETS-CMD-SECTION-END
    // SENSITIVE-CMD-SECTION
    factories.sensitive,
    // SENSITIVE-CMD-SECTION-END
    // WATCH-COMMANDS-SECTION
    factories.watch,
    factories.diagnose,
    // WATCH-COMMANDS-SECTION-END
    // WHITEBOARD-CMD-SECTION
    factories.whiteboard,
    // WHITEBOARD-CMD-SECTION-END
    // LAN-SHARE-CMD-SECTION
    factories.share,
    // LAN-SHARE-CMD-SECTION-END
    // LANGUAGE-CMD-SECTION
    factories.language,
    factories.lang,
    // LANGUAGE-CMD-SECTION-END
    // SITE-CMD-SECTION
    factories.site,
    // SITE-CMD-SECTION-END
    // WEB-CMD-SECTION
    factories.web,
    // WEB-CMD-SECTION-END
    // DEMO-TUTORIAL-CMD-SECTION
    factories.demo,
    factories.tutorial,
    // DEMO-TUTORIAL-CMD-SECTION-END
    // UPDATE-CMD-SECTION
    factories.update,
    // UPDATE-CMD-SECTION-END
    // METRICS-CMD-SECTION
    factories.metrics,
    // METRICS-CMD-SECTION-END
    // MARKETPLACE-CMD-SECTION
    factories.skillsBrowse,
    factories.mcpBrowse,
    // MARKETPLACE-CMD-SECTION-END
  ];
  for (const cmd of ordered) {
    if (cmd) registry.register(cmd);
  }
  return registry;
}
