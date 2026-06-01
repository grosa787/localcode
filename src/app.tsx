/**
 * Root ink component for LocalCode.
 *
 * Owns top-level state (which screen, app config, session id) and wires every
 * real service (LLM adapter, session manager, tool executor, skills watcher,
 * slash-command registry) to the presentational UI screens built by Agent 4.
 *
 * This file is intentionally the single "composition root" — every other
 * module stays dependency-free. All I/O funnels through callbacks passed to
 * the screens.
 *
 * R2 integration notes (Agent 8 R2):
 *   - LLMAdapter receives `backend`, `contextMaxTokens`, `keepAliveSeconds`,
 *     `stallTimeoutMs` (FIXES #4, #5, #10).
 *   - ToolExecutor receives `autoApproveTools` from config.permissions (FIX #2).
 *   - SkillsManager constructed in two-source mode with projectRoot (FIX #16),
 *     watched in BOTH project-local and global directories.
 *   - ContextManager.buildSystemPrompt invoked with object form carrying the
 *     persisted session summary (FIX #19).
 *   - generateSummary → sessionManager.updateSummary on /clear and session
 *     switch (FIX #19).
 *   - New slash commands registered: /permissions, /ctxsize, /new-skill.
 *   - Skill overlay state + handler (FIX #15).
 *   - Input history + non-blocking pending queue managed via reducer state
 *     and drained in useEffect (FIXES #6, #9).
 *   - Assistant message persistence now carries usage + durationMs telemetry.
 *   - fetch_image tool result → multimodal follow-up user message (FIX #21).
 *   - Exit banner printed in cli.tsx unmount hook (FIX #8).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import chokidar from 'chokidar';
import { execa } from 'execa';

import type {
  AppConfig,
  AutoApprovableTool,
  Backend,
  CommandContext,
  GenerationConfig,
  Message,
  OverlayKind,
  PermissionProfile,
  Screen,
  Session,
  Skill,
  SlashCommand,
  ToolCall,
  ToolResult,
} from '@/types/global';
import type { OverlayState, PendingApproval, ToolCallState } from '@/ui/screens/ChatScreen';
import SkillInputOverlay, {
  type SkillOverlaySubmission,
  type SkillSubmitPayload,
} from '@/ui/components/SkillInputOverlay';
import { buildImageMessage } from '@/types/message';
import ProviderOverlay, {
  type ProviderApiKeys,
  type ProviderUrls,
} from '@/ui/components/ProviderOverlay';
import SettingsOverlay from '@/ui/components/SettingsOverlay';
import { SoundPlayer } from '@/integration/sound';

import OnboardingScreen from '@/ui/screens/OnboardingScreen';
// SPLASH-MOUNT-SECTION — animated first-impression welcome screen.
// Shown only on the very first launch (no config on disk); after the
// splash auto-advances OR the user presses a key, the App falls through
// to the language picker (which then advances to onboarding → chat).
import SplashScreen from '@/ui/screens/SplashScreen';
// SPLASH-MOUNT-SECTION-END
// TUTORIAL-MOUNT-SECTION — interactive first-run walkthrough overlay.
// Shown over the chat screen on the very first session AFTER onboarding
// completes (gated by `config.firstRun?.tutorialShown`). Re-invokable
// on demand via the `/tutorial` slash command.
import TutorialOverlay from '@/ui/overlays/TutorialOverlay';
// PLAN-MODE-OVERLAY-SECTION (import)
import { PlanModeBanner } from '@/ui/overlays/PlanModeOverlay';
// PLAN-MODE-OVERLAY-SECTION (import end)
// TUTORIAL-MOUNT-SECTION-END
// LANGUAGE-PICKER-MOUNT-SECTION — first-launch language picker.
import LanguagePicker from '@/ui/screens/LanguagePicker';
// LOCALE-APPLY-WIRE-SECTION — TUI i18n provider. Wraps every rendered
// screen so the `config.locale` value flows through React context to
// every `useT()` consumer and the slash-command print path (via the
// module-level mirror in `src/i18n/index.ts`).
import { LocaleProvider, t as appT } from '@/i18n';
// LOCALE-APPLY-WIRE-SECTION-END
// LANGUAGE-PICKER-MOUNT-SECTION-END
import ChatScreen from '@/ui/screens/ChatScreen';
import SkillsScreen from '@/ui/screens/SkillsScreen';
import ModelSelectScreen from '@/ui/screens/ModelSelectScreen';

import { LLMAdapter } from '@/llm/adapter';
import { AnthropicAdapter } from '@/llm/adapter-anthropic';
import {
  ContextManager,
  buildCompressPrompt,
  buildPreviewSummaryPrompt,
  estimateContextTokens,
} from '@/llm/context-manager';
import {
  autoCompressCooldownElapsed,
  DEFAULT_AUTO_COMPRESS_COOLDOWN_MS,
  shouldAutoCompress,
} from '@/llm/auto-compress';
import { ToolExecutor } from '@/llm/tool-executor';
import { TOOLS_SCHEMA } from '@/llm/tools-schema';

import {
  createToolHandlerMap,
  getProcessBackgroundTaskRegistry,
} from '@/tools/index';
import type { ToolContext } from '@/tools/types';

import { ConfigManager } from '@/config/config-manager';
import {
  getMaxContextTokens,
  PROVIDER_DEFAULTS,
  resolveApiKey,
} from '@/config/defaults';

import { SessionManager, titleFromFirstMessage } from '@/sessions/session-manager';
import type { Todo } from '@/sessions/session-manager';
import { resetDefaultDb } from '@/sessions/db';
// JOURNAL-RECOVERY-SECTION (imports)
import {
  JournalWriter,
  archiveJournal,
  pruneArchivedJournals,
  recoverableJournals,
  type RecoverableJournal,
} from '@/sessions/journal';
// JOURNAL-RECOVERY-SECTION (imports end)
// SANDBOX-WIRING-SECTION (imports)
import type { SandboxRuntimeConfig } from '@/tools/sandbox/types';
// SANDBOX-WIRING-SECTION (imports end)
// COST-WIRING-SECTION (imports) — Wave 9D next-turn cost forecast.
import {
  DEFAULT_RECENT_OUTPUT,
  estimateNextTurn,
} from '@/llm/cost-estimator';
// COST-WIRING-SECTION (imports end)
// UNDO-SECTION
import { getProcessFileSnapshotStack } from '@/sessions/file-snapshot-stack';
// UNDO-SECTION-END

import { SkillsManager } from '@/skills/skills-manager';
// SKILL-SUGGEST-SECTION (imports)
// Auto-suggest skills based on the current user input. The suggester is
// pure / synchronous; the toast component is render-only. Wiring +
// dismissal timer + Tab/Esc handling live in this composition root.
import {
  suggestSkillsForInput,
  type SkillSuggestion,
} from '@/skills/auto-suggest';
import SkillSuggestionToast from '@/ui/components/SkillSuggestionToast';
// SKILL-SUGGEST-SECTION (imports end)
// MARKETPLACE-WIRING-SECTION (imports) — `/skills browse` + `/mcp browse`.
// Marketplace overlay + catalog fetchers + installers. The overlay
// renders the entries hand-off from cmd-marketplace's `openMarketplace`
// callback and handles its own keystroke loop.
import MarketplaceOverlay, {
  type MarketplaceEntry,
} from '@/ui/overlays/MarketplaceOverlay';
import {
  fetchSkillCatalog,
  installSkill,
} from '@/marketplace/skills-fetcher';
import {
  fetchMcpCatalog,
  installMcpServer,
} from '@/marketplace/mcp-fetcher';
import type {
  MarketplaceFetchResult,
  MarketplaceMcpServer,
  MarketplaceSkill,
} from '@/marketplace/types';
// MARKETPLACE-WIRING-SECTION (imports end)
// METRICS-WIRE-SECTION (imports) — `/metrics` overlay (local-only).
import MetricsOverlay from '@/ui/overlays/MetricsOverlay';
import { snapshot as snapshotMetrics } from '@/telemetry/aggregator';
import type { MetricsSnapshot } from '@/telemetry/types';
// METRICS-WIRE-SECTION (imports end)
// IMPORT-CMD-SECTION (imports) — `/import claude-code` slash command +
// the first-run prompt that surfaces when we detect ~/.claude/projects/
// without any LocalCode sessions yet.
import { createImportCommand } from '@/commands/cmd-import';
import { scanClaudeCode } from '@/migration/from-claude-code';
// IMPORT-CMD-SECTION (imports end)

import { MemoryStore, type MemoryEntry } from '@/memory';
import { renderMemorySection } from '@/llm/memory-prompt';

import {
  SlashRegistry,
  createInitCommand,
  createModelCommand,
  createResumeCommand,
  createContextCommand,
  createClearCommand,
  createPermissionsCommand,
  createProfileCommand,
  createCtxSizeCommand,
  createNewSkillCommand,
  createProviderCommand,
  createCompressCommand,
  createSettingsCommand,
  createDiffCommand,
  createReviewCommand,
  createPlanCommand,
  createAgentCommand,
  createTodosCommand,
  createSpawnCommand,
  createStatuslineCommand,
  createStyleCommand,
  // LANGUAGE-CMD-SECTION — `/language` (alias `/lang`) factory.
  createLanguageCommand,
  // LANGUAGE-CMD-SECTION-END
  // SITE-CMD-SECTION — `/site` opens the landing page in the user's
  // default browser. No deps; pure local action.
  createSiteCommand,
  // SITE-CMD-SECTION-END
  // WEB-CMD-SECTION — `/web` (and `/web stop`) — boot the embedded web
  // UI in-process so the user can continue the current session in their
  // browser without leaving the TUI. The composition root owns the
  // singleton handle below (see WEB-LAUNCH-SECTION).
  createWebCommand,
  // WEB-CMD-SECTION-END
  createWakeupsCommand,
  createUndoCommand,
  createWorktreesCommand,
  // USAGE-COMMANDS-SECTION — start (Wave 6A4 wiring)
  createUsageCommand,
  createCostCommand,
  createPerfCommand,
  createFilterCommand,
  // USAGE-COMMANDS-SECTION — end
  // BRANCHES-MOUNT-SECTION
  createBranchCommand,
  // BRANCHES-MOUNT-SECTION-END
  // PLUGIN-CMD-SECTION (Wave 6D)
  createPluginCommand,
  // PLUGIN-CMD-SECTION-END
  // CONV-CMD-SECTION (Wave 6D)
  createConvCommand,
  // CONV-CMD-SECTION-END
  // MEMORY-SAVE-SECTION (Wave 6 self-evolution)
  createMemoryCommand,
  createMemorySaveCommand,
  // MEMORY-SAVE-SECTION-END
  // DEMO-TUTORIAL-CMD-SECTION — bundled tour replay + first-run overlay.
  createDemoCommand,
  createTutorialCommand,
  // DEMO-TUTORIAL-CMD-SECTION-END
  // UPDATE-CMD-SECTION — `/update` slash command (auto-updater wrapper).
  createUpdateCommand,
  // UPDATE-CMD-SECTION-END
  // METRICS-WIRE-SECTION — `/metrics` factory (Wave 10E).
  createMetricsCommand,
  // METRICS-WIRE-SECTION-END
  // MARKETPLACE-WIRING-SECTION — `/skills browse` + `/mcp browse`.
  createSkillsBrowseCommand,
  createMcpBrowseCommand,
  // MARKETPLACE-WIRING-SECTION-END
  registerBuiltinCommands,
} from '@/commands/index';
// DEMO-TUTORIAL-CMD-SECTION — Player ctor for the in-session `/demo`.
import { Player } from '@/recordings';
// DEMO-TUTORIAL-CMD-SECTION-END
// PROACTIVE-DETECTOR-WIRE-SECTION (Wave 6D imports)
import {
  ProactiveDetector,
  type ProactiveSuggestion,
  type ToolCallObservation,
} from '@/agents/proactive-detector';
import {
  AutoFeedbackDetector,
  getProcessFeedbackStagingArea,
} from '@/memory/auto-feedback';
// PROACTIVE-DETECTOR-WIRE-SECTION-END
import { resolvePrice } from '@/llm/pricing/resolver';
import { refreshOpenRouterPricing } from '@/llm/pricing/openrouter-pricing';
import { computeCostBreakdown } from '@/llm/pricing/cost-calculator';
import type { UsageDashboardData } from '@/ui/overlays/UsageDashboard';
import type { CostTurnRow } from '@/ui/overlays/CostDashboard';
import type { TokenTurnSample } from '@/ui/overlays/TokenVisualizer';

import {
  buildInitPrompt,
  ensureLocalcodeScaffold,
  getLocalcodeMdStatus,
  loadHierarchy,
  readLocalcodeMd,
  writeLocalcodeMd,
} from '@/init/localcode-md';
import { ProjectScanner } from '@/init/project-scanner';

import {
  loadPlugins,
  buildPluginHandlerMap,
  type Plugin,
} from '@/plugins';

import {
  chatReducer,
  initialChatState,
  type ChatAction,
} from '@/integration/chat-state';

import {
  HookEngine,
  type HookSessionEndReason,
  type HookUsageSnapshot,
} from '@/hooks';
import { withBuiltinSecurityHooks } from '@/security';
import { getProcessMcpRegistry } from '@/mcp';
// ONTOLOGY-WIRE-SECTION — background ontology indexer + `/ontology`
// slash command. The indexer is per-project (keyed by projectRoot) and
// owns its LSP child process. Disposed on unmount.
import { OntologyIndexer } from '@/ontology';
import OntologyGraph from '@/ui/overlays/OntologyGraph';
import UpdateOverlay from '@/ui/overlays/UpdateOverlay';
import { createOntologyCommand } from '@/commands';
// ONTOLOGY-WIRE-SECTION-END
// PROCESS-MONITOR-WIRE-SECTION — long-running process registry +
// `/watch` + `/diagnose` slash commands. The monitor is a process-wide
// singleton; disposal on unmount kills every still-running child via
// SIGTERM (then SIGKILL after the grace window). Diagnostic signals
// are forwarded into the chat as synthetic system messages so the
// model can react without the user pasting log lines.
import { getProcessMonitor } from '@/process-monitor';
import type { DiagnosticSignal } from '@/process-monitor';
import {
  buildDiagnosticMessage,
  createDiagnoseCommand,
  createWatchCommand,
} from '@/commands';
// PROCESS-MONITOR-WIRE-SECTION-END
// SECRETS-CMD-SECTION — `/secrets` slash command (scan/scan-all/allow).
import { createSecretsCommand } from '@/commands';
// SECRETS-CMD-SECTION-END
// SENSITIVE-CMD-SECTION — `/sensitive` slash command (list/add/check).
import { createSensitiveCommand } from '@/commands';
// SENSITIVE-CMD-SECTION-END
import {
  getProcessWakeupRegistry,
  setProcessWakeupRegistry,
  WakeupRegistry,
} from '@/scheduling';
import {
  buildMcpToolHandlerMap,
  buildMcpToolSchema,
} from '@/tools/mcp-tool';

// AGENT-PANEL-SECTION (Wave 5A — TA team) — multi-agent orchestrator
// wiring for the TUI. Mirrors the lazy construction pattern from
// `src/web/index.ts`. Kept in a tight import group so future audits can
// see at a glance what the orchestrator brings into the composition
// root.
import { AgentOrchestrator } from '@/agents/orchestrator';
import {
  buildAgentRunnerFactory,
  type WorkerAdapter,
} from '@/agents/runner-factory';
import {
  LEAD_AGENT_ID,
  type TeamBusMessage,
} from '@/agents/types';
import type { AgentToolContext } from '@/tools/agent';
import type { AgentRow } from '@/ui/components/AgentPanel';
import CommandPalette, {
  type PaletteSelection,
  type PaletteCommand,
  type PaletteFile,
  type PaletteSession,
  type PaletteTool,
} from '@/ui/overlays/CommandPalette';
// DIFF-VIEWER-MOUNT-SECTION (Wave 5B / TF4) — full-screen diff viewer
// overlay for `/diff`. The command (cmd-diff.ts) resolves a structured
// `DiffEntry[]` from git and hands it to the viewer via the
// `openViewer` callback we wire below. Like CommandPalette, the viewer
// takes over input fully — see the mount block at the bottom of the
// component for the InputDispatcherProvider + InputPump wrapper that
// gives the viewer its own keystroke pump independent of ChatScreen.
import DiffViewer from '@/ui/overlays/DiffViewer';
import type { DiffEntry } from '@/commands/cmd-diff';
// BATCH-APPROVAL-SECTION (Wave 10D) — unified batch-approval modal
// surfaced when the LLM emits ≥ permissions.batchApprovalThreshold
// mutating tool calls in a single turn. Reviews all diffs at once
// instead of firing N sequential approval prompts. State + mount
// markers below; see BatchApprovalDialog component for the UX.
import BatchApprovalDialog, {
  type BatchApprovalDialogItem,
} from '@/ui/components/BatchApprovalDialog';
import type {
  BatchApprovalCallback,
  BatchApprovalDecision,
  BatchApprovalItem,
} from '@/types/message';
// BATCH-APPROVAL-SECTION-END
// BRANCHES-MOUNT-SECTION (imports)
import { flattenBranchTree as flattenBranchTreeForPicker } from '@/ui/overlays/BranchPicker';
// BRANCHES-MOUNT-SECTION (imports end)
import {
  InputDispatcherProvider,
  useInputDispatcher,
} from '@/ui/components/InputDispatcher';

// ---------- Props ----------

export interface AppProps {
  readonly projectRoot: string;
  readonly dangerouslyAllowAll: boolean;
  readonly resumeSessionId: string | null;
  readonly modelOverride: string | null;
  readonly startScreen: 'splash' | 'onboarding' | 'chat';
  /**
   * R8 (Agent 8) — when true, skip the in-mount startup model refresh
   * effect. Driven by the `--no-refresh-models` CLI flag in cli.tsx.
   * Default false (refresh enabled). Optional so standalone tests can
   * omit it without thinking about refresh semantics.
   */
  readonly noRefreshModels?: boolean;
  /**
   * Called right before the app unmounts with the active session id so
   * cli.tsx can print a resume hint to stdout. Optional so standalone
   * tests / alternate hosts can omit it.
   */
  readonly onSessionExit?: (sessionId: string | null) => void;
  /**
   * Optional per-run permission-profile override. When non-null, App
   * persists this onto `config.permissions.profile` on first config
   * load so the executor's `useMemo` (which depends on
   * `config.permissions.profile`) picks it up. Driven by the
   * `--profile <name>` CLI flag in cli.tsx.
   */
  readonly profileOverride?: PermissionProfile | null;
  /**
   * When true, the user passed the legacy `--dangerously-allow-all`
   * flag. App surfaces a one-time deprecation notice in the chat log
   * the first time it has rendered text. Optional / defaulted to false
   * so tests + alt hosts can omit it.
   */
  readonly dangerouslyAllowAllDeprecationNotice?: boolean;
}

// ---------- Small helpers ----------

function newId(prefix: string): string {
  const base = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${base}`;
}

function nowMs(): number {
  return Date.now();
}

// LANGUAGE-PICKER-MOUNT-SECTION — heuristic default for the picker.
/**
 * Best-effort guess at the user's preferred UI language for the
 * first-run highlight. Reads the system locale via Intl; anything that
 * starts with `ru` maps to Russian, otherwise English.
 *
 * The picker still shows even when the heuristic produced a confident
 * answer — we just pre-highlight the matching row so the user can
 * confirm with one keystroke.
 */
function detectSystemLocale(): 'en' | 'ru' {
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof tag === 'string' && tag.toLowerCase().startsWith('ru')) {
      return 'ru';
    }
  } catch {
    /* ignored — fall through to default */
  }
  return 'en';
}
// LANGUAGE-PICKER-MOUNT-SECTION-END

/**
 * Cooldown (ms) between auto-compress invocations. Re-exported from
 * `@/llm/auto-compress` so the trigger here and the unit tests in
 * `tests/llm/auto-compress.test.ts` share one source of truth. 60s
 * is conservative: long enough that consecutive compresses don't
 * pile up across a tool-call loop, short enough that a user who
 * manually blew up context can still get a second compress within
 * a minute.
 */
const AUTO_COMPRESS_COOLDOWN_MS = DEFAULT_AUTO_COMPRESS_COOLDOWN_MS;

/**
 * R9 (Agent 8) — system prompt for the AI Writer mode of `/new-skill`.
 *
 * The user's description is sent as a one-shot, isolated request — it
 * does NOT get appended to the chat session's history (the overlay
 * runs in its own ephemeral message pair). The model's job is to emit
 * a complete markdown skill file: optional YAML frontmatter (with at
 * least `name:` so {@link extractFilename} can derive a slug) followed
 * by an opinionated, actionable body in second-person voice.
 *
 * Kept as a top-level constant so unit tests can import it if they
 * need to verify the contract without spinning up the React tree.
 */
const SKILL_WRITER_SYSTEM_PROMPT = `You are a skill writer for LocalCode, a CLI AI coding assistant.

A "skill" is a markdown file with optional YAML frontmatter that gets injected into LocalCode's system prompt to give it specific expertise or behavior. The user will describe what kind of skill they want; you produce a complete markdown file.

Format:
\`\`\`
---
name: <short skill name, kebab-case>
description: <one-sentence summary>
---

<body — markdown content that teaches the AI how to handle the described domain>
\`\`\`

The body should:
- Be concise but specific. 200-600 words is ideal.
- Use second-person ("you") to address the AI assistant.
- Include concrete patterns, library preferences, anti-patterns, and rules.
- Avoid generic platitudes like "write good code" — focus on opinionated, actionable guidance.

Example user prompt: "Frontend skill emphasizing React Server Components, no client boilerplate"

Example output:
\`\`\`
---
name: frontend-rsc
description: Frontend expertise centered on React Server Components and server-first architecture.
---

# Frontend (Server-First)

You favor React Server Components for all data-bound UI. Default to async server components; reach for 'use client' only when interactivity demands it (forms, hover state, modals).

## Patterns
- Fetch in the component itself — no SWR/React Query unless the data is interactive.
- Streaming via Suspense boundaries...

## Anti-patterns
- Don't wrap entire pages in 'use client'...

...
\`\`\`

Now respond ONLY with the markdown file content (frontmatter + body). No preamble, no code fence, no commentary.`;

/** Regex for http(s) image URLs used to nudge the model towards fetch_image. */
const IMAGE_URL_RE = /(https?:\/\/\S+\.(?:png|jpe?g|gif|webp))(?:\?\S*)?/i;

/**
 * Pattern for a "clean" slash-command identifier — the first segment
 * after `/` must start with a letter and contain only ASCII letters,
 * digits, hyphens, and underscores. Mirrors the matcher in
 * `ChatScreen.classifySubmit`.
 */
const SLASH_CLEAN_IDENT_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

// UPDATER-WIRE-SECTION
// PKG_VERSION mirror — kept in sync with `PKG_VERSION` in src/cli.tsx
// and the `version` field in package.json. The single-source-of-truth
// is package.json; cli.tsx + this module both copy the literal so the
// embedded bundle never reads from disk. CI / test
// `tests/cli/version-sync.test.ts` (existing) covers the drift.
const PKG_VERSION_FOR_UPDATER = '0.19.0';
// UPDATER-WIRE-SECTION-END

/**
 * R6 (Agent 8) — defense-in-depth heuristic. Returns `true` when the
 * trimmed text "looks like" a slash command and therefore should NOT
 * be forwarded to the LLM if it leaks past the ChatScreen router.
 *
 * Conservative by design — only command-shaped inputs are blocked.
 * Path-shaped inputs (`/Users/...`, `/var/log/...`, `/usr/local/...`)
 * fall through to the model so the user can paste paths/URLs into the
 * chat without the slash router eating them.
 *
 * Pre-conditions:
 *   - `trimmed` is the result of `text.trim()`.
 *   - `trimmed.startsWith('/')` and `!trimmed.startsWith('//')`.
 *
 * Exported for unit tests in `tests/llm/slash-routing-r6.test.ts`.
 */
export function isCommandShape(trimmed: string): boolean {
  const rest = trimmed.slice(1);
  // Bare `/` — definitely command-shape.
  if (rest.length === 0) return true;
  const spaceIdx = rest.search(/\s/);
  const firstWord = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  if (!SLASH_CLEAN_IDENT_RE.test(firstWord)) return false;
  // Clean-ident first segment AND no further `/` after the first
  // word → command shape (e.g. `/permissions add write_file`).
  // If there's another `/` (anywhere in `rest`, including the first
  // word's region — but a clean ident has no `/`, so it must be in
  // args), assume the user pasted a path with a deceptive prefix.
  return !rest.includes('/');
}

interface ToolCallWithResult {
  readonly toolCall: ToolCall;
  readonly result: ToolResult;
}

/**
 * R12 (Agent 8) — runtime extension shape for assistant messages that
 * carry the streamed `<think>...</think>` reasoning. The canonical
 * `Message` interface in `src/types/global.d.ts` is owned by another
 * round, so we attach `thinking` here at the call-site via a structural
 * extension rather than amending the global type. The extra field is
 * carried through the chat reducer (`messages: readonly Message[]`)
 * without TypeScript noticing — readers that need it (committed-
 * message UI follow-up by Agent 4 R16) can narrow to this shape.
 *
 * Empty / `undefined` thinking is normalised to `undefined` so the
 * key is omitted entirely, keeping legacy snapshots and DB rows
 * untouched on streams that produced no thinking content.
 */
interface MessageWithThinking extends Message {
  readonly thinking?: string;
}

/**
 * R12 (Agent 8) — attach accumulated thinking content to an assistant
 * message. Returns the original reference unchanged when the buffer is
 * empty so call-sites that don't need thinking don't pay an allocation.
 */
function withThinking(msg: Message, thinking: string): Message {
  if (thinking.length === 0) return msg;
  const extended: MessageWithThinking = { ...msg, thinking };
  // Cast back to `Message` so the rest of the pipeline (contextManager,
  // sessionManager, reducer) keeps its existing type contract. The
  // structural extension survives the cast at runtime.
  return extended as Message;
}

// ---------- Adapter factory ----------

/**
 * R12 (Agent F) — common type for any LLM adapter constructed via
 * {@link createAdapter}. Both adapters expose the same call-shape for
 * `streamChat`, `getModels`, `ping`, and `cancel`, so call sites that
 * only use these four methods are interchangeable. The few extras
 * (`LLMAdapter.streamMultiple`) are not used here — `app.tsx` never
 * dereferences them.
 */
type AnyAdapter = LLMAdapter | AnthropicAdapter;

// APPROVAL-BATCH-SECTION
/**
 * Argument shape accepted by `pendingResolverRef`. Either:
 *   - a plain `boolean` (legacy / `[y]`/`[n]` path), or
 *   - an `ApprovalDecision`-shaped object (carries `approveAllInTurn`
 *     / `approveForSession` flags fired by the `[A]`/`[S]` buttons).
 */
type ApprovalResolverArg =
  | boolean
  | {
      readonly approved: boolean;
      readonly approveAllInTurn?: boolean;
      readonly approveForSession?: boolean;
    };
// APPROVAL-BATCH-SECTION-END

/**
 * Inputs accepted by {@link createAdapter}. Mirrors the shared subset of
 * `LLMAdapterConfig` and `AnthropicAdapterOptions`. The factory routes
 * `'anthropic'` to {@link AnthropicAdapter} (which requires an apiKey)
 * and every other backend to {@link LLMAdapter} via its OpenAI-compat
 * code path. Cloud OpenAI-compat providers (`openai`, `openrouter`,
 * `google` once supported, `custom`) flow into the LM Studio shape with
 * the apiKey forwarded as `Authorization: Bearer …` by the adapter.
 */
interface CreateAdapterOptions {
  readonly backend: Backend;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextMaxTokens?: number;
  readonly keepAliveSeconds?: number;
  readonly responseTimeoutSeconds?: number;
  readonly generation?: GenerationConfig;
  readonly trimToolResultsAfter?: number;
  readonly chunkBatchMs?: number;
  readonly useJsonMode?: boolean;
  readonly adaptiveTemperature?: boolean;
  readonly customHeaders?: Record<string, string>;
  readonly dumpFailedRequests?: boolean;
}

/**
 * Build the right adapter for the given backend.
 *
 * - `'anthropic'` → {@link AnthropicAdapter} (Messages API, x-api-key
 *   auth, hardcoded model list). Throws inside the constructor when the
 *   apiKey or model is missing — caller must surface that.
 * - everything else → {@link LLMAdapter} on the shared OpenAI-compat
 *   path. Local providers (`ollama`, `lmstudio`) ignore `apiKey`; cloud
 *   providers forward it as `Authorization: Bearer <key>`. The exact
 *   wire shape is decided inside the adapter based on `backend`.
 *
 * The factory is a plain top-level function so call sites can invoke it
 * inside a `useMemo` (the closure body) without dragging the helper into
 * the dep list.
 */
function createAdapter(opts: CreateAdapterOptions): AnyAdapter {
  if (opts.backend === 'anthropic') {
    return new AnthropicAdapter({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey ?? '',
      model: opts.model,
      contextMaxTokens: opts.contextMaxTokens,
      generation: opts.generation,
      stallTimeoutMs:
        opts.responseTimeoutSeconds !== undefined
          ? opts.responseTimeoutSeconds * 1000
          : undefined,
      customHeaders: opts.customHeaders,
    });
  }
  return new LLMAdapter({
    backend: opts.backend,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    contextMaxTokens: opts.contextMaxTokens,
    keepAliveSeconds: opts.keepAliveSeconds,
    stallTimeoutMs:
      opts.responseTimeoutSeconds !== undefined
        ? opts.responseTimeoutSeconds * 1000
        : undefined,
    generation: opts.generation,
    trimToolResultsAfter: opts.trimToolResultsAfter,
    chunkBatchMs: opts.chunkBatchMs,
    useJsonMode: opts.useJsonMode,
    adaptiveTemperature: opts.adaptiveTemperature,
    customHeaders: opts.customHeaders,
    dumpFailedRequests: opts.dumpFailedRequests,
  });
}

// ---------- Root component ----------

function App(props: AppProps): React.JSX.Element {
  const {
    projectRoot,
    dangerouslyAllowAll,
    resumeSessionId,
    modelOverride,
    startScreen,
    noRefreshModels = false,
    onSessionExit,
    profileOverride = null,
    dangerouslyAllowAllDeprecationNotice = false,
  } = props;

  const { exit } = useApp();

  // ---------- Core state ----------
  const [screen, setScreen] = useState<Screen>(startScreen);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoadError, setConfigLoadError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // todo_write — in-memory mirror of the active session's current todos.
  // Loaded from DB on /resume; updated by the tool handler.
  const [sessionTodos, setSessionTodos] = useState<readonly Todo[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [skills, setSkills] = useState<readonly Skill[]>([]);
  // Memory entries loaded from `<projectRoot>/.localcode/memory/`. Kept
  // as React state so the watcher can trigger a fresh `buildSystemMessage`
  // closure on each turn without restarting the session.
  const [memoryEntries, setMemoryEntries] = useState<readonly MemoryEntry[]>([]);
  const [chatLog, setChatLog] = useState<readonly string[]>([]);
  const [slashCommands, setSlashCommands] = useState<readonly SlashCommand[]>([]);
  // ONTOLOGY-WIRE-SECTION — overlay state for `/ontology graph <sym>`.
  // `null` keeps the overlay closed. Set by the command handler;
  // cleared on the overlay's onClose callback.
  const [ontologyGraphSymbol, setOntologyGraphSymbol] = useState<string | null>(null);
  // ONTOLOGY-WIRE-SECTION-END
  // UPDATE-OVERLAY-MOUNT-SECTION
  // Holds the most-recent `update-available` payload from the updater
  // singleton. When non-null the full-screen <UpdateOverlay> mounts above
  // the chat. `Esc` / "Later" clears it (without persistence); "Install"
  // forwards to the updater's download path; "Skip" persists.
  const [updateOverlayInfo, setUpdateOverlayInfo] = useState<{
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    releaseName: string;
    body: string;
  } | null>(null);
  const [updateDownloadedVersion, setUpdateDownloadedVersion] = useState<string | null>(null);
  const updaterRef = useRef<{
    skipVersion(v: string): Promise<void>;
    dismissUntil(t: number): void;
    downloadLatest(): Promise<{ ok: boolean; error?: string }>;
    // UPDATE-CMD-SECTION — `/update` subcommands also touch these
    // methods. Kept on the same ref so the slash command can read the
    // current updater singleton without crossing module boundaries.
    getState(): import('@/updater').UpdateState;
    checkNow(): Promise<import('@/updater').UpdateState>;
    applyPending(): Promise<{ ok: boolean; appliedVersion?: string; error?: string }>;
    // UPDATE-CMD-SECTION-END
  } | null>(null);
  // UPDATE-OVERLAY-MOUNT-SECTION-END

  // TUTORIAL-MOUNT-SECTION — interactive walkthrough overlay state.
  // `null` keeps the overlay closed; setting non-null mounts it over
  // the chat screen until the user presses Esc / Enter past the final
  // step. Fires automatically on first chat-screen render when
  // `config.firstRun?.tutorialShown !== true`; re-shown on demand via
  // the `/tutorial` slash command. The composition root owns both
  // halves so the persistence write only happens on dismiss.
  const [tutorialOpen, setTutorialOpen] = useState<boolean>(false);
  const tutorialAutoTriggeredRef = useRef<boolean>(false);
  // TUTORIAL-MOUNT-SECTION-END

  // Chat-screen state (messages / streaming / approvals / history / queue).
  const [chatState, chatDispatch] = useReducer(chatReducer, initialChatState);

  // SKILL-SUGGEST-SECTION (state) — list of suggestion toasts surfaced
  // above the chat input. Populated on every submit; cleared by Esc /
  // Tab activation / 8s auto-dismiss timer.
  const [skillSuggestions, setSkillSuggestions] = useState<
    readonly SkillSuggestion[]
  >([]);
  // SKILL-SUGGEST-SECTION (state end)

  // MARKETPLACE-WIRING-SECTION (state) — overlay payload for
  // `/skills browse` and `/mcp browse`. `null` keeps the overlay closed.
  type MarketplaceState =
    | {
        readonly mode: 'skills';
        readonly result: MarketplaceFetchResult<MarketplaceSkill>;
      }
    | {
        readonly mode: 'mcp';
        readonly result: MarketplaceFetchResult<MarketplaceMcpServer>;
      };
  const [marketplaceState, setMarketplaceState] =
    useState<MarketplaceState | null>(null);
  const [marketplaceInfo, setMarketplaceInfo] = useState<string | null>(null);
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState<boolean>(false);
  // MARKETPLACE-WIRING-SECTION (state end)

  // METRICS-WIRE-SECTION (state) — opened by `/metrics`; null keeps the
  // overlay closed. Refresh re-aggregates the snapshot in place.
  const [metricsOverlayData, setMetricsOverlayData] =
    useState<MetricsSnapshot | null>(null);
  const [metricsRefreshing, setMetricsRefreshing] = useState<boolean>(false);
  // METRICS-WIRE-SECTION (state end)

  // IMPORT-FIRST-RUN-SECTION (state) — controls the one-time prompt
  // shown on first launch when ~/.claude/projects/ exists with content
  // and the user hasn't dismissed it yet (`migration.claudeCodeDismissed`).
  const [importPromptOpen, setImportPromptOpen] = useState<boolean>(false);
  const importPromptCheckedRef = useRef<boolean>(false);
  // IMPORT-FIRST-RUN-SECTION (state end)

  // TOKEN-VISUALIZER-SAMPLES-SECTION (Wave 6A4) — ring buffer of the
  // last `TOKEN_SAMPLES_RING_SIZE` assistant turns + the matching cost
  // rows. Used by `/perf` (sparklines) and `/cost` (per-turn table).
  // The reducer would be a natural home for these, but
  // (a) we only need them inside the host (no consumers in tests),
  // (b) the data is purely view-time aggregation derived from stream
  //     completion telemetry, and
  // (c) keeping it in plain React state means the chat-state
  //     byte-stability tests stay clean.
  const TOKEN_SAMPLES_RING_SIZE = 20;
  const [perfSamples, setPerfSamples] = useState<readonly TokenTurnSample[]>(
    [],
  );
  const [costSampleRows, setCostSampleRows] = useState<readonly CostTurnRow[]>(
    [],
  );
  const turnCounterRef = useRef<number>(0);
  // TOKEN-VISUALIZER-SAMPLES-SECTION — end

  // USAGE-OVERLAY-STATE-SECTION (Wave 6A4) — async refresh state for
  // the cross-session usage dashboard. The dashboard re-renders the
  // moment data flips so r-refresh feels instant. Numbers are
  // recomputed in `usageDashboardData` below on every render.
  const [usageRefreshTick, setUsageRefreshTick] = useState<number>(0);
  const [usageRefreshing, setUsageRefreshing] = useState<boolean>(false);
  // USAGE-OVERLAY-STATE-SECTION — end

  /**
   * Bump counter incremented whenever
   * `<projectRoot>/.localcode/settings.json` changes on disk (FIX #35).
   * Wired into the LLMAdapter `useMemo` key so a fresh adapter — with
   * the latest resolved generation params — is built whenever the user
   * edits the file directly or via `/settings`.
   */
  const [projectSettingsTick, setProjectSettingsTick] = useState<number>(0);

  /**
   * Agent F (ROADMAP — Tier 3 plugins): plugins discovered under
   * `~/.localcode/plugins/` and `<projectRoot>/.localcode/plugins/`.
   * Loaded once per `projectRoot` change. Each plugin contributes one
   * or more tools that are merged into the executor's handler map
   * below. Failures inside `loadPlugins` are swallowed by the loader
   * (which emits per-file warnings via `onLoadError`); on a global
   * loader explosion we just keep the empty list and continue.
   */
  const [plugins, setPlugins] = useState<readonly Plugin[]>([]);
  /**
   * Records that we've already announced the plugin set in the chat
   * log for the current `projectRoot`. Without this, a re-render that
   * happens to redeliver the same plugins would re-emit the
   * "Loaded N plugins" line.
   */
  const pluginsAnnouncedRef = useRef<boolean>(false);

  // ---------- Services ----------
  const configManager = useMemo(() => new ConfigManager(), []);
  const sessionManager = useMemo(() => new SessionManager(), []);

  // JOURNAL-RECOVERY-SECTION (state)
  // Per-session crash-resilient journal writer. One per active session;
  // owned by this composition root so the lifecycle matches App's
  // mount/unmount cleanly. The writer fires `message_committed` events
  // via `SessionManager.attachJournal(sid, writer)` after each row
  // lands, plus a terminal `session_end` on clean close so the recovery
  // scan on next startup skips this session.
  const journalWriterRef = useRef<JournalWriter | null>(null);
  // Recovery prompt state. Populated once on mount from
  // `recoverableJournals()`; non-empty list mounts the overlay above
  // the rest of the chat tree. `null` (initial) → "scan not done yet";
  // `[]` → "scan done, nothing to recover".
  const [recoverableList, setRecoverableList] =
    useState<readonly RecoverableJournal[] | null>(null);
  const recoveryScanDoneRef = useRef<boolean>(false);
  // JOURNAL-RECOVERY-SECTION (state end)

  // AGENT-PANEL-SECTION (Wave 5A — TA team)
  // -----------------------------------------------------------------
  // Multi-agent orchestrator — one instance per TUI process (mirrors
  // the per-process pattern in `src/web/index.ts`). Constructed lazily
  // through a ref so the factory closes over the *latest* config + the
  // backend-specific adapter at spawn time rather than at App-mount
  // time.
  //
  // The orchestrator owns the runner factory which itself reaches
  // back into ConfigManager / SessionManager via the lazy getter. This
  // matches the orchestrator contract: callers inject `runnerFactory`,
  // the orchestrator never imports ChatRuntime directly. The TUI's
  // runner is a stripped-down clone of the web's — same WorkerAdapter
  // construction, same auto-approve list, no per-session WS event bus
  // (worker output reaches the UI via direct orchestrator events).
  const agentOrchestratorRef = useRef<AgentOrchestrator | null>(null);
  const getAgentOrchestrator = useCallback((): AgentOrchestrator => {
    const existing = agentOrchestratorRef.current;
    if (existing !== null) return existing;
    const cfg = configRef.current ?? configManager.read();
    // LM Studio defaults to 3 parallel slots; everything else keeps the
    // schema default of 5. The check is on the active backend at
    // construction time — switching backend mid-session does NOT
    // re-derive this (rare path; the schema's `maxConcurrent` already
    // ships a safe default).
    const isLmStudio = cfg.backend.type === 'lmstudio';
    const fallbackMaxConcurrent = isLmStudio ? 3 : 5;
    const agentsCfg = cfg.agents ?? {
      workerModel: cfg.model.current,
      maxConcurrent: fallbackMaxConcurrent,
      isolation: 'worktree' as const,
      approval: 'auto' as const,
      defaultTimeoutSec: 600,
    };
    const created = new AgentOrchestrator({
      projectRoot,
      config: agentsCfg,
      runnerFactory: buildAgentRunnerFactory({
        orchestrator: () => getAgentOrchestrator(),
        sessionManager,
        configManager,
        createAdapterForModel: (model: string): WorkerAdapter => {
          // Reuse the active backend baseUrl + key. LM Studio's
          // OpenAI-compat shim handles parallel slot allocation server-
          // side, so workers can share the same baseUrl.
          const fresh = configRef.current ?? configManager.read();
          if (fresh.backend.type === 'anthropic') {
            const key =
              fresh.backend.apiKey ?? resolveApiKey('anthropic') ?? '';
            return new AnthropicAdapter({
              baseUrl: fresh.backend.baseUrl,
              model,
              apiKey: key,
            });
          }
          const adapterCfg: ConstructorParameters<typeof LLMAdapter>[0] = {
            baseUrl: fresh.backend.baseUrl,
            model,
            backend: fresh.backend.type,
          };
          if (
            fresh.backend.apiKey !== undefined &&
            fresh.backend.apiKey.length > 0
          ) {
            adapterCfg.apiKey = fresh.backend.apiKey;
          }
          if (fresh.backend.customHeaders !== undefined) {
            adapterCfg.customHeaders = fresh.backend.customHeaders;
          }
          return new LLMAdapter(adapterCfg);
        },
        resolveProjectRoot: (parentSessionId: string): string | null => {
          const sess = sessionManager.getSession(parentSessionId);
          return sess !== null ? sess.projectRoot : null;
        },
        resolveBackend: () => {
          const fresh = configRef.current ?? configManager.read();
          return fresh.backend.type;
        },
      }),
    });
    agentOrchestratorRef.current = created;
    return created;
  }, [projectRoot, sessionManager, configManager]);

  // Dispose orchestrator on unmount so worktree cleanup runs and
  // long-running workers are cancelled (matches web's SIGINT path).
  useEffect(() => {
    return () => {
      const orch = agentOrchestratorRef.current;
      if (orch === null) return;
      void orch.disposeAll().catch(() => { /* best-effort */ });
      agentOrchestratorRef.current = null;
    };
  }, []);

  // WORKTREE-GC-STARTUP-SECTION
  // Sweep stale sub-agent worktrees left behind by previous crashed
  // runs. Fire-and-forget so a slow `git worktree remove` never blocks
  // the TUI. Errors are swallowed — the GC is non-essential.
  useEffect(() => {
    const orch = agentOrchestratorRef.current ?? getAgentOrchestrator();
    void orch
      .getWorktreeGC()
      .gcOrphans(projectRoot)
      .then((res) => {
        if (res.removed.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[worktree-gc] removed ${res.removed.length} stale worktree(s)`,
          );
        }
      })
      .catch(() => {
        /* best-effort */
      });
  }, [projectRoot, getAgentOrchestrator]);
  // WORKTREE-GC-STARTUP-SECTION-END

  // AGENT-PANEL-SECTION (Wave 5A — TA team)
  // -----------------------------------------------------------------
  // Live worker-row state for `<AgentPanel>`. Rebuilt from a
  // `orchestrator.list(sessionId)` snapshot every time the orchestrator
  // fires an event for the current parent session. The composition root
  // is the *only* consumer of orchestrator events on the TUI path; the
  // panel itself is pure presentational (see AgentPanel docstring).
  //
  // The subscription is keyed by sessionId — switching sessions
  // (resume / new session) tears down the previous subscription and
  // immediately re-snapshots the new parent's team.
  const [agentWorkers, setAgentWorkers] = useState<readonly AgentRow[]>([]);

  // CMD-PALETTE-MOUNT-SECTION (Wave 5A — TA team)
  // -----------------------------------------------------------------
  // Command palette open/close state. Trigger sources:
  //   - Ctrl+K from anywhere (the InputDispatcher pump catches it
  //     and dispatches `setPaletteOpen(true)`).
  //   - `/` from an EMPTY composer (ChatScreen would emit this; for
  //     now Ctrl+K is the primary trigger and the registered
  //     `/palette` slash command can also flip the flag if added).
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);

  // DIFF-VIEWER-MOUNT-SECTION (Wave 5B / TF4)
  // -----------------------------------------------------------------
  // Full-screen `<DiffViewer>` overlay state. The `/diff` slash command
  // resolves a `DiffEntry[]` (working-tree vs HEAD, ref-to-ref, or a
  // single file) and hands it off via its `openViewer` callback, which
  // we wire to populate this state. The viewer takes over input fully
  // (see the takeover render block below, before the ChatScreen
  // branch); `q`/`Esc` close it.
  const [diffEntries, setDiffEntries] = useState<readonly DiffEntry[]>([]);
  const [diffOpen, setDiffOpen] = useState<boolean>(false);
  const closeDiffViewer = useCallback((): void => {
    setDiffOpen(false);
    setDiffEntries([]);
  }, []);
  const openDiffViewer = useCallback((entries: readonly DiffEntry[]): void => {
    setDiffEntries(entries);
    setDiffOpen(true);
  }, []);
  // DIFF-VIEWER-MOUNT-SECTION-END

  // Map of agentId -> most-recent visible message text. Lives next to
  // the snapshot because the orchestrator's snapshot() field is updated
  // by the handle itself, but we keep our own copy here so the
  // streaming `agent_team_message` channel can also feed previews.
  const lastMessagesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (sessionId === null) {
      setAgentWorkers([]);
      return undefined;
    }
    const orch = agentOrchestratorRef.current ?? getAgentOrchestrator();
    const refresh = (): void => {
      const handles = orch.list(sessionId);
      const rows: AgentRow[] = handles.map((h) => {
        const snap = h.snapshot();
        const last = lastMessagesRef.current.get(h.agentId);
        const row: AgentRow = {
          agentId: h.agentId,
          // Prefer template id (if encoded in task header `[role: …]`)
          // else fall back to model name so the row is never blank.
          label:
            extractTemplateLabel(h.task) ?? (h.model.length > 0 ? h.model : 'worker'),
          status: snap.status,
          ...(last !== undefined && last.length > 0 ? { lastMessage: last } : {}),
        };
        return row;
      });
      setAgentWorkers(rows);
    };
    refresh();
    const unsubscribe = orch.subscribe((evt) => {
      if (evt.sessionId !== sessionId) return;
      if (evt.type === 'agent_status' && evt.lastMessage !== undefined) {
        lastMessagesRef.current.set(evt.agentId, evt.lastMessage);
      }
      if (evt.type === 'agent_team_message' && evt.from !== LEAD_AGENT_ID) {
        // Mirror worker→lead bus messages as a preview so the panel
        // shows the last thing the worker said even if `snapshot()`
        // is stale.
        lastMessagesRef.current.set(evt.from, evt.message);
      }
      refresh();
    });
    return (): void => {
      unsubscribe();
    };
  }, [sessionId, getAgentOrchestrator]);

  // Sound cues (FIX #29) — read from configRef at play time so live
  // config edits (e.g. future overlay) take effect without a rebuild.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const soundPlayer = useMemo(
    () =>
      new SoundPlayer(() => {
        const cfg = configRef.current;
        // Fall back to an everything-off config if we haven't loaded yet;
        // keeps the helper safe at app-boot time.
        if (cfg === null) {
          return {
            enabled: false,
            onCompletion: false,
            onApproval: false,
            onError: false,
            volume: 0,
            completionFile: null,
            approvalFile: null,
            errorFile: null,
          };
        }
        return cfg.sound;
      }),
    [],
  );

  // SkillsManager is scoped to the project root (FIX #16) — project-local
  // skills win, with fallback to global `~/.localcode/skills/`.
  const skillsManager = useMemo(
    () => new SkillsManager({ projectRoot, configManager }),
    [projectRoot, configManager],
  );

  // ONTOLOGY-WIRE-SECTION — per-project ontology indexer. Constructed
  // lazily so test harnesses can override `projectRoot` between
  // renders. The boot effect below kicks the first scan + arms a
  // background re-index loop.
  const ontologyIndexer = useMemo(
    () => new OntologyIndexer({ projectRoot }),
    [projectRoot],
  );
  // ONTOLOGY-WIRE-SECTION-END

  // MemoryStore is per-project. Stored entries live under
  // `<projectRoot>/.localcode/memory/`. The watcher below refreshes
  // `memoryEntries` state on filesystem changes so the system prompt
  // picks up new / edited memory without restarting the session.
  const memoryStore = useMemo(
    () => new MemoryStore(projectRoot),
    [projectRoot],
  );

  // PROACTIVE-DETECTOR-WIRE-SECTION (Wave 6D)
  // ProactiveDetector + AutoFeedbackDetector are heuristic observers
  // that NEVER hit the LLM. They run on the message/tool-call snapshots
  // accumulated in chatState and produce:
  //   - ProactiveSuggestion → rendered as a one-line dim hint above the
  //     InputBar via ChatScreen's <ProactiveSuggestionsPanel/>.
  //   - FeedbackProposal    → staged in the process-wide singleton and
  //     surfaced as a synthetic system note so the user can `/memory-
  //     save <id>` it.
  // Both detectors are pure, allocation-light singletons; we hold them
  // in useMemo with stable deps so re-renders don't churn.
  const proactiveDetector = useMemo(() => new ProactiveDetector(), []);
  const autoFeedbackDetector = useMemo(
    () => new AutoFeedbackDetector(),
    [],
  );
  const feedbackStaging = useMemo(
    () => getProcessFeedbackStagingArea(),
    [],
  );
  const stagedProposalIdsRef = useRef<Set<string>>(new Set());

  // Derived top suggestion. Recomputes whenever the user-message tail
  // or the tool-call state map changes. We extract a compact snapshot
  // (`recentUserMessages`, `recentToolCalls`) to feed `ProactiveDetector
  // .top(...)` so the dependency surface stays small and stable.
  const proactiveSuggestion: ProactiveSuggestion | null = useMemo(() => {
    const userMessages: string[] = [];
    for (const m of chatState.messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        userMessages.push(m.content);
      }
    }
    const toolCalls: ToolCallObservation[] = [];
    for (const state of chatState.toolCallStates.values()) {
      const args = state.args;
      const pathArg =
        typeof args['path'] === 'string'
          ? (args['path'] as string)
          : typeof args['file_path'] === 'string'
            ? (args['file_path'] as string)
            : typeof args['command'] === 'string'
              ? (args['command'] as string)
              : undefined;
      toolCalls.push({
        toolName: state.name,
        ...(pathArg !== undefined ? { path: pathArg } : {}),
      });
    }
    return proactiveDetector.top({
      recentUserMessages: userMessages,
      recentToolCalls: toolCalls,
    });
  }, [chatState.messages, chatState.toolCallStates, proactiveDetector]);

  // AutoFeedbackDetector observation. Fires when a new user message
  // lands at the tail; if the detector returns a proposal, we stage it
  // and append a synthetic system note. The `stagedProposalIdsRef` set
  // guards against double-staging the same message id when the
  // reducer's identity-stable array passes referential equality.
  useEffect(() => {
    const last = chatState.messages[chatState.messages.length - 1];
    if (last === undefined || last.role !== 'user') return;
    if (stagedProposalIdsRef.current.has(last.id)) return;
    let lastAssistant: string | null = null;
    for (let i = chatState.messages.length - 2; i >= 0; i -= 1) {
      const prev = chatState.messages[i];
      if (prev === undefined) continue;
      if (prev.role === 'assistant') {
        lastAssistant = prev.content;
        break;
      }
    }
    const result = autoFeedbackDetector.observe(last.content, lastAssistant);
    if (!result.suggestSavingFeedback || result.suggestedProposal === undefined) {
      return;
    }
    const proposal = result.suggestedProposal;
    stagedProposalIdsRef.current.add(last.id);
    feedbackStaging.stage(proposal);
    setChatLog((prev) => [
      ...prev,
      `Save this as feedback memory? /memory-save ${proposal.id}`,
    ]);
  }, [chatState.messages, autoFeedbackDetector, feedbackStaging]);
  // PROACTIVE-DETECTOR-WIRE-SECTION-END

  // Refs for values read inside callbacks where we don't want stale closures.
  const configRef = useRef<AppConfig | null>(null);
  useEffect(() => { configRef.current = config; }, [config]);

  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  // Reset todos when the session changes (new session starts clean;
  // /resume loads todos from DB in its own branch).
  useEffect(() => {
    if (sessionId === null) {
      setSessionTodos([]);
    } else {
      // Load persisted todos for resumed sessions.
      setSessionTodos(sessionManager.getTodos(sessionId));
    }
  }, [sessionId, sessionManager]);

  const currentSessionRef = useRef<Session | null>(null);
  useEffect(() => { currentSessionRef.current = currentSession; }, [currentSession]);

  const skillsRef = useRef<readonly Skill[]>([]);
  useEffect(() => { skillsRef.current = skills; }, [skills]);

  // Ref-mirror of `memoryEntries` so callbacks captured by `useCallback`
  // (e.g. `buildSystemMessage`) always read the freshest list without
  // re-binding when memory changes.
  const memoryEntriesRef = useRef<readonly MemoryEntry[]>([]);
  useEffect(() => { memoryEntriesRef.current = memoryEntries; }, [memoryEntries]);

  const isStreamingRef = useRef<boolean>(false);
  useEffect(() => { isStreamingRef.current = chatState.isStreaming; }, [chatState.isStreaming]);

  // USAGE-COMMANDS-SECTION — refs that let the slash-command handles
  // read the freshest reducer slice + per-turn cost ring without
  // re-binding the command factory on every render.
  const chatStateRef = useRef(chatState);
  useEffect(() => { chatStateRef.current = chatState; }, [chatState]);
  const costSampleRowsRef = useRef<readonly CostTurnRow[]>([]);
  useEffect(() => { costSampleRowsRef.current = costSampleRows; }, [costSampleRows]);

  // R7 (FIX #8) — ref-mirror of chatState.confirmExitAt so the Ctrl+C
  // useInput callback always reads the freshest timestamp without
  // re-registering on every render.
  const confirmExitAtRef = useRef<number | null>(null);
  useEffect(() => { confirmExitAtRef.current = chatState.confirmExitAt; }, [chatState.confirmExitAt]);

  // Pending approval promise resolver. Populated when the tool-executor
  // asks for approval; resolved by onApprove / onReject from ChatScreen.
  // APPROVAL-BATCH-SECTION — resolver accepts either the legacy boolean
  // form OR the rich `ApprovalDecision` so the `[A]`/`[S]` buttons can
  // pass their flags through to the executor.
  const pendingResolverRef = useRef<((decision: ApprovalResolverArg) => void) | null>(null);

  // BATCH-APPROVAL-SECTION
  // Unified batch-approval modal state. Populated when `executeAll`
  // gathers ≥ threshold mutating calls AND the user wired the
  // `batchApprovalCallback` opt below. The dialog is rendered as a
  // full-takeover overlay (see BATCH-APPROVAL mount block at the
  // bottom of the render function); its `onConfirm` resolves the
  // resolver ref with the per-item Map and clears state.
  const [batchApproval, setBatchApproval] = useState<{
    readonly items: readonly BatchApprovalDialogItem[];
    readonly resolver: (
      decisions: ReadonlyMap<string, BatchApprovalDecision>,
    ) => void;
  } | null>(null);
  // BATCH-APPROVAL-SECTION-END

  // R16 (Agent 8) — refs to the latest preview-summariser callbacks.
  // Initialised to a no-op so the slash-command useEffect (which
  // registers BEFORE the helpers themselves are declared in the
  // function body) can dereference `*Ref.current` without a TDZ
  // hazard. A sync effect further down keeps them pointing at the
  // freshest closures.
  const summariseAndPersistOutgoingRef = useRef<() => Promise<void>>(
    async () => { /* not yet wired */ },
  );
  const summariseFromSnapshotRef = useRef<
    (messages: readonly Message[], sessionIdOverride: string | null) => Promise<void>
  >(async () => { /* not yet wired */ });
  const summariseWithTimeoutRef = useRef<(timeoutMs?: number) => Promise<void>>(
    async () => { /* not yet wired */ },
  );

  // Active LLM adapter abort controller — used by cancel().
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Auto-compress cooldown — timestamp (ms, from `Date.now()`) of the
   * last successful programmatic `/compress` invocation. Held in a ref
   * (instead of state) so it doesn't trigger renders and so unrelated
   * re-mounts never reset the cooldown window. Compared against
   * `AUTO_COMPRESS_COOLDOWN_MS` in `runStreamLoop` after each turn so
   * the trigger fires at most once per minute even if the predicate
   * stays true (e.g. a long tool-call loop on a near-full context).
   * `0` means "no compress yet this app instance".
   */
  const lastAutoCompressAtRef = useRef<number>(0);

  /**
   * Programmatic entry-point for the `/compress` slash command. Set by
   * the slash-registry effect once `createCompressCommand` is wired,
   * then invoked from `runStreamLoop` via the auto-compress trigger.
   * Held in a ref so the trigger always sees the freshest closure even
   * after a `/model` or `/provider` swap rebuilds the registry.
   * `null` means the registry hasn't initialised yet — no-op the trigger.
   */
  const compressExecRef = useRef<
    | ((args: string, ctx: CommandContext) => Promise<void> | void)
    | null
  >(null);

  /**
   * R17 (Agent 8) — per-turn skill override ref. Populated by `onSubmit`
   * AFTER `preprocessUserMessage` resolves the `@-mention` skill set
   * for the current submission, then consumed (and cleared) by
   * `runStreamLoop` when it builds the system message. Holding it in a
   * ref (instead of state) keeps the override out of React's render
   * loop — the value is purely a one-shot handoff between the submit
   * handler and the stream loop.
   *
   * `undefined` means "no override — fall back to the active-skills set".
   */
  const skillsForNextTurnRef = useRef<readonly Skill[] | undefined>(undefined);

  /**
   * Effective generation parameters (FIX #35) — project-level overrides
   * from `<projectRoot>/.localcode/settings.json` layered on top of the
   * global TOML `[generation]` block. Resolved here once per render so
   * both the LLM-adapter memo (key) and the per-stream `options` payload
   * (used at `streamChat` call time) stay in sync.
   *
   * Falls back to a sensible default when config is still loading so
   * `streamChat` can pre-render without throwing.
   */
  const resolvedGeneration = useMemo<GenerationConfig | null>(() => {
    if (config === null) return null;
    try {
      return configManager.resolveGeneration(projectRoot).generation;
    } catch {
      // Fall back to the global generation block on any read failure
      // (e.g. malformed settings.json). Better to use defaults than to
      // brick the adapter.
      return config.generation;
    }
    // projectSettingsTick deliberately included so the memo re-runs
    // whenever the on-disk file changes via the chokidar watcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, configManager, projectRoot, projectSettingsTick]);

  const resolvedGenerationRef = useRef<GenerationConfig | null>(null);
  useEffect(() => {
    resolvedGenerationRef.current = resolvedGeneration;
  }, [resolvedGeneration]);

  // LLM adapter — rebuilt whenever backend / model / context tuning
  // changes so `/ctxsize`, `/model`, and `/provider` take effect live.
  // Keyed on the specific scalar fields rather than the whole config
  // object so unrelated config churn (e.g. toggling sound.enabled)
  // doesn't thrash the adapter. The four generation-param fields and a
  // chokidar tick (FIX #35) are also part of the key so a `/settings`
  // edit OR a direct file edit immediately rebuilds the adapter.
  //
  // R10 (Agent 8): `context.responseTimeoutSeconds` (Agent 5 R7) is now
  // wired through to the adapter's `stallTimeoutMs` knob — multiplied by
  // 1000 to convert seconds → ms. The dep list includes it so a change
  // via the `/ctxsize` overlay rebuilds the adapter immediately.
  const llm = useMemo<AnyAdapter | null>(() => {
    if (config === null) return null;
    // R12 (Agent F): route through `createAdapter` so the Anthropic
    // backend gets its dedicated adapter while every other provider
    // (ollama / lmstudio / openai / openrouter / google* / custom)
    // shares the OpenAI-compat `LLMAdapter`. The apiKey is resolved at
    // build time (explicit config > env-var fallback) so a user with
    // `OPENAI_API_KEY` set in their shell never has to retype it.
    return createAdapter({
      backend: config.backend.type,
      baseUrl: config.backend.baseUrl,
      apiKey: resolveApiKey(config.backend.type, config.backend.apiKey),
      model: modelOverride ?? config.model.current,
      contextMaxTokens: config.context.maxTokens,
      keepAliveSeconds: config.context.keepAliveSeconds,
      responseTimeoutSeconds: config.context.responseTimeoutSeconds,
      generation: resolvedGeneration ?? undefined,
      // Agent F (R26 wiring): forward Agent A's new ctor options.
      //   - trimToolResultsAfter: read from config (Agent D's
      //     `context.trimToolResultsAfter` knob, default 5).
      //   - chunkBatchMs: 30ms is a sensible default that gives ~33
      //     paints/sec while staying inside the ChatScreen render
      //     throttle window.
      //   - useJsonMode: opt-in only — kept OFF until we have a
      //     selector for weak local models that benefit from it.
      //   - adaptiveTemperature: ON — coding-style verbs (write/fix/
      //     implement) get temp=0.1 for determinism, otherwise the
      //     configured base temperature is preserved.
      trimToolResultsAfter: config.context.trimToolResultsAfter,
      chunkBatchMs: 30,
      useJsonMode: false,
      adaptiveTemperature: true,
      customHeaders: config.backend.customHeaders,
      dumpFailedRequests: config.diagnostics?.dumpFailedRequests === true,
    });
  }, [
    config?.backend.type,
    config?.backend.baseUrl,
    config?.backend.apiKey,
    config?.backend.customHeaders,
    config?.model.current,
    config?.context.maxTokens,
    config?.context.keepAliveSeconds,
    config?.context.responseTimeoutSeconds,
    config?.context.trimToolResultsAfter,
    resolvedGeneration,
    modelOverride,
  ]);

  const llmRef = useRef<AnyAdapter | null>(null);
  // R13 (Agent 8) — keep `llmRef` in sync with the latest adapter, but
  // do NOT abort the in-flight stream just because the memo rotated.
  //
  // The previous implementation called `abortControllerRef.current?.abort()`
  // here on every `[llm]` change. That looks defensive ("rotate adapter →
  // kill old stream"), but in practice it became a critical bug: any
  // re-render that produced a new adapter instance — including incidental
  // ones during streaming — would terminate the user's request mid-flight
  // with `(stream error) Request cancelled`.
  //
  // The legitimate cancellation paths are all explicit and remain intact:
  //   - Ctrl+C in `useInput` (line ~1058)
  //   - `onCancel` callback (line ~1628)
  //   - `onProviderApply` (line ~2083) — backend swap aborts on purpose
  //
  // `runStreamLoop` always installs a fresh AbortController at the start
  // of every turn (line ~1266) and clears the ref to null on completion
  // (line ~1348), so there is never a stale controller to leak into a
  // subsequent stream. The old adapter's stream — if any — drains
  // naturally; its `onChunk` writes are append-only into the reducer
  // and a `onDone` from a stale stream cannot resurrect a dispatched
  // `END_STREAM` because `runStreamLoop` reads its own local
  // accumulators (see `accumulated`, `accumulatedThinking`).
  useEffect(() => {
    llmRef.current = llm;
  }, [llm]);

  // Context manager — new shape: summariser + maxInMemoryMessages + session
  // totals. We do NOT rebuild it on every config change (that would wipe
  // the message list); config-dependent options (max tokens, backend) are
  // read at call time.
  const contextManager = useMemo<ContextManager>(() => {
    return new ContextManager({
      summarizeAtPercent: 0.8,
      maxInMemoryMessages: 200,
      summarizer: async (messagesToSummarize: readonly Message[]): Promise<string> => {
        const current = llmRef.current;
        if (current === null) return '';
        const summaryMessages: Message[] = [
          {
            id: newId('sum-sys'),
            role: 'system',
            content:
              'Summarise the following conversation into a concise paragraph ' +
              'that preserves decisions made, files touched, and open questions. ' +
              'Omit small talk.',
            createdAt: nowMs(),
          },
          {
            id: newId('sum-u'),
            role: 'user',
            content: messagesToSummarize
              .map((m) => `${m.role}: ${String(m.content)}`)
              .join('\n\n'),
            createdAt: nowMs(),
          },
        ];
        let out = '';
        await current.streamChat({
          messages: summaryMessages,
          onChunk: (text: string) => {
            out += text;
          },
        });
        return out.trim();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whole-session summariser used on /clear and exit (FIX #19).
  const summarizeAllMessages = useCallback(
    async (messagesToSummarize: readonly Message[]): Promise<string> => {
      const current = llmRef.current;
      if (current === null) return '';
      if (messagesToSummarize.length === 0) return '';
      const rendered = messagesToSummarize
        .map((m) => `${m.role.toUpperCase()}: ${String(m.content)}`)
        .join('\n\n');
      const prompt: Message[] = [
        {
          id: newId('sum-sys'),
          role: 'system',
          content:
            'You are producing a SHORT session summary (<= 500 tokens) for a ' +
            'resume-hint. Capture intent, decisions made, files touched, and ' +
            'unresolved questions. Skip pleasantries.',
          createdAt: nowMs(),
        },
        {
          id: newId('sum-u'),
          role: 'user',
          content: rendered,
          createdAt: nowMs(),
        },
      ];
      let out = '';
      await current.streamChat({
        messages: prompt,
        onChunk: (text: string) => {
          out += text;
        },
      });
      return out.trim();
    },
    [],
  );

  // Hook engine — rebuilt when projectRoot or hooks config changes.
  // Zero-overhead when no hooks are configured (engine short-circuits).
  // SECURITY-CONFIG-SECTION — auto-prepend the built-in secret scanner
  // hook unless explicitly disabled. Default ON for safety.
  const hookEngine = useMemo(
    () =>
      new HookEngine({
        hooks: withBuiltinSecurityHooks(config?.hooks, {
          enabled: config?.security?.secretScanner?.enabled,
        }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectRoot, config?.hooks, config?.security?.secretScanner?.enabled],
  );

  // Ref-tracked hook engine so signal handlers + slash-command closures
  // that captured an earlier instance still fire against the freshest
  // engine after a hot config reload.
  const hookEngineRef = useRef<HookEngine>(hookEngine);
  useEffect(() => {
    hookEngineRef.current = hookEngine;
  }, [hookEngine]);

  /**
   * Fire SessionEnd hooks (fire-and-forget). The hook engine itself
   * runs hooks in parallel and never throws — we still wrap the call
   * in a try/catch so a synchronous engine misconfiguration can't
   * propagate into the calling shutdown / switch path. Returns
   * immediately; the spawned shell commands continue in the
   * background. We do NOT await this so it never consumes the
   * summariser's budget.
   */
  const fireSessionEndHook = useCallback(
    (reason: HookSessionEndReason): void => {
      const engine = hookEngineRef.current;
      if (!engine.hasHooksFor('SessionEnd')) return;
      const sid = sessionIdRef.current;
      try {
        void engine
          .run({
            trigger: 'SessionEnd',
            projectRoot,
            reason,
            ...(sid !== null ? { sessionId: sid } : {}),
          })
          .catch(() => {
            // best-effort; SessionEnd hooks can never keep a session alive.
          });
      } catch {
        // ignore — fire-and-forget contract
      }
    },
    [projectRoot],
  );

  // Ref-track the latest closure so signal handlers registered in the
  // empty-deps useEffect below still fire against the freshest engine.
  const fireSessionEndHookRef = useRef(fireSessionEndHook);
  useEffect(() => {
    fireSessionEndHookRef.current = fireSessionEndHook;
  }, [fireSessionEndHook]);

  // Tool executor — rebuilt when the danger flag toggles OR the user's
  // auto-approve list changes (FIX #2). Agent F: also rebuilt when the
  // plugin list rotates so plugin-contributed tools appear in the
  // executor's handler map without a process restart.
  const toolExecutor = useMemo<ToolExecutor>(() => {
    // AGENT-PANEL-SECTION (Wave 5A — TA team) — the ToolContext is now
    // a superset that includes AgentToolContext so spawn_agent /
    // team_send / team_read / await_agent / agent_status route through
    // the same orchestrator the TUI panel observes. The orchestrator is
    // resolved lazily on each call site so the tools see the freshest
    // instance even after a hot-reload reset clears the ref.
    const ctx: ToolContext & AgentToolContext = {
      projectRoot,
      dangerouslyAllowAll,
      // todo_write — sessionManager is stable (created once). sessionId is
      // read via sessionIdRef so the context stays live across sessions
      // without recreating the executor.
      sessionManager,
      get sessionId() {
        return sessionIdRef.current ?? undefined;
      },
      // schedule_wakeup — singleton WakeupRegistry installed by the
      // mount-time effect above. Reading the process singleton each turn
      // keeps the context resilient to test resets / hot reloads.
      get wakeupRegistry() {
        return getProcessWakeupRegistry();
      },
      // Lead-only fields for the agent_* tools. The tool layer enforces
      // that workers cannot spawn sub-sub-agents (callerAgentId guard).
      get agents() {
        return getAgentOrchestrator();
      },
      get parentSessionId() {
        return sessionIdRef.current ?? undefined;
      },
      callerAgentId: LEAD_AGENT_ID,
      // `agentsConfig` is optional in the tool ctx; surface it when the
      // user has defined explicit worker-slots so spawn_agent's strict
      // model-allow-list works in the TUI too.
      get agentsConfig() {
        return configRef.current?.agents;
      },
      // ONTOLOGY-WIRE-SECTION — surface the indexer via the structural
      // shape `narrowOntologyContext` expects. Tools fall back to
      // `{ success: false, error: 'Ontology not ready' }` when the
      // current graph is empty (e.g. first scan still running).
      ontology: ontologyIndexer,
      // ONTOLOGY-WIRE-SECTION-END
    };
    // SANDBOX-WIRING-SECTION — push the user's `[sandbox]` TOML
    // preferences into the run_command tool ctx. When unset, the tool
    // falls back to its built-in defaults (backend='auto',
    // allowNetwork=true) so legacy hosts keep their pre-sandbox
    // behaviour. Resolved via `configRef.current` (narrowed at runtime
    // — the Zod-validated `sandbox` block is optional and not yet
    // mirrored on the `.d.ts` AppConfig shape) so a live `/settings`
    // edit picks up on the next tool call without rebuilding the
    // executor.
    const sandboxConfigForCtx = readSandboxConfig(configRef.current);
    if (sandboxConfigForCtx !== undefined) {
      (ctx as ToolContext & AgentToolContext & {
        sandboxConfig?: SandboxRuntimeConfig;
      }).sandboxConfig = sandboxConfigForCtx;
    }
    // SANDBOX-WIRING-SECTION-END
    const handlerMap = createToolHandlerMap(ctx);

    // Adapter to the shape ToolExecutor expects: (args) => Promise<ToolResult>.
    // We run `preview` first; if it reports `requiresApproval`, the executor's
    // approvalCallback will handle that. If approved AND the tool has a
    // commit phase, we then run commit.
    const flat: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {};
    for (const [name, handler] of Object.entries(handlerMap)) {
      flat[name] = async (args: Record<string, unknown>): Promise<ToolResult> => {
        const preview = await handler.preview(args, ctx);
        // Non-destructive tools: preview is the result.
        if (handler.commit === undefined) {
          return preview;
        }
        // Destructive tools: if preview succeeded, commit runs after approval.
        // The ToolExecutor above us has already called approvalCallback by the
        // time this function is called. So here we just run commit.
        if (!preview.success) return preview;
        const committed = await handler.commit(args, ctx);
        // If commit succeeds but returns no output, fall back to preview output.
        if (committed.success && committed.output.length === 0) {
          return { ...committed, output: preview.output };
        }
        return committed;
      };
    }

    // Agent F (ROADMAP — Tier 3 plugins). Build the plugin handler map
    // and adapt it to the same `(args) => Promise<ToolResult>` contract
    // the ToolExecutor expects. Plugin handlers receive their own
    // `PluginExecuteContext` (just `projectRoot` for now) and return
    // already-shaped `ToolResult` values via `buildPluginHandlerMap`'s
    // `normaliseResult`. Plugin-contributed tools are merged AFTER
    // built-ins — this means a plugin-side accidental name collision
    // shadows the built-in. The plugin loader's own validation forbids
    // collisions inside its own scope; cross-scope collisions are
    // intentional (plugins are an extensibility point).
    const pluginMap = buildPluginHandlerMap(plugins);
    for (const [name, handler] of Object.entries(pluginMap)) {
      flat[name] = (args: Record<string, unknown>): Promise<ToolResult> =>
        handler.preview(args, { projectRoot });
    }

    // MCP tools merged last — they shadow plugins and built-ins on name
    // collision (deliberate: MCP is the outermost extensibility layer).
    const mcpMap = buildMcpToolHandlerMap(getProcessMcpRegistry());
    for (const [name, handler] of Object.entries(mcpMap)) {
      flat[name] = (args: Record<string, unknown>): Promise<ToolResult> =>
        handler.preview(args, ctx);
    }

    const executor = new ToolExecutor({
      handlers: flat,
      dangerouslyAllowAll,
      autoApproveTools: config?.permissions.autoApprove ?? [],
      // Permission profile — layered on top of autoApprove. Reading via
      // optional chain so existing tests that build a minimal config
      // without `[permissions]` keep returning `default`.
      profile: config?.permissions.profile ?? 'default',
      // FIX #27 — auto-lint post-write hook already defaults ON inside
      // ToolExecutor; we just need to route the synthetic message into
      // the ContextManager so the next model turn sees lint output.
      autoLintAfterWrite: true,
      onAutoCheckResult: (syntheticMsg: Message): void => {
        try {
          contextManager.add(syntheticMsg);
          // Also render the synthetic tool message in the UI so the
          // user can see what the linter reported.
          chatDispatch({ type: 'ADD_MESSAGE', message: syntheticMsg });
        } catch {
          // best-effort — never let a surfacing failure kill a tool run
        }
      },
      // Settings-driven hooks bridge. The engine satisfies
      // ToolExecutorHookBridge structurally (hasHooksFor + run).
      hookBridge: hookEngine,
      onHookEvent: (syntheticMsg: Message): void => {
        try {
          contextManager.add(syntheticMsg);
          chatDispatch({ type: 'ADD_MESSAGE', message: syntheticMsg });
        } catch {
          // best-effort
        }
      },
      projectRoot,
      sessionId: sessionId ?? undefined,
      approvalCallback: async (
        toolName: string,
        args: Record<string, unknown>,
      ): Promise<
        | boolean
        | {
            readonly approved: boolean;
            readonly approveAllInTurn?: boolean;
            readonly approveForSession?: boolean;
          }
      > => {
        // Build a UI-friendly PendingApproval, dispatch, and wait for the
        // resolver to be called. APPROVAL-BATCH-SECTION extends the
        // resolver shape so the `[A]`/`[S]` buttons can signal the
        // executor without a separate channel.
        return new Promise((resolvePromise) => {
          pendingResolverRef.current = (decision: ApprovalResolverArg) => {
            pendingResolverRef.current = null;
            resolvePromise(decision);
          };

          const approval = buildPendingApproval(toolName, args);
          chatDispatch({ type: 'SET_PENDING_APPROVAL', approval });
          // FIX #29 — audible cue when an approval is shown.
          soundPlayer.play('approval');
        });
      },
      // BATCH-APPROVAL-SECTION
      // When ≥ threshold mutating tool calls land in a single turn,
      // route them through the unified dialog instead of N sequential
      // approval prompts. The callback receives every mutating item
      // upfront, builds a `BatchApprovalDialogItem` row per call (with
      // a friendly label + best-effort preview), mounts the dialog,
      // and resolves with the user's per-item decisions. Below the
      // threshold OR with no `permissions.batchApprovalThreshold`
      // configured, the existing per-call approvalCallback above fires
      // sequentially (legacy behaviour preserved).
      batchApprovalThreshold:
        config?.permissions?.batchApprovalThreshold ?? 3,
      batchApprovalCallback: (async ({
        items,
      }: {
        readonly items: readonly BatchApprovalItem[];
      }): Promise<ReadonlyMap<string, BatchApprovalDecision>> => {
        return new Promise((resolvePromise) => {
          const dialogItems: BatchApprovalDialogItem[] = items.map((it) => {
            const a = it.args;
            const path =
              typeof a['path'] === 'string' ? (a['path'] as string) : '';
            const command =
              typeof a['command'] === 'string'
                ? (a['command'] as string)
                : '';
            const content =
              typeof a['content'] === 'string'
                ? (a['content'] as string)
                : '';
            const label =
              path.length > 0
                ? path
                : command.length > 0
                  ? command
                  : '';
            // Best-effort preview: write_file → first 30 lines of
            // content; edit_file → find→replace summary; run_command
            // → the command line; others → JSON.stringify(args).
            let preview = '';
            if (it.toolName === 'write_file' && content.length > 0) {
              preview = content
                .split(/\r?\n/)
                .slice(0, 30)
                .map((ln) => `+ ${ln}`)
                .join('\n');
            } else if (it.toolName === 'edit_file') {
              const find =
                typeof a['find_text'] === 'string'
                  ? (a['find_text'] as string)
                  : '';
              const replace =
                typeof a['replace_text'] === 'string'
                  ? (a['replace_text'] as string)
                  : '';
              const findHead = find.split(/\r?\n/).slice(0, 10).join('\n');
              const replaceHead = replace
                .split(/\r?\n/)
                .slice(0, 10)
                .join('\n');
              preview =
                (findHead.length > 0
                  ? findHead
                      .split(/\r?\n/)
                      .map((ln) => `- ${ln}`)
                      .join('\n') + '\n'
                  : '') +
                (replaceHead.length > 0
                  ? replaceHead
                      .split(/\r?\n/)
                      .map((ln) => `+ ${ln}`)
                      .join('\n')
                  : '');
            } else if (it.toolName === 'run_command' && command.length > 0) {
              preview = `$ ${command}`;
            } else {
              try {
                preview = JSON.stringify(a, null, 2);
              } catch {
                preview = '';
              }
            }
            return {
              toolCallId: it.toolCallId,
              toolName: it.toolName,
              label,
              previewOutput: preview,
            };
          });
          setBatchApproval({
            items: dialogItems,
            resolver: (decisions) => {
              setBatchApproval(null);
              resolvePromise(decisions);
            },
          });
          soundPlayer.play('approval');
        });
      }) satisfies BatchApprovalCallback,
      // BATCH-APPROVAL-SECTION-END
    });
    // UNDO-SECTION
    // Wire the snapshot hook so each successful write_file / edit_file /
    // multi_edit pushes the file's PRE-mutation content onto the
    // process-wide ring buffer. `/undo` consumes it later. The hook
    // resolves the path against `projectRoot` and silently skips
    // anything outside the root (defence-in-depth — the tools already
    // block traversal via resolveSafePathStrict).
    const snapshotStack = getProcessFileSnapshotStack();
    executor.setSnapshotHook(async (toolName, args) => {
      const rawPath = args['path'];
      if (typeof rawPath !== 'string' || rawPath.length === 0) return;
      const abs = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(projectRoot, rawPath);
      let before: string | null = null;
      try {
        before = await fs.promises.readFile(abs, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // New-file mutation; restore = delete.
          before = null;
        } else {
          // Other read errors (e.g. binary file, permission) — skip
          // snapshotting rather than aborting the tool.
          return;
        }
      }
      snapshotStack.push(rawPath, before, toolName);
    });
    // UNDO-SECTION-END
    return executor;
  }, [projectRoot, dangerouslyAllowAll, config?.permissions.autoApprove, config?.permissions.profile, contextManager, soundPlayer, plugins, hookEngine, sessionId, sessionManager, ontologyIndexer]);

  // TUTORIAL-MOUNT-SECTION — auto-trigger on first chat-screen entry
  // when the persisted config indicates the tutorial has not yet been
  // shown. Persistence happens in `dismissTutorial` below so a partial
  // dismissal (Esc) still marks it shown — the tutorial is skippable
  // and we explicitly never auto-re-show.
  useEffect(() => {
    if (tutorialAutoTriggeredRef.current) return;
    if (screen !== 'chat') return;
    if (config === null) return;
    if (config.firstRun?.tutorialShown === true) return;
    tutorialAutoTriggeredRef.current = true;
    setTutorialOpen(true);
  }, [screen, config]);

  const dismissTutorial = useCallback((): void => {
    setTutorialOpen(false);
    try {
      const merged = configManager.update({
        firstRun: { tutorialShown: true },
      });
      setConfig(merged);
    } catch {
      // Swallow — persistence failure shouldn't keep the user trapped
      // in a re-opening tutorial. The in-memory ref already prevents
      // a re-trigger for this session.
    }
  }, [configManager]);
  // TUTORIAL-MOUNT-SECTION-END

  // LANGUAGE-PICKER-MOUNT-SECTION — first-launch redirect.
  // When the app boots straight into onboarding (no config on disk
  // yet) we want the language picker to appear FIRST. This effect
  // runs once after mount and flips the screen from `onboarding` to
  // `languagePicker` before the OnboardingScreen UI is shown.
  const initialLanguageRedirectRef = useRef<boolean>(false);
  useEffect(() => {
    if (initialLanguageRedirectRef.current) return;
    initialLanguageRedirectRef.current = true;
    if (screen !== 'onboarding') return;
    if (configManager.exists()) return;
    setScreen('languagePicker');
  }, [screen, configManager]);
  // LANGUAGE-PICKER-MOUNT-SECTION-END

  // ---------- Bootstrapping: load config when entering chat ----------
  useEffect(() => {
    if (screen === 'onboarding') return;
    // LANGUAGE-PICKER-MOUNT-SECTION — skip config load during picker.
    if (screen === 'languagePicker') return;
    // LANGUAGE-PICKER-MOUNT-SECTION-END
    // CONFIG-SELFHEAL-SECTION — on a fresh machine the very first screen
    // is the animated splash; the config file does not exist yet and is
    // only written when onboarding completes. Reading it here would
    // throw "cannot read config.toml" and latch a config-load error that
    // surfaces later on the chat screen. Skip the read entirely during
    // splash (mirrors the onboarding/languagePicker guards above) — the
    // splash → languagePicker → onboarding flow writes the config, and
    // this effect re-runs once we actually reach chat.
    if (screen === 'splash') return;
    // CONFIG-SELFHEAL-SECTION-END
    if (config !== null) return;
    try {
      // readOrCreate (not read): if we somehow reach a real screen with
      // no config on disk, auto-create the defaults instead of crashing.
      // The default has onboarding.completed=false + no locale, so the
      // branches below still route through the language picker /
      // onboarding rather than dropping the user into a half-set-up chat.
      let loaded = configManager.readOrCreate();
      // Permission profile override (from `--profile <name>` or the
      // legacy `--dangerously-allow-all` flag). Persisted via update()
      // so subsequent reads see the override and so the executor's
      // useMemo dep (`config.permissions.profile`) reflects it. We do
      // NOT persist on no-op — when the override matches the current
      // value, this is a cheap read.
      if (
        profileOverride !== null &&
        loaded.permissions.profile !== profileOverride
      ) {
        try {
          loaded = configManager.update({
            permissions: {
              autoApprove: loaded.permissions.autoApprove,
              profile: profileOverride,
            },
          });
        } catch {
          // Ignore: persist failure shouldn't block the UI. The
          // override won't survive the session, but the user sees it
          // in the deprecation note below.
        }
      }
      setConfig(loaded);
      setConfigLoadError(null);
      // LANGUAGE-PICKER-MOUNT-SECTION — first-launch picker.
      // When the persisted config predates the locale field, fall
      // through to the picker screen so the user explicitly confirms a
      // language before reaching chat. The picker's onSelect callback
      // patches `config.locale` and advances to onboarding/chat.
      if (loaded.locale === undefined) {
        setScreen('languagePicker');
      } else if (loaded.onboarding.completed !== true) {
        // Wave 8C bug fix: when the picker scaffolds a minimal stub
        // before quit-before-onboarding, the next launch lands here
        // with locale set but onboarding still incomplete. Route to
        // onboarding instead of dropping the user into chat with a
        // half-formed config.
        setScreen('onboarding');
      }
      // LANGUAGE-PICKER-MOUNT-SECTION-END
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConfigLoadError(msg);
    }
  }, [screen, config, configManager, profileOverride]);

  // Surface the `--dangerously-allow-all` deprecation note exactly
  // once per app boot. Appending to chatLog (not stdout) so the line
  // lands inside the ink frame instead of above it.
  const dangerouslyAllowAllDeprecationLoggedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!dangerouslyAllowAllDeprecationNotice) return;
    if (dangerouslyAllowAllDeprecationLoggedRef.current) return;
    if (config === null) return;
    dangerouslyAllowAllDeprecationLoggedRef.current = true;
    appendLog(
      '[deprecation] --dangerously-allow-all is deprecated. Use `--profile dontAsk` instead.',
    );
  }, [dangerouslyAllowAllDeprecationNotice, config]);

  // ---------- MCP registry bootstrap ----------
  // Construct once per app instance (config drives the server map).
  // fire-and-forget — failed servers record their error; they never
  // crash the UI.
  //
  // CRITICAL: this effect must NOT dispose the process-wide registry on
  // re-render. `config` is replaced wholesale on every config mutation
  // (locale change, model swap, provider switch, /web boot, etc.), and
  // disposing the registry mid-session would:
  //   1. tear down running stdio children for active MCP servers,
  //   2. set `disposed = true` so the next `start()` becomes a no-op,
  //   3. (historically) crash the TUI with `Unhandled rejection:
  //      MCPRegistry: already disposed` when the embedded `/web` server
  //      called `start()` on the same singleton.
  // `start()` is idempotent on already-booted slots so re-running it on
  // config changes is cheap. Disposal is handled in the separate
  // unmount-only effect below.
  useEffect(() => {
    if (config === null) return;
    const registry = getProcessMcpRegistry();
    const servers = config.mcpServers ?? {};
    void registry.start(servers).catch(() => {
      // individual server errors are recorded inside the registry
    });
  // config.mcpServers reference changes when config object changes; we
  // re-call start (idempotent) so newly-added servers boot without
  // requiring an app restart.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Unmount-only cleanup: dispose the process-wide MCP registry exactly
  // once when the TUI tears down. Empty dep array → React runs the
  // cleanup on unmount, never on re-render. `dispose()` is itself
  // idempotent so a duplicate signal-handler-driven dispose is harmless.
  useEffect(() => {
    return () => {
      void getProcessMcpRegistry().dispose().catch(() => { /* swallow */ });
    };
  }, []);

  // PRICING-REFRESH-SECTION — kick a non-blocking refresh of the
  // OpenRouter pricing catalog on first mount. Respects the 24h
  // on-disk cache TTL (no-op on hot starts) and falls back silently to
  // the existing cache / static table on network failure. Persisted
  // per-message cost rows pick up refreshed prices on the next turn.
  // Mirror lives in src/web/index.ts for the web entrypoint.
  useEffect(() => {
    void refreshOpenRouterPricing().catch(() => {
      /* best-effort — pricing degrades to static table on failure */
    });
  }, []);
  // PRICING-REFRESH-SECTION-END

  // JOURNAL-RECOVERY-SECTION (boot)
  // Scan `~/.localcode/journal/` for recoverable sessions on first
  // mount and prune anything in the archive older than 30 days so the
  // folder stays bounded. Both calls are synchronous directory walks
  // — no blocking work, no network. Skipped during onboarding /
  // language-picker so the prompt cannot mask the first-launch flow.
  useEffect(() => {
    if (recoveryScanDoneRef.current) return;
    if (screen === 'onboarding' || screen === 'languagePicker' || screen === 'splash') {
      return;
    }
    recoveryScanDoneRef.current = true;
    try {
      pruneArchivedJournals();
    } catch {
      /* best-effort — pruning is a housekeeping nicety */
    }
    try {
      const found = recoverableJournals();
      setRecoverableList(found);
    } catch {
      setRecoverableList([]);
    }
  }, [screen]);
  // JOURNAL-RECOVERY-SECTION (boot end)

  // ONTOLOGY-WIRE-SECTION — start the indexer on mount: load any
  // persisted snapshot, kick a first scan, arm the background re-index
  // loop, and wire a chokidar watcher (debounced 2s) so saved edits
  // trigger an incremental refresh. Every failure is swallowed — the
  // ontology is best-effort.
  useEffect(() => {
    let disposed = false;
    void (async (): Promise<void> => {
      try {
        await ontologyIndexer.loadPersisted();
        if (disposed) return;
        void ontologyIndexer.indexProject();
      } catch {
        /* swallow — best-effort */
      }
    })();
    const stopInterval = ontologyIndexer.startBackgroundReindex(300_000);
    const watcher = chokidar.watch(projectRoot, {
      ignoreInitial: true,
      depth: 8,
      persistent: true,
      ignored: (filePath: string) =>
        filePath.includes('node_modules') ||
        filePath.includes('.git') ||
        filePath.includes('/dist/') ||
        filePath.includes('/dist-web/') ||
        filePath.includes('.localcode'),
    });
    const onChange = (filePath: string): void => {
      if (!/\.(?:tsx|ts|cts|mts)$/.test(filePath)) return;
      ontologyIndexer.scheduleReindex(2_000);
    };
    watcher.on('add', onChange);
    watcher.on('change', onChange);
    watcher.on('unlink', onChange);
    watcher.on('error', () => {
      /* swallow — best-effort */
    });
    return () => {
      disposed = true;
      stopInterval();
      void watcher.close();
      void ontologyIndexer.dispose().catch(() => { /* swallow */ });
    };
  }, [ontologyIndexer, projectRoot]);
  // ONTOLOGY-WIRE-SECTION-END

  // ---------- Create / resume session once config is loaded ----------
  useEffect(() => {
    if (config === null) return;
    if (sessionId !== null) return;
    if (screen === 'onboarding') return;

    try {
      if (resumeSessionId !== null) {
        // Try an exact match first, then any prefix hit from the last 200.
        const exact = sessionManager.getSession(resumeSessionId);
        const target: Session | null =
          exact ??
          findPrefixMatch(sessionManager.listSessions(200), resumeSessionId);

        if (target === null) {
          // Fall back to creating a new session and let the user know.
          appendLog(`No session matching '${resumeSessionId}'; starting a new one.`);
          const created = sessionManager.createSession(
            projectRoot,
            modelOverride ?? config.model.current,
            config.backend.type,
          );
          setSessionId(created.id);
          setCurrentSession(created);
          return;
        }

        // Load messages and hydrate the context manager.
        // Agent F (post-Agent D pagination): use `getAllMessages` so
        // the resume path retrieves the FULL session history (the
        // default `getMessages` returns the most recent 100 only).
        // /resume is a discrete one-shot operation; the cost of an
        // unbounded fetch is acceptable.
        const rows = sessionManager.getAllMessages(target.id);
        contextManager.replaceAll(rows);
        chatDispatch({ type: 'REPLACE_MESSAGES', messages: rows });
        setSessionId(target.id);
        setCurrentSession(target);
        appendLog(`Resumed session ${target.id.slice(0, 8)}.`);
        if (target.summary !== null && target.summary.length > 0) {
          appendLog('Prior session summary restored — model will remember context.');
        }
        return;
      }

      const created = sessionManager.createSession(
        projectRoot,
        modelOverride ?? config.model.current,
        config.backend.type,
      );
      setSessionId(created.id);
      setCurrentSession(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(`Failed to initialise session: ${msg}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config,
    sessionId,
    screen,
    projectRoot,
    modelOverride,
    resumeSessionId,
    sessionManager,
    contextManager,
  ]);

  // JOURNAL-RECOVERY-SECTION (writer wiring)
  // Open a per-session JournalWriter as soon as a session id is
  // assigned, and close it cleanly when the session changes (resume,
  // /clear, branch hop) or the app unmounts. On clean close we emit a
  // terminal `session_end` event so the next-launch recovery scan
  // skips this session — without that marker the user would see a
  // false-positive prompt for every previous run.
  useEffect(() => {
    if (sessionId === null || sessionId.length === 0) return;
    let writer: JournalWriter;
    try {
      writer = new JournalWriter(sessionId);
    } catch {
      // Best-effort — if the journal dir is unwritable (e.g. ROFS),
      // skip the recovery hook entirely rather than crash the TUI.
      return;
    }
    journalWriterRef.current = writer;
    try {
      sessionManager.attachJournal(sessionId, writer);
      writer.append({
        ts: Date.now(),
        type: 'session_start',
        data: { sessionId, projectRoot },
      });
    } catch {
      /* swallow — journaling is best-effort */
    }
    return (): void => {
      try {
        sessionManager.detachJournal(sessionId);
      } catch {
        /* swallow */
      }
      try {
        writer.close('clean');
      } catch {
        /* swallow */
      }
      if (journalWriterRef.current === writer) {
        journalWriterRef.current = null;
      }
    };
  }, [sessionId, sessionManager, projectRoot]);
  // JOURNAL-RECOVERY-SECTION (writer wiring end)

  // ---------- Project settings.json watcher (FIX #35) ----------
  /**
   * Watch `<projectRoot>/.localcode/settings.json` so a direct file
   * edit (or a `/settings` write through the SettingsOverlay) rebuilds
   * the live LLM adapter with the latest resolved generation params.
   *
   * The chokidar watcher is best-effort — failures are swallowed
   * because per-project overrides are an enhancement, not a hard
   * requirement. The bump triggers `resolvedGeneration` to recompute
   * which in turn re-keys the adapter `useMemo`.
   */
  useEffect(() => {
    const settingsPath = `${projectRoot}/.localcode/settings.json`;
    const watcher = chokidar.watch(settingsPath, {
      ignoreInitial: true,
      // settings.json rewrites use atomic rename (write tmp + rename),
      // so chokidar needs to follow the rename without re-arming.
      atomic: true,
      persistent: true,
    });
    const onChange = (): void => {
      setProjectSettingsTick((t) => t + 1);
    };
    watcher.on('add', onChange);
    watcher.on('change', onChange);
    watcher.on('unlink', onChange);
    watcher.on('error', () => { /* swallow */ });
    return () => {
      void watcher.close();
    };
  }, [projectRoot]);

  // ---------- Skills: initial load + chokidar watcher (both dirs) ----------
  useEffect(() => {
    let cancelled = false;

    const reload = async (): Promise<void> => {
      try {
        const list = await skillsManager.list();
        if (!cancelled) setSkills(list);
      } catch {
        if (!cancelled) setSkills([]);
      }
    };

    void reload();

    // Watch BOTH the project-local and global skills directories (FIX #16).
    const dirs: string[] = [];
    if (skillsManager.projectDirectory !== null) {
      dirs.push(skillsManager.projectDirectory);
    }
    dirs.push(skillsManager.globalDirectory);

    const watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      depth: 1,
      persistent: true,
    });

    watcher.on('add', () => { void reload(); });
    watcher.on('change', () => { void reload(); });
    watcher.on('unlink', () => { void reload(); });
    watcher.on('error', () => { /* swallow — skills are best-effort */ });

    return () => {
      cancelled = true;
      void watcher.close();
    };
  }, [skillsManager]);

  // ---------- Memory: initial load + chokidar watcher ----------
  // Mirrors the skills watcher pattern. The directory may not exist yet
  // — chokidar `ignoreInitial: false` plus a tolerant `add` handler
  // arms cleanly in that case (the watcher silently re-arms when
  // `MemoryStore.write` materialises the dir on first save).
  useEffect(() => {
    let cancelled = false;

    const reload = async (): Promise<void> => {
      try {
        const list = await memoryStore.list();
        if (!cancelled) setMemoryEntries(list);
      } catch {
        if (!cancelled) setMemoryEntries([]);
      }
    };

    void reload();

    const watcher = chokidar.watch(memoryStore.directory, {
      ignoreInitial: false,
      depth: 1,
      persistent: true,
    });
    watcher.on('add', () => { void reload(); });
    watcher.on('change', () => { void reload(); });
    watcher.on('unlink', () => { void reload(); });
    watcher.on('error', () => { /* swallow — memory is best-effort */ });

    return () => {
      cancelled = true;
      void watcher.close();
    };
  }, [memoryStore]);

  // UPDATER-WIRE-SECTION
  // Auto-update singleton. Boots after the chat screen mounts; surfaces
  // `update-available` / `update-downloaded` as synthetic system
  // messages via `appendLog`. Disabled when `config.updater.enabled`
  // is false (zero traffic). The singleton owns its own scheduler so
  // we only need to subscribe + tear down on unmount.
  useEffect(() => {
    if (config === null) return;
    const updaterCfg = config.updater ?? {
      enabled: true,
      channel: 'stable' as const,
      checkIntervalHours: 6,
      autoDownload: true,
      checkOnLaunch: true,
      silentBackground: true,
      preferPatchDelta: true,
    };
    if (!updaterCfg.enabled) return;
    let unsubscribe: (() => void) | null = null;
    let stop: (() => void) | null = null;
    void (async (): Promise<void> => {
      try {
        const updaterMod = await import('@/updater');
        const { getProcessUpdater } = updaterMod;
        // App-supplied PKG_VERSION — kept in sync with cli.tsx. Tests
        // override via `injectedUpdater` (not yet exposed in App props).
        const updater = getProcessUpdater({
          currentVersion: PKG_VERSION_FOR_UPDATER,
          autoDownload: updaterCfg.autoDownload,
          intervalMs: updaterCfg.checkIntervalHours * 60 * 60 * 1_000,
          preferPatchDelta: updaterCfg.preferPatchDelta,
          forceNew: true,
        });
        updaterRef.current = updater;
        unsubscribe = updater.on((event) => {
          if (event.type === 'update-available') {
            // UPDATE-OVERLAY-MOUNT-SECTION — surface a polished overlay
            // instead of the prior synthetic chat log entry. Silent
            // background mode is enforced by NOT emitting any pre-event
            // "checking…" — the only visible affordance is the overlay
            // itself.
            //
            // DELTA-NOTES-FETCH — open the overlay immediately with the
            // single-release body so the user has SOMETHING the moment
            // detection fires, then opportunistically swap in the
            // concatenated delta (every intermediate release between
            // current → latest) once the GitHub API returns. The first
            // call is bounded by the in-module 24h cache so reopening
            // does not re-fetch.
            setUpdateOverlayInfo({
              currentVersion: event.currentVersion,
              latestVersion: event.release.version,
              releaseUrl: event.release.htmlUrl,
              releaseName: event.release.name,
              body: event.release.body,
            });
            void (async (): Promise<void> => {
              try {
                const delta = await updater.getDeltaNotes();
                if (delta !== null && delta.notes.trim().length > 0) {
                  setUpdateOverlayInfo({
                    currentVersion: event.currentVersion,
                    latestVersion: event.release.version,
                    releaseUrl: event.release.htmlUrl,
                    releaseName: event.release.name,
                    body: delta.notes,
                  });
                }
              } catch {
                /* swallow — best-effort, original body already shown */
              }
            })();
          } else if (event.type === 'update-downloaded') {
            setUpdateDownloadedVersion(event.version);
            if (updaterCfg.silentBackground !== true) {
              setChatLog((prev) => [
                ...prev,
                `Update ready: v${event.version}. Restart LocalCode to apply.`,
              ]);
            }
          } else if (event.type === 'update-error') {
            // Quiet by default — only surface when in diagnostics
            // mode to avoid spamming users on transient failures.
            if (config.diagnostics?.dumpFailedRequests === true) {
              setChatLog((prev) => [
                ...prev,
                `[updater:${event.stage}] ${event.message}`,
              ]);
            }
          }
        });
        if (updaterCfg.checkOnLaunch !== false) {
          updater.start();
        }
        stop = (): void => {
          try {
            updater.stop();
          } catch {
            /* swallow */
          }
        };
      } catch {
        /* swallow — updater is best-effort */
      }
    })();
    return () => {
      if (unsubscribe !== null) unsubscribe();
      if (stop !== null) stop();
      updaterRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.updater?.enabled]);
  // UPDATER-WIRE-SECTION-END

  // ---------- WakeupRegistry: install + onFire wiring (C2) ----------
  //
  // Install a process-wide WakeupRegistry whose `onFire` enqueues the
  // self-prompt onto the chat reducer's pending queue. Each session
  // owns its own dispatch — we filter by sessionId so wakeups scheduled
  // in a prior session don't leak into the active one. The queue flush
  // path is identical to the type-ahead pipeline; ChatScreen's drain
  // effect picks the message up on the next idle frame.
  useEffect(() => {
    const onFire = (firedSessionId: string, prompt: string): void => {
      // Only inject when the active session matches the wakeup's owner.
      // A user who switched sessions between schedule + fire sees the
      // wakeup silently dropped — better than smuggling a self-prompt
      // into an unrelated conversation.
      const currentSid = sessionIdRef.current;
      if (currentSid !== firedSessionId) return;
      chatDispatch({ type: 'ENQUEUE_PENDING', text: prompt });
    };
    const registry = new WakeupRegistry(onFire);
    setProcessWakeupRegistry(registry);
    return () => {
      setProcessWakeupRegistry(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Slash-command registration ----------
  useEffect(() => {
    if (config === null || llm === null) return;

    const registry = new SlashRegistry();

    // /init, /model, /resume, /context, /clear from Agent 6 factories.
    //
    // R12 (Agent F): `cmd-init.ts` and `cmd-model.ts` were written before
    // we widened the adapter to `AnyAdapter = LLMAdapter | AnthropicAdapter`.
    // Their `deps.llm` parameter is still typed as `LLMAdapter`. Since both
    // adapters expose the same public `streamChat` / `getModels` surface
    // (the only methods these commands use), the `as LLMAdapter` cast at
    // the boundary is sound — TypeScript only rejects it because the
    // private-field shapes differ. We use the `unknown` intermediate so
    // the cast doesn't accidentally permit unrelated types in future.
    const llmAsLLMAdapter = llm as unknown as LLMAdapter;
    const initCmd = createInitCommand({
      llm: llmAsLLMAdapter,
      contextManager,
      scanProject: async (root: string) => {
        const scanner = new ProjectScanner();
        const res = await scanner.scan(root);
        return {
          tree: res.tree,
          fileCount: res.fileCount,
          totalSize: res.totalSize,
          keyFiles: res.keyFiles.map((k) => ({
            path: k.path,
            content: k.content,
            type: k.type,
          })),
          languages: res.languages,
        };
      },
      writeLocalcodeMd,
      readLocalcodeMd,
      buildInitPrompt: (scan, existing) => {
        // cmd-init declares the shape with `type: string` (wide). The real
        // buildInitPrompt expects the stricter `KeyFileType` union. Since
        // scanProject above sources the value directly from ProjectScanner,
        // the values are already valid members of the union — narrow the
        // cast explicitly here to satisfy the strict signature.
        const narrowed = {
          ...scan,
          keyFiles: scan.keyFiles.map((k) => ({
            path: k.path,
            content: k.content,
            type: k.type as 'readme' | 'manifest' | 'config' | 'entry',
          })),
        };
        return buildInitPrompt(narrowed, existing);
      },
    });

    const modelCmd = createModelCommand({
      llm: llmAsLLMAdapter,
      configManager,
      setScreen,
    });

    const resumeCmd = createResumeCommand({
      sessionManager,
      setScreen,
      loadSession: async (id: string): Promise<void> => {
        // Fire SessionEnd hooks BEFORE the summariser so a slow user
        // hook can't eat the summary budget. Reason is `session_switch`
        // because the user is moving to a different existing session
        // — the SQLite row stays put.
        fireSessionEndHookRef.current('session_switch');
        // Persist a summary of the outgoing session (best-effort) before
        // switching away (FIX #19). R16 — dereferenced via the ref so
        // the freshest summariser closure always runs even when the
        // slash-command registry was set up before the helper was
        // declared (TDZ safety).
        await summariseAndPersistOutgoingRef.current();

        const target = sessionManager.getSession(id);
        // Agent F (post-Agent D pagination): full history on resume.
        const rows = sessionManager.getAllMessages(id);
        contextManager.replaceAll(rows);
        contextManager.resetUsage();
        chatDispatch({ type: 'REPLACE_MESSAGES', messages: rows });
        chatDispatch({ type: 'SET_SESSION_TOTAL_OUT', tokens: 0 });
        setSessionId(id);
        setCurrentSession(target);
      },
    });

    const contextCmd = createContextCommand({
      contextManager,
      skillsManager,
      localcodeMdStatus: () => getLocalcodeMdStatus(projectRoot),
      maxTokens: config.context.maxTokens,
    });

    // R16 — `cmd-clear.ts` invokes `contextManager.clear()` BEFORE
    // calling `onNewSession()`, so by the time the wiring callback
    // runs the manager is already empty and `summariseAndPersistOutgoing`
    // would race against an empty snapshot. Capture the messages and
    // outgoing session id at command-entry into `pendingClearSnapshot`,
    // then have the underlying `clearCmd` run; the `onNewSession`
    // callback below replays the captured snapshot through
    // `summariseFromSnapshot` so the persist actually has data.
    const pendingClearSnapshot: { messages: Message[]; sid: string | null } = {
      messages: [],
      sid: null,
    };
    const innerClearCmd = createClearCommand({
      contextManager,
      onNewSession: (): string => {
        // Fire-and-forget summarise-on-clear, using the snapshot we
        // captured at command-entry (the manager was already cleared
        // by the time this callback runs). Background SQLite write.
        // R16 — dereference via the ref so we always invoke the
        // latest closure (TDZ-safe).
        void summariseFromSnapshotRef.current(
          pendingClearSnapshot.messages,
          pendingClearSnapshot.sid,
        );
        // Reset the snapshot so a future invocation doesn't replay
        // stale data if the capture step is somehow skipped.
        pendingClearSnapshot.messages = [];
        pendingClearSnapshot.sid = null;

        const created = sessionManager.createSession(
          projectRoot,
          modelOverride ?? config.model.current,
          config.backend.type,
        );
        setSessionId(created.id);
        setCurrentSession(created);
        contextManager.resetUsage();
        chatDispatch({ type: 'RESET' });
        return created.id;
      },
    });

    const clearCmd: SlashCommand = {
      name: innerClearCmd.name,
      description: innerClearCmd.description,
      usage: innerClearCmd.usage,
      execute: (args: string, ctx: CommandContext): Promise<void> | void => {
        // R16 — capture BEFORE `cmd-clear.ts` clears the manager, so
        // the deferred summariser sees the conversation that's about
        // to be wiped.
        pendingClearSnapshot.messages = contextManager.getMessages();
        pendingClearSnapshot.sid = sessionIdRef.current;
        // Fire SessionEnd hooks BEFORE creating the fresh session so
        // user hooks see the outgoing session id, not the freshly
        // minted one. Fire-and-forget — never blocks the /clear flow.
        fireSessionEndHookRef.current('session_switch');
        return innerClearCmd.execute(args, ctx);
      },
    };

    const permissionsCmd = createPermissionsCommand({ configManager });
    const profileCmd = createProfileCommand({ configManager });
    const ctxsizeCmd = createCtxSizeCommand({ configManager });
    const newSkillCmd = createNewSkillCommand({
      skillsManager,
      openSkillOverlay: () => {
        chatDispatch({ type: 'OPEN_SKILL_OVERLAY' });
      },
    });
    const providerCmd = createProviderCommand({ configManager });

    // FIX #34 — `/compress`. The live ContextManager satisfies the
    // narrow `CompressContextManager` interface (`getMessages` +
    // `compress(summarizer, opts?)`) directly — Agent 2 R5b landed the
    // `compress` API on the class itself. The command injects the live
    // LLM adapter as the summariser backend and persists the resulting
    // summary onto the active session row via
    // `sessionManager.updateSummary`.
    const compressCmd = createCompressCommand({
      contextManager,
      buildCompressPrompt,
      llm,
      sessionManager,
      getSessionId: () => sessionIdRef.current,
      // COMPRESS-STRATEGY-SECTION — wire the new strategy-aware
      // compression path. `getBackend` lets the strategy selector pick
      // between `dedup | summarize | truncate` based on the active
      // provider; `contextManager.replaceAll` is the apply step. Both
      // are no-ops via fallback when undefined.
      getBackend: () => config?.backend?.type ?? null,
      // COMPRESS-STRATEGY-SECTION-END
    });
    // Expose the execute closure so the auto-compress trigger in
    // `runStreamLoop` can dispatch a programmatic `/compress` without
    // routing through the user-input pipe (which would echo a literal
    // `/compress` line and confuse the slash-classifier).
    compressExecRef.current = compressCmd.execute;

    // FIX #35 — `/settings`. The command itself only needs the config
    // manager + project root; the actual editing UI lives in
    // `<SettingsOverlay>`, which is rendered by the `overlayKind ===
    // 'settings'` branch below.
    const settingsCmd = createSettingsCommand({
      configManager,
      projectRoot,
    });

    // FIX #36 — `/diff` and `/review`. The diff command is a pure git
    // wrapper (no LLM). The review command needs the LIVE adapter, so
    // we hand it a thin shim that always reads `llmRef.current` — that
    // way `/review` invoked AFTER a `/model` or `/provider` swap sees
    // the freshest adapter without needing to re-register.
    // DIFF-VIEWER-MOUNT-SECTION (Wave 5B / TF4) — wire the `/diff`
    // command to the full-screen overlay. Without an `openViewer`
    // callback `cmd-diff` falls back to a text summary; with it, the
    // command pushes the resolved entries into the viewer state below
    // and the takeover render block mounts `<DiffViewer>`.
    const diffCmd = createDiffCommand({
      projectRoot,
      openViewer: (entries) => {
        openDiffViewer(entries);
      },
    });
    const reviewCmd = createReviewCommand({
      projectRoot,
      llm: {
        streamChat: async (params) => {
          const adapter = llmRef.current;
          if (adapter === null) {
            throw new Error(
              'LLM adapter not initialised — cannot run /review.',
            );
          }
          await adapter.streamChat(params);
        },
      },
    });

    // Agent F (ROADMAP #10) — `/plan`. Borrow the live system-prompt
    // builder and the same `readLocalcodeMd` accessor used by `/init`.
    // Like `/review`, the LLM adapter is dereferenced via `llmRef`
    // inside the streamChat shim so the freshest adapter (post
    // `/model` or `/provider` swap) is always used.
    // The PlanContextManager / AgentContextManager interfaces are
    // narrower than ContextManager — they only need `buildSystemPrompt`
    // (and, for the agent, `getMessages` + `addMessage`). Wrap the live
    // ContextManager so the structural mismatch on the `skills`
    // parameter type (`{ content: string }[]` vs full `Skill[]`) is
    // resolved at the wiring site rather than via a wider cast.
    const planContextAdapter = {
      buildSystemPrompt: (
        md: string | null,
        sks: ReadonlyArray<{ content: string }>,
      ): string => {
        // The cast is safe at runtime: ContextManager.buildSystemPrompt
        // only reads `skill.content` from the array entries (id /
        // name / etc are used for sorting + section headers; missing
        // fields render as empty strings). The wrapper preserves the
        // public contract Agent E declared without forcing every
        // caller to construct full Skill objects.
        return contextManager.buildSystemPrompt(md, sks as unknown as readonly Skill[]);
      },
    };

    const planCmd = createPlanCommand({
      llm: {
        streamChat: async (params) => {
          const adapter = llmRef.current;
          if (adapter === null) {
            throw new Error(
              'LLM adapter not initialised — cannot run /plan.',
            );
          }
          await adapter.streamChat(params);
        },
      },
      contextManager: planContextAdapter,
      readLocalcodeMd: (root: string) => readLocalcodeMdSafe(root),
    });

    // Agent F (ROADMAP #16) — `/agent`. The agent loop drives:
    //   - the LLM adapter (via `llmRef.current` shim),
    //   - the live ContextManager (we wrap `add` as `addMessage` to
    //     satisfy the AgentContextManager interface),
    //   - the live ToolExecutor (closure-captured here — note that
    //     `toolExecutor` is rebuilt when permissions or plugins
    //     change, but the registry only re-runs this useEffect on the
    //     same triggers, so the agent always picks up the freshest
    //     executor instance).
    //
    // The `confirm` callback uses a lightweight "pause and ask the
    // user to type `/agent resume`" pattern instead of a synchronous
    // y/n prompt overlay. When the agent loop hits its 10-iteration
    // checkpoint or trips the watchdog, we surface the prompt in
    // chat and return `false` — that flips the persisted state to
    // `paused`. The user resumes manually via `/agent resume`.
    const agentCmd = createAgentCommand({
      llm: {
        streamChat: async (params) => {
          const adapter = llmRef.current;
          if (adapter === null) {
            throw new Error(
              'LLM adapter not initialised — cannot run /agent.',
            );
          }
          await adapter.streamChat(params);
        },
      },
      contextManager: {
        getMessages: () => contextManager.getMessages(),
        addMessage: (m) => contextManager.add(m),
        buildSystemPrompt: (md, sks) =>
          contextManager.buildSystemPrompt(md, sks as unknown as readonly Skill[]),
      },
      toolExecutor: {
        executeAll: (calls) => toolExecutor.executeAll(calls),
      },
      tools: [...TOOLS_SCHEMA, ...buildMcpToolSchema(getProcessMcpRegistry())],
      readLocalcodeMd: (root: string) => readLocalcodeMdSafe(root),
      confirm: async (prompt: string): Promise<boolean> => {
        // Surface the prompt in chat and pause the loop. The user
        // resumes via `/agent resume` (see cmd-agent's `handleResume`).
        appendLog(`Agent: ${prompt}`);
        appendLog('Type `/agent resume` to continue or `/agent cancel` to stop.');
        return false;
      },
    });

    const todosCmd = createTodosCommand({
      getSessionId: () => sessionIdRef.current,
      sessionManager,
    });

    // AGENT-PANEL-SECTION (Wave 5A — TA team)
    // `/spawn` — sub-agent catalog. Now wired to the real orchestrator
    // (constructed lazily above). `spawnFromTemplate` returns
    // `AgentHandle`; the `SpawnOrchestrator` interface only reads
    // `agentId` from the result, so the structural sub-typing matches.
    const spawnCmd = createSpawnCommand({
      getSessionId: () => sessionIdRef.current,
      orchestrator: {
        spawnFromTemplate: async (parentSessionId, templateId, customPrompt, overrides) => {
          const orch = getAgentOrchestrator();
          const handle = await orch.spawnFromTemplate(
            parentSessionId,
            templateId,
            customPrompt,
            overrides,
          );
          return { agentId: handle.agentId };
        },
      },
    });

    // C1 / C2 — statusline / output-style / wakeups wiring.
    //   - `/statusline` and `/style` only need ConfigManager — they
    //     persist a TOML field that the next-turn system prompt reads.
    //   - `/wakeups` reads + cancels entries from the process-wide
    //     WakeupRegistry. The registry is installed below (or earlier
    //     by another composition root); here we just grab the singleton.
    const statuslineCmd = createStatuslineCommand({ configManager });
    const styleCmd = createStyleCommand({ configManager });
    // LANGUAGE-CMD-SECTION — `/language` (alias `/lang`). The picker
    // overlay is the TUI's first-launch screen; we plumb a callback so
    // the no-arg invocation reopens it without echoing the command.
    const languageCmd = createLanguageCommand({
      configManager,
      openPicker: () => setScreen('languagePicker'),
    });
    // Manual alias: the slash registry routes by `name`, so we just
    // construct a second SlashCommand with `name: 'lang'` that delegates
    // to the same handler. Keeps the alias surface explicit (it shows up
    // in /help) without depending on registry-level alias support.
    const langCmd: SlashCommand = {
      ...languageCmd,
      name: 'lang',
      description: `${languageCmd.description} (alias for /language)`,
    };
    // LANGUAGE-CMD-SECTION-END

    // SITE-CMD-SECTION — `/site` is a thin shell-out command (open|xdg-open).
    // No deps, no LLM round-trip.
    const siteCmd = createSiteCommand();
    // SITE-CMD-SECTION-END
    const wakeupsCmd = createWakeupsCommand({
      registry: getProcessWakeupRegistry(),
    });

    // UNDO-SECTION
    const undoCmd = createUndoCommand({
      stack: getProcessFileSnapshotStack(),
      projectRoot,
    });
    // UNDO-SECTION-END

    // WORKTREE-GC-STARTUP-SECTION
    // `/worktrees` reads the orchestrator's GC bookkeeping; without an
    // orchestrator the command renders an explanatory message rather
    // than fail. The orchestrator getter is lazy so the cmd handle works
    // even when no agent has been spawned yet.
    const worktreesCmd = createWorktreesCommand({
      gc: getAgentOrchestrator().getWorktreeGC(),
      getProjectRoot: () => projectRoot,
    });
    // WORKTREE-GC-STARTUP-SECTION-END

    // BRANCHES-DISPATCH-SECTION (start)
    // `/branch` shares the same heavy-lifting that `/resume`'s
    // loadSession does — persist the outgoing summary, replace the
    // in-memory context + chat reducer, and update the session id. The
    // resume command already wires that callback; we forward
    // switchSession to the same implementation so a branch hop and a
    // resume hop are indistinguishable to the chat state.
    const branchCmd = createBranchCommand({
      sessionManager,
      getActiveSessionId: () => sessionIdRef.current,
      switchSession: async (targetId: string): Promise<void> => {
        fireSessionEndHookRef.current('session_switch');
        await summariseAndPersistOutgoingRef.current();
        const target = sessionManager.getSession(targetId);
        const rows = sessionManager.getAllMessages(targetId);
        contextManager.replaceAll(rows);
        contextManager.resetUsage();
        chatDispatch({ type: 'REPLACE_MESSAGES', messages: rows });
        chatDispatch({ type: 'SET_SESSION_TOTAL_OUT', tokens: 0 });
        setSessionId(targetId);
        setCurrentSession(target);
      },
    });
    // BRANCHES-DISPATCH-SECTION (end)

    // USAGE-COMMANDS-SECTION (start) — Wave 6A4 wiring.
    // `/usage` reads cross-session aggregates from SessionManager;
    // `/cost` reads the in-memory ring buffer maintained by the
    // stream loop; `/perf` (+ alias `/tokens`) opens the live token
    // visualiser. All three short-circuit via `ctx.showOverlay(...)`
    // so the slash router never echoes their names into chat output.
    const usageCmd = createUsageCommand({
      sessionManager,
      currentBackend: () => config.backend.type,
    });
    const costCmd = createCostCommand({
      // Shallow copy to satisfy the cmd-cost mutable-array contract;
      // the command itself never mutates rows, but the type widens to
      // `Array<...>` so we hand it a fresh slice.
      sessionTurnSnapshot: () => costSampleRowsRef.current.map((r) => ({ ...r })),
    });
    const perfCmd = createPerfCommand('perf');
    const tokensCmd = createPerfCommand('tokens');
    // `/filter` flips the reducer-owned filter slice via the dispatch
    // bridge. Reads the live slice for the no-arg echo.
    const filterCmd = createFilterCommand({
      getOutputFilters: () => chatStateRef.current.outputFilters,
      setOutputFilters: (filters) =>
        chatDispatch({ type: 'SET_OUTPUT_FILTER', filters }),
    });
    // USAGE-COMMANDS-SECTION (end)

    // PLUGIN-CMD-SECTION (Wave 6D) — `/plugin <subcommand>`. The
    // registry instance defaults to project scope; reload is a
    // no-op placeholder here because hot-rotating the executor's
    // handler map mid-session is owned by a separate effect (the
    // chat runtime is reconstructed when plugins toggle).
    const pluginCmd = createPluginCommand({
      getProjectRoot: () => projectRoot,
    });
    // PLUGIN-CMD-SECTION-END

    // CONV-CMD-SECTION (Wave 6D) — `/conv diff`. Reuses the existing
    // `<DiffViewer>` overlay by adapting `ConversationDiffViewerEntry`
    // to the structurally-identical `DiffEntry` shape openDiffViewer
    // expects.
    const convCmd = createConvCommand({
      sessionManager,
      getActiveSessionId: () => sessionIdRef.current,
      openViewer: (entries) => {
        openDiffViewer(entries.map((e) => ({
          filePath: e.filePath,
          before: e.before,
          after: e.after,
          mode: e.mode,
        })));
      },
    });
    // CONV-CMD-SECTION-END

    // MEMORY-SAVE-SECTION (Wave 6 self-evolution) — `/memory` lists
    // entries; `/memory-save <id>` consumes a staged feedback proposal
    // produced by the AutoFeedbackDetector below.
    const memoryCmd = createMemoryCommand({
      projectRoot,
    });
    const memorySaveCmd = createMemorySaveCommand({
      projectRoot,
      staging: feedbackStaging,
    });
    // MEMORY-SAVE-SECTION-END

    // ONTOLOGY-WIRE-SECTION — `/ontology status|refresh|graph <symbol>`.
    // `graph` opens the OntologyGraph overlay via the dispatcher
    // installed below; the command falls back to ASCII print when the
    // dispatcher isn't wired.
    const ontologyCmd = createOntologyCommand({
      getIndexer: () => ({
        get current() { return ontologyIndexer.current; },
        get isIndexing() { return ontologyIndexer.isIndexing; },
        indexProject: () => ontologyIndexer.indexProject(),
      }),
      openGraph: (sym: string) => {
        setOntologyGraphSymbol(sym);
      },
    });
    // ONTOLOGY-WIRE-SECTION-END

    // PROCESS-MONITOR-WIRE-SECTION — `/watch` + `/diagnose`. The monitor
    // is the process-wide singleton; both commands fall back to it when
    // no override is supplied. The `injectSyntheticMessage` callback
    // routes manual-diagnose output through the chat reducer so the
    // model sees the digest on its next turn.
    const processMonitor = getProcessMonitor();
    const watchCmd = createWatchCommand({
      projectRoot,
      monitor: processMonitor,
    });
    const diagnoseCmd = createDiagnoseCommand({
      monitor: processMonitor,
      injectSyntheticMessage: (msg) => {
        chatDispatch({ type: 'ADD_MESSAGE', message: msg });
      },
    });
    // PROCESS-MONITOR-WIRE-SECTION-END

    // SECRETS-CMD-SECTION — construct here; no extra deps.
    const secretsCmd = createSecretsCommand();
    // SECRETS-CMD-SECTION-END

    // SENSITIVE-CMD-SECTION — construct here; no extra deps. The
    // command reloads the catalog on every invocation, so wiring it
    // once at startup is enough.
    const sensitiveCmd = createSensitiveCommand();
    // SENSITIVE-CMD-SECTION-END

    // WEB-LAUNCH-SECTION — `/web` boots the embedded web server
    // in-process, reusing the same SQLite handle the TUI writes to.
    // `launchWeb`/`stopWeb` resolve against a module-level singleton
    // (`webHandleRef`) so repeated invocations are idempotent — the
    // second `/web` simply returns the same URL with the fresh session
    // fragment so the browser can re-focus the current session.
    const webCmd = createWebCommand({
      launchWeb: async (sessionId: string | null) => {
        const { ensureWebServerStarted } = await import('@/web/embedded-launch');
        return ensureWebServerStarted({
          projectRoot,
          sessionId,
        });
      },
      stopWeb: async () => {
        const { stopWebServer } = await import('@/web/embedded-launch');
        await stopWebServer();
      },
      openBrowser: async (url: string) => {
        const { openBrowser } = await import('@/web/server/open-browser');
        await openBrowser(url);
      },
    });
    // WEB-LAUNCH-SECTION-END

    // DEMO-TUTORIAL-CMD-SECTION — wire `/demo` and `/tutorial`. `/demo`
    // routes each replay entry through `appendLog` so the bundled tour
    // shows up as system-style lines in the chat log (matches the
    // chatLog → synthetic system message pipeline above). `/tutorial`
    // simply flips the overlay state on; the React mount block reads
    // `tutorialOpen` directly so the command is a thin shim.
    const demoCmd = createDemoCommand({
      player: new Player(),
      dispatch: (entry) => {
        // Inline the same one-line formatter the standalone CLI uses so
        // the in-session output stays consistent across surfaces.
        appendLog(
          entry.kind === 'user'
            ? `[you]      ${entry.content}`
            : entry.kind === 'assistant'
              ? `[localcode] ${entry.content}`
              : entry.kind === 'tool_call'
                ? `[tool ${entry.name}] ${entry.result.split('\n')[0] ?? ''}`
                : `[info]     ${entry.content}`,
        );
      },
    });
    const tutorialCmd = createTutorialCommand({
      open: (): void => {
        setTutorialOpen(true);
      },
    });
    // DEMO-TUTORIAL-CMD-SECTION-END

    // UPDATE-CMD-SECTION — wraps the updater singleton (booted by the
    // `UPDATER-WIRE-SECTION` effect above). `getUpdater` reads from
    // `updaterRef.current`, which is non-null whenever auto-update is
    // enabled. When the user disables auto-update entirely the command
    // still registers but prints a friendly "feature disabled" message.
    const updateCmd = createUpdateCommand({
      getUpdater: () => updaterRef.current,
      exit: (): void => {
        exit();
      },
    });
    // UPDATE-CMD-SECTION-END

    // METRICS-WIRE-SECTION — `/metrics` slash command. Wires the
    // process-wide aggregator + telemetry config gate. The command
    // itself opens the `metrics` overlay via `ctx.showOverlay`; when
    // the host dispatcher rejects the kind it falls back to text.
    const metricsCmd = createMetricsCommand({});
    // METRICS-WIRE-SECTION-END

    // MARKETPLACE-WIRING-SECTION — `/skills browse` + `/mcp browse`.
    // The factory takes a `fetchCatalog` and an `openMarketplace`
    // callback; the latter pushes the fetched entries into the host
    // overlay state above, which is rendered as a takeover overlay in
    // the chat-screen case branch.
    const skillsBrowseCmd = createSkillsBrowseCommand({
      fetchCatalog: fetchSkillCatalog,
      openMarketplace: (payload) => {
        setMarketplaceError(null);
        setMarketplaceInfo(null);
        setMarketplaceLoading(false);
        setMarketplaceState(payload);
      },
    });
    const mcpBrowseCmd = createMcpBrowseCommand({
      fetchCatalog: fetchMcpCatalog,
      openMarketplace: (payload) => {
        setMarketplaceError(null);
        setMarketplaceInfo(null);
        setMarketplaceLoading(false);
        setMarketplaceState(payload);
      },
    });
    // MARKETPLACE-WIRING-SECTION-END

    // IMPORT-CMD-SECTION — `/import claude-code` slash command. The
    // command opens an overlay through `ctx.showOverlay('import',
    // { plan })` when the host dispatches it; we currently don't wire
    // an interactive overlay (the cmd falls back to printing the plan
    // into chat), so the user can also pass `all` to import everything
    // in one shot.
    const importCmd = createImportCommand({ sessionManager });
    // IMPORT-CMD-SECTION-END

    registerBuiltinCommands(registry, {
      init: initCmd,
      model: modelCmd,
      resume: resumeCmd,
      context: contextCmd,
      clear: clearCmd,
      permissions: permissionsCmd,
      ctxsize: ctxsizeCmd,
      newSkill: newSkillCmd,
      provider: providerCmd,
      compress: compressCmd,
      settings: settingsCmd,
      diff: diffCmd,
      review: reviewCmd,
      plan: planCmd,
      agent: agentCmd,
      todos: todosCmd,
      profile: profileCmd,
      spawn: spawnCmd,
      statusline: statuslineCmd,
      style: styleCmd,
      // LANGUAGE-CMD-SECTION
      language: languageCmd,
      lang: langCmd,
      // LANGUAGE-CMD-SECTION-END
      // SITE-CMD-SECTION
      site: siteCmd,
      // SITE-CMD-SECTION-END
      wakeups: wakeupsCmd,
      undo: undoCmd,
      worktrees: worktreesCmd,
      // BRANCHES-REGISTRY-MOUNT
      branch: branchCmd,
      // USAGE-COMMANDS-SECTION (start)
      usage: usageCmd,
      cost: costCmd,
      perf: perfCmd,
      tokens: tokensCmd,
      filter: filterCmd,
      // USAGE-COMMANDS-SECTION (end)
      // PLUGIN-CMD-SECTION (Wave 6D)
      plugin: pluginCmd,
      // PLUGIN-CMD-SECTION-END
      // CONV-CMD-SECTION (Wave 6D)
      conv: convCmd,
      // CONV-CMD-SECTION-END
      // MEMORY-SAVE-SECTION (Wave 6 self-evolution)
      memory: memoryCmd,
      memorySave: memorySaveCmd,
      // MEMORY-SAVE-SECTION-END
      // ONTOLOGY-WIRE-SECTION
      ontology: ontologyCmd,
      // ONTOLOGY-WIRE-SECTION-END
      // SECRETS-CMD-SECTION
      secrets: secretsCmd,
      // SECRETS-CMD-SECTION-END
      // SENSITIVE-CMD-SECTION
      sensitive: sensitiveCmd,
      // SENSITIVE-CMD-SECTION-END
      // PROCESS-MONITOR-WIRE-SECTION
      watch: watchCmd,
      diagnose: diagnoseCmd,
      // PROCESS-MONITOR-WIRE-SECTION-END
      // WEB-CMD-SECTION
      web: webCmd,
      // WEB-CMD-SECTION-END
      // DEMO-TUTORIAL-CMD-SECTION
      demo: demoCmd,
      tutorial: tutorialCmd,
      // DEMO-TUTORIAL-CMD-SECTION-END
      // UPDATE-CMD-SECTION
      update: updateCmd,
      // UPDATE-CMD-SECTION-END
      // METRICS-WIRE-SECTION
      metrics: metricsCmd,
      // METRICS-WIRE-SECTION-END
      // MARKETPLACE-WIRING-SECTION
      skillsBrowse: skillsBrowseCmd,
      mcpBrowse: mcpBrowseCmd,
      // MARKETPLACE-WIRING-SECTION-END
    });

    // IMPORT-CMD-SECTION — `/import` is not in the BuiltinCommandFactories
    // bag (the bag is curated). Register it directly on the registry so
    // the user can invoke `/import claude-code` and `/import cc`.
    registry.register(importCmd);
    // IMPORT-CMD-SECTION-END

    // Extra built-ins added here (not in Agent 6 factories).
    const skillsScreenCmd: SlashCommand = {
      name: 'skills',
      description: 'Open the skills management screen',
      usage: '/skills',
      execute: (_args: string, _ctx: CommandContext): void => {
        setScreen('skills');
      },
    };

    const exitCmd: SlashCommand = {
      name: 'exit',
      description: 'Quit LocalCode',
      usage: '/exit',
      // R16 — bounded-await the preview-summary persist so the SQLite
      // write completes BEFORE we trigger ink unmount. Capped at 3 s
      // so a hanging local model can't prevent the user from quitting.
      // R7 (FIX #8): unmount via useApp().exit() so cli.tsx's
      // waitUntilExit() resolves and the resume banner prints.
      execute: async (_args: string, _ctx: CommandContext): Promise<void> => {
        // Fire SessionEnd BEFORE the summariser so a slow user hook
        // can't eat the 3 s budget. Fire-and-forget — even if the
        // hooks haven't finished by the time ink unmounts, Node will
        // wait for the spawned subprocesses on the event loop drain.
        fireSessionEndHookRef.current('user_quit');
        await summariseWithTimeoutRef.current(3000);
        // WEB-LAUNCH-SECTION — tear down the embedded web server (if
        // running) so the user's `/exit` releases the port and stops
        // the WS event loop. Best-effort — never block /exit.
        try {
          const { stopWebServer } = await import('@/web/embedded-launch');
          await stopWebServer();
        } catch {
          // ignore
        }
        // WEB-LAUNCH-SECTION-END
        onSessionExit?.(sessionIdRef.current);
        exit();
      },
    };

    const helpCmd: SlashCommand = {
      name: 'help',
      description: 'Show available slash commands',
      usage: '/help',
      execute: (_args: string, ctx: CommandContext): void => {
        ctx.print('Available slash commands:');
        for (const cmd of registry.getAll()) {
          ctx.print(`  /${cmd.name}  —  ${cmd.description}`);
        }
      },
    };

    registry.register(skillsScreenCmd);
    registry.register(exitCmd);
    registry.register(helpCmd);

    setSlashCommands(registry.getAll());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config,
    llm,
    contextManager,
    configManager,
    sessionManager,
    skillsManager,
    projectRoot,
    modelOverride,
    summarizeAllMessages,
    // Agent F: include `toolExecutor` so `/agent` re-registers with the
    // freshest executor instance (rotated when permissions / plugins
    // change). `appendLog` is intentionally NOT listed because it is
    // declared LATER in the function body (TDZ would fire). It is a
    // stable `useCallback(..., [])` reference at runtime, so closures
    // captured here always see the same instance — the lint disable
    // below covers it.
    toolExecutor,
    // R16 — `summariseAndPersistOutgoing`, `summariseFromSnapshot`, and
    // `summariseWithTimeout` are intentionally NOT listed here even
    // though the closures reference them. They are declared LATER in
    // the function body (TDZ would fire if listed). The slash-command
    // closures dereference them at call time via stable
    // `*Ref.current` values populated by sync effects further down,
    // so a rotated implementation is always in effect on the next
    // user interaction without needing to re-register every command.
  ]);

  // ---------- Process-level signal handlers (cleanup DB + watcher) ----------
  // R7 (FIX #8) — these fire for non-keyboard signals (e.g.
  // `kill -INT <pid>`) since ink's raw-mode terminal delivers Ctrl+C as
  // a `\x03` byte, NOT as a SIGINT. Keyboard Ctrl+C is handled by the
  // `useInput` block above. We avoid calling `process.exit` here so
  // `waitUntilExit()` can drain in cli.tsx and the resume banner prints.
  useEffect(() => {
    const cleanup = (): void => {
      try {
        resetDefaultDb();
      } catch {
        // ignore
      }
      // B3 — kill any still-running background `run_command` children so
      // they don't outlive the TUI. Fire-and-forget: SIGINT/SIGTERM is
      // already on the exit path, so we don't await.
      try {
        void getProcessBackgroundTaskRegistry().dispose();
      } catch {
        // ignore
      }
      // PROCESS-MONITOR-WIRE-SECTION — kill watched processes (SIGTERM
      // then SIGKILL after the grace window). Fire-and-forget; we are
      // already on the exit path.
      try {
        void getProcessMonitor().dispose();
      } catch {
        // ignore
      }
      // PROCESS-MONITOR-WIRE-SECTION-END
      // JOURNAL-RECOVERY-SECTION (signal close)
      // Close the active session journal cleanly so the next-launch
      // recovery scan doesn't surface this run as unfinished. The
      // React useEffect cleanup also tries to close, but a hard signal
      // path may exit before React tears down — belt-and-braces here.
      try {
        const writer = journalWriterRef.current;
        if (writer !== null) {
          writer.close('clean');
          journalWriterRef.current = null;
        }
      } catch {
        // ignore
      }
      // JOURNAL-RECOVERY-SECTION (signal close end)
    };

    // R16 — fire the preview-summary persist with a 3 s race, then
    // run the cleanup + ink unmount sequence. Using `void` on the
    // outer async IIFE keeps the SIGINT/SIGTERM handler signature
    // synchronous while still allowing the inner await chain to land
    // the SQLite write before the process actually exits. Node will
    // wait for the microtask to drain after the handler returns, and
    // the 3 s race prevents a hanging summariser from holding up the
    // user's quit. We dereference the latest closure via
    // `summariseWithTimeoutRef.current` so the empty-deps useEffect
    // doesn't capture a stale function (e.g. one whose llmRef was
    // still null at first mount).
    const onSigint = (): void => {
      // SessionEnd hooks fire BEFORE the summariser so a slow user
      // hook can't consume the 3 s budget the summariser races against.
      fireSessionEndHookRef.current('user_quit');
      void (async (): Promise<void> => {
        try {
          await summariseWithTimeoutRef.current(3000);
        } finally {
          onSessionExit?.(sessionIdRef.current);
          cleanup();
          // Trigger ink unmount via useApp().exit() — NOT process.exit —
          // so cli.tsx's waitUntilExit() can resolve and the resume banner
          // prints before the process actually terminates.
          exit();
        }
      })();
    };
    const onSigterm = (): void => {
      fireSessionEndHookRef.current('user_quit');
      void (async (): Promise<void> => {
        try {
          await summariseWithTimeoutRef.current(3000);
        } finally {
          onSessionExit?.(sessionIdRef.current);
          cleanup();
          exit();
        }
      })();
    };
    // Agent F — graceful shutdown on SIGHUP. Same persistence + ink
    // unmount sequence as SIGTERM. SIGHUP fires when the controlling
    // terminal closes (e.g. tmux pane killed, ssh disconnect, parent
    // shell exiting), and without an explicit handler Node would
    // either ignore it or terminate without flushing the SQLite write.
    const onSighup = (): void => {
      fireSessionEndHookRef.current('user_quit');
      void (async (): Promise<void> => {
        try {
          await summariseWithTimeoutRef.current(3000);
        } finally {
          onSessionExit?.(sessionIdRef.current);
          cleanup();
          exit();
        }
      })();
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('SIGHUP', onSighup);
    process.on('exit', cleanup);

    return () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
      process.off('exit', cleanup);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PROCESS-MONITOR-WIRE-SECTION — surface auto-emitted diagnostic
  // signals into the chat as synthetic system messages. The monitor
  // already throttles duplicate signatures (30 s window) and the
  // diagnoser is intentionally conservative, so each emission here is
  // a meaningful event the model should react to on its next turn.
  // The subscription is empty-deps + reads the live singleton so we
  // attach exactly once for the TUI lifetime.
  useEffect(() => {
    const monitor = getProcessMonitor();
    const onDiagnostic = (signal: DiagnosticSignal): void => {
      const snap = monitor.get(signal.processId);
      const label = snap === null ? signal.processId : snap.label;
      const msg = buildDiagnosticMessage(label, signal);
      chatDispatch({ type: 'ADD_MESSAGE', message: msg });
    };
    monitor.on('diagnostic', onDiagnostic);
    return () => {
      monitor.off('diagnostic', onDiagnostic);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // PROCESS-MONITOR-WIRE-SECTION-END

  // ---------- Global hotkeys (Ctrl+C / Ctrl+L) ----------
  const clearScreen = useCallback((): void => {
    process.stdout.write('\x1b[2J\x1b[H');
  }, []);

  /**
   * Window (ms) within which a second Ctrl+C confirms the exit. After
   * this elapses the next Ctrl+C is treated as a fresh first press.
   * Mirrors the Claude Code interactive-shell pattern.
   */
  const EXIT_CONFIRM_WINDOW_MS = 2000;

  // R7 (FIX #8) — two-press Ctrl+C flow.
  //   1st press → cancel any active stream, dispatch START_EXIT_CONFIRM,
  //               surface a "Press Ctrl+C again to exit" notice in chat.
  //   2nd press within EXIT_CONFIRM_WINDOW_MS → run the persist+exit
  //               flow (summary write is fire-and-forget; banner prints
  //               from cli.tsx after waitUntilExit resolves).
  //   2nd press after the window → treated as a fresh first press.
  useInput((input, key) => {
    // CMD-PALETTE-MOUNT-SECTION (Wave 5A — TA team) — Ctrl+K opens the
    // command palette from anywhere. Mounted at app-root so it works
    // outside the ChatScreen tree too (onboarding / model select / etc.).
    if (key.ctrl && (input === 'k' || input === 'K')) {
      setPaletteOpen((prev) => !prev);
      return;
    }

    if (key.ctrl && input === 'c') {
      const firstAt = confirmExitAtRef.current;
      const now = Date.now();
      const inWindow =
        firstAt !== null && now - firstAt <= EXIT_CONFIRM_WINDOW_MS;

      if (inWindow) {
        // R16 — confirmed exit. Bounded-await the preview-summary
        // persist (3 s timeout) so the SQLite write lands before ink
        // unmounts. Then notify cli.tsx of the active session so it
        // can print the resume banner after ink unmounts. Finally
        // trigger ink unmount via useApp().exit() — NOT process.exit,
        // so waitUntilExit can drain naturally.
        chatDispatch({ type: 'CANCEL_EXIT_CONFIRM' });
        // Fire SessionEnd hooks BEFORE the summariser so a slow user
        // hook never eats the 3 s budget that races the summary write.
        fireSessionEndHookRef.current('user_quit');
        void (async (): Promise<void> => {
          try {
            await summariseWithTimeoutRef.current(3000);
          } finally {
            onSessionExit?.(sessionIdRef.current);
            exit();
          }
        })();
        return;
      }

      // First press (or stale press past the 2s window) — start the
      // confirmation window. If a stream is active, also cancel it so
      // the user gets immediate feedback that Ctrl+C did something.
      if (isStreamingRef.current) {
        abortControllerRef.current?.abort();
      }
      chatDispatch({ type: 'START_EXIT_CONFIRM', timestamp: now });
      appendLog('Press Ctrl+C again to exit (within 2s)');
      return;
    }

    if (key.ctrl && input === 'l') {
      clearScreen();
      return;
    }

    // PLAN-MODE-HOTKEY-SECTION
    // Ctrl+P — toggle Plan Mode. When the active profile is `plan`,
    // switch back to `default`; otherwise switch to `plan`. Ink doesn't
    // expose Cmd-Shift-* combinations through raw stdin so `Ctrl+P` is
    // the cross-platform-safe binding; documented in --help / README.
    // Persisted via ConfigManager so the executor's useMemo dep
    // (`config.permissions.profile`) picks the switch up.
    //
    // Toast copy comes from the i18n table (`plan.toast.on` /
    // `plan.toast.off`) via the module-level `appT` so the keystroke
    // handler — which is NOT a React component and therefore can't use
    // the `useT()` hook — still picks up the user's locale.
    if (key.ctrl && input === 'p') {
      try {
        const cur = configManager.read();
        const nextProfile: PermissionProfile =
          cur.permissions.profile === 'plan' ? 'default' : 'plan';
        const updated = configManager.update({
          permissions: {
            autoApprove: cur.permissions.autoApprove,
            profile: nextProfile,
          },
        });
        setConfig(updated);
        setChatLog((prev) => [
          ...prev,
          nextProfile === 'plan'
            ? appT('plan.toast.on')
            : appT('plan.toast.off'),
        ]);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        setChatLog((prev) => [...prev, `Failed to toggle Plan Mode: ${msg}`]);
      }
      return;
    }
    // PLAN-MODE-HOTKEY-SECTION-END

    // SKILL-SUGGEST-SECTION (hotkeys) — Tab activates the first
    // suggestion (matches the convention "use the visually-first item");
    // Esc dismisses without activating. Both keys also clear the
    // suggestion list so the toast goes away immediately. We only
    // intercept when at least one suggestion is showing; otherwise the
    // keys fall through to whoever else binds them.
    if (skillSuggestions.length > 0) {
      if (key.tab) {
        const first = skillSuggestions[0];
        if (first !== undefined) {
          void (async (): Promise<void> => {
            try {
              await skillsManager.toggle(first.skillId);
              const next = await skillsManager.list();
              setSkills(next);
              setChatLog((prev) => [
                ...prev,
                `Activated skill: ${first.skillName}`,
              ]);
            } catch (cause) {
              const msg =
                cause instanceof Error ? cause.message : String(cause);
              setChatLog((prev) => [
                ...prev,
                `Failed to activate skill ${first.skillId}: ${msg}`,
              ]);
            }
          })();
        }
        setSkillSuggestions([]);
        return;
      }
      if (key.escape) {
        setSkillSuggestions([]);
        return;
      }
    }
    // SKILL-SUGGEST-SECTION (hotkeys end)
  });

  // R7 (FIX #8) — when the exit-confirm window opens, schedule a timer
  // that auto-resets the pending state after EXIT_CONFIRM_WINDOW_MS so
  // a stale "press again" intent doesn't carry forward indefinitely.
  useEffect(() => {
    if (chatState.confirmExitAt === null) return undefined;
    const handle = setTimeout(() => {
      chatDispatch({ type: 'CANCEL_EXIT_CONFIRM' });
    }, EXIT_CONFIRM_WINDOW_MS);
    return () => clearTimeout(handle);
  }, [chatState.confirmExitAt]);

  // SKILL-SUGGEST-SECTION (timer) — 8s auto-dismiss for the skill
  // suggestion toast. Resets on every change to `skillSuggestions`, so
  // a fresh submit that produces a new suggestion gives the user a
  // full 8s window before it disappears.
  useEffect(() => {
    if (skillSuggestions.length === 0) return undefined;
    const handle = setTimeout(() => {
      setSkillSuggestions([]);
    }, 8000);
    return () => clearTimeout(handle);
  }, [skillSuggestions]);
  // SKILL-SUGGEST-SECTION (timer end)

  // IMPORT-FIRST-RUN-SECTION (effect)
  // On first chat-screen mount, detect:
  //   1. zero LocalCode sessions in the SQLite store,
  //   2. populated ~/.claude/projects/ on disk,
  //   3. user hasn't dismissed the prompt before.
  // If all three hold, open the first-run import prompt. The dismissal
  // flag is persisted via ConfigManager so subsequent launches don't
  // re-prompt. Guarded by a ref so we only run the detection once per
  // <App> mount, never on re-renders.
  useEffect(() => {
    if (importPromptCheckedRef.current) return;
    if (screen !== 'chat') return;
    if (config === null) return;
    importPromptCheckedRef.current = true;
    const cfgMig = (config as unknown as {
      migration?: { claudeCodeDismissed?: boolean };
    }).migration;
    if (cfgMig?.claudeCodeDismissed === true) return;
    void (async (): Promise<void> => {
      try {
        // Cheap: count = SELECT count(*) FROM sessions (one row).
        let count = 0;
        try {
          count = sessionManager.listSessions(1).length;
        } catch {
          return; // SQLite unreadable — skip silently
        }
        if (count > 0) return;
        const plan = await scanClaudeCode();
        if (plan.totalSessions === 0) return;
        setImportPromptOpen(true);
      } catch {
        // Detection is best-effort; never block first-launch.
      }
    })();
  }, [screen, config, sessionManager]);
  // IMPORT-FIRST-RUN-SECTION (effect end)

  // ---------- Helpers that depend on state ----------
  const appendLog = useCallback((line: string): void => {
    setChatLog((prev) => [...prev, line]);
  }, []);

  // ---------- Auto-scaffold .localcode/ once per app mount ----------
  /**
   * R12 (Agent 8) — first-launch scaffold (Task B).
   *
   * On the first time the chat screen mounts with a usable
   * `projectRoot`, ensure `.localcode/` exists in the project so the
   * skill loader and `/init` flow have somewhere to write. Runs ONCE
   * per `<App>` mount even if the user later navigates away from chat
   * and back, because the ref guard never resets within a render tree.
   *
   * Failures are non-fatal: any I/O error degrades to a one-line info
   * message in the chat log. The model and tools keep working without
   * the scaffold; the only consequence is that `/init` will create
   * `.localcode/` on its own when invoked.
   */
  const scaffoldedRef = useRef<boolean>(false);
  useEffect(() => {
    if (scaffoldedRef.current) return;
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) return;
    if (screen !== 'chat') return;
    scaffoldedRef.current = true;
    try {
      const result = ensureLocalcodeScaffold(projectRoot);
      if (result.created && result.newlyCreatedFiles.length > 0) {
        appendLog(
          `✓ Scaffolded .localcode/ for this project (${result.newlyCreatedFiles.length} files). Run /init to populate LOCALCODE.md from the codebase.`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`Note: could not scaffold .localcode/: ${msg}`);
    }
  }, [projectRoot, screen, appendLog]);

  // ---------- Plugin discovery (Agent F) ----------
  /**
   * Load plugins from `~/.localcode/plugins/` and
   * `<projectRoot>/.localcode/plugins/` once per `projectRoot`. Failures
   * inside the loader are surfaced via `console.warn` (the loader's
   * default error reporter) — we never let a malformed plugin block the
   * chat. Successful loads are announced once per session via a single
   * chat-log line so the user can see which plugins are active.
   *
   * The state setter is guarded with a `cancelled` flag because the
   * dynamic-import in `loadPlugins` is async and the user may switch
   * `projectRoot` before it resolves.
   */
  useEffect(() => {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) return;
    if (screen !== 'chat') return;
    let cancelled = false;
    void (async (): Promise<void> => {
      let loaded: Plugin[] = [];
      try {
        loaded = await loadPlugins({ projectRoot });
      } catch {
        loaded = [];
      }
      if (cancelled) return;
      setPlugins(loaded);
      if (!pluginsAnnouncedRef.current) {
        pluginsAnnouncedRef.current = true;
        if (loaded.length > 0) {
          const names = loaded.map((p) => p.name).join(', ');
          appendLog(`✓ Loaded ${loaded.length} plugin${loaded.length === 1 ? '' : 's'}: ${names}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRoot, screen, appendLog]);

  /**
   * R16 (Agent 8) — produce a tight 1-2 sentence preview summary of
   * the supplied messages, suitable for the `/resume` overlay's
   * session-preview row.
   *
   * Crucially this is DIFFERENT from `summarizeAllMessages` (which
   * produces a longer ≤500-token "resume context" handoff used by
   * `/compress` and the system-prompt `summary` field). The preview
   * variant is shorter, has a different prompt, and is truncated at
   * 300 chars — it's purely for human eyeballs scanning a list of
   * past sessions.
   *
   * Tolerates: no LLM available, empty/short context (< 4 messages),
   * stream errors, empty responses. Returns `null` rather than throwing
   * so callers can `if (summary !== null)` and skip persistence.
   */
  const buildPreviewSummary = useCallback(
    async (messages: readonly Message[]): Promise<string | null> => {
      const adapter = llmRef.current;
      if (adapter === null) return null;
      // R16 — only summarise if there's meaningful conversation. Three
      // messages or fewer (a system + first user + first assistant) is
      // not worth a network round-trip.
      if (messages.length < 4) return null;

      const prompt = buildPreviewSummaryPrompt(messages);
      const requestMsgs: Message[] = [
        {
          id: newId('preview-sys'),
          role: 'system',
          content: 'You produce short, one-sentence session summaries.',
          createdAt: nowMs(),
        },
        {
          id: newId('preview-u'),
          role: 'user',
          content: prompt,
          createdAt: nowMs(),
        },
      ];

      let buffer = '';
      try {
        await new Promise<void>((resolve, reject) => {
          // Fire the request through the live adapter. We force
          // `tools: []` so the model doesn't get distracted by the
          // schema, and rely on `onDone` to surface stream-level errors
          // (the adapter never throws post-connection).
          void adapter.streamChat({
            messages: requestMsgs,
            tools: [],
            onChunk: (text: string) => {
              buffer += text;
            },
            onToolCalls: () => {
              // ignore — preview summariser doesn't run tools
            },
            onDone: (result) => {
              if (result.error !== undefined) {
                reject(new Error(result.error));
                return;
              }
              resolve();
            },
          });
        });
      } catch {
        return null; // tolerate any stream failure
      }

      let s = buffer.trim();
      if (s.length === 0) return null;
      // Cap at 300 chars (1-2 sentences). The session-list overlay only
      // shows a one-line preview, so anything longer wastes vertical
      // space and risks line wrap on narrow terminals.
      if (s.length > 300) s = s.slice(0, 297) + '...';
      return s;
    },
    [],
  );

  /**
   * R16 — explicit-snapshot variant. Use this when the caller has
   * already captured the messages it wants summarised (e.g. before
   * `contextManager.clear()` runs in the `/clear` flow, by which point
   * the manager itself has been emptied). The session id can also be
   * supplied explicitly; pass `null` to default to
   * `sessionIdRef.current`.
   *
   * Tolerates an empty snapshot (returns silently) and any LLM
   * failures (the `buildPreviewSummary` helper already swallows them).
   */
  const summariseFromSnapshot = useCallback(
    async (
      messages: readonly Message[],
      sessionIdOverride: string | null,
    ): Promise<void> => {
      try {
        const sid = sessionIdOverride ?? sessionIdRef.current;
        if (sid === null) return;
        if (messages.length === 0) return;
        const summary = await buildPreviewSummary(messages);
        if (summary !== null && summary.length > 0) {
          sessionManager.updateSummary(sid, summary);
        }
      } catch {
        // swallow — summaries are best-effort
      }
    },
    [sessionManager, buildPreviewSummary],
  );

  /**
   * Summarise the in-memory context (best effort) and write it to the
   * outgoing session row. Awaiting callers (e.g. `/resume`'s
   * `loadSession`) will see the SQLite write complete before continuing;
   * fire-and-forget callers (slash `/exit`, Ctrl+C, SIGINT, SIGTERM)
   * accept that the write may race with process termination — the
   * signal handlers themselves wrap a 3 s race so the persistence never
   * hangs the exit. Swallows all errors; summaries are never
   * load-bearing.
   *
   * R16 — uses the short `buildPreviewSummary` prompt rather than the
   * older `summarizeAllMessages` resume-context summariser, because the
   * persisted value lives on `Session.summary` solely as a preview
   * shown in the resume overlay. The longer resume-context summariser
   * is still available via `/compress` for in-session compression.
   *
   * Captures both `messages` and `sid` synchronously BEFORE the LLM
   * round-trip — that way callers that immediately mutate the manager
   * or rotate the session id (e.g. switching sessions in `/resume`)
   * don't poison the snapshot. `/clear` is the one exception: by the
   * time the slash-command's `onNewSession` hook fires, the manager
   * has already been cleared by `cmd-clear.ts`. For that path use
   * {@link summariseFromSnapshot} with a pre-captured array.
   */
  const summariseAndPersistOutgoing = useCallback(async (): Promise<void> => {
    const sid = sessionIdRef.current;
    if (sid === null) return;
    const messages = contextManager.getMessages();
    await summariseFromSnapshot(messages, sid);
  }, [contextManager, summariseFromSnapshot]);

  /**
   * R16 — race-bounded variant for fire-and-forget exit paths
   * (SIGINT, SIGTERM, Ctrl+C-twice, slash `/exit`). Awaits
   * `summariseAndPersistOutgoing` but never blocks the caller for
   * more than `timeoutMs` ms — local LLMs can hang on first-token,
   * and we don't want a runaway summariser to prevent the user's
   * Ctrl+C from actually exiting.
   */
  const summariseWithTimeout = useCallback(
    async (timeoutMs: number = 3000): Promise<void> => {
      const work = summariseAndPersistOutgoing();
      const deadline = new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(0, timeoutMs)),
      );
      try {
        await Promise.race([work, deadline]);
      } catch {
        // unreachable — work() never throws; defensive only
      }
    },
    [summariseAndPersistOutgoing],
  );

  // R16 — sync the early-declared refs (line ~395) with the latest
  // closures every render. The slash-command useEffect captures
  // those refs via `*Ref.current` instead of the bare callbacks, so
  // there's no TDZ hazard at the cost of a tiny indirection. The
  // signal-handler useEffect (deps: []) also reads through these
  // refs so it always sees the freshest summariser even though it
  // mounts exactly once at app start (when llmRef may not yet be
  // populated).
  useEffect(() => {
    summariseAndPersistOutgoingRef.current = summariseAndPersistOutgoing;
    summariseFromSnapshotRef.current = summariseFromSnapshot;
    summariseWithTimeoutRef.current = summariseWithTimeout;
  }, [summariseAndPersistOutgoing, summariseFromSnapshot, summariseWithTimeout]);

  // ---------- Startup model-list refresh (Agent 8 R8) ----------
  /**
   * Re-fetch the model list from the configured backend the FIRST time
   * the chat screen mounts with a usable config. Keeps
   * `config.model.available` honest as the user installs / pulls new
   * models and removes stale ones in Ollama / LM Studio.
   *
   * Behaviour:
   *   - Only fires on the chat screen (skip during onboarding /
   *     `--reconfigure`). The user picks the model directly during
   *     onboarding so a redundant refresh is wasted bandwidth and
   *     racy with the wizard's own state.
   *   - Skipped entirely when `--no-refresh-models` is passed.
   *   - On success: rewrite `model.available`. If the previously
   *     selected `model.current` is missing from the new list, fall
   *     back to the first available model and surface a chat-log
   *     notice so the user knows their selection moved.
   *   - On failure (network, timeout, 404, etc.): log a single
   *     warning line and keep the existing config — the chat still
   *     works, the user can run `/model refresh` to retry.
   *   - Cancellation-safe: a `cancelled` flag stops late writes from
   *     a stale fetch resolving after unmount.
   *
   * Runs ONCE per `(screen, llm)` pair: when the user navigates back
   * to chat from another screen we don't fire again (the adapter is
   * the same instance, so the closure captures the same `llmRef`).
   * The dependency array uses the screen + llm-presence sentinel
   * deliberately so a fresh adapter (e.g. via /provider) re-arms.
   */
  const refreshSentinel = llm !== null ? 1 : 0;
  useEffect(() => {
    if (noRefreshModels) return undefined;
    if (screen !== 'chat') return undefined;
    if (configRef.current === null) return undefined;
    if (llmRef.current === null) return undefined;

    let cancelled = false;
    void (async () => {
      const adapter = llmRef.current;
      if (adapter === null) return;
      let models: readonly string[];
      try {
        models = await adapter.getModels();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(
          `Could not refresh models: ${msg}. The chat will still work; try /provider to verify the URL or /model to pick another model.`,
        );
        return;
      }
      if (cancelled) return;

      if (models.length === 0) {
        appendLog(
          'No models found on the configured backend. Check the URL via /provider, then run /model refresh.',
        );
        return;
      }

      // Re-read the live config so we don't clobber a concurrent edit
      // (e.g. the user changed `/model` via slash-command between
      // mount and the refresh resolving).
      let liveCurrent: string;
      try {
        liveCurrent = configManager.read().model.current;
      } catch {
        // If the config disappeared mid-flight, bail out cleanly.
        return;
      }

      const updates: { available: string[]; current?: string } = {
        available: [...models],
      };
      if (!models.includes(liveCurrent)) {
        const fallback = models[0];
        if (typeof fallback === 'string' && fallback.length > 0) {
          updates.current = fallback;
          appendLog(
            `Note: previously-selected model "${liveCurrent}" is no longer available on the backend. Switched to "${fallback}". Run /model to pick another.`,
          );
        }
      }

      try {
        const merged = configManager.update({ model: updates });
        if (!cancelled) {
          setConfig(merged);
          // Visible confirmation — without this line the in-mount
          // refresh is silent on the happy path, so the user can't
          // tell whether the auto-sync ran. Always emit a single
          // status line so the behaviour is observable. The
          // "current model auto-switched" suffix only appears when
          // the previously-selected model vanished from the fresh
          // list (we already log a more detailed note in that
          // branch above; this is a brief, parallel hint).
          const backend = configRef.current?.backend.type ?? 'unknown';
          const changed =
            updates.current !== undefined ? ' (current model auto-switched)' : '';
          appendLog(`✓ Synced ${models.length} models from ${backend}${changed}`);
        }
      } catch {
        // Persist failure — leave the in-memory config alone; the
        // user can retry via /model refresh.
      }
    })();

    return () => {
      cancelled = true;
    };
    // appendLog / configManager are stable; refreshSentinel re-arms on
    // adapter rotation. eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, refreshSentinel, noRefreshModels]);

  /**
   * R17 (Agent 8) — `skillsOverride` lets the per-turn `@-mention`
   * skill resolution (computed in `preprocessUserMessage`) replace the
   * default "all active skills" set just for the current turn. Pass
   * `undefined` to keep the legacy behaviour (read the active set from
   * `skillsRef`). The override is consumed once via a ref that
   * `runStreamLoop` reads exactly when it builds the wire message.
   */
  const buildSystemMessage = useCallback(
    (skillsOverride?: readonly Skill[]): Message => {
      const activeSkills =
        skillsOverride ?? skillsRef.current.filter((s) => s.active);
      const md = readLocalcodeMdSafe(projectRoot);
      const summary =
        currentSessionRef.current !== null
          ? currentSessionRef.current.summary
          : null;
      // Agent F (R26 wiring): pass `modelName` so `buildSystemPrompt`
      // can pick a model-specific Identity preset (Qwen / Gemma / Llama
      // / DeepSeek / generic). The current model is the override (when
      // present) or the persisted config value. `configRef` guarantees
      // we read the latest value even if `config` state is stale in
      // this closure.
      const modelName =
        modelOverride ?? configRef.current?.model.current;
      // Memory section is pre-rendered byte-stably from the freshest
      // watcher snapshot. Empty entries → empty string → consumer
      // omits the heading entirely (preserves prefix-cache stability
      // for projects with no memory yet).
      const memorySection = renderMemorySection(memoryEntriesRef.current);
      const outputStyle = configRef.current?.outputStyle;
      const content = contextManager.buildSystemPrompt({
        localcodeMd: md,
        skills: activeSkills,
        summary,
        modelName,
        memorySection,
        ...(outputStyle !== undefined ? { outputStyle } : {}),
      });
      return {
        id: newId('sys'),
        role: 'system',
        content,
        createdAt: nowMs(),
      };
    },
    [contextManager, projectRoot, modelOverride],
  );

  // ---------- Submit handler: user message → stream loop ----------
  const runStreamLoop = useCallback(async (): Promise<void> => {
    if (llm === null) return;
    if (config === null) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const maxTokens = config.context.maxTokens > 0
      ? config.context.maxTokens
      : getMaxContextTokens(config.backend.type);

    // Auto-summarise if we're over threshold.
    try {
      await contextManager.maybeSummarize(maxTokens);
    } catch {
      // swallow — summariser is best-effort
    }

    // Prepend a fresh system message (skills / LOCALCODE.md may have changed).
    // R17 — consume any per-turn `@-mention` skills override that
    // `onSubmit`/`preprocessUserMessage` placed in the ref. Cleared
    // immediately so subsequent turns fall back to the active set
    // unless the next user message also `@-mentions` skills.
    const skillsOverride = skillsForNextTurnRef.current;
    skillsForNextTurnRef.current = undefined;
    const system = buildSystemMessage(skillsOverride);
    const messagesForWire: Message[] = [system, ...contextManager.getMessages()];

    // Snapshot the model THIS request will be served by, before
    // streaming begins. Reading `config.model.current` again at commit
    // time would let a mid-stream `/model` switch retroactively relabel
    // the message we are about to commit. The captured value is
    // attached to the assistant `Message.model` field so the UI can
    // label each row with the model that actually generated it.
    const requestModel =
      modelOverride ?? configRef.current?.model.current ?? config.model.current;

    let accumulated = '';
    // R12 (Agent 8) — local accumulator mirroring `accumulated` for
    // model thinking content. Fed by `onThinkingChunk` from the R13
    // splitter. Persisted onto the resulting assistant message via
    // `Message.thinking` so the committed-message UI (Agent 4 R16
    // follow-up) can render <ThinkingBlock collapsedByDefault>. Kept
    // local — not derived from `chatState` — so the END_STREAM reset
    // can't race the commit.
    let accumulatedThinking = '';
    const emittedToolCallsBox: { value: ToolCall[] | null } = { value: null };
    let streamError: string | null = null;
    let streamUsagePromptTokens: number | undefined;
    let streamUsageCompletionTokens: number | undefined;
    let streamUsageCachedTokens: number | undefined;
    // COST-PERSIST-SECTION — Anthropic-only cache-write counter; passed
    // through to SessionManager.addMessage so the cost-calculator can
    // bill the cache-write surcharge.
    let streamUsageCacheCreationTokens: number | undefined;
    // COST-PERSIST-SECTION-END
    let streamDurationMs: number | undefined;

    chatDispatch({ type: 'START_STREAM' });

    try {
      await llm.streamChat({
        messages: messagesForWire,
        tools: [...TOOLS_SCHEMA, ...buildMcpToolSchema(getProcessMcpRegistry())],
        signal: controller.signal,
        options: buildGenerationOptions(
          resolvedGenerationRef.current,
          config.backend.type,
        ),
        onChunk: (text: string) => {
          accumulated += text;
          chatDispatch({ type: 'APPEND_CHUNK', text });
        },
        onThinkingChunk: (text: string) => {
          // R12 (Agent 8) — wire R13 thinking-channel into the chat
          // state so the live <ThinkingBlock> can render the model's
          // reasoning above the streaming reply. Both the local
          // accumulator (used at commit time) and the reducer state
          // (used by the live UI) get the same delta.
          accumulatedThinking += text;
          chatDispatch({ type: 'APPEND_THINKING', text });
        },
        onToolCalls: (calls: ToolCall[]) => {
          emittedToolCallsBox.value = calls;
        },
        onDone: (result) => {
          if (result.error !== undefined) streamError = result.error;
          if (result.usage !== undefined) {
            streamUsagePromptTokens = result.usage.promptTokens;
            streamUsageCompletionTokens = result.usage.completionTokens;
            streamUsageCachedTokens = result.usage.cachedInputTokens;
            // COST-PERSIST-SECTION — Anthropic cache-write counter for
            // the assistant message persistence path.
            streamUsageCacheCreationTokens = result.usage.cacheCreationTokens;
            // COST-PERSIST-SECTION-END
          }
          if (result.durationMs !== undefined) {
            streamDurationMs = result.durationMs;
          }
          // FIX #29 — stream finished; play the completion cue. We do
          // NOT beep here when the stream errored (the error path
          // below triggers `error` instead), keeping the two signals
          // distinguishable.
          if (result.error === undefined) {
            soundPlayer.play('completion');
          } else {
            soundPlayer.play('error');
          }
        },
      });
    } catch (err) {
      streamError = err instanceof Error ? err.message : String(err);
    } finally {
      abortControllerRef.current = null;
    }

    // Fix 2 (type-ahead error gate): forward the stream-error verbatim
    // to the reducer so ChatScreen can pause auto-flushing the queued
    // type-ahead messages until the user explicitly retries.
    chatDispatch({
      type: 'END_STREAM',
      ...(streamError !== null ? { error: streamError } : {}),
    });

    // Record usage for the session totals (shown in the footer).
    if (
      streamUsagePromptTokens !== undefined ||
      streamUsageCompletionTokens !== undefined
    ) {
      contextManager.recordUsage(
        streamUsagePromptTokens ?? 0,
        streamUsageCompletionTokens ?? 0,
      );
      if (streamUsageCompletionTokens !== undefined) {
        chatDispatch({
          type: 'ADD_OUTPUT_TOKENS',
          tokens: streamUsageCompletionTokens,
        });
      }

      // TOKEN-VISUALIZER-SAMPLES-SECTION (Wave 6A4) — push the just-
      // completed turn into the ring buffers so `/perf` (sparklines)
      // and `/cost` (per-turn table) reflect it on next open. Sample
      // is recorded only when at least one usage metric came back —
      // a pure-error stream contributes nothing.
      if (streamError === null) {
        const tokIn = streamUsagePromptTokens ?? 0;
        const tokOut = streamUsageCompletionTokens ?? 0;
        const cached = streamUsageCachedTokens ?? 0;
        const dur = streamDurationMs ?? 0;
        const cacheHitPct = tokIn > 0 ? (cached / tokIn) * 100 : 0;
        const sample: TokenTurnSample = {
          tokensIn: tokIn,
          tokensOut: tokOut,
          durationMs: dur,
          cacheHitPct,
        };
        setPerfSamples((prev) => {
          const next = [...prev, sample];
          if (next.length > TOKEN_SAMPLES_RING_SIZE) {
            return next.slice(next.length - TOKEN_SAMPLES_RING_SIZE);
          }
          return next;
        });
        // Cost row mirrors the sample but adds per-turn computed
        // cost. We resolve pricing inline so OpenRouter overrides
        // (refreshed via the dashboard's `r` action) are picked up
        // on the next push.
        try {
          const pricing = resolvePrice(config.backend.type, requestModel);
          const cb = computeCostBreakdown(
            {
              inputTokens: tokIn,
              outputTokens: tokOut,
              cachedInputTokens: cached,
            },
            pricing,
          );
          const turn = ++turnCounterRef.current;
          const row: CostTurnRow = {
            turn,
            inputTokens: tokIn,
            outputTokens: tokOut,
            cachedTokens: cached,
            durationMs: dur,
            cost: cb.total,
            model: requestModel,
          };
          setCostSampleRows((prev) => {
            const next = [...prev, row];
            if (next.length > TOKEN_SAMPLES_RING_SIZE) {
              return next.slice(next.length - TOKEN_SAMPLES_RING_SIZE);
            }
            return next;
          });
        } catch {
          // Pricing resolution failures (unknown model, etc.) are
          // non-fatal — we still record the sample with cost=0 so
          // the cost dashboard renders the rest of the row.
          const turn = ++turnCounterRef.current;
          const row: CostTurnRow = {
            turn,
            inputTokens: tokIn,
            outputTokens: tokOut,
            cachedTokens: cached,
            durationMs: dur,
            cost: 0,
            model: requestModel,
          };
          setCostSampleRows((prev) => {
            const next = [...prev, row];
            if (next.length > TOKEN_SAMPLES_RING_SIZE) {
              return next.slice(next.length - TOKEN_SAMPLES_RING_SIZE);
            }
            return next;
          });
        }
      }
      // TOKEN-VISUALIZER-SAMPLES-SECTION — end
    }

    if (streamError !== null) {
      const errMsg: Message = {
        id: newId('err'),
        role: 'system',
        content: `(stream error) ${streamError}`,
        createdAt: nowMs(),
      };
      chatDispatch({ type: 'ADD_MESSAGE', message: errMsg });
      return;
    }

    // If we got tool calls, emit an assistant message carrying them plus any
    // preceding text, then execute each tool, append tool results, and loop.
    const emittedToolCalls = emittedToolCallsBox.value;
    if (emittedToolCalls !== null && emittedToolCalls.length > 0) {
      const assistantMsg: Message = withThinking(
        {
          id: newId('asst'),
          role: 'assistant',
          content: accumulated,
          toolCalls: emittedToolCalls,
          createdAt: nowMs(),
          tokensInput: streamUsagePromptTokens,
          tokensOutput: streamUsageCompletionTokens,
          durationMs: streamDurationMs,
          model: requestModel,
        },
        accumulatedThinking,
      );
      contextManager.add(assistantMsg);
      chatDispatch({ type: 'ADD_MESSAGE', message: assistantMsg });
      // R12 (Agent 8) — assistant message just committed with the
      // accumulated thinking attached. Drop the live buffer so the
      // streaming <ThinkingBlock> doesn't keep showing it after the
      // turn ends.
      chatDispatch({ type: 'RESET_THINKING' });
      persistMessage(sessionManager, sessionIdRef.current, assistantMsg, {
        tokensInput: streamUsagePromptTokens,
        tokensOutput: streamUsageCompletionTokens,
        durationMs: streamDurationMs,
        model: requestModel,
        // COST-PERSIST-SECTION — backend + cache telemetry so
        // SessionManager resolves OpenRouter-routed pricing and persists
        // `cost_usd` / cache columns alongside the standard counters.
        backend: config.backend.type,
        ...(streamUsageCachedTokens !== undefined
          ? { cachedInputTokens: streamUsageCachedTokens }
          : {}),
        ...(streamUsageCacheCreationTokens !== undefined
          ? { cacheCreationTokens: streamUsageCacheCreationTokens }
          : {}),
        // COST-PERSIST-SECTION-END
      });

      // Execute each tool call serially.
      const results = await executeToolsWithUi(
        emittedToolCalls,
        toolExecutor,
        chatDispatch,
      );

      // Clear pendingApproval state after all tools run.
      chatDispatch({ type: 'SET_PENDING_APPROVAL', approval: null });

      // Append a tool message per call. For fetch_image results we also
      // splice a multimodal user message so the NEXT model turn can
      // analyse the image (FIX #21).
      const extraUserMessages: Message[] = [];
      for (const { toolCall, result } of results) {
        const toolMsg: Message = {
          id: newId('tool'),
          role: 'tool',
          content: formatToolOutput(result),
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          createdAt: nowMs(),
        };
        contextManager.add(toolMsg);
        chatDispatch({ type: 'ADD_MESSAGE', message: toolMsg });
        persistMessage(sessionManager, sessionIdRef.current, toolMsg);

        // FIX #29 — fire an error cue when a tool failed so the user
        // isn't left wondering about a silent red block.
        if (
          !result.success &&
          typeof result.error === 'string' &&
          result.error.length > 0
        ) {
          soundPlayer.play('error');
        }

        if (toolCall.name === 'fetch_image' && result.success) {
          const imgMsg = maybeBuildImageFollowup(result);
          if (imgMsg !== null) extraUserMessages.push(imgMsg);
        }

        // todo_write — refresh the in-memory todos state from DB so
        // TasksLine reflects the update immediately.
        if (toolCall.name === 'todo_write' && result.success) {
          const sid = sessionIdRef.current;
          if (sid !== null) {
            setSessionTodos(sessionManager.getTodos(sid));
          }
        }
      }

      // Append multimodal follow-up user messages (no UI render — they go
      // straight to context for the next model turn).
      for (const m of extraUserMessages) {
        contextManager.add(m);
      }

      // Recurse to let the model continue with the tool outputs.
      await runStreamLoop();
      return;
    }

    // Plain text completion — persist one assistant message with telemetry.
    if (accumulated.length > 0) {
      const msg: Message = withThinking(
        {
          id: newId('asst'),
          role: 'assistant',
          content: accumulated,
          createdAt: nowMs(),
          tokensInput: streamUsagePromptTokens,
          tokensOutput: streamUsageCompletionTokens,
          durationMs: streamDurationMs,
          model: requestModel,
        },
        accumulatedThinking,
      );
      contextManager.add(msg);
      chatDispatch({ type: 'ADD_MESSAGE', message: msg });
      // R12 (Agent 8) — see comment on the tool-call branch above. Live
      // thinking buffer is cleared after persisting the message.
      chatDispatch({ type: 'RESET_THINKING' });
      persistMessage(sessionManager, sessionIdRef.current, msg, {
        tokensInput: streamUsagePromptTokens,
        tokensOutput: streamUsageCompletionTokens,
        durationMs: streamDurationMs,
        model: requestModel,
        // COST-PERSIST-SECTION — see twin call in the tool-call branch.
        backend: config.backend.type,
        ...(streamUsageCachedTokens !== undefined
          ? { cachedInputTokens: streamUsageCachedTokens }
          : {}),
        ...(streamUsageCacheCreationTokens !== undefined
          ? { cacheCreationTokens: streamUsageCacheCreationTokens }
          : {}),
        // COST-PERSIST-SECTION-END
      });
    }

    // Stop — fires ONLY on the final turn (this branch has no
    // pending tool calls and is NOT going to recurse). Carries the
    // usage snapshot for the just-finished turn. Blocking outcomes
    // surface as a synthetic system note via the same `ADD_MESSAGE`
    // pattern used elsewhere. We never roll back the assistant
    // message that already streamed — the user has already seen it.
    if (hookEngine.hasHooksFor('Stop')) {
      try {
        const usage: HookUsageSnapshot = {};
        if (streamUsagePromptTokens !== undefined) {
          usage.promptTokens = streamUsagePromptTokens;
        }
        if (streamUsageCompletionTokens !== undefined) {
          usage.completionTokens = streamUsageCompletionTokens;
        }
        const outcomes = await hookEngine.run({
          trigger: 'Stop',
          projectRoot,
          ...(sessionIdRef.current !== null
            ? { sessionId: sessionIdRef.current }
            : {}),
          usage,
        });
        const blocker = outcomes.find((o) => o.blocked);
        if (blocker !== undefined) {
          const stderrTrimmed = blocker.stderr.trim();
          const reason =
            stderrTrimmed.length > 0
              ? stderrTrimmed
              : `Stop hook exit ${blocker.exitCode}`;
          chatDispatch({
            type: 'ADD_MESSAGE',
            message: {
              id: newId('sys'),
              role: 'system',
              content: `Stop hook flagged: ${reason}`,
              createdAt: nowMs(),
            },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        chatDispatch({
          type: 'ADD_MESSAGE',
          message: {
            id: newId('sys'),
            role: 'system',
            content: `Stop hook engine failed: ${msg}`,
            createdAt: nowMs(),
          },
        });
      }
    }

    // Auto-compress trigger. Runs ONLY at the tail of a plain-text
    // turn (the tool-call branch returned earlier and recurses, so its
    // own final turn will hit this site). The predicate is pure —
    // cooldown + queue-once semantics live here.
    void maybeAutoCompress();
  }, [
    llm,
    config,
    contextManager,
    sessionManager,
    toolExecutor,
    buildSystemMessage,
    soundPlayer,
    hookEngine,
    projectRoot,
  ]);

  /**
   * Auto-compress dispatcher. Idempotent + cooldown-guarded: at most
   * one compress fires per `AUTO_COMPRESS_COOLDOWN_MS` window, even
   * if the predicate stays true across several turns.
   *
   * Invokes the `/compress` execute closure programmatically (NOT
   * through the user-input pipe) so the user never sees a literal
   * `/compress` line in their transcript — only a one-line system
   * status message announcing the auto-trigger.
   */
  const maybeAutoCompress = useCallback(async (): Promise<void> => {
    const cfg = configRef.current;
    if (cfg === null) return;
    const exec = compressExecRef.current;
    if (exec === null) return;

    const maxCtx = cfg.context.maxTokens > 0
      ? cfg.context.maxTokens
      : getMaxContextTokens(cfg.backend.type);
    const triggerAtPercent = cfg.context.autoCompressPercent ?? 0.8;

    const messages = contextManager.getMessages();
    const systemPreview = buildSystemMessage();
    const sysContent = typeof systemPreview.content === 'string'
      ? systemPreview.content
      : '';
    const ctxTokens = estimateContextTokens(messages, sysContent);

    if (
      !shouldAutoCompress({
        contextTokens: ctxTokens,
        maxContextTokens: maxCtx,
        triggerAtPercent,
      })
    ) {
      return;
    }

    const now = nowMs();
    if (
      !autoCompressCooldownElapsed({
        lastCompressAt: lastAutoCompressAtRef.current,
        now,
        cooldownMs: AUTO_COMPRESS_COOLDOWN_MS,
      })
    ) {
      return;
    }

    // PreCompact — give user hooks a chance to abort the compress.
    // A blocking non-zero exit aborts; cooldown is NOT stamped so
    // the user can fix the hook and try again on the next turn.
    if (hookEngine.hasHooksFor('PreCompact')) {
      try {
        const outcomes = await hookEngine.run({
          trigger: 'PreCompact',
          projectRoot,
          ...(sessionIdRef.current !== null
            ? { sessionId: sessionIdRef.current }
            : {}),
          contextTokens: ctxTokens,
          maxContextTokens: maxCtx,
        });
        const blocker = outcomes.find((o) => o.blocked);
        if (blocker !== undefined) {
          const stderrTrimmed = blocker.stderr.trim();
          const reason =
            stderrTrimmed.length > 0
              ? stderrTrimmed
              : `PreCompact hook exit ${blocker.exitCode}`;
          chatDispatch({
            type: 'ADD_MESSAGE',
            message: {
              id: newId('sys'),
              role: 'system',
              content: `Auto-compress aborted by hook: ${reason}`,
              createdAt: now,
            },
          });
          return;
        }
      } catch (err) {
        // Engine failures don't abort compress — degrade to a notice
        // and continue so a broken hook can't permanently block
        // auto-compress.
        const msg = err instanceof Error ? err.message : String(err);
        chatDispatch({
          type: 'ADD_MESSAGE',
          message: {
            id: newId('sys'),
            role: 'system',
            content: `PreCompact hook engine failed: ${msg}`,
            createdAt: now,
          },
        });
      }
    }

    // Stamp cooldown AFTER the hook passes — a blocked PreCompact
    // must NOT consume the 60s window or the user would lose two
    // compress opportunities in a row from one misconfigured hook.
    lastAutoCompressAtRef.current = now;

    const pct = Math.round(triggerAtPercent * 100);
    const banner: Message = {
      id: newId('sys'),
      role: 'system',
      content: `Auto-compressing context (${pct}% of ${maxCtx.toLocaleString()})…`,
      createdAt: now,
    };
    chatDispatch({ type: 'ADD_MESSAGE', message: banner });

    // Build a minimal CommandContext that mirrors the slash-execute
    // path: `print` lands as a system message, `setScreen` /
    // `showOverlay` are no-ops here (compress doesn't use them).
    const ctx: CommandContext = {
      projectRoot,
      sessionId: sessionIdRef.current,
      config: cfg,
      print: (line: string): void => {
        chatDispatch({
          type: 'ADD_MESSAGE',
          message: {
            id: newId('sys'),
            role: 'system',
            content: line,
            createdAt: nowMs(),
          },
        });
      },
      setScreen,
      showOverlay: undefined,
    };
    try {
      await exec('', ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chatDispatch({
        type: 'ADD_MESSAGE',
        message: {
          id: newId('sys'),
          role: 'system',
          content: `Auto-compress failed: ${msg}`,
          createdAt: nowMs(),
        },
      });
    }
  }, [contextManager, buildSystemMessage, projectRoot, setScreen, hookEngine]);

  /**
   * R17 (Agent 8) — pre-process a freshly-submitted user message.
   *
   * Two passes:
   *
   * 1. **`@path:line` file references.** Scan the text for tokens like
   *    `@src/foo.ts:42` (with optional column `:42:7`). For each that
   *    points at a file inside `projectRoot`, read 5 lines of context
   *    on either side and append a numbered code excerpt to the
   *    expanded message. Path traversal is rejected — anything that
   *    resolves outside `projectRoot` is silently skipped, so a user
   *    can't sneak `@../../etc/passwd:1` past the guard.
   *
   * 2. **`@skill` mentions.** Delegate to
   *    `skillsManager.getSkillsForTurn(text)` (Agent 6 R7). It returns
   *    the per-turn skill set (mentions override the active set) and
   *    a list of unknown mentions. Callers surface unknowns to the
   *    user via `appendLog`.
   *
   * Failure modes are tolerated: missing files, unreadable files, or
   * any I/O hiccup → the reference is dropped and the rest of the
   * message proceeds. The original text is always retained verbatim
   * at the head of `expandedText`; the expansions are appended after
   * a clearly-marked separator so the model can tell what the user
   * actually wrote vs. the auto-attached context.
   */
  const preprocessUserMessage = useCallback(
    async (
      text: string,
    ): Promise<{
      expandedText: string;
      fileExpansions: { path: string; line: number; excerpt: string }[];
      skillsForTurn: Skill[];
      unknownMentions: string[];
    }> => {
      const fileExpansions: {
        path: string;
        line: number;
        excerpt: string;
      }[] = [];
      // The `(?:^|\s)` anchor + the `@` literal guard against email
      // addresses (`user@example.com`). Body chars match a typical
      // POSIX-relative path: word chars, `.`, `/`, `\`, `-`. Two
      // capture groups: line (required), column (optional but
      // accepted to keep editor jump-link compatibility).
      const fileRefRe = /(?:^|\s)@([\w./\\-]+):(\d+)(?::(\d+))?\b/g;
      const rootResolved = path.resolve(projectRoot);

      for (const m of text.matchAll(fileRefRe)) {
        const relPath = m[1];
        const lineRaw = m[2];
        if (typeof relPath !== 'string' || typeof lineRaw !== 'string') {
          continue;
        }
        const line = Number.parseInt(lineRaw, 10);
        if (!Number.isFinite(line) || line < 1) continue;

        const fullPath = path.resolve(projectRoot, relPath);
        // Path-traversal guard: refuse anything that escapes the
        // project root after resolution. Allow `fullPath ===
        // rootResolved` (project root itself) defensively even though
        // it can never be a file.
        if (
          fullPath !== rootResolved &&
          !fullPath.startsWith(rootResolved + path.sep)
        ) {
          continue;
        }
        if (!fs.existsSync(fullPath)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          // 5 lines context above + 5 below, inclusive of the cited
          // line. `start` is 0-based for slicing; the rendered prefix
          // is 1-based to match editor line numbers.
          const start = Math.max(0, line - 6);
          const end = Math.min(lines.length, line + 5);
          const excerpt = lines
            .slice(start, end)
            .map((l, i) => `${start + i + 1}: ${l}`)
            .join('\n');
          fileExpansions.push({ path: relPath, line, excerpt });
        } catch {
          // unreadable → skip this reference, keep going
        }
      }

      // Skill resolution — defaults to the active set when no
      // mentions are present, see SkillsManager.getSkillsForTurn JSDoc.
      let skillsForTurn: Skill[] = [];
      let unknownMentions: string[] = [];
      try {
        const turn = await skillsManager.getSkillsForTurn(text);
        skillsForTurn = turn.skills;
        unknownMentions = turn.unknownMentions;
      } catch {
        // Skill resolution failure is non-fatal — fall back to an empty
        // set rather than blocking the user's message. The system
        // prompt builder tolerates an empty `skills` array.
      }

      let expandedText = text;
      if (fileExpansions.length > 0) {
        const expansions = fileExpansions
          .map((e) => `\n[@${e.path}:${e.line}]\n${e.excerpt}\n`)
          .join('');
        expandedText = text + '\n\n[Inline file references]' + expansions;
      }

      return {
        expandedText,
        fileExpansions,
        skillsForTurn,
        unknownMentions,
      };
    },
    [projectRoot, skillsManager],
  );

  const onSubmit = useCallback(
    (text: string): void => {
      if (text.trim().length === 0) return;
      if (sessionIdRef.current === null) {
        appendLog('No active session yet; please wait.');
        return;
      }

      // Defense in depth (Agent 8 R4/R6 — slash-leak fix): the ChatScreen
      // submit path is responsible for routing `/`-prefixed input
      // through `onSlashExecute`. If any future caller (queue replay,
      // synthetic dispatch, regression in ChatScreen) hands a single-
      // slash payload to this `onSubmit` that LOOKS LIKE A COMMAND
      // (clean-ident first segment, no further `/`), intercept it so
      // it can never reach `streamChat`.
      //
      // R6 refinement: paths and URL-shaped inputs (`/Users/foo.png`,
      // `/var/log/system.log`, `/usr/local/bin`) are NOT command-
      // shaped and must flow through to the LLM as ordinary user
      // text — the user pastes a path, expects the model + fetch_image
      // tool to consume it. The previous R4 guard was too aggressive
      // and intercepted these as "stray slash input".
      const trimmed = text.trim();
      if (
        trimmed.startsWith('/') &&
        !trimmed.startsWith('//') &&
        isCommandShape(trimmed)
      ) {
        appendLog(
          `Ignored stray slash input "${trimmed}" — slash commands must go through the command bar.`,
        );
        return;
      }

      // AGENT-PANEL-SECTION (Wave 5A — TA team) — attached-worker route.
      // When the user has attached the composer to a worker via
      // `<AgentPanel>` (`currentConversant !== 'lead'`), Enter posts the
      // text onto the orchestrator's TeamBus as a `lead → <worker>`
      // unicast message rather than firing a fresh LLM stream. History
      // is still pushed (so ↑/↓ walks it) and a synthetic chat note is
      // appended so the user sees the routed message in scrollback.
      if (
        chatState.currentConversant !== 'lead' &&
        chatState.currentConversant.length > 0
      ) {
        const targetAgentId = chatState.currentConversant;
        chatDispatch({ type: 'PUSH_HISTORY', text });
        try {
          const orch = agentOrchestratorRef.current ?? getAgentOrchestrator();
          orch.postTeamMessage(
            sessionIdRef.current,
            LEAD_AGENT_ID,
            targetAgentId,
            text,
          );
          appendLog(`→ ${targetAgentId}: ${text}`);
        } catch (err) {
          appendLog(
            `Failed to deliver to ${targetAgentId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      // History-push for every submitted text (ChatScreen ↑/↓ walks it).
      chatDispatch({ type: 'PUSH_HISTORY', text });

      // SKILL-SUGGEST-SECTION (submit) — auto-suggest non-active skills
      // whose `triggers` regexes match the user's input. Best-effort:
      // any throw inside the suggester (bad regex etc) is swallowed —
      // the suggester itself returns `[]` rather than throwing, but we
      // wrap defensively. The toast is purely advisory; we never block
      // the submit waiting for the suggester.
      try {
        const allSkills = skills;
        const activeIds = new Set<string>();
        for (const s of allSkills) {
          if (s.active) activeIds.add(s.id);
        }
        const suggestions = suggestSkillsForInput(text, allSkills, activeIds);
        setSkillSuggestions(suggestions);
      } catch {
        // Never block submit on suggester failure.
        setSkillSuggestions([]);
      }
      // SKILL-SUGGEST-SECTION (submit end)

      // APPROVAL-BATCH-SECTION
      // Reset turn-scoped batch approvals on every new user message —
      // the `[A]` button only lasts for the turn that approved it.
      // Session-scoped `[S]` approvals on `run_command` survive across
      // turns and are NOT reset here (they stay valid for the rest of
      // the process lifetime).
      toolExecutor.resetTurnAutoApprove();
      // APPROVAL-BATCH-SECTION-END

      // Defense-in-depth: ChatScreen's `submit()` already swallows
      // streaming-time submits into the reducer queue via
      // `onEnqueuePending`, so this branch is only ever hit by
      // synthetic callers (drain replay, tests, hypothetical future
      // consumers) racing the gate. We dispatch the same
      // `ENQUEUE_PENDING` so the single source of truth stays
      // consistent and the ChatScreen flush effect picks it up once
      // the gate reopens. No drain effect is needed — the flush is
      // single-shot concat-and-send, owned entirely by ChatScreen.
      if (
        isStreamingRef.current ||
        chatState.pendingApproval !== null
      ) {
        chatDispatch({ type: 'ENQUEUE_PENDING', text });
        return;
      }

      // R17 — preprocess the raw text BEFORE adding to the context
      // manager. The async preprocessor expands `@file:line` references
      // and resolves `@skill` mentions; we then commit the EXPANDED
      // text to history (so the model sees the file excerpts) and
      // stash the per-turn skill set on `skillsForNextTurnRef` for
      // `runStreamLoop` to consume when it builds the system prompt.
      void (async (): Promise<void> => {
        const sid = sessionIdRef.current;
        if (sid === null) return;

        const pre = await preprocessUserMessage(text);

        if (pre.unknownMentions.length > 0) {
          appendLog(
            `Note: skills not found: ${pre.unknownMentions.map((s) => '@' + s).join(', ')} (continuing with known mentions only)`,
          );
        }

        const userMsg: Message = {
          id: newId('user'),
          role: 'user',
          content: pre.expandedText,
          createdAt: nowMs(),
        };

        // Set the session title from the first user message — use the
        // ORIGINAL text so the title isn't polluted by expanded
        // excerpts. Best-effort.
        try {
          const existing = sessionManager.getSession(sid);
          if (
            existing &&
            (existing.title === null || existing.title.length === 0)
          ) {
            sessionManager.updateTitle(sid, titleFromFirstMessage(text));
          }
        } catch {
          // ignore
        }

        contextManager.add(userMsg);
        chatDispatch({ type: 'ADD_MESSAGE', message: userMsg });
        persistMessage(sessionManager, sid, userMsg);

        // If the user pasted an image URL, hint the model toward fetch_image.
        if (IMAGE_URL_RE.test(text)) {
          const hint: Message = {
            id: newId('sys'),
            role: 'system',
            content:
              'User pasted an image URL. Use fetch_image if you need to analyse it.',
            createdAt: nowMs(),
          };
          contextManager.add(hint);
        }

        // Stash the per-turn skill set for runStreamLoop. The ref is
        // cleared by runStreamLoop after consumption so subsequent
        // turns fall back to the active set.
        skillsForNextTurnRef.current = pre.skillsForTurn;

        void runStreamLoop();
      })();
    },
    [
      appendLog,
      contextManager,
      runStreamLoop,
      sessionManager,
      chatState.pendingApproval,
      chatState.currentConversant,
      preprocessUserMessage,
      getAgentOrchestrator,
      // SKILL-SUGGEST-SECTION (deps)
      skills,
      // SKILL-SUGGEST-SECTION (deps end)
    ],
  );

  // Drain callbacks for the type-ahead queue. ChatScreen reads
  // `chatState.pendingQueue` directly via props and owns the flush
  // effect; these helpers are the upward dispatch path so submit /
  // double-Esc / Ctrl+X discard / post-flush clear all funnel through
  // the same reducer actions. No `useEffect`-driven drain runs here:
  // the flush is a single-shot concat-and-send orchestrated by
  // ChatScreen's flush effect, which dispatches `onClearPending` then
  // `onSubmit(concatenated)`.
  const onEnqueuePending = useCallback((text: string): void => {
    chatDispatch({ type: 'ENQUEUE_PENDING', text });
  }, []);
  const onClearPending = useCallback((): void => {
    chatDispatch({ type: 'CLEAR_PENDING' });
  }, []);

  /**
   * R17 (Agent 8) — bash mode (`!cmd`) handler. Wired into ChatScreen
   * via the `onBashExecute` prop; ChatScreen fires this for inputs
   * classified as `bash` by `classifySubmit` (Agent 4 R20).
   *
   * The user's `!cmd` line and its stdout/stderr are surfaced in the
   * chat UI as `system`-role messages via `appendLog`, which routes
   * through `setChatLog` (NOT through `contextManager`). This means
   * the bash output is visible to the user but NEVER reaches the
   * LLM on subsequent turns — the whole point of bash mode.
   *
   * Notes on safety:
   *   - Spawned via `sh -c <cmd>` with `cwd: projectRoot` so commands
   *     run inside the user's project. The user has explicit intent
   *     (the `!` prefix); bash mode is gated by ChatScreen and only
   *     reaches us when the classifier returned `bash`.
   *   - `reject: false` keeps execa from throwing on non-zero exit;
   *     we surface the exit code via a tail line.
   *   - 30s timeout — long enough for typical commands (build, test
   *     subset, ls, git status), short enough that a runaway shell
   *     can't hang the chat session.
   */
  const onBashExecute = useCallback(
    async (command: string): Promise<void> => {
      // Echo the command line first so the user has scrollback context
      // before any output lands.
      appendLog(`$ ${command}`);
      try {
        const result = await execa('sh', ['-c', command], {
          cwd: projectRoot,
          reject: false,
          timeout: 30_000,
        });
        const stdout = typeof result.stdout === 'string' ? result.stdout : '';
        const stderr = typeof result.stderr === 'string' ? result.stderr : '';
        const output =
          stdout + (stderr.length > 0 ? `\n[stderr]\n${stderr}` : '');
        const trimmed = output.trim();
        if (trimmed.length > 0) appendLog(trimmed);
        if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
          appendLog(`(exit ${result.exitCode})`);
        }
      } catch (e) {
        appendLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [projectRoot, appendLog],
  );

  const onApprove = useCallback((_id: string): void => {
    const resolver = pendingResolverRef.current;
    if (resolver !== null) {
      resolver(true);
    }
    chatDispatch({ type: 'SET_PENDING_APPROVAL', approval: null });
  }, []);

  const onReject = useCallback((_id: string): void => {
    const resolver = pendingResolverRef.current;
    if (resolver !== null) {
      resolver(false);
    }
    chatDispatch({ type: 'SET_PENDING_APPROVAL', approval: null });
  }, []);

  // APPROVAL-BATCH-SECTION
  const onApproveAllInTurn = useCallback((_id: string): void => {
    const resolver = pendingResolverRef.current;
    if (resolver !== null) {
      resolver({ approved: true, approveAllInTurn: true });
    }
    chatDispatch({ type: 'SET_PENDING_APPROVAL', approval: null });
  }, []);

  const onApproveForSession = useCallback((_id: string): void => {
    const resolver = pendingResolverRef.current;
    if (resolver !== null) {
      resolver({ approved: true, approveForSession: true });
    }
    chatDispatch({ type: 'SET_PENDING_APPROVAL', approval: null });
  }, []);
  // APPROVAL-BATCH-SECTION-END

  // AGENT-PANEL-SECTION (Wave 5A — TA team) — composer routing
  const onAgentFocusEnter = useCallback((): void => {
    chatDispatch({ type: 'AGENT_FOCUS_ENTER' });
  }, []);
  const onAgentFocusExit = useCallback((): void => {
    chatDispatch({ type: 'AGENT_FOCUS_EXIT' });
  }, []);
  const onAgentSelectNext = useCallback((): void => {
    chatDispatch({
      type: 'AGENT_SELECT_NEXT',
      workerCount: agentWorkers.length,
    });
  }, [agentWorkers.length]);
  const onAgentSelectPrev = useCallback((): void => {
    chatDispatch({
      type: 'AGENT_SELECT_PREV',
      workerCount: agentWorkers.length,
    });
  }, [agentWorkers.length]);
  const onAgentAttach = useCallback((agentId: string): void => {
    chatDispatch({ type: 'AGENT_ATTACH', agentId });
  }, []);
  const onAgentDetach = useCallback((): void => {
    chatDispatch({ type: 'AGENT_DETACH' });
  }, []);

  // CMD-PALETTE-MOUNT-SECTION (Wave 5A — TA team)
  // Build palette input data lazily — `paletteCommands` reflects the
  // currently-registered slash commands; `paletteFiles` is the recent
  // file list (a small seeded set today; future versions can refresh
  // it from a glob walk); `paletteSessions` is the user's recent
  // sessions; `paletteTools` is the static tools schema.
  const paletteCommands = useMemo<readonly PaletteCommand[]>(
    () =>
      slashCommands.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        ...(c.usage !== undefined ? { usage: c.usage } : {}),
      })),
    [slashCommands],
  );
  const paletteFiles = useMemo<readonly PaletteFile[]>(() => [], []);
  const paletteSessions = useMemo<readonly PaletteSession[]>(() => {
    try {
      const list = sessionManager.listSessions(20);
      return list.map((s) => ({
        id: s.id,
        title: s.title ?? '',
        updatedAt: s.updatedAt ?? Date.now(),
      }));
    } catch {
      return [];
    }
  }, [sessionManager]);
  const paletteTools = useMemo<readonly PaletteTool[]>(
    () =>
      TOOLS_SCHEMA.map((t) => ({
        name: t.function.name,
        description:
          typeof t.function.description === 'string' ? t.function.description : '',
      })),
    [],
  );
  const closePalette = useCallback((): void => {
    setPaletteOpen(false);
  }, []);
  const onPaletteSelect = useCallback(
    (selection: PaletteSelection): void => {
      setPaletteOpen(false);
      switch (selection.kind) {
        case 'command': {
          const cmd = slashCommands.find((c) => c.name === selection.name);
          if (cmd !== undefined) {
            // Insert prompt into the composer via chat log — caller
            // can type args after the command name. We don't auto-
            // execute because most commands open overlays anyway.
            appendLog(`/${cmd.name} `);
          }
          return;
        }
        case 'file': {
          appendLog(`@${selection.path}`);
          return;
        }
        case 'session': {
          appendLog(`/resume ${selection.id}`);
          return;
        }
        case 'tool': {
          appendLog(
            `tool: ${selection.name}${selection.usage !== undefined ? ` — ${selection.usage}` : ''}`,
          );
          return;
        }
        default: {
          const _exhaustive: never = selection;
          void _exhaustive;
          return;
        }
      }
    },
    [slashCommands, appendLog],
  );
  // CMD-PALETTE-MOUNT-SECTION-END

  const onCancel = useCallback((): void => {
    abortControllerRef.current?.abort();
    llm?.cancel();
  }, [llm]);

  const onSlashExecute = useCallback(
    (cmd: SlashCommand, args: string): void => {
      if (config === null) return;
      // Slash commands NEVER hit the LLM (FIX #15 verification). We call
      // cmd.execute directly; no path below touches runStreamLoop or the
      // adapter.
      const ctx: CommandContext = {
        projectRoot,
        sessionId: sessionIdRef.current,
        config,
        print: (line: string) => {
          const sysMsg: Message = {
            id: newId('sys'),
            role: 'system',
            content: line,
            createdAt: nowMs(),
          };
          chatDispatch({ type: 'ADD_MESSAGE', message: sysMsg });
        },
        setScreen,
        // FIX #32 — slash commands can open a local overlay instead of
        // emitting text. The reducer owns `overlayKind`; the overlay
        // itself is rendered by the branch below.
        //
        // R13 (Agent 8) — accept an optional `data` payload so callers
        // can pre-seed kind-specific state (e.g. `/model claude` →
        // `data.filter = 'claude'`). For 'model' we dispatch
        // `SHOW_OVERLAY` so the reducer stages the filter atomically
        // with the overlay open, then route to the modelSelect screen.
        // ModelSelectScreen consumes `chatState.modelOverlayFilter` via
        // its `initialFilter` prop on the rendering branch below.
        showOverlay: (
          kind: OverlayKind,
          data?: { filter?: string },
        ): void => {
          // `'skills'` reuses its dedicated full-screen route rather
          // than rendering a modal over ChatScreen; the legacy flow
          // still works for that caller.
          if (kind === 'skills') {
            setScreen('skills');
            return;
          }
          if (kind === 'model') {
            chatDispatch({ type: 'SHOW_OVERLAY', kind, data });
            setScreen('modelSelect');
            return;
          }
          // METRICS-WIRE-SECTION — `/metrics` dispatches `kind: 'metrics'`.
          // We aggregate the snapshot in the host (so the overlay stays
          // presentational) and set `metricsOverlayData` non-null to
          // trigger the takeover overlay branch in the chat-screen
          // render path below.
          if (kind === 'metrics') {
            setMetricsRefreshing(true);
            void (async (): Promise<void> => {
              try {
                const cfgTele = (config as unknown as {
                  telemetry?: { enabled?: boolean; retentionDays?: number };
                }).telemetry;
                const snap = await snapshotMetrics({
                  enabled: cfgTele?.enabled === true,
                  windowDays: cfgTele?.retentionDays ?? 30,
                });
                setMetricsOverlayData(snap);
              } catch (cause) {
                const msg =
                  cause instanceof Error ? cause.message : String(cause);
                appendLog(`/metrics failed: ${msg}`);
              } finally {
                setMetricsRefreshing(false);
              }
            })();
            return;
          }
          // METRICS-WIRE-SECTION-END
          chatDispatch({ type: 'SHOW_OVERLAY', kind, data });
        },
      };
      void (async () => {
        try {
          await cmd.execute(args, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.print(`/${cmd.name} failed: ${msg}`);
        }
      })();
    },
    [config, projectRoot],
  );

  // ---------- Skill overlay submit / cancel ----------

  /**
   * R9 (Agent 8) — AI Writer driver for `/new-skill`.
   *
   * The overlay calls this with the user's free-form description; we
   * stream a markdown skill file from the local LLM under a dedicated
   * SKILL-WRITER system prompt. The user's text is NOT added to the
   * global chat history — this is a one-shot, isolated request that
   * lives only inside the overlay.
   *
   * Returns a promise that resolves with the *full* generated content
   * (markdown, frontmatter included). Forwards the optional
   * `AbortSignal` so the overlay can cancel mid-stream (Esc / `c`).
   * Rejection paths:
   *   - Adapter unavailable (no LLM yet) → Error('LLM adapter not available.')
   *   - Stream finished with `error`     → Error(error)
   *   - User aborted via signal          → DOMException('Aborted', 'AbortError')
   * The overlay surfaces rejection messages inline as
   * `Last error: …` and re-seeds the prompt so the user can retry
   * without retyping.
   */
  const handleAiWriterGenerate = useCallback(
    async (
      prompt: string,
      onChunk: (text: string) => void,
      signal?: AbortSignal,
    ): Promise<string> => {
      const llm = llmRef.current;
      if (llm === null) throw new Error('LLM adapter not available.');

      const sysMessage: Message = {
        id: newId('skill-sys'),
        role: 'system',
        content: SKILL_WRITER_SYSTEM_PROMPT,
        createdAt: nowMs(),
      };
      const userMessage: Message = {
        id: newId('skill-u'),
        role: 'user',
        content: prompt,
        createdAt: nowMs(),
      };

      let buffer = '';
      return new Promise<string>((resolve, reject) => {
        const abortHandler = (): void => {
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal !== undefined) {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        // Fire-and-forget: streamChat never throws post-connection — all
        // outcomes surface through `onDone`. Wrapping in `void` keeps
        // `useCallback`'s sync signature intact.
        void llm.streamChat({
          messages: [sysMessage, userMessage],
          // Skill generation is a pure-text task — no tools, no
          // tool_choice. An empty array tells `buildRequestBody` to
          // omit the `tools`/`tool_choice` keys entirely so the
          // request body matches the legacy shape.
          tools: [],
          signal,
          onChunk: (text: string): void => {
            // Guard against late chunks arriving after an abort —
            // overlay would already be in the prompt step but a
            // straggling delta could otherwise fire onChunk.
            if (signal?.aborted === true) return;
            buffer += text;
            try {
              onChunk(text);
            } catch {
              // Swallow caller-callback failures: the overlay is the
              // only consumer today and it's pure setState; defensive
              // anyway in case of future use.
            }
          },
          // Tool calls should never happen for skill generation (we
          // pass `tools: []`), but if a server emits them anyway
          // we ignore the batch — the buffer is the source of truth.
          onToolCalls: () => {},
          onDone: (result): void => {
            if (signal !== undefined) {
              signal.removeEventListener('abort', abortHandler);
            }
            // If the user already aborted, the abortHandler above
            // already rejected; don't double-resolve.
            if (signal?.aborted === true) return;
            if (typeof result.error === 'string' && result.error.length > 0) {
              reject(new Error(result.error));
              return;
            }
            const trimmed = buffer.trim();
            if (trimmed.length === 0) {
              reject(
                new Error(
                  'The model returned an empty response. Try again or refine the prompt.',
                ),
              );
              return;
            }
            resolve(trimmed);
          },
        });
      });
    },
    [],
  );

  const onSkillSubmit = useCallback(
    (payload: SkillOverlaySubmission): void => {
      void (async () => {
        try {
          // The runtime shape from `SkillInputOverlay` always matches
          // the legacy `SkillOverlaySubmission` union. The new
          // `SkillSubmitPayload` type adds an optional `kind`
          // discriminator that lets us distinguish AI-writer output
          // (for clearer log lines) without breaking paste/file flows.
          const tagged = payload as SkillSubmitPayload;
          if ('sourcePath' in payload) {
            await skillsManager.add(payload.sourcePath);
            appendLog(`Added skill from ${payload.sourcePath}`);
          } else {
            await skillsManager.addFromText(payload.filename, payload.content);
            const label =
              'kind' in tagged && tagged.kind === 'ai-writer'
                ? `Added AI-generated skill ${payload.filename}`
                : `Added skill ${payload.filename}`;
            appendLog(label);
          }
          const next = await skillsManager.list();
          setSkills(next);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendLog(`Failed to add skill: ${msg}`);
        } finally {
          chatDispatch({ type: 'CLOSE_SKILL_OVERLAY' });
        }
      })();
    },
    [appendLog, skillsManager],
  );

  const onSkillCancel = useCallback((): void => {
    chatDispatch({ type: 'CLOSE_SKILL_OVERLAY' });
  }, []);

  // LANGUAGE-PICKER-MOUNT-SECTION — first-launch + /language callback.
  /**
   * Called when the user confirms a row in the language picker. Persists
   * the choice through `configManager.update(...)` (creating a minimal
   * config blob on first launch when no file exists yet) and advances
   * to the next screen — onboarding if it hasn't completed, chat if it
   * has (the `/language` re-open path).
   *
   * Wave 8C bug fix: previously, on FIRST launch (no config on disk yet),
   * the picker only stashed the locale on in-memory state. If the user
   * quit before onboarding completed, the locale was LOST and the picker
   * re-appeared on next launch. We now scaffold a minimal-but-valid
   * AppConfig with sensible defaults (ollama backend, no model yet,
   * `onboarding.completed: false`) and write it to disk IMMEDIATELY.
   * On next launch the loaded config has `locale === 'ru'` so the
   * picker is skipped, and `onboarding.completed === false` so the
   * onboarding flow still runs.
   */
  const onLanguageSelect = useCallback(
    (locale: 'en' | 'ru'): void => {
      try {
        if (configManager.exists()) {
          const merged = configManager.update({ locale });
          setConfig(merged);
        } else {
          // First launch — scaffold a minimal stub with the chosen
          // locale so the choice survives a quit-before-onboarding. The
          // remaining fields are placeholders; onboarding overwrites
          // them via `configManager.write(finalCfg)` on completion.
          const stub: AppConfig = {
            backend: { type: 'ollama', baseUrl: 'http://localhost:11434' },
            model: { current: '', available: [] },
            onboarding: { completed: false },
            permissions: { autoApprove: [], profile: 'default' },
            context: {
              maxTokens: 8192,
              keepAliveSeconds: 1800,
              responseTimeoutSeconds: 300,
              trimToolResultsAfter: 5,
              autoCompressPercent: 0.8,
              maxRecentMessages: 20,
            },
            sound: {
              enabled: false,
              onCompletion: true,
              onApproval: true,
              onError: true,
              volume: 0.5,
              completionFile: null,
              approvalFile: null,
              errorFile: null,
            },
            generation: {
              temperature: 0.2,
              topP: 0.9,
              repeatPenalty: 1.1,
              maxTokens: 4096,
            },
            outputStyle: 'concise',
            locale,
          };
          configManager.write(stub);
          setConfig(stub);
        }
      } catch {
        // Non-fatal — picker still advances. We don't surface a noisy
        // error here because the user will get the same message at the
        // onboarding write step if the disk is genuinely unwritable.
      }
      // Advance to onboarding if not yet completed; otherwise back to
      // chat (the `/language` re-open path).
      const completed = config?.onboarding.completed === true;
      setScreen(completed ? 'chat' : 'onboarding');
    },
    [configManager, config],
  );
  // LANGUAGE-PICKER-MOUNT-SECTION-END

  // ---------- Onboarding callbacks ----------
  const onOnboardComplete = useCallback(
    (cfg: AppConfig): void => {
      try {
        // Preserve any locale chosen via the language picker before
        // onboarding ran (the picker stashes it on in-memory state
        // when the config file did not yet exist).
        const finalCfg: AppConfig =
          config?.locale !== undefined && cfg.locale === undefined
            ? { ...cfg, locale: config.locale }
            : cfg;
        configManager.write(finalCfg);
        setConfig(finalCfg);
        setConfigLoadError(null);
        setScreen('chat');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setConfigLoadError(`Failed to save config: ${msg}`);
      }
    },
    [configManager, config],
  );

  // R12 (Agent F): onboarding helpers default to the Ollama wire shape
  // (no backend → adapter falls back to LM Studio path which is fine
  // for an early ping before the user has chosen a provider). Cloud
  // probing happens via `onProviderPing` which threads backend + key.
  const pingBackend = useCallback(async (url: string): Promise<boolean> => {
    const probe = new LLMAdapter({ baseUrl: url, model: '' });
    return probe.ping();
  }, []);

  const fetchModels = useCallback(async (url: string): Promise<string[]> => {
    const probe = new LLMAdapter({ baseUrl: url, model: '' });
    return probe.getModels();
  }, []);

  // ---------- Skills screen callbacks ----------
  const onToggleSkill = useCallback(
    (id: string): void => {
      void (async () => {
        try {
          await skillsManager.toggle(id);
          const next = await skillsManager.list();
          setSkills(next);
        } catch {
          // ignore — UI will refresh via watcher
        }
      })();
    },
    [skillsManager],
  );

  const onAddSkill = useCallback(
    async (filePath: string): Promise<void> => {
      await skillsManager.add(filePath);
      const next = await skillsManager.list();
      setSkills(next);
    },
    [skillsManager],
  );

  const onDeleteSkill = useCallback(
    (id: string): void => {
      void (async () => {
        try {
          await skillsManager.delete(id);
          const next = await skillsManager.list();
          setSkills(next);
        } catch {
          // ignore
        }
      })();
    },
    [skillsManager],
  );

  const onBackFromSkills = useCallback((): void => {
    setScreen('chat');
  }, []);

  // ---------- Model select callbacks ----------
  const onModelSelect = useCallback(
    (model: string): void => {
      if (config === null) return;
      try {
        const merged = configManager.update({ model: { current: model } });
        setConfig(merged);
      } catch {
        // ignore
      }
      // R13 (Agent 8) — clear the staged overlay filter (if any) so a
      // future `/model` reopen starts clean. CLOSE_OVERLAY also wipes
      // `overlayKind`, but for the 'model' overlay that field was only
      // a marker — the actual screen swap happens via setScreen.
      chatDispatch({ type: 'CLOSE_OVERLAY' });
      setScreen('chat');
    },
    [config, configManager],
  );

  const onModelCancel = useCallback((): void => {
    // R13 (Agent 8) — same reset as onModelSelect; a future `/model`
    // open should not inherit the previous invocation's filter.
    chatDispatch({ type: 'CLOSE_OVERLAY' });
    setScreen('chat');
  }, []);

  const onModelRefresh = useCallback((): void => {
    if (llm === null) return;
    void (async () => {
      try {
        const available = await llm.getModels();
        const merged = configManager.update({ model: { available } });
        setConfig(merged);
      } catch {
        // ignore
      }
    })();
  }, [configManager, llm]);

  // ---------- Context percentage for Header ----------
  const contextPercent = useMemo<number>(() => {
    if (config === null) return 0;
    const max = config.context.maxTokens > 0
      ? config.context.maxTokens
      : getMaxContextTokens(config.backend.type);
    const percentUnit = contextManager.getContextPercent(max);
    return Math.min(100, Math.round(percentUnit * 100));
    // Depend on chatState.messages length so the bar updates as messages are added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, contextManager, chatState.messages.length]);

  // BUDGET-BAR-WIRING-SECTION (Wave 6A4) — compute the per-zone
  // context breakdown so any consumer (UsageFooter via MessageBlock,
  // status pill, dashboards) can render the stacked bar. The
  // ContextManager.getBreakdown() helper takes the rendered system
  // prompt fragments + max-tokens budget and returns five zone counts
  // (systemPrompt / skills / memory / messages / toolResults). We
  // compute it here so the heavy estimateTokens() walk runs ONCE per
  // dependency tick rather than per consumer mount.
  const budgetBreakdown = useMemo(() => {
    if (config === null) return undefined;
    const max =
      config.context.maxTokens > 0
        ? config.context.maxTokens
        : getMaxContextTokens(config.backend.type);
    // The skills + memory fragments are the same strings the system
    // prompt build pipeline feeds; we don't have a cached pointer here
    // so we approximate by passing only the size-dominant pieces. The
    // breakdown remains a reasonable estimate — see ContextManager.
    try {
      return contextManager.getBreakdown({ maxTokens: max });
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, contextManager, chatState.messages.length]);
  // Touch `budgetBreakdown` so tsc's noUnused* doesn't complain when
  // the value isn't routed to a downstream consumer yet. Wave 6A4
  // landed the prop on UsageFooter (`./ui/components/UsageFooter.tsx`
  // line 91) but threading it through MessageBlock requires an edit
  // outside this round's surgical ownership — left to the follow-up
  // wave that owns MessageBlock's surface. The memo here is the
  // ready-to-consume single source of truth.
  void budgetBreakdown;
  // BUDGET-BAR-WIRING-SECTION (end)

  // ---------- Overlay callbacks (FIX #32 / #33) ----------

  const closeOverlay = useCallback((): void => {
    chatDispatch({ type: 'CLOSE_OVERLAY' });
  }, []);

  /**
   * Permissions overlay — toggle individual tools. The user's choice
   * is persisted through ConfigManager.update; the ToolExecutor memo
   * depends on `config.permissions.autoApprove`, so flipping this list
   * automatically rebuilds the executor with the new allow-list.
   */
  const onPermissionsToggle = useCallback(
    (tool: AutoApprovableTool): void => {
      if (config === null) return;
      const current = config.permissions.autoApprove;
      const hasIt = current.includes(tool);
      const next: AutoApprovableTool[] = hasIt
        ? current.filter((t) => t !== tool)
        : [...current, tool];
      try {
        const merged = configManager.update({
          permissions: { autoApprove: next },
        });
        setConfig(merged);
      } catch {
        // swallow — user can retry
      }
    },
    [config, configManager],
  );

  const onPermissionsAcceptAll = useCallback((): void => {
    if (config === null) return;
    // Accept the full set of destructive tools spelt out in the spec.
    const allAuto: AutoApprovableTool[] = ['write_file', 'run_command'];
    try {
      const merged = configManager.update({
        permissions: { autoApprove: allAuto },
      });
      setConfig(merged);
    } catch {
      // swallow
    }
  }, [config, configManager]);

  /**
   * CtxSize overlay — persists the three `context.*` fields atomically.
   * The LLMAdapter memo keys on every field, so the adapter rebuilds
   * automatically on the next render.
   *
   * R10 (Agent 8): the third arg is optional for backward-compat with
   * older callers — when present, it persists `responseTimeoutSeconds`
   * which feeds the adapter's `stallTimeoutMs` (× 1000) on rebuild.
   * Clamped to the same [30..7200] range enforced by the config schema.
   */
  const onCtxSizeApply = useCallback(
    (maxTokens: number, keepAlive: number, responseTimeout?: number): void => {
      try {
        const updates: { maxTokens: number; keepAliveSeconds: number; responseTimeoutSeconds?: number } = {
          maxTokens: Math.max(1, Math.floor(maxTokens)),
          keepAliveSeconds: Math.max(0, Math.floor(keepAlive)),
        };
        if (typeof responseTimeout === 'number' && Number.isFinite(responseTimeout)) {
          updates.responseTimeoutSeconds = Math.min(
            7200,
            Math.max(30, Math.floor(responseTimeout)),
          );
        }
        const merged = configManager.update({ context: updates });
        setConfig(merged);
      } catch {
        // swallow
      }
      chatDispatch({ type: 'CLOSE_OVERLAY' });
    },
    [configManager],
  );

  /**
   * Settings overlay — global generation params (FIX #35). Persisted
   * through ConfigManager.update; the LLM adapter memo keys on each
   * generation field so it rebuilds on the next render.
   *
   * R14 (Agent 8) — widened to accept the optional `timeouts` second
   * arg from SettingsOverlay's R17 contract: when present, the
   * `responseTimeoutSeconds` / `keepAliveSeconds` fields under
   * `config.context` are persisted alongside the generation block in a
   * second `configManager.update` call. The adapter memo (which keys
   * on `config.context.responseTimeoutSeconds` and
   * `config.context.keepAliveSeconds`) will then rebuild on the next
   * render so live streams pick up the new values without a restart.
   */
  const onSettingsApplyGlobal = useCallback(
    (
      next: GenerationConfig,
      timeouts?: { responseTimeoutSeconds: number; keepAliveSeconds: number },
    ): void => {
      try {
        let merged = configManager.update({ generation: next });
        if (timeouts) {
          merged = configManager.update({
            context: {
              responseTimeoutSeconds: timeouts.responseTimeoutSeconds,
              keepAliveSeconds: timeouts.keepAliveSeconds,
            },
          });
        }
        setConfig(merged);
      } catch {
        // swallow — user can retry
      }
      chatDispatch({ type: 'CLOSE_OVERLAY' });
    },
    [configManager],
  );

  /**
   * Settings overlay — per-project overrides (FIX #35). `null` clears
   * the entire `generation` block in `<projectRoot>/.localcode/settings.json`,
   * causing `resolveGeneration` to fall back to the global config. The
   * file watcher (above) will pick up the change and trigger an adapter
   * rebuild via `projectSettingsTick`.
   */
  const onSettingsApplyProject = useCallback(
    (next: Partial<GenerationConfig> | null): void => {
      try {
        if (next === null) {
          // Clear all overrides — write empty generation. This is safe
          // because the chokidar watcher will fire and bump the tick,
          // and `readProjectSettings` returns `null` once the keys are
          // gone (the writer below merges, so we just write `{}`).
          configManager.writeProjectSettings(projectRoot, {});
        } else {
          configManager.writeProjectSettings(projectRoot, next);
        }
      } catch {
        // swallow — user can retry
      }
      // Bump the tick eagerly so the adapter rebuilds even if chokidar
      // has not fired yet (some filesystems debounce events).
      setProjectSettingsTick((t) => t + 1);
      chatDispatch({ type: 'CLOSE_OVERLAY' });
    },
    [configManager, projectRoot],
  );

  /**
   * Provider overlay — switch backend type and/or base URL. Any in-
   * flight stream is aborted first so the next request targets the new
   * backend cleanly.
   */
  const onProviderApply = useCallback(
    (backend: Backend, baseUrl: string, apiKey?: string): void => {
      try {
        abortControllerRef.current?.abort();
      } catch {
        // ignore
      }
      try {
        // R12 (Agent F): the overlay now passes an optional apiKey for
        // cloud providers. Persist it explicitly only when non-empty —
        // a blank string would shadow the env-var fallback in
        // `resolveApiKey`. Local providers always pass `undefined`.
        const trimmedKey =
          typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
        const merged = configManager.update({
          backend: { type: backend, baseUrl, apiKey: trimmedKey },
        });
        setConfig(merged);
      } catch {
        // swallow
      }
      chatDispatch({ type: 'CLOSE_OVERLAY' });
    },
    [configManager],
  );

  /**
   * Provider overlay — liveness probe. Returns true iff the URL
   * responds OK within the adapter's ping timeout. Uses a standalone
   * adapter constructed via {@link createAdapter} so cloud providers
   * (Anthropic on its own adapter, OpenAI / OpenRouter on `LLMAdapter`)
   * are tested with the right wire shape and headers.
   *
   * R12 (Agent F) — when `onPing` runs from the overlay we don't yet
   * know which provider row's URL is being tested unless the caller
   * threads it through. ProviderOverlay invokes the callback with the
   * URL of the currently-selected row only, so we use the live
   * `config.backend.type` as the best guess. The apiKey for cloud
   * probes is taken from the same config (or env-var) — the overlay's
   * key edit hasn't been applied yet, so we ping with the persisted
   * key. That is sufficient for a "is the endpoint alive at all"
   * check, which is what the dot indicator means.
   */
  const onProviderPing = useCallback(
    async (url: string): Promise<boolean> => {
      try {
        const backend: Backend = config?.backend.type ?? 'ollama';
        const probe = createAdapter({
          backend,
          baseUrl: url,
          apiKey: resolveApiKey(backend, config?.backend.apiKey),
          // Anthropic's adapter requires a non-empty model in its
          // constructor; pass the live model when present and a
          // documented dummy when it isn't (the ping issues a 1-token
          // POST that any chat-completions server validates against
          // the model field).
          model: config?.model.current ?? 'claude-3-5-haiku-20241022',
        });
        return await probe.ping();
      } catch {
        return false;
      }
    },
    [config?.backend.type, config?.backend.apiKey, config?.model.current],
  );

  /** Resume overlay — reuse the existing loader through the slash-cmd deps. */
  const onResumeSelect = useCallback(
    (id: string): void => {
      chatDispatch({ type: 'CLOSE_OVERLAY' });
      // Fire-and-forget — the loader mirrors what `/resume <prefix>`
      // does, including summary persistence for the outgoing session.
      void (async () => {
        try {
          await summariseAndPersistOutgoing();
          const target = sessionManager.getSession(id);
          if (target === null) {
            appendLog(`No session with id ${id.slice(0, 8)}.`);
            return;
          }
          // Agent F (post-Agent D pagination): full history on resume.
          const rows = sessionManager.getAllMessages(id);
          contextManager.replaceAll(rows);
          contextManager.resetUsage();
          chatDispatch({ type: 'REPLACE_MESSAGES', messages: rows });
          chatDispatch({ type: 'SET_SESSION_TOTAL_OUT', tokens: 0 });
          setSessionId(id);
          setCurrentSession(target);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendLog(`Failed to resume session: ${msg}`);
        }
      })();
    },
    [
      appendLog,
      contextManager,
      sessionManager,
      summariseAndPersistOutgoing,
    ],
  );

  // BRANCHES-MOUNT-SECTION (callbacks + derived state)
  // ----------------------------------------------------------------
  // Branch picker — wired from the Ctrl+B overlay. The slash command
  // (`/branch …`) reuses the same switchSession wiring through
  // BRANCHES-DISPATCH-SECTION; these callbacks below feed the picker.
  //
  // branchPickerRows is recomputed from the active session id. We seed
  // a counter (`branchRefreshTick`) so create/archive ops can force a
  // re-derivation without waiting for an external state change.
  const [branchRefreshTick, setBranchRefreshTick] = useState<number>(0);

  const branchPickerRows = useMemo(() => {
    if (sessionId === null || sessionId.length === 0) return [];
    try {
      const rootId = sessionManager.findBranchRoot(sessionId);
      if (rootId === null) return [];
      const tree = sessionManager.getBranchTree(rootId);
      if (tree === null) return [];
      return flattenBranchTreeForPicker(tree, sessionId);
    } catch {
      return [];
    }
    // branchRefreshTick is intentionally part of the deps so create /
    // delete operations can bump it to invalidate the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionManager, branchRefreshTick]);

  const branchChainForBreadcrumb = useMemo(() => {
    if (sessionId === null || sessionId.length === 0) return [];
    try {
      const chain = sessionManager.getBranchChain(sessionId);
      return chain.map((info) => ({
        id: info.id,
        label:
          info.branchName !== null && info.branchName.length > 0
            ? info.branchName
            : info.title !== null && info.title.length > 0
              ? info.title
              : `(root ${info.id.slice(0, 8)})`,
        active: info.id === sessionId,
      }));
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionManager, branchRefreshTick]);

  const onBranchPickerSwitch = useCallback(
    (id: string): void => {
      chatDispatch({ type: 'CLOSE_OVERLAY' });
      if (sessionIdRef.current === id) return;
      void (async () => {
        try {
          await summariseAndPersistOutgoing();
          const target = sessionManager.getSession(id);
          if (target === null) {
            appendLog(`No session with id ${id.slice(0, 8)}.`);
            return;
          }
          const rows = sessionManager.getAllMessages(id);
          contextManager.replaceAll(rows);
          contextManager.resetUsage();
          chatDispatch({ type: 'REPLACE_MESSAGES', messages: rows });
          chatDispatch({ type: 'SET_SESSION_TOTAL_OUT', tokens: 0 });
          setSessionId(id);
          setCurrentSession(target);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendLog(`Failed to switch branch: ${msg}`);
        }
      })();
    },
    [appendLog, contextManager, sessionManager, summariseAndPersistOutgoing],
  );

  const onBranchPickerCreate = useCallback(
    (name: string): void => {
      const cleaned = name.trim();
      if (cleaned.length === 0) return;
      const fromId = sessionIdRef.current;
      if (fromId === null || fromId.length === 0) {
        appendLog('No active session yet — send a message first.');
        return;
      }
      try {
        const created = sessionManager.createBranch(fromId, cleaned);
        appendLog(`✓ Branched into '${cleaned}' (${created.id.slice(0, 8)}).`);
        setBranchRefreshTick((t) => t + 1);
        // Switch into the new branch immediately, mirroring `/branch <name>`.
        onBranchPickerSwitch(created.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`Failed to create branch: ${msg}`);
      }
    },
    [appendLog, onBranchPickerSwitch, sessionManager],
  );

  const onBranchPickerDelete = useCallback(
    (id: string): void => {
      try {
        if (sessionIdRef.current === id) {
          appendLog('Switch to a different branch before deleting this one.');
          return;
        }
        sessionManager.archiveBranch(id);
        appendLog(`✓ Archived branch ${id.slice(0, 8)}.`);
        setBranchRefreshTick((t) => t + 1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`Failed to archive branch: ${msg}`);
      }
    },
    [appendLog, sessionManager],
  );

  const openBranchPicker = useCallback((): void => {
    chatDispatch({ type: 'SHOW_OVERLAY', kind: 'branch' });
  }, []);
  // BRANCHES-MOUNT-SECTION (callbacks + derived state end)

  // Derived OverlayState for ChatScreen — null when overlayKind is
  // 'provider' (rendered separately) or when there's no overlay.
  const overlayForChat = useMemo<OverlayState | undefined>(() => {
    if (config === null) return undefined;
    const kind = chatState.overlayKind;
    if (kind === null) return undefined;

    if (kind === 'permissions') {
      return {
        kind: 'permissions',
        onToggle: onPermissionsToggle,
        onAcceptAll: onPermissionsAcceptAll,
        onClose: closeOverlay,
      };
    }

    if (kind === 'context') {
      const max =
        config.context.maxTokens > 0
          ? config.context.maxTokens
          : getMaxContextTokens(config.backend.type);
      const activeSkillNames = skills.filter((s) => s.active).map((s) => s.name);
      const tokenCount = contextManager.getTokenCount();
      return {
        kind: 'context',
        contextPercent,
        totalTokens: tokenCount,
        maxTokens: max,
        messageCount: chatState.messages.length,
        activeSkills: activeSkillNames,
        localcodeMd: readLocalcodeMdSafe(projectRoot) !== null,
        onClose: closeOverlay,
      };
    }

    if (kind === 'ctxsize') {
      return {
        kind: 'ctxsize',
        currentMaxTokens: config.context.maxTokens,
        currentKeepAlive: config.context.keepAliveSeconds,
        currentResponseTimeout: config.context.responseTimeoutSeconds,
        onApply: onCtxSizeApply,
        onClose: closeOverlay,
      };
    }

    if (kind === 'resume') {
      const list = sessionManager.listSessions(20);
      return {
        kind: 'resume',
        sessions: list,
        onSelect: onResumeSelect,
        onClose: closeOverlay,
      };
    }

    // BRANCHES-MOUNT-SECTION (overlayForChat)
    if (kind === 'branch') {
      const activeId = sessionId;
      // Build the flat picker rows from the branch tree of the root.
      // When there's no session yet (very early in startup), surface an
      // empty list — the picker renders an explanatory message.
      const rows = branchPickerRows;
      return {
        kind: 'branch',
        rows,
        activeSessionId: activeId,
        onSwitch: onBranchPickerSwitch,
        onCreate: onBranchPickerCreate,
        onDelete: onBranchPickerDelete,
        onClose: closeOverlay,
      };
    }
    // BRANCHES-MOUNT-SECTION (overlayForChat end)

    if (kind === 'usage') {
      // Aggregate across every session in the DB. The dashboard's `r`
      // action triggers `refreshOpenRouterPricing` then bumps
      // `usageRefreshTick` — that re-runs this useMemo so the cost
      // numbers reflect the freshest pricing on the next paint.
      const backend = config.backend.type;
      const byModelRaw = (() => {
        try {
          return sessionManager.aggregateUsageByModel();
        } catch {
          return [] as ReturnType<SessionManager['aggregateUsageByModel']>;
        }
      })();
      let totalCost = 0;
      let totalTokens = 0;
      let favorite: string | null = null;
      let favoriteTokens = 0;
      const perModel = byModelRaw.map((row) => {
        const pricing = resolvePrice(backend, row.model);
        const c = computeCostBreakdown(
          {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokens: row.cachedTokens,
          },
          pricing,
        );
        const cacheHitPct =
          row.inputTokens > 0 ? (row.cachedTokens / row.inputTokens) * 100 : 0;
        totalCost += c.total;
        totalTokens += row.inputTokens + row.outputTokens;
        const modelTokens = row.inputTokens + row.outputTokens;
        if (modelTokens > favoriteTokens) {
          favoriteTokens = modelTokens;
          favorite = row.model;
        }
        return {
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cachedTokens: row.cachedTokens,
          cost: c.total,
          cacheHitPct,
        };
      });
      const stats = (() => {
        try {
          return sessionManager.getUsageStats({});
        } catch {
          return null;
        }
      })();
      const topSessions = (stats?.topSessions ?? []).map((s) => ({
        sessionId: s.sessionId,
        title: s.title ?? s.sessionId.slice(0, 8),
        model: '—',
        tokens: s.tokens,
        cost: s.cost,
        when: s.lastUsedAt,
      }));
      const data: UsageDashboardData = {
        totalCost,
        totalTokens,
        sessionCount: stats?.sessionCount ?? 0,
        favoriteModel: favorite,
        perModel,
        topSessions,
      };
      return {
        kind: 'usage',
        data,
        isRefreshing: usageRefreshing,
        onRefresh: () => {
          // Force-refetch OpenRouter prices then bump the tick so this
          // useMemo runs again with the new pricing table. Errors are
          // swallowed — pricing fallback already returns stale values.
          setUsageRefreshing(true);
          void refreshOpenRouterPricing({ force: true })
            .catch(() => {
              // ignore network errors — keep existing pricing
            })
            .finally(() => {
              setUsageRefreshing(false);
              setUsageRefreshTick((n) => n + 1);
            });
        },
        onClose: closeOverlay,
      };
    }

    if (kind === 'cost') {
      return {
        kind: 'cost',
        turns: costSampleRows,
        sessionLabel:
          currentSession?.title ?? sessionId?.slice(0, 8) ?? undefined,
        onClose: closeOverlay,
      };
    }

    if (kind === 'perf') {
      return {
        kind: 'perf',
        samples: perfSamples,
        onClose: closeOverlay,
      };
    }

    // 'provider' / 'model' / 'skills' are handled at the App render
    // layer or via setScreen, so they don't populate ChatScreen's
    // overlay slot.
    return undefined;
  }, [
    chatState.overlayKind,
    chatState.messages.length,
    closeOverlay,
    config,
    contextManager,
    contextPercent,
    costSampleRows,
    currentSession,
    onCtxSizeApply,
    onPermissionsAcceptAll,
    onPermissionsToggle,
    onResumeSelect,
    perfSamples,
    projectRoot,
    sessionId,
    sessionManager,
    skills,
    usageRefreshTick,
    usageRefreshing,
  ]);

  /**
   * Current provider URLs for the overlay. We read them from the live
   * config; for the row that matches the active backend we surface its
   * current `baseUrl`, every other row falls back to the per-provider
   * default published in `PROVIDER_DEFAULTS`. `custom` carries the
   * configured URL when the active backend is `'custom'`, else empty.
   *
   * R12 (Agent F): widened from the original 3-row {ollama, lmstudio,
   * custom} object to the full 7-row `ProviderUrls` shape after
   * Agent 4 R27 widened the overlay schema. Sourcing each default from
   * `PROVIDER_DEFAULTS` keeps the values aligned with the rest of the
   * stack — onboarding, the LLMAdapter, and config persistence all
   * read from the same map.
   */
  const providerUrls = useMemo<ProviderUrls>(() => {
    const live = config?.backend.baseUrl ?? '';
    const liveType = config?.backend.type;
    const urlFor = (b: Backend): string =>
      liveType === b ? live : PROVIDER_DEFAULTS[b].baseUrl;
    return {
      ollama: urlFor('ollama'),
      lmstudio: urlFor('lmstudio'),
      openai: urlFor('openai'),
      anthropic: urlFor('anthropic'),
      openrouter: urlFor('openrouter'),
      google: urlFor('google'),
      custom: liveType === 'custom' ? live : '',
    };
  }, [config]);

  /**
   * R12 (Agent F) — per-cloud-provider API keys for the overlay.
   *
   * Only the row matching the currently-active backend can carry a
   * persisted key (we store one `apiKey` slot in `BackendConfig`); every
   * other row starts empty so the user types a fresh key into it. The
   * overlay falls back to env vars (`OPENAI_API_KEY`, etc.) silently —
   * we don't surface those values here for security (the user typed
   * them once into their shell and may not want them mirrored into the
   * UI), but `resolveApiKey` reads them at adapter-construction time so
   * env-only setups still work end-to-end.
   */
  const providerApiKeys = useMemo<ProviderApiKeys>(() => {
    const liveType = config?.backend.type;
    const liveKey = config?.backend.apiKey ?? '';
    const keyFor = (b: Backend): string => (liveType === b ? liveKey : '');
    return {
      openai: keyFor('openai'),
      anthropic: keyFor('anthropic'),
      openrouter: keyFor('openrouter'),
      google: keyFor('google'),
      custom: keyFor('custom'),
    };
  }, [config?.backend.type, config?.backend.apiKey]);

  // COST-WIRING-SECTION (start) — Wave 9D next-turn cost forecast +
  // cumulative session/today totals. Both branches are kept cheap so
  // every render can recompute:
  //
  //   - `nextTurnEstimate` runs `estimateNextTurn(...)` against the
  //     current ContextManager token total + the last assistant turn's
  //     cached-token count. Unknown models surface as `unknown: true`
  //     so the chip renders `~?` instead of a misleading number.
  //
  //   - `sessionCostUsd` / `todayCostUsd` query the read-replica via
  //     `SessionManager.getSessionCost(sid)` + `getTodayCost()`. The
  //     queries are single-row SUM() aggregates against a covering
  //     index — well under 1ms even on a many-session DB. They are
  //     memoised on the chat-state turn boundary (sessionId +
  //     messages.length + outgoing turn counter) so they refire when
  //     a new turn lands, not on every reducer mutation.
  //
  // When the wiring to UsageFooter is added in ChatScreen/MessageBlock
  // (currently out of scope for this composition root because the
  // cumulative totals are not yet exposed on ChatScreenProps), the
  // values below are ready to be threaded through.

  // Average completion-token count over the last 10 assistant turns.
  // Falls back to the estimator's default when too few priced turns
  // have landed in the session yet.
  const recentOutputAvg = useMemo<number>(() => {
    let total = 0;
    let counted = 0;
    for (let i = chatState.messages.length - 1; i >= 0 && counted < 10; i -= 1) {
      const m = chatState.messages[i];
      if (m === undefined) continue;
      if (m.role !== 'assistant') continue;
      const out = m.tokensOutput;
      if (typeof out === 'number' && Number.isFinite(out) && out > 0) {
        total += out;
        counted += 1;
      }
    }
    if (counted === 0) return DEFAULT_RECENT_OUTPUT;
    return Math.max(1, Math.round(total / counted));
  }, [chatState.messages]);

  // Last assistant turn's cached-input token count — feeds the
  // cache-rate portion of the forecast. Defaults to 0 when no prior
  // turn carried cache telemetry (local providers, fresh sessions).
  const lastCachedInputTokens = useMemo<number>(() => {
    for (let i = chatState.messages.length - 1; i >= 0; i -= 1) {
      const m = chatState.messages[i];
      if (m === undefined) continue;
      if (m.role !== 'assistant') continue;
      const cached = m.cachedInputTokens;
      if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) {
        return cached;
      }
      // First assistant turn from the tail without cache info → 0.
      return 0;
    }
    return 0;
  }, [chatState.messages]);

  const nextTurnEstimate = useMemo(() => {
    if (config === null) return { estimated: 0, unknown: true } as const;
    const ctxTokens = contextManager.getTokenCount();
    return estimateNextTurn({
      contextTokens: ctxTokens,
      cacheTokens: lastCachedInputTokens,
      currentModel: modelOverride ?? config.model.current,
      provider: config.backend.type,
      recentOutputAvg,
    });
  }, [
    config,
    contextManager,
    lastCachedInputTokens,
    modelOverride,
    recentOutputAvg,
    // Re-key on message length so a freshly-landed turn updates the
    // forecast immediately (token count is read at the call site, but
    // the memo identity must change).
    chatState.messages.length,
  ]);

  // Cumulative spend — refreshed on session-id change AND on every
  // assistant turn landing in the message ring. Wrapped in useMemo so
  // the SQL aggregates only run when something interesting happened.
  const sessionCostUsd = useMemo<number>(() => {
    if (sessionId === null || sessionId.length === 0) return 0;
    try {
      return sessionManager.getSessionCost(sessionId);
    } catch {
      return 0;
    }
    // The reducer's message length only ticks once per committed turn,
    // so this is effectively a per-turn refresh.
  }, [sessionId, sessionManager, chatState.messages.length]);

  const todayCostUsd = useMemo<number>(() => {
    try {
      return sessionManager.getTodayCost();
    } catch {
      return 0;
    }
  }, [sessionManager, chatState.messages.length]);

  // COST-FOOTER-PROPS-SECTION — the void shim previously parked here
  // is no longer needed; both values are now plumbed through to
  // ChatScreen → MessageRow → MessageBlock → UsageFooter.
  // COST-WIRING-SECTION (end)

  // ---------- Render ----------

  // LOCALE-APPLY-WIRE-SECTION — propagate the active locale into the
  // React tree. The provider keeps the module-level mirror in sync via
  // `useEffect`, so non-React print paths (slash commands) also pick
  // up the latest value automatically.
  const activeLocale = config?.locale ?? 'en';
  const renderTree = (node: React.JSX.Element): React.JSX.Element => (
    <LocaleProvider locale={activeLocale}>{node}</LocaleProvider>
  );
  // LOCALE-APPLY-WIRE-SECTION-END

  // Startup error splash
  if (configLoadError !== null && screen === 'chat') {
    // LOCALE-APPLY-WIRE-SECTION — error splash strings flow through the
    // i18n table so users see Russian copy when their persisted locale
    // is `ru` (the picker may have set it before the failed config load).
    return renderTree(
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="red">{appT('chat.configLoadFailed', undefined, activeLocale)}</Text>
        <Text color="gray">{configLoadError}</Text>
        <Box marginTop={1}>
          <Text color="gray">{appT('chat.reconfigureHint', undefined, activeLocale)}</Text>
        </Box>
      </Box>
    );
  }
  // LOCALE-APPLY-WIRE-SECTION-END

  // Dispatch to the active screen.
  switch (screen) {
    // SPLASH-MOUNT-SECTION — animated first-impression welcome.
    // Always advances to the language picker on completion (Enter / Esc
    // / any key OR after the auto-advance timeout). The splash never
    // re-shows for the same user — `'splash'` only appears as the
    // initial screen value from cli.tsx and we transition out of it
    // here.
    case 'splash':
      return renderTree(
        <SplashScreen
          onDone={(): void => {
            setScreen('languagePicker');
          }}
        />
      );
    // SPLASH-MOUNT-SECTION-END
    // LANGUAGE-PICKER-MOUNT-SECTION — first-launch language picker.
    case 'languagePicker':
      return renderTree(
        <LanguagePicker
          initial={config?.locale ?? detectSystemLocale()}
          onSelect={onLanguageSelect}
        />
      );
    // LANGUAGE-PICKER-MOUNT-SECTION-END
    case 'onboarding':
      return renderTree(
        <OnboardingScreen
          onComplete={onOnboardComplete}
          pingBackend={pingBackend}
          fetchModels={fetchModels}
        />
      );
    case 'skills':
      return renderTree(
        <SkillsScreen
          skills={skills}
          onToggle={onToggleSkill}
          onAdd={onAddSkill}
          onDelete={onDeleteSkill}
          onBack={onBackFromSkills}
        />
      );
    case 'modelSelect': {
      if (config === null) {
        return renderTree(
          <Box paddingX={1}>
            <Text color="gray">Loading…</Text>
          </Box>
        );
      }
      // R13 (Agent 8) — `initialFilter` is plumbed from
      // `chatState.modelOverlayFilter`, populated by `SHOW_OVERLAY`
      // when the slash-command parser routed `/model <query>` here
      // (see `cmd-model.ts` and the `showOverlay` dispatcher in
      // `onSlashExecute`). When the user opens the screen via legacy
      // paths (no-arg `/model`, status-bar shortcut, etc.) the field
      // is null and ModelSelectScreen falls back to its default
      // empty-filter behaviour.
      return renderTree(
        <ModelSelectScreen
          available={config.model.available}
          current={modelOverride ?? config.model.current}
          onSelect={onModelSelect}
          onCancel={onModelCancel}
          onRefresh={onModelRefresh}
          {...(chatState.modelOverlayFilter !== null
            ? { initialFilter: chatState.modelOverlayFilter }
            : {})}
        />
      );
    }
    case 'chat': {
      if (config === null) {
        return renderTree(
          <Box paddingX={1}>
            <Text color="gray">Loading configuration…</Text>
          </Box>
        );
      }
      // Convert the chatLog (pure strings) into synthetic system messages so
      // they show up in the chat log with the actual messages.
      const syntheticMessages: Message[] = chatLog.map((line, idx) => ({
        id: `log-${idx}`,
        role: 'system' as const,
        content: line,
        createdAt: idx,
      }));
      const combinedMessages: Message[] = [
        ...syntheticMessages,
        ...chatState.messages,
      ];
      // JOURNAL-RECOVERY-SECTION (ui)
      // Surface the unfinished-session prompt as a full-takeover
      // overlay above every other chat overlay. Resolves once the
      // user picks R / A / Esc — setting `recoverableList` to `[]`
      // dismisses the overlay for this app run.
      if (recoverableList !== null && recoverableList.length > 0) {
        return renderTree(
          <Box flexDirection="column">
            <InputDispatcherProvider mode="overlay">
              <DiffViewerInputPump />
              <JournalRecoveryOverlay
                recoverable={recoverableList}
                locale={activeLocale}
                onResume={(sid) => {
                  void (async () => {
                    try {
                      await summariseAndPersistOutgoing();
                      const target = sessionManager.getSession(sid);
                      if (target !== null) {
                        const rows = sessionManager.getAllMessages(sid);
                        contextManager.replaceAll(rows);
                        contextManager.resetUsage();
                        chatDispatch({ type: 'REPLACE_MESSAGES', messages: rows });
                        chatDispatch({ type: 'SET_SESSION_TOTAL_OUT', tokens: 0 });
                        setSessionId(sid);
                        setCurrentSession(target);
                      } else {
                        appendLog(
                          `Unfinished session ${sid.slice(0, 8)} no longer exists.`,
                        );
                      }
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      appendLog(`Failed to resume unfinished session: ${msg}`);
                    } finally {
                      setRecoverableList([]);
                    }
                  })();
                }}
                onArchiveAll={() => {
                  let archived = 0;
                  for (const r of recoverableList) {
                    try {
                      if (archiveJournal(r.sessionId)) archived += 1;
                    } catch {
                      /* swallow — archive is best-effort */
                    }
                  }
                  if (archived > 0) {
                    appendLog(appT('journal.recovery.archived', undefined, activeLocale));
                  }
                  setRecoverableList([]);
                }}
                onDismiss={() => {
                  setRecoverableList([]);
                }}
              />
            </InputDispatcherProvider>
          </Box>
        );
      }
      // JOURNAL-RECOVERY-SECTION (ui end)
      // TUTORIAL-MOUNT-SECTION — render the first-run walkthrough as a
      // full-takeover overlay above the chat tree. Mirrors the
      // CommandPalette pattern (its own InputDispatcherProvider so the
      // ink useInput plumbing reaches the overlay). Skippable via Esc;
      // dismiss writes `firstRun.tutorialShown = true` so we never
      // auto-re-show.
      if (tutorialOpen) {
        return renderTree(
          <Box flexDirection="column">
            <InputDispatcherProvider mode="overlay">
              <DiffViewerInputPump />
              <TutorialOverlay onDone={dismissTutorial} />
            </InputDispatcherProvider>
          </Box>
        );
      }
      // TUTORIAL-MOUNT-SECTION-END
      // CMD-PALETTE-MOUNT-SECTION (Wave 5A — TA team)
      // -----------------------------------------------------------
      // The command palette lives outside ChatScreen's OverlayState
      // union — like ProviderOverlay and SettingsOverlay it takes over
      // input fully until the user selects or cancels. Triggered via
      // Ctrl+K from anywhere; selection-side effects (insert text /
      // run command / open resume) are handled in `onPaletteSelect`.
      if (paletteOpen) {
        return renderTree(
          <Box flexDirection="column">
            <InputDispatcherProvider mode="overlay">
              <DiffViewerInputPump />
              <CommandPalette
                open
                commands={paletteCommands}
                files={paletteFiles}
                sessions={paletteSessions}
                tools={paletteTools}
                onSelect={onPaletteSelect}
                onClose={closePalette}
              />
            </InputDispatcherProvider>
          </Box>
        );
      }
      // CMD-PALETTE-MOUNT-SECTION-END

      // BATCH-APPROVAL-SECTION (Wave 10D)
      // -----------------------------------------------------------
      // Unified batch-approval modal fired when the LLM emits ≥
      // permissions.batchApprovalThreshold mutating tool calls in
      // one turn (multi-file refactor). Owns input fully via
      // mode='approval' (same dispatcher slot ApprovalPrompt /
      // DiffView use — the LIFO subscription guarantees the dialog's
      // handler wins). `onConfirm` resolves the awaiting executor
      // promise with per-item decisions; `onCancel` (Esc) resolves
      // with every item rejected.
      if (batchApproval !== null) {
        const captured = batchApproval;
        return renderTree(
          <Box flexDirection="column">
            <InputDispatcherProvider mode="approval">
              <DiffViewerInputPump />
              <BatchApprovalDialog
                items={captured.items}
                onConfirm={(decisions) => {
                  captured.resolver(decisions);
                }}
                onCancel={() => {
                  const empty = new Map<
                    string,
                    'approved' | 'rejected'
                  >();
                  for (const it of captured.items) {
                    empty.set(it.toolCallId, 'rejected');
                  }
                  captured.resolver(empty);
                }}
              />
            </InputDispatcherProvider>
          </Box>,
        );
      }
      // BATCH-APPROVAL-SECTION-END

      // DIFF-VIEWER-MOUNT-SECTION (Wave 5B / TF4)
      // -----------------------------------------------------------
      // The full-screen diff viewer takes over input fully when open
      // (mounted via `/diff`). Like CommandPalette it sits OUTSIDE the
      // ChatScreen tree so it can own keystrokes through its own
      // InputDispatcherProvider — the viewer's `useInputModeHandler`
      // subscribes to mode='diff-viewer' (see `DIFF-VIEWER-DISPATCH-
      // SECTION` in InputDispatcher.tsx) and exits when the user
      // presses q / Esc.
      if (diffOpen) {
        return renderTree(
          <Box flexDirection="column">
            <InputDispatcherProvider mode="diff-viewer">
              <DiffViewerInputPump />
              <DiffViewer
                open
                entries={diffEntries}
                onClose={closeDiffViewer}
              />
            </InputDispatcherProvider>
          </Box>
        );
      }
      // DIFF-VIEWER-MOUNT-SECTION-END

      // UPDATE-OVERLAY-MOUNT-SECTION — full-screen update modal. Mounts
      // above all other overlays except active streaming so the user
      // sees the prompt at the next idle moment. Key bindings: i / l /
      // s / Esc (see UpdateOverlay component).
      if (updateOverlayInfo !== null) {
        return renderTree(
          <Box flexDirection="column">
            <UpdateOverlay
              info={updateOverlayInfo}
              downloaded={updateDownloadedVersion === updateOverlayInfo.latestVersion}
              onInstall={() => {
                const u = updaterRef.current;
                if (u !== null) {
                  void u.downloadLatest();
                }
                setUpdateOverlayInfo(null);
              }}
              onLater={() => {
                const u = updaterRef.current;
                if (u !== null) {
                  u.dismissUntil(Date.now() + 24 * 60 * 60 * 1_000);
                }
                setUpdateOverlayInfo(null);
              }}
              onSkip={(v) => {
                const u = updaterRef.current;
                if (u !== null) {
                  void u.skipVersion(v);
                }
                setUpdateOverlayInfo(null);
              }}
              onClose={() => setUpdateOverlayInfo(null)}
            />
          </Box>
        );
      }
      // UPDATE-OVERLAY-MOUNT-SECTION-END

      // ONTOLOGY-WIRE-SECTION — full-screen `<OntologyGraph>` overlay.
      // Opened by `/ontology graph <symbol>`; takes over input via its
      // own `useInput` hook (Esc / q close it).
      if (ontologyGraphSymbol !== null) {
        return renderTree(
          <Box flexDirection="column">
            <OntologyGraph
              ontology={ontologyIndexer.current}
              symbolName={ontologyGraphSymbol}
              onClose={() => setOntologyGraphSymbol(null)}
            />
          </Box>
        );
      }
      // ONTOLOGY-WIRE-SECTION-END

      // FIX #33 — the ProviderOverlay lives outside ChatScreen's
      // OverlayState union (which only covers the four R3 panels that
      // share its layout). When the user opens `/provider`, we mount
      // it above the chat frame and let it fully take over input until
      // it fires apply/cancel.
      if (chatState.overlayKind === 'provider') {
        return renderTree(
          <Box flexDirection="column">
            <ProviderOverlay
              currentBackend={config.backend.type}
              urls={providerUrls}
              apiKeys={providerApiKeys}
              onApply={onProviderApply}
              onCancel={closeOverlay}
              onPing={onProviderPing}
            />
          </Box>
        );
      }
      // R9 (Agent 8) — `/new-skill` overlay. Mounted as a standalone
      // screen (same pattern as ProviderOverlay/SettingsOverlay) so we
      // can wire `onAiWriterGenerate` to the local LLM. ChatScreen's
      // own internal render of SkillInputOverlay is suppressed below
      // by passing `skillOverlay={false}` whenever we own the render.
      if (chatState.skillOverlay) {
        return renderTree(
          <Box flexDirection="column">
            <SkillInputOverlay
              onSubmit={onSkillSubmit}
              onCancel={onSkillCancel}
              onAiWriterGenerate={handleAiWriterGenerate}
            />
          </Box>
        );
      }
      // FIX #35 — SettingsOverlay (per-project + global generation
      // params). Same mounting pattern as ProviderOverlay: render it
      // above the chat frame and let it fully take over input.
      if (chatState.overlayKind === 'settings') {
        const resolved = (() => {
          try {
            return configManager.resolveGeneration(projectRoot);
          } catch {
            return { generation: config.generation, source: 'global' as const };
          }
        })();
        const projectGen = (() => {
          try {
            return configManager.readProjectSettings(projectRoot);
          } catch {
            return null;
          }
        })();
        return renderTree(
          <Box flexDirection="column">
            <SettingsOverlay
              globalGeneration={config.generation}
              projectGeneration={projectGen}
              source={resolved.source}
              globalTimeouts={{
                responseTimeoutSeconds: config.context.responseTimeoutSeconds,
                keepAliveSeconds: config.context.keepAliveSeconds,
              }}
              onApplyGlobal={onSettingsApplyGlobal}
              onApplyProject={onSettingsApplyProject}
              onClose={closeOverlay}
            />
          </Box>
        );
      }
      // MARKETPLACE-WIRING-SECTION (render) — full-screen marketplace
      // overlay opened by `/skills browse` / `/mcp browse`. Mounts above
      // the chat frame and owns its own keystroke loop.
      if (marketplaceState !== null) {
        const entries: ReadonlyArray<MarketplaceEntry> =
          marketplaceState.result.entries;
        const onRefresh = (): void => {
          setMarketplaceLoading(true);
          setMarketplaceError(null);
          setMarketplaceInfo(null);
          void (async (): Promise<void> => {
            try {
              if (marketplaceState.mode === 'skills') {
                const result = await fetchSkillCatalog({ force: true });
                setMarketplaceState({ mode: 'skills', result });
              } else {
                const result = await fetchMcpCatalog({ force: true });
                setMarketplaceState({ mode: 'mcp', result });
              }
            } catch (cause) {
              const msg =
                cause instanceof Error ? cause.message : String(cause);
              setMarketplaceError(msg);
            } finally {
              setMarketplaceLoading(false);
            }
          })();
        };
        const onInstallGlobal = (entry: MarketplaceEntry): void => {
          setMarketplaceInfo(null);
          setMarketplaceError(null);
          void (async (): Promise<void> => {
            try {
              if (marketplaceState.mode === 'skills') {
                const out = await installSkill(
                  entry as MarketplaceSkill,
                  'global',
                );
                setMarketplaceInfo(`Installed to ${out.installedAt}`);
              } else {
                const out = await installMcpServer(
                  entry as MarketplaceMcpServer,
                );
                setMarketplaceInfo(`Installed MCP server: ${out.installedAs}`);
              }
            } catch (cause) {
              const msg =
                cause instanceof Error ? cause.message : String(cause);
              setMarketplaceError(msg);
            }
          })();
        };
        const onInstallProject =
          marketplaceState.mode === 'skills'
            ? (entry: MarketplaceEntry): void => {
                setMarketplaceInfo(null);
                setMarketplaceError(null);
                void (async (): Promise<void> => {
                  try {
                    const out = await installSkill(
                      entry as MarketplaceSkill,
                      'project',
                      { projectRoot },
                    );
                    setMarketplaceInfo(`Installed to ${out.installedAt}`);
                  } catch (cause) {
                    const msg =
                      cause instanceof Error ? cause.message : String(cause);
                    setMarketplaceError(msg);
                  }
                })();
              }
            : undefined;
        return renderTree(
          <Box flexDirection="column">
            <MarketplaceOverlay
              mode={marketplaceState.mode}
              entries={entries}
              loading={marketplaceLoading}
              error={marketplaceError}
              info={marketplaceInfo}
              cacheAgeMs={marketplaceState.result.ageMs}
              stale={marketplaceState.result.stale}
              rateLimited={marketplaceState.result.rateLimited}
              onInstallGlobal={onInstallGlobal}
              {...(onInstallProject !== undefined
                ? { onInstallProject }
                : {})}
              onRefresh={onRefresh}
              onClose={() => {
                setMarketplaceState(null);
                setMarketplaceInfo(null);
                setMarketplaceError(null);
              }}
            />
          </Box>,
        );
      }
      // MARKETPLACE-WIRING-SECTION (render end)

      // IMPORT-FIRST-RUN-SECTION (render) — one-line top banner with
      // three actions (Yes / Not now / Never ask). Renders above the
      // ChatScreen so the user sees it on first boot. Persists the
      // dismissal flag via ConfigManager.
      if (importPromptOpen) {
        const persistDismissal = (): void => {
          try {
            const updated = configManager.update({
              migration: { claudeCodeDismissed: true },
            });
            setConfig(updated);
          } catch (cause) {
            const msg =
              cause instanceof Error ? cause.message : String(cause);
            appendLog(`Failed to persist import-prompt dismissal: ${msg}`);
          }
        };
        return renderTree(
          <Box flexDirection="column" paddingX={1} paddingY={1}>
            <Text color="cyan" bold>
              {appT(
                'import.firstRun.prompt',
                undefined,
                activeLocale,
              )}
            </Text>
            <Box marginTop={1}>
              <Text color="gray">
                {appT('import.firstRun.yes', undefined, activeLocale)}: Y  ·
                {appT('import.firstRun.no', undefined, activeLocale)}: N  ·
                {appT(
                  'import.firstRun.never',
                  undefined,
                  activeLocale,
                )}: X
              </Text>
            </Box>
            <ImportPromptInputPump
              onYes={() => {
                setImportPromptOpen(false);
                appendLog(
                  'Run `/import claude-code all` to import everything, or `/import claude-code` to pick.',
                );
              }}
              onNo={() => {
                setImportPromptOpen(false);
              }}
              onNever={() => {
                setImportPromptOpen(false);
                persistDismissal();
              }}
            />
          </Box>,
        );
      }
      // IMPORT-FIRST-RUN-SECTION (render end)

      // METRICS-WIRE-SECTION (render) — local-only metrics dashboard
      // opened by `/metrics`. Esc closes; R refreshes the snapshot.
      if (metricsOverlayData !== null) {
        return renderTree(
          <Box flexDirection="column">
            <MetricsOverlay
              data={metricsOverlayData}
              isRefreshing={metricsRefreshing}
              onRefresh={() => {
                setMetricsRefreshing(true);
                void (async (): Promise<void> => {
                  try {
                    const cfgTele = (config as unknown as {
                      telemetry?: { enabled?: boolean; retentionDays?: number };
                    }).telemetry;
                    const snap = await snapshotMetrics({
                      enabled: cfgTele?.enabled === true,
                      windowDays: cfgTele?.retentionDays ?? 30,
                    });
                    setMetricsOverlayData(snap);
                  } catch {
                    // best-effort
                  } finally {
                    setMetricsRefreshing(false);
                  }
                })();
              }}
              onClose={() => setMetricsOverlayData(null)}
            />
          </Box>,
        );
      }
      // METRICS-WIRE-SECTION (render end)

      return renderTree(
        <Box flexDirection="column">
          {/* PLAN-MODE-OVERLAY-SECTION
              Top-of-screen Plan Mode banner. Mounts only when the active
              profile is `plan` (the executor's PLAN-MODE-BLOCK-SECTION
              also gates on this same field, so the banner stays in sync
              with the actual block behaviour). Banner copy + colour live
              in `src/ui/overlays/PlanModeOverlay.tsx`; toggling happens
              via Ctrl+P (PLAN-MODE-HOTKEY-SECTION above) or the
              `/profile plan` slash command. */}
          {config.permissions.profile === 'plan' && <PlanModeBanner />}
          {/* PLAN-MODE-OVERLAY-SECTION-END */}
          {/* SKILL-SUGGEST-SECTION (render)
              Subtle vertically-stacked suggestion toasts above the chat
              area. Each toast renders one matched skill; Tab activates
              the first; Esc dismisses. Auto-dismiss after 8s. */}
          {skillSuggestions.length > 0 && (
            <Box flexDirection="column">
              {skillSuggestions.map((s) => (
                <SkillSuggestionToast
                  key={s.skillId}
                  toastText={appT(
                    'skill.suggest.toast',
                    { name: s.skillName },
                    activeLocale,
                  )}
                  reason={s.reason}
                  tabHint={appT(
                    'skill.suggest.hint.tab',
                    undefined,
                    activeLocale,
                  )}
                  escHint={appT(
                    'skill.suggest.hint.esc',
                    undefined,
                    activeLocale,
                  )}
                />
              ))}
            </Box>
          )}
          {/* SKILL-SUGGEST-SECTION (render end) */}
          <ChatScreen
            config={config}
            projectRoot={projectRoot}
            sessionId={sessionId}
            messages={combinedMessages}
            toolCallStates={chatState.toolCallStates}
            isStreaming={chatState.isStreaming}
            currentOutput={chatState.currentOutput}
            currentThinking={chatState.currentThinking}
            pendingApproval={chatState.pendingApproval}
            thinkingStartedAt={chatState.thinkingStartedAt}
            contextPercent={contextPercent}
            slashCommands={slashCommands}
            onSubmit={onSubmit}
            onApprove={onApprove}
            onReject={onReject}
            onApproveAllInTurn={onApproveAllInTurn}
            onApproveForSession={onApproveForSession}
            onSlashExecute={onSlashExecute}
            onBashExecute={onBashExecute}
            onCancel={onCancel}
            skillOverlay={chatState.skillOverlay}
            onSkillSubmit={onSkillSubmit}
            onSkillCancel={onSkillCancel}
            modelName={modelOverride ?? config.model.current}
            sessionTotalOut={chatState.sessionTotalOut}
            overlay={overlayForChat}
            responseTimeoutSeconds={config.context.responseTimeoutSeconds}
            lastTurnError={chatState.lastTurnError}
            onClearTurnError={() => chatDispatch({ type: 'CLEAR_TURN_ERROR' })}
            pendingQueue={chatState.pendingQueue}
            onEnqueuePending={onEnqueuePending}
            onClearPending={onClearPending}
            todos={sessionTodos}
            agentWorkers={agentWorkers}
            leadStreaming={chatState.isStreaming}
            currentConversant={chatState.currentConversant}
            agentFocusMode={chatState.agentFocusMode}
            agentSelectedIdx={chatState.agentSelectedIdx}
            onAgentFocusEnter={onAgentFocusEnter}
            onAgentFocusExit={onAgentFocusExit}
            onAgentSelectNext={onAgentSelectNext}
            onAgentSelectPrev={onAgentSelectPrev}
            onAgentAttach={onAgentAttach}
            onAgentDetach={onAgentDetach}
            // OUTPUT-FILTER-SECTION / READING-MODE-SECTION — wire the
            // reducer-owned slices + dispatch bridges down to ChatScreen.
            outputFilters={chatState.outputFilters}
            onCycleOutputFilter={() =>
              chatDispatch({ type: 'CYCLE_OUTPUT_FILTER' })
            }
            readingMode={chatState.readingMode}
            onToggleReadingMode={() =>
              chatDispatch({ type: 'TOGGLE_READING_MODE' })
            }
            // BRANCHES-MOUNT-SECTION (props)
            branchChain={branchChainForBreadcrumb}
            onOpenBranchPicker={openBranchPicker}
            // BRANCHES-MOUNT-SECTION (props end)
            // PROACTIVE-MOUNT-SECTION (Wave 6D)
            proactiveSuggestion={proactiveSuggestion}
            // PROACTIVE-MOUNT-SECTION-END
            // COST-WIRING-SECTION (render) — Wave 9D next-turn chip.
            nextTurnEstimateUsd={nextTurnEstimate.estimated}
            nextTurnEstimateUnknown={nextTurnEstimate.unknown}
            // COST-WIRING-SECTION (render end)
            // COST-FOOTER-PROPS-SECTION (thread) — cumulative spend
            // chips threaded from the host into UsageFooter via
            // MessageBlock. Both values come from the SQLite read
            // replica and are bound by useMemo on chat-state changes,
            // so per-render overhead is one ref check.
            sessionCostUsd={sessionCostUsd}
            todayCostUsd={todayCostUsd}
            // COST-FOOTER-PROPS-SECTION (thread end)
          />
        </Box>
      );
    }
    default: {
      const _exhaustive: never = screen;
      void _exhaustive;
      return renderTree(<Text>unknown screen</Text>);
    }
  }
}

// ---------- Free helpers ----------

// DIFF-VIEWER-MOUNT-SECTION (Wave 5B / TF4)
// ---------------------------------------------------------------------
// Keystroke pump for overlays mounted OUTSIDE the ChatScreen tree
// (CommandPalette and DiffViewer). Mirrors `InputPump` in ChatScreen:
// it sits inside the InputDispatcherProvider, calls ink's `useInput`,
// and forwards each keystroke through the dispatcher. Without this
// pump no key would reach the overlay's `useInputModeHandler`
// subscription (the dispatcher API is wired but no source feeds it).
// Returns `null` — invisible.
function DiffViewerInputPump(): React.JSX.Element | null {
  const dispatcher = useInputDispatcher();
  useInput((input, key) => {
    if (dispatcher === null) return;
    dispatcher.dispatch({ input, key });
  });
  return null;
}

// IMPORT-FIRST-RUN-SECTION (input pump)
// Tiny invisible component that owns the Y/N/X keystrokes for the
// import first-run prompt. Lives outside ChatScreen so the chat input
// stays inert during the prompt.
function ImportPromptInputPump(props: {
  readonly onYes: () => void;
  readonly onNo: () => void;
  readonly onNever: () => void;
}): React.JSX.Element | null {
  useInput((input, key) => {
    const lower = input.toLowerCase();
    if (lower === 'y' || key.return) {
      props.onYes();
      return;
    }
    if (lower === 'x') {
      props.onNever();
      return;
    }
    if (lower === 'n' || key.escape) {
      props.onNo();
      return;
    }
  });
  return null;
}
// IMPORT-FIRST-RUN-SECTION (input pump end)

/**
 * Read the full LOCALCODE.md hierarchy (project root → $HOME, plus the
 * global `~/.localcode/LOCALCODE.md`) and produce a single string suitable
 * for the system-prompt `localcodeMd` slot. Falls back to the single-file
 * reader when the hierarchy loader throws.
 *
 * When the joined hierarchy is too large to inline, returns a short
 * pointer body listing each LOCALCODE.md path so the model can lazy-load
 * via `read_file`. This keeps the system prompt byte-stable across turns.
 */
function readLocalcodeMdSafe(projectRoot: string): string | null {
  try {
    const result = loadHierarchy(projectRoot);
    if (result.inline !== undefined) return result.inline;
    if (result.pointers !== undefined && result.pointers.length > 0) {
      const lines = [
        'LOCALCODE.md hierarchy exceeds the inline budget; read on demand:',
        ...result.pointers.map((p) => `- ${p}`),
      ];
      return lines.join('\n');
    }
    return null;
  } catch {
    // Fallback to single-file read so older test harnesses / odd FS
    // setups still get *something*.
    try {
      return readLocalcodeMd(projectRoot);
    } catch {
      return null;
    }
  }
}

/**
 * AGENT-PANEL-SECTION — extract the `[role: <name>]` prefix that
 * `spawnFromTemplate` prepends to the worker's task. Returns the
 * template name when found, otherwise `null` so the caller can fall
 * back to the model id.
 */
function extractTemplateLabel(task: string): string | null {
  const m = task.match(/^\[role:\s*([^\]]+)\]/);
  if (m === null) return null;
  const label = (m[1] ?? '').trim();
  return label.length > 0 ? label : null;
}

// JOURNAL-RECOVERY-SECTION (component)
/**
 * Small ink overlay that surfaces the unfinished-session prompt on
 * startup when {@link recoverableJournals} returned a non-empty list.
 *
 * Key bindings:
 *   - R  → resume the most recent unfinished session
 *   - A  → archive every unfinished session (move into the archive dir)
 *   - Esc → dismiss for this run (the journals stay; the prompt will
 *           appear again on next launch)
 *
 * Strings flow through the i18n table so Russian users see Russian
 * copy. Component is private to this composition root — no other call
 * site needs it.
 */
interface JournalRecoveryOverlayProps {
  readonly recoverable: readonly RecoverableJournal[];
  readonly locale: 'en' | 'ru';
  readonly onResume: (sessionId: string) => void;
  readonly onArchiveAll: () => void;
  readonly onDismiss: () => void;
}
function JournalRecoveryOverlay(
  props: JournalRecoveryOverlayProps,
): React.JSX.Element {
  useInput((input, key) => {
    if (key.escape) {
      props.onDismiss();
      return;
    }
    const ch = (input ?? '').toLowerCase();
    if (ch === 'r') {
      const first = props.recoverable[0];
      if (first !== undefined) props.onResume(first.sessionId);
      return;
    }
    if (ch === 'a') {
      props.onArchiveAll();
      return;
    }
  });
  const count = props.recoverable.length;
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="yellow">
        {appT('journal.recovery.title', undefined, props.locale)}
      </Text>
      <Box marginTop={1}>
        <Text color="gray">
          {appT(
            'journal.recovery.message',
            { n: String(count) },
            props.locale,
          )}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray" dimColor>
          {appT('journal.recovery.hintResume', undefined, props.locale)}
        </Text>
        <Text color="gray" dimColor>
          {appT('journal.recovery.hintArchive', undefined, props.locale)}
        </Text>
        <Text color="gray" dimColor>
          {appT('journal.recovery.hintIgnore', undefined, props.locale)}
        </Text>
      </Box>
    </Box>
  );
}
// JOURNAL-RECOVERY-SECTION (component end)

// SANDBOX-WIRING-SECTION (helper)
/**
 * Narrow the optional `[sandbox]` block off `AppConfig` into the
 * `SandboxRuntimeConfig` shape `run_command` consumes. Returns
 * `undefined` when the user has not opted in (the tool then falls back
 * to its built-in defaults — `backend='auto'`, `allowNetwork=true`).
 *
 * Read at runtime via structural narrowing because the Zod-validated
 * `sandbox` block on `Config` is not yet mirrored on the `.d.ts`
 * `AppConfig` interface (the Zod compat assert tolerates the extra
 * optional field). Once the .d.ts catches up this helper can be a
 * plain `cfg.sandbox` read.
 */
function readSandboxConfig(cfg: AppConfig | null): SandboxRuntimeConfig | undefined {
  if (cfg === null) return undefined;
  const sb = (cfg as unknown as { sandbox?: unknown }).sandbox;
  if (sb === undefined || sb === null || typeof sb !== 'object') return undefined;
  const obj = sb as Record<string, unknown>;
  const backend = obj['backend'];
  const allowNetwork = obj['allowNetwork'];
  const allowWritePaths = obj['allowWritePaths'];
  const timeoutMs = obj['timeoutMs'];
  if (
    typeof backend !== 'string' ||
    typeof allowNetwork !== 'boolean' ||
    !Array.isArray(allowWritePaths) ||
    typeof timeoutMs !== 'number'
  ) {
    return undefined;
  }
  const validBackends: readonly SandboxRuntimeConfig['backend'][] = [
    'auto',
    'sandbox-exec',
    'firejail',
    'docker',
    'none',
  ];
  if (!validBackends.includes(backend as SandboxRuntimeConfig['backend'])) {
    return undefined;
  }
  const writePaths: string[] = [];
  for (const p of allowWritePaths) {
    if (typeof p === 'string') writePaths.push(p);
  }
  const out: SandboxRuntimeConfig = {
    backend: backend as SandboxRuntimeConfig['backend'],
    allowNetwork,
    allowWritePaths: writePaths,
    timeoutMs,
  };
  const dockerImage = obj['dockerImage'];
  if (typeof dockerImage === 'string' && dockerImage.length > 0) {
    out.dockerImage = dockerImage;
  }
  return out;
}
// SANDBOX-WIRING-SECTION (helper end)

function findPrefixMatch(
  sessions: readonly Session[],
  prefix: string,
): Session | null {
  const needle = prefix.toLowerCase();
  const candidates = sessions.filter((s) => s.id.toLowerCase().startsWith(needle));
  if (candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

function buildPendingApproval(
  toolName: string,
  args: Record<string, unknown>,
): PendingApproval {
  const id = newId('approval');

  if (
    toolName === 'write_file' ||
    toolName === 'edit_file' ||
    toolName === 'multi_edit'
  ) {
    const p = typeof args['path'] === 'string' ? (args['path'] as string) : '(file)';
    const verb =
      toolName === 'write_file'
        ? 'Write'
        : toolName === 'edit_file'
          ? 'Edit'
          : 'Multi-edit';
    return {
      id,
      kind: 'diff',
      title: `${verb} ${p}`,
      description: `The model wants to ${verb.toLowerCase()} this file.`,
      filePath: p,
      // The actual diff string is filled in by the executor's preview result;
      // we show a placeholder here because ChatScreen doesn't get the diff
      // through this path in this iteration — full diff rendering uses the
      // 'generic' fallback with the preview output prepended.
      diffString: '',
      toolName,
    };
  }

  if (toolName === 'run_command') {
    const cmd = typeof args['command'] === 'string' ? (args['command'] as string) : '(command)';
    return {
      id,
      kind: 'command',
      title: `Run shell command`,
      description: cmd,
      toolName,
    };
  }

  if (toolName === 'fetch_image') {
    const url = typeof args['url'] === 'string' ? (args['url'] as string) : '(url)';
    return {
      id,
      kind: 'generic',
      title: `Fetch image`,
      description: url,
      toolName,
    };
  }

  return {
    id,
    kind: 'generic',
    title: `Run ${toolName}`,
    description: JSON.stringify(args),
    toolName,
  };
}

interface PersistTelemetry {
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  /** Model name to persist with the row (assistant messages only). */
  model?: string;
  // COST-PERSIST-SECTION — backend + cache telemetry so SessionManager
  // can resolve OpenRouter-routed pricing and persist `cost_usd` +
  // cached/cache-creation columns alongside the standard counters.
  backend?: string;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  // COST-PERSIST-SECTION-END
}

function persistMessage(
  sessionManager: SessionManager,
  sessionId: string | null,
  message: Message,
  telemetry?: PersistTelemetry,
): void {
  if (sessionId === null) return;
  try {
    sessionManager.addMessage(sessionId, message, telemetry);
  } catch {
    // swallow — persistence is best-effort
  }
}

function formatToolOutput(result: ToolResult): string {
  if (!result.success) {
    return `(error) ${result.error ?? 'unknown error'}\n${result.output}`.trim();
  }
  return result.output;
}

/**
 * Inspect a successful `fetch_image` tool result and, when it carries
 * image bytes, return a follow-up user message with the image spliced
 * into multimodal content. Returns null for any non-image payload.
 */
function maybeBuildImageFollowup(result: ToolResult): Message | null {
  try {
    const parsed: unknown = JSON.parse(result.output);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj['kind'] !== 'image') return null;
    const mime = typeof obj['mimeType'] === 'string' ? obj['mimeType'] : '';
    const data = typeof obj['dataBase64'] === 'string' ? obj['dataBase64'] : '';
    if (mime.length === 0 || data.length === 0) return null;
    return buildImageMessage(data, mime, 'Here is the fetched image.');
  } catch {
    return null;
  }
}

async function executeToolsWithUi(
  toolCalls: readonly ToolCall[],
  executor: ToolExecutor,
  dispatch: (action: ChatAction) => void,
): Promise<readonly ToolCallWithResult[]> {
  const results: ToolCallWithResult[] = [];
  for (const call of toolCalls) {
    const runningState: ToolCallState = {
      id: call.id,
      name: call.name,
      args: call.arguments,
      status: 'running',
    };
    dispatch({ type: 'UPSERT_TOOL_CALL_STATE', id: call.id, state: runningState });

    const result = await executor.execute(call);

    const finalState: ToolCallState = {
      id: call.id,
      name: call.name,
      args: call.arguments,
      status: result.success ? 'done' : 'error',
      output: result.output,
      error: result.error,
      // For write_file / edit_file / multi_edit, carry the preview diff into the
      // post-hoc ToolCallBlock render (FIX #12).
      diffPreview:
        (call.name === 'write_file' ||
          call.name === 'edit_file' ||
          call.name === 'multi_edit') && result.success
          ? result.output
          : undefined,
      diffFilePath:
        typeof call.arguments['path'] === 'string'
          ? (call.arguments['path'] as string)
          : undefined,
    };
    dispatch({ type: 'UPSERT_TOOL_CALL_STATE', id: call.id, state: finalState });
    results.push({ toolCall: call, result });
  }
  return results;
}

/**
 * Convert the resolved {@link GenerationConfig} into the request-body
 * `options` shape understood by `LLMAdapter.streamChat`. The helper
 * emits backend-aware keys:
 *
 *   - `temperature` and `top_p` are common to both Ollama and LM Studio
 *     and live at the top level of the request body.
 *   - `max_tokens` is mapped to OpenAI's `max_tokens` (recognised by
 *     LM Studio and Ollama's OpenAI shim alike).
 *   - `repeat_penalty` is Ollama-specific. We surface it inside
 *     `options.options` (Ollama merges that into its native options
 *     block); LM Studio ignores unknown OpenAI fields, so the safe
 *     fallback is `frequency_penalty` mapped from `repeat_penalty - 1`
 *     (a 1.0 baseline maps to 0.0, 1.5 → 0.5, etc.).
 *
 * Returns `undefined` if generation hasn't been resolved yet so the
 * adapter falls back to its built-in defaults.
 */
function buildGenerationOptions(
  generation: GenerationConfig | null,
  backend: Backend,
): Record<string, unknown> | undefined {
  if (generation === null) return undefined;
  const opts: Record<string, unknown> = {
    temperature: generation.temperature,
    top_p: generation.topP,
    max_tokens: generation.maxTokens,
  };
  if (backend === 'ollama') {
    // Ollama's OpenAI shim accepts repeat_penalty inside `options`.
    opts.options = { repeat_penalty: generation.repeatPenalty };
  } else {
    // LM Studio (and most OpenAI-compatible servers) understand
    // `frequency_penalty` instead. Centre 1.0 (no penalty) on 0.0.
    const freq = generation.repeatPenalty - 1;
    if (Number.isFinite(freq)) opts.frequency_penalty = freq;
  }
  return opts;
}

// ---------- Re-export for testability ----------

export { chatReducer, initialChatState } from '@/integration/chat-state';

export default App;
