/**
 * Main chat screen. Purely presentational: all state (messages,
 * streaming buffer, pending approvals, thinking time) is owned by the
 * parent (app.tsx) and flows in via props.
 *
 * R2 layout changes (Task 3):
 *   ── messages / stream / approval ──
 *   SlashMenu (when open)
 *   Pending-queue pill (when queue non-empty) / Overlay (when active)
 *   InputBar (bordered)
 *   Header (model / context / backend)  ← now BELOW the input
 *
 * Other R2 additions:
 *   - Task 6: pending-queue while streaming. User submissions during
 *     streaming are enqueued locally; onDone (isStreaming false → true
 *     transition) drains one entry, invoking `onSubmit`.
 *   - Task 7+13+22: structured MessageBlock with per-role separators,
 *     model-name label, usage footer.
 *   - Task 9: up/down history navigation in InputBar; this screen
 *     tracks every user-submitted message in a local list for the
 *     session lifetime.
 *   - Task 15: SkillInputOverlay rendered when `skillOverlay === true`
 *     (prop), hiding the input and blocking keystrokes below.
 *
 * R3 additions:
 *   - FIX #25: `<NoxBig>` splash on an empty-and-idle screen; `<NoxMini>`
 *     permanent companion next to the InputBar. Mini blinks while the
 *     model is streaming.
 *   - FIX #32: overlay routing. The parent can render any of the
 *     slash-command overlays (Permissions / Context / CtxSize / Resume)
 *     by setting `overlay` on the props; while an overlay is active
 *     the InputBar is hidden and Nox/header stay visible.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useInput } from 'ink';
import {
  InputDispatcherProvider,
  useInputDispatcher,
  useInputModeHandler,
  type InputEvent,
  type InputMode,
} from '../components/InputDispatcher.js';
import Header from '../components/Header.js';
import InputBar from '../components/InputBar.js';
import SlashMenu from '../components/SlashMenu.js';
import DiffView from '../components/DiffView.js';
import ApprovalPrompt from '../components/ApprovalPrompt.js';
import ToolCallBlock, { type ToolCallStatus } from '../components/ToolCallBlock.js';
// PLAN-MODE-BADGE-MOUNT-SECTION — render the inline "[BLOCKED IN PLAN]"
// chip in place of the standard tool-error body whenever the executor
// surfaces the plan-mode short-circuit error string (see
// `src/llm/tool-executor.ts` PLAN-MODE-BLOCK-SECTION). The badge sits
// next to the existing `ToolCallBlock` so the user still sees the call
// trace + arguments — only the error body is swapped.
import { PlanModeBlockedBadge } from '../overlays/PlanModeOverlay.js';
// PLAN-MODE-BADGE-MOUNT-SECTION-END
import StreamOutput from '../components/StreamOutput.js';
import ThinkingSpinner from '../components/ThinkingSpinner.js';
import { ThinkingBlock } from '../components/ThinkingBlock.js';
import MessageBlock from '../components/MessageBlock.js';
import InlineDiffView from '../components/InlineDiffView.js';
import SkillInputOverlay, {
  type SkillOverlaySubmission,
} from '../components/SkillInputOverlay.js';
import PermissionsOverlay from '../components/PermissionsOverlay.js';
import ContextOverlay from '../components/ContextOverlay.js';
import CtxSizeOverlay from '../components/CtxSizeOverlay.js';
import ResumeOverlay from '../components/ResumeOverlay.js';
// BRANCHES-MOUNT-SECTION (imports)
import BranchBreadcrumb, {
  type BranchCrumb,
} from '../components/BranchBreadcrumb.js';
import BranchPicker, {
  type BranchPickerRow,
} from '../overlays/BranchPicker.js';
// BRANCHES-MOUNT-SECTION (imports end)
// SUGGEST-MOUNT-SECTION (Wave 6B) — Suggested follow-ups (ghost rows
// below each committed assistant message). Pure presentation +
// hot-keystroke wiring; the heuristic generator lives in the component.
import SuggestedFollowUps, {
  generateFollowUps,
  type FollowUpSuggestion,
} from '../components/SuggestedFollowUps.js';
// AGENT-TAIL-RENDER-SECTION (Wave 6B) — inline TeamBus messages.
import AgentInlineMessage from '../components/AgentInlineMessage.js';
import type { AgentTailEntry } from '../agent-tail-store.js';
// SNIPPET-MODE-MOUNT-SECTION (Wave 6B) — selection ring for `@clip-N`.
import {
  expandClipReferences,
  getSnippetRing,
  type SnippetRing,
} from '../snippet-ring.js';
// VIM-INDICATOR-MOUNT-SECTION (Wave 6B) — read-only mode chip.
import type { VimMode } from '../vim/types.js';
import UsageDashboard, {
  type UsageDashboardData,
} from '../overlays/UsageDashboard.js';
import CostDashboard, {
  type CostTurnRow,
} from '../overlays/CostDashboard.js';
import TokenVisualizer, {
  type TokenTurnSample,
} from '../overlays/TokenVisualizer.js';
import { NoxBig, NoxTamagotchi } from '../components/Nox.js';
import { TasksLine } from '../components/TasksLine.js';
// AGENT-PANEL-SECTION (Wave 5A — TA team)
import { AgentPanel, type AgentRow } from '../components/AgentPanel.js';
// PROACTIVE-MOUNT-SECTION (Wave 6D) — top suggestion above the InputBar.
import ProactiveSuggestionsPanel from '../components/ProactiveSuggestionsPanel.js';
// PROACTIVE-MOUNT-SECTION-END
// WATCH-PANEL-MOUNT-SECTION — 1-row process strip rendered above the
// InputBar / StatusPill whenever the `ProcessMonitor` is tracking ≥1
// long-running child. Subscribes to the singleton's `output` / `exit`
// events for live updates so the strip reflects state changes without
// the user pressing a key. Renders nothing when no processes are
// watched (the common case).
import WatchPanel from '../components/WatchPanel.js';
import { getProcessMonitor } from '../../process-monitor/index.js';
import type { WatchedProcess } from '../../process-monitor/types.js';
// WATCH-PANEL-MOUNT-SECTION-END
// TOC-SECTION / TIMELINE-SECTION / SEARCH-SECTION (Wave 6B —
// navigation aids). All three components are off by default; ChatScreen
// owns the toggle state + key bindings (Ctrl+T / Ctrl+Y / Ctrl+F) and
// drives the children purely via props.
import ConversationTOC, {
  buildTOCEntries,
  type ConversationTOCEntry,
} from '../components/ConversationTOC.js';
import SessionTimeline, {
  buildTimelineEvents,
  type TimelineEvent,
} from '../components/SessionTimeline.js';
import ConversationSearch, {
  findMatches,
  stepCursor,
  type MessageHit,
} from '../overlays/ConversationSearch.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
// LOCALE-APPLY-SECTION — `t()` for ChatScreen-owned banners, hints, and
// the empty-state copy. ChatScreen already receives `locale` via props
// (forwarded to ThinkingSpinner), but for re-renderable surface strings
// we go through the React context so a live `/language` switch flips
// every label without re-mounting.
import { useT } from '../../i18n/index.js';
// LOCALE-APPLY-SECTION-END
// CLIPBOARD-PASTE-SECTION (imports)
// Node-side helpers for the Ctrl+V clipboard-image bridge. `fs` /
// `path` / `os` are used to land the captured PNG into
// `~/.localcode/clipboard-images/<ts>-<id>.png` so the InputBar's
// existing bare-path auto-attach (`promoteBareImagePaths`) can swap it
// for an image PasteToken on the next submit. The actual clipboard
// read happens in `@/util/clipboard`, which is mockable for tests.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readClipboardImage } from '@/util/clipboard';
// CLIPBOARD-PASTE-SECTION (imports end)
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
import type { Todo } from '../../sessions/session-manager.js';
import type {
  AppConfig,
  AutoApprovableTool,
  Message,
  Session,
  SlashCommand,
  ToolCall,
} from '../../types/global.js';

/**
 * Describes a pending tool approval requested by the LLM. The parent
 * owns the promise resolution — this screen just renders the right UI
 * and forwards `onApprove` / `onReject`.
 */
export interface PendingApproval {
  readonly id: string;
  readonly kind: 'diff' | 'command' | 'generic';
  readonly title: string;
  readonly description: string;
  readonly filePath?: string;
  readonly diffString?: string;
  readonly onEdit?: () => void;
  /**
   * Source tool name (`write_file`, `edit_file`, `run_command`, …).
   * Drives which batching buttons the ApprovalPrompt offers — `[A]`
   * for any mutating tool and `[S]` only for `run_command`. Optional
   * so legacy callers (tests, web bridge) keep working unchanged.
   */
  readonly toolName?: string;
}

/**
 * A message + its associated tool-call render state. The parent may
 * pass this information inline on a message.toolCalls entry, or via a
 * side channel — either way the screen just consumes the results.
 *
 * R2 addition: `diffPreview` carries the tool's preview diff string
 * for inline mini-diff rendering alongside tool results (Task 12).
 * `filePath` complements it with the target path.
 */
export interface ToolCallState {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolCallStatus;
  readonly output?: string;
  readonly error?: string;
  /** Unified diff string (from write_file / edit_file preview). */
  readonly diffPreview?: string;
  /** Target file path for the diff, if applicable. */
  readonly diffFilePath?: string;
}

/**
 * FIX #32 — discriminated union covering every slash-command overlay
 * the ChatScreen can host. Any of these is optional; when omitted, no
 * overlay is rendered.
 */
export type OverlayState =
  | {
      readonly kind: 'permissions';
      readonly onToggle: (tool: AutoApprovableTool) => void;
      readonly onAcceptAll: () => void;
      readonly onClose: () => void;
    }
  | {
      readonly kind: 'context';
      readonly contextPercent: number;
      readonly totalTokens: number;
      readonly maxTokens: number;
      readonly messageCount: number;
      readonly activeSkills: readonly string[];
      readonly localcodeMd: boolean;
      readonly onClose: () => void;
    }
  | {
      readonly kind: 'ctxsize';
      readonly currentMaxTokens: number;
      readonly currentKeepAlive: number;
      readonly currentResponseTimeout: number;
      readonly onApply: (maxTokens: number, keepAlive: number, responseTimeout?: number) => void;
      readonly onClose: () => void;
    }
  | {
      readonly kind: 'resume';
      readonly sessions: readonly Session[];
      readonly onSelect: (id: string) => void;
      readonly onClose: () => void;
    }
  // 6A4 — three analytics overlays. Each kind carries its own
  // structured data + close callback; the host (app.tsx) precomputes
  // the data so the overlays stay presentational. `usage` additionally
  // accepts a refresh callback (re-pulls OpenRouter pricing).
  | {
      readonly kind: 'usage';
      readonly data: UsageDashboardData;
      readonly onRefresh: () => void;
      readonly onClose: () => void;
      readonly isRefreshing?: boolean;
      readonly onSelectSession?: (sessionId: string) => void;
    }
  | {
      readonly kind: 'cost';
      readonly turns: readonly CostTurnRow[];
      readonly sessionLabel?: string;
      readonly onClose: () => void;
    }
  | {
      readonly kind: 'perf';
      readonly samples: readonly TokenTurnSample[];
      readonly liveTokensPerSec?: number;
      readonly liveCacheHitPct?: number;
      readonly liveLatencyMs?: number;
      readonly onClose: () => void;
    }
  // BRANCHES-MOUNT-SECTION — `/branch` picker (Ctrl+B). Host
  // (app.tsx) precomputes the flat branch rows + active session id
  // from `SessionManager.getBranchTree()` and threads the callbacks
  // back into the chat reducer + slash command.
  | {
      readonly kind: 'branch';
      readonly rows: readonly BranchPickerRow[];
      readonly activeSessionId: string | null;
      readonly onSwitch: (id: string) => void;
      readonly onCreate: (name: string) => void;
      readonly onDelete: (id: string) => void;
      readonly onClose: () => void;
    };

export interface ChatScreenProps {
  readonly config: AppConfig;
  readonly projectRoot: string;
  readonly sessionId: string | null;
  readonly messages: readonly Message[];
  readonly toolCallStates?: ReadonlyMap<string, ToolCallState>;
  readonly isStreaming: boolean;
  readonly currentOutput: string;
  readonly pendingApproval: PendingApproval | null;
  readonly thinkingStartedAt: number | null;
  readonly contextPercent: number;
  readonly slashCommands: readonly SlashCommand[];
  readonly onSubmit: (text: string) => void;
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
  /**
   * Optional batched-approval handlers. `onApproveAllInTurn` is wired
   * to the `[A]` button; `onApproveForSession` to `[S]` (only meaningful
   * for `run_command`). When undefined, the relevant button is hidden —
   * legacy callers keep the simple `[y]/[n]` UX.
   */
  readonly onApproveAllInTurn?: (id: string) => void;
  readonly onApproveForSession?: (id: string) => void;
  readonly onSlashExecute: (cmd: SlashCommand, args: string) => void;
  readonly onCancel: () => void;
  /**
   * R2 additions — all optional so legacy callers keep working.
   */
  /** Overlay toggle (Task 15). When true, the SkillInputOverlay is shown. */
  readonly skillOverlay?: boolean;
  /** Called when the overlay submits a valid payload. */
  readonly onSkillSubmit?: (payload: SkillOverlaySubmission) => void;
  /** Called when the overlay is cancelled (Esc). */
  readonly onSkillCancel?: () => void;
  /** Active model name for assistant message labels (Task 22). */
  readonly modelName?: string;
  /** Cumulative session output tokens (Task 13). Forwarded to UsageFooter. */
  readonly sessionTotalOut?: number;
  /**
   * FIX #32 — slash-command overlay state. When present, the InputBar
   * is replaced by the relevant overlay component and all keystrokes
   * flow into that overlay (the parent handles the overlay's
   * callbacks).
   */
  readonly overlay?: OverlayState;
  /** Locale hint forwarded to ThinkingSpinner for phrase selection. */
  readonly locale?: 'en' | 'ru';
  /**
   * R16 (Agent 4) — live extended-thinking buffer. The reducer
   * (`chatState.currentThinking`, wired by Agent 8 R12) accumulates
   * thinking-channel deltas while the model is generating. We render
   * it via `<ThinkingBlock>` above the visible-content `<StreamOutput>`
   * so the user can watch the model's reasoning land before the
   * polished reply. Cleared by START_STREAM / END_STREAM /
   * REPLACE_MESSAGES on the reducer side, so a falsy value here just
   * means "no thinking content for this turn yet".
   */
  readonly currentThinking?: string;
  /**
   * R17 (Agent 4) — response-timeout in seconds, sourced from
   * `config.context.responseTimeoutSeconds` by app.tsx. The
   * `<StreamTimer>` indicator uses this to draw a "Processing Xs / Ys
   * timeout" line near the spinner, escalating colour as elapsed
   * approaches the limit. Optional so existing tests/callers that
   * don't pass it keep working — when undefined, the timer hides.
   */
  readonly responseTimeoutSeconds?: number;
  /**
   * R20 (Agent 4) — Bash-mode dispatch hook. When the user submits a
   * draft starting with `!` (and not `!!`), `classifySubmit` returns
   * `{ kind: 'bash', command }` and we forward the command body here
   * instead of `onSubmit`. The host (app.tsx, wired by Agent 8 R17)
   * is expected to spawn the command locally (e.g. via `execa`) and
   * surface the output as a system-style chat message. The model is
   * NEVER shown the command or its output — this is purely a local
   * convenience for the user.
   *
   * Optional so legacy callers / unit tests keep working: when
   * undefined, bash-mode submissions silently fall through to the
   * normal text path (the `!` prefix is preserved and the model
   * sees it). The InputBar's visual indicator still lights up — this
   * matches Agent 8 R6's literal-slash strategy where the visual
   * cue is decoupled from the routing decision.
   */
  readonly onBashExecute?: (command: string) => void;
  /**
   * Fix 2 (type-ahead error gate). When non-null, the most recent turn
   * ended with an error. ChatScreen pauses the auto-flush of the
   * type-ahead queue and renders a single-line banner above
   * `<QueueIndicator>` with Retry / Discard buttons.
   *
   *   - Retry  → calls `onClearTurnError` and re-arms the flush.
   *   - Discard→ clears both the queue and the error.
   *
   * Optional so legacy callers / tests keep working: when undefined,
   * the screen behaves exactly as before (queue auto-flushes on any
   * stream end).
   */
  readonly lastTurnError?: string | null;
  /** Called by the Retry button — host clears `lastTurnError`. */
  readonly onClearTurnError?: () => void;
  /**
   * Single source of truth for the type-ahead-while-busy queue
   * (`chatState.pendingQueue` in the reducer). ChatScreen used to
   * mirror this in a local `useState` slice, which could drift if any
   * other caller dispatched `ENQUEUE_PENDING` while the screen was
   * mounted. Reading the queue via props eliminates that risk.
   *
   * Optional so legacy callers / unit tests keep working: when
   * undefined the queue stays empty and enqueue/clear are no-ops.
   */
  readonly pendingQueue?: readonly string[];
  /**
   * Fires when the user submits text while a stream / approval is in
   * flight. The host dispatches `ENQUEUE_PENDING` against the reducer.
   * Optional — when undefined the streaming-time submit silently drops
   * the text (matches the pre-prop fallback for non-wired callers).
   */
  readonly onEnqueuePending?: (text: string) => void;
  /**
   * Empties the pending queue. Fired by the flush effect immediately
   * before re-submitting the concatenated payload, by the double-Esc
   * clear path, and by the Ctrl+X error-discard path. Host dispatches
   * `CLEAR_PENDING`.
   */
  readonly onClearPending?: () => void;
  /**
   * Current todos for the active session — displayed in TasksLine above
   * the InputBar. Optional; renders nothing when absent or empty.
   */
  readonly todos?: readonly Todo[];
  // AGENT-PANEL-SECTION (Wave 5A — TA team) — multi-agent UX
  /**
   * Live worker list rendered as `<AgentPanel>` under the InputBar.
   * Empty / undefined → panel is not mounted (saves vertical space).
   * The list is owned by app.tsx via an orchestrator-event subscription
   * so the screen stays purely presentational.
   */
  readonly agentWorkers?: readonly AgentRow[];
  /** True when the lead's assistant stream is in flight. */
  readonly leadStreaming?: boolean;
  /**
   * Which agent the composer is currently routing to. `'lead'` (default)
   * = normal chat path; any other string = a worker id (Enter sends via
   * TeamBus, Esc returns to lead).
   */
  readonly currentConversant?: 'lead' | string;
  /**
   * When true, the AgentPanel owns ↑/↓/Enter/Esc. Tab toggles this. The
   * screen renders the panel either way but switches the dispatcher mode.
   */
  readonly agentFocusMode?: boolean;
  /** Index of the highlighted row inside `agentWorkers`. */
  readonly agentSelectedIdx?: number;
  /** Called when the user presses Tab to enter agent-focus. */
  readonly onAgentFocusEnter?: () => void;
  /** Called when the user presses Tab/Esc to exit agent-focus. */
  readonly onAgentFocusExit?: () => void;
  /** Called when the user presses ↓ in agent-focus. */
  readonly onAgentSelectNext?: () => void;
  /** Called when the user presses ↑ in agent-focus. */
  readonly onAgentSelectPrev?: () => void;
  /** Called when the user presses Enter to attach to a worker. */
  readonly onAgentAttach?: (agentId: string) => void;
  /** Called when the user presses Esc to detach (return to lead). */
  readonly onAgentDetach?: () => void;
  // OUTPUT-FILTER-SECTION (Wave 6A2) — start
  /**
   * Filter slice from `chatState.outputFilters`. When undefined, the
   * screen behaves as if all categories were enabled (defaults =
   * legacy behaviour). Three booleans gate rendering of thinking
   * blocks, tool-call results, and system-note messages.
   */
  readonly outputFilters?: {
    readonly thinking: boolean;
    readonly toolCalls: boolean;
    readonly systemNotes: boolean;
  };
  /** Cycle to the next preset (Shift+H / `/filter`). */
  readonly onCycleOutputFilter?: () => void;
  // OUTPUT-FILTER-SECTION — end
  // READING-MODE-SECTION (Wave 6A2) — start
  /**
   * When true, the screen hides AgentPanel / status pill row /
   * InputBar and shows a single banner inviting the user to press F
   * to exit. F also toggles it on from the composer mode.
   */
  readonly readingMode?: boolean;
  /** Toggle reading mode (F). */
  readonly onToggleReadingMode?: () => void;
  // READING-MODE-SECTION — end
  // BRANCHES-MOUNT-SECTION (props)
  /**
   * Branch breadcrumb chain (root → current). Empty / undefined →
   * the breadcrumb auto-hides. Optional so legacy callers (tests, web
   * bridge) keep working without wiring it.
   */
  readonly branchChain?: readonly BranchCrumb[];
  /**
   * Open the branch picker overlay (Ctrl+B). Optional — when undefined
   * the keystroke falls through to other handlers.
   */
  readonly onOpenBranchPicker?: () => void;
  // BRANCHES-MOUNT-SECTION (props end)
  // SUGGEST-MOUNT-SECTION (Wave 6B) — Suggested follow-up ghost rows.
  /** Toggle from `/suggest on|off`. When undefined the rows render
   *  iff there's an eligible last-assistant message. */
  readonly suggestEnabled?: boolean;
  // VIM-INDICATOR-MOUNT-SECTION (Wave 6B) — `config.editor.vimMode`.
  /**
   * Current vim mode for the chip below the composer. Render only
   * when `config.editor?.vimMode === true`; legacy callers leave both
   * undefined and pay zero cost.
   */
  readonly vimMode?: VimMode;
  // AGENT-TAIL-RENDER-SECTION (Wave 6B) — TeamBus message interleave.
  /** Optional chronological agent-tail snapshot for this session. */
  readonly agentTailEntries?: readonly AgentTailEntry[];
  // SNIPPET-MODE-MOUNT-SECTION (Wave 6B) — ad-hoc clipboard ring.
  /** Injectable ring (defaults to process-wide singleton). */
  readonly snippetRing?: SnippetRing;
  // MODEL-SWAP-MOUNT-SECTION (Wave 6B) — Ctrl+M live picker.
  /** Open the model-swap overlay. Host cancels in-flight stream + migrates. */
  readonly onOpenModelSwap?: () => void;
  // PROACTIVE-MOUNT-SECTION (Wave 6D)
  /**
   * Top proactive suggestion produced by `ProactiveDetector`. The
   * `ProactiveSuggestionsPanel` renders one dim row above the InputBar
   * when this is non-null and `proactivePanelVisible` is not false.
   * Host (`app.tsx`) builds the detector input from chat state and
   * passes the highest-confidence suggestion (or null when none qualify).
   */
  readonly proactiveSuggestion?: import('@/agents/proactive-detector').ProactiveSuggestion | null;
  /**
   * Toggleable via a future `/suggest panel off`. Defaults to true so
   * legacy callers (tests, web bridge) keep working — when undefined the
   * panel is shown iff `proactiveSuggestion` is non-null.
   */
  readonly proactivePanelVisible?: boolean;
  // PROACTIVE-MOUNT-SECTION-END
  // COST-FORECAST-SECTION (start) — next-turn cost preview chip rendered
  // directly above the InputBar. The host computes the inputs via
  // `estimateNextTurn` (`src/llm/cost-estimator.ts`) so this screen stays
  // presentational. Both fields are optional — when both are omitted
  // (or the provider is local), the chip self-hides.
  /** Central USD estimate for the next assistant reply. */
  readonly nextTurnEstimateUsd?: number;
  /** True when the model has no known pricing — chip renders `~?`. */
  readonly nextTurnEstimateUnknown?: boolean;
  // COST-FORECAST-SECTION (end)
  // COST-FOOTER-PROPS-SECTION (start) — cumulative spend chips threaded
  // into the `UsageFooter` rendered beneath the most-recent assistant
  // turn. The host computes both values via
  // `SessionManager.getSessionCost(sid)` + `getTodayCost()` and passes
  // them through. The footer self-hides when both are zero or omitted,
  // so the chat tail stays clean for local-only sessions.
  readonly sessionCostUsd?: number;
  readonly todayCostUsd?: number;
  // COST-FOOTER-PROPS-SECTION (end)
}

/**
 * R17 (Agent 4) — live elapsed-time indicator rendered while the model
 * is streaming. Reads `chatState.thinkingStartedAt` (Agent 4 R7 / Agent
 * 8) for the start tick and ticks every second via a `setInterval`
 * pump in `useEffect`.
 *
 * Format:
 *   - elapsed < 0.5 × timeout → highlight (calm purple)
 *   - elapsed > 0.5 × timeout → yellow (warning)
 *   - elapsed > 0.9 × timeout → red (about to abort)
 *
 * The component self-hides when `isStreaming` is false so it never
 * leaves a stale tick after the stream ends. The interval is cleaned
 * up by the effect's teardown function — no memory leak risk if the
 * parent unmounts mid-stream.
 *
 * Owned by ChatScreen; not exported. The component lives in this file
 * because it has no use outside the streaming area and doesn't deserve
 * its own component file (Agent 4 R17 brief).
 */
interface StreamTimerProps {
  readonly startedAt: number;
  readonly timeoutSeconds: number;
  readonly isStreaming: boolean;
}

function StreamTimerImpl({
  startedAt,
  timeoutSeconds,
  isStreaming,
}: StreamTimerProps): React.JSX.Element | null {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!isStreaming) return undefined;
    // Tick every 1s — the indicator's resolution is whole seconds, so
    // anything finer would just burn battery and flicker the row.
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [isStreaming, startedAt]);

  if (!isStreaming) return null;

  // Defensive — guard against an out-of-range `startedAt` (e.g. parent
  // forgot to clear it) so we never render a negative elapsed value.
  const rawElapsed = Math.floor((now - startedAt) / 1000);
  const elapsedSec = rawElapsed < 0 ? 0 : rawElapsed;
  // Defensive against a non-positive timeout (would NaN/Infinity the
  // ratio); fall back to "elapsed only" rendering if so.
  const safeTimeout =
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds
      : null;
  const ratio = safeTimeout === null ? 0 : elapsedSec / safeTimeout;
  const colour =
    ratio > 0.9
      ? '#fca5a5'
      : ratio > 0.5
        ? noxPalette.yellow
        : noxPalette.highlight;
  const text =
    safeTimeout === null
      ? `⏱ Processing ${elapsedSec}s`
      : `⏱ Processing ${elapsedSec}s / ${safeTimeout}s timeout`;

  return (
    <Box paddingX={1}>
      <Text color={colour}>{text}</Text>
    </Box>
  );
}

// L5 — wrap in React.memo so the parent's per-tick re-renders (e.g.
// streaming chunks at ~6.7 Hz) don't reconcile StreamTimer between
// its own 1-second internal ticks. All three props are primitives, so
// the default referential comparator is correct.
const StreamTimer = React.memo(StreamTimerImpl);

// COST-FORECAST-SECTION (component) ----------
//
// One-line cost preview rendered directly above the InputBar so users
// on paid backends see what their next reply will cost BEFORE pressing
// Enter. Stateless and entirely prop-driven; the host (`app.tsx`)
// runs the actual `estimateNextTurn` call and threads the result down.
//
// Colour ladder: <$0.01 = calm highlight, <$0.10 = yellow caution,
// >=$0.10 = red. When `unknown` is true, the chip renders a muted
// `~? next turn` so the absence of pricing is visible instead of
// silently zero.
//
// The chip self-hides when both `estimateUsd` and `unknown` are
// absent (the common case: local backend, no pricing context, etc.).
// The trailing label is accepted via the optional `nextTurnLabel`
// prop so the i18n team (9A) can swap it without touching this
// component's logic.

interface CostForecastChipProps {
  readonly estimateUsd: number | undefined;
  readonly unknown: boolean | undefined;
  /** Optional translated trailing label. Defaults to `next turn`. */
  readonly nextTurnLabel?: string;
}

function formatForecastUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$0.0000';
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return '$0.0000';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function CostForecastChipImpl({
  estimateUsd,
  unknown,
  nextTurnLabel,
}: CostForecastChipProps): React.JSX.Element | null {
  const labelTail = nextTurnLabel ?? 'next turn';

  if (unknown === true) {
    return (
      <Box paddingX={1}>
        <Text color={textMuted} dimColor>
          {`~? ${labelTail}`}
        </Text>
      </Box>
    );
  }
  if (
    estimateUsd === undefined ||
    !Number.isFinite(estimateUsd) ||
    estimateUsd < 0.001
  ) {
    return null;
  }

  let colour: string;
  if (estimateUsd >= 0.1) {
    colour = '#fca5a5';
  } else if (estimateUsd >= 0.01) {
    colour = noxPalette.yellow;
  } else {
    colour = noxPalette.highlight;
  }

  return (
    <Box paddingX={1}>
      <Text color={colour}>{`~${formatForecastUsd(estimateUsd)} ${labelTail}`}</Text>
    </Box>
  );
}

const CostForecastChip = React.memo(CostForecastChipImpl);
// COST-FORECAST-SECTION (component end) ----------

/**
 * R16 (Agent 4) — structural narrowing for the optional `thinking`
 * field that Agent 8 R12 attaches to assistant messages via
 * `withThinking()` in app.tsx. The canonical `Message` interface in
 * `src/types/global.d.ts` is owned by another round, so the field
 * rides on the runtime object without TypeScript noticing. We
 * narrow at the read-site here so the renderer can pull the field
 * without any cast at the field access (`m.thinking`) and the rest
 * of ChatScreen keeps its `Message[]` type contract.
 */
interface MessageWithThinking extends Message {
  readonly thinking?: string;
}

interface MessageRowProps {
  readonly message: MessageWithThinking;
  readonly toolCallStates?: ReadonlyMap<string, ToolCallState>;
  readonly modelName?: string;
  readonly sessionTotalOut?: number;
  // OUTPUT-FILTER-SECTION (start) — receives the resolved filter
  // tuple so the renderer can omit thinking / tool-call / system-note
  // rows without mutating the underlying message data.
  readonly outputFilters?: {
    readonly thinking: boolean;
    readonly toolCalls: boolean;
    readonly systemNotes: boolean;
  };
  // OUTPUT-FILTER-SECTION (end)
  // COST-FOOTER-PROPS-SECTION (start) — cumulative session + today USD
  // chips shown only on the LAST assistant message (so the chat tail
  // stays clean for older turns). Both fields self-hide when zero/omitted.
  readonly sessionCostUsd?: number;
  readonly todayCostUsd?: number;
  readonly isLastMessage?: boolean;
  // COST-FOOTER-PROPS-SECTION (end)
}

function MessageRowImpl({
  message,
  toolCallStates,
  modelName,
  sessionTotalOut,
  outputFilters,
  // COST-FOOTER-PROPS-SECTION (start)
  sessionCostUsd,
  todayCostUsd,
  isLastMessage,
  // COST-FOOTER-PROPS-SECTION (end)
}: MessageRowProps): React.JSX.Element | null {
  // FILTER-RENDER-SECTION (start) — output-filter view guards. These
  // affect render only; persisted message data is untouched.
  const filtersOn = outputFilters !== undefined;
  const hideThinking = filtersOn && outputFilters.thinking === false;
  const hideToolCalls = filtersOn && outputFilters.toolCalls === false;
  const hideSystemNotes = filtersOn && outputFilters.systemNotes === false;
  // FILTER-RENDER-SECTION (end)
  switch (message.role) {
    case 'user':
      // FIX #24: `label` is still required by the MessageBlock props
      // signature but user messages deliberately suppress any label
      // rendering. Keep passing an empty string so downstream callers
      // never spot "You" in snapshots.
      return (
        <MessageBlock
          role="user"
          label=""
          content={message.content}
          createdAt={message.createdAt}
        />
      );
    case 'assistant': {
      // Per-message label: prefer the model the message itself recorded
      // (so old assistant rows keep showing the model that actually
      // generated them, even after the user switches the active model).
      // Fall back to the screen-level `modelName` (current model) for
      // legacy rows persisted before the column existed and for
      // in-flight streams that haven't committed yet.
      const messageModel =
        typeof message.model === 'string' && message.model.length > 0
          ? message.model
          : undefined;
      const label =
        messageModel ?? (modelName !== undefined && modelName.length > 0 ? modelName : 'assistant');
      // R16 (Agent 4) — committed-message thinking renders ABOVE the
      // visible content so the user reads "reasoning → answer" in
      // order. Defaults to collapsed so a long history stays scannable;
      // expanding is up to the user (the ThinkingBlock owns its own
      // collapse toggle internally).
      const thinkingText = message.thinking;
      const hasThinking = thinkingText !== undefined && thinkingText.trim().length > 0;
      return (
        <Box flexDirection="column">
          {/* FILTER-RENDER-SECTION — thinking blocks hidden under the
              'concise' / 'clean' presets. */}
          {hasThinking && !hideThinking && (
            <ThinkingBlock
              text={thinkingText ?? ''}
              isActive={false}
              collapsedByDefault={true}
            />
          )}
          {message.content.length > 0 && (
            <MessageBlock
              role="assistant"
              label={label}
              content={message.content}
              createdAt={message.createdAt}
              tokensInput={message.tokensInput}
              tokensOutput={message.tokensOutput}
              durationMs={message.durationMs}
              sessionTotalOut={sessionTotalOut}
              // COST-FOOTER-PROPS-SECTION (mount) — only annotate the
              // most-recent assistant message so older turns don't
              // grow noisier on every committed row.
              {...(isLastMessage === true
                ? {
                    sessionCostUsd: sessionCostUsd,
                    todayCostUsd: todayCostUsd,
                  }
                : {})}
              // COST-FOOTER-PROPS-SECTION (mount end)
            />
          )}
          {/* FILTER-RENDER-SECTION — tool calls hidden under the 'clean'
              preset (and below). */}
          {!hideToolCalls && message.toolCalls !== undefined && message.toolCalls.length > 0 && (
            <Box flexDirection="column" marginTop={message.content.length > 0 ? 1 : 0} paddingX={1}>
              {message.toolCalls.map((tc: ToolCall) => {
                const st = toolCallStates?.get(tc.id);
                // PLAN-MODE-BADGE-MOUNT-SECTION — when the executor's
                // plan-mode short-circuit fired (see PLAN-MODE-BLOCK-SECTION
                // in `src/llm/tool-executor.ts`) the error body starts
                // with the literal "Plan mode active" string. Render
                // the inline badge in place of the raw error so the
                // user sees a clean "[BLOCKED IN PLAN] <tool>" chip.
                const planBlocked =
                  typeof st?.error === 'string' &&
                  st.error.startsWith('Plan mode active');
                // PLAN-MODE-BADGE-MOUNT-SECTION-END
                return (
                  <Box key={tc.id} flexDirection="column">
                    <ToolCallBlock
                      name={tc.name}
                      args={tc.arguments}
                      status={st?.status ?? 'pending'}
                      output={st?.output}
                      // PLAN-MODE-BADGE-MOUNT-SECTION — suppress the
                      // raw error text when we render the badge below.
                      error={planBlocked ? undefined : st?.error}
                      // PLAN-MODE-BADGE-MOUNT-SECTION-END
                    />
                    {/* PLAN-MODE-BADGE-MOUNT-SECTION (start) */}
                    {planBlocked && (
                      <Box paddingLeft={2}>
                        <PlanModeBlockedBadge toolName={tc.name} />
                      </Box>
                    )}
                    {/* PLAN-MODE-BADGE-MOUNT-SECTION-END */}
                    {st?.diffPreview !== undefined && st.diffPreview.length > 0 && (
                      <Box paddingLeft={2} marginTop={1}>
                        <InlineDiffView
                          filePath={st.diffFilePath ?? tc.arguments.path?.toString() ?? '(file)'}
                          diffString={st.diffPreview}
                        />
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      );
    }
    case 'tool':
      // FILTER-RENDER-SECTION — tool roundtrip results suppressed under
      // 'clean'+ presets. Render nothing rather than an empty placeholder.
      if (hideToolCalls) return null;
      return (
        <MessageBlock
          role="tool"
          label={`tool: ${message.toolName ?? 'unknown'}`}
          content={message.content.slice(0, 480)}
          createdAt={message.createdAt}
        />
      );
    case 'system':
      // FILTER-RENDER-SECTION — system notes hidden under 'minimal'
      // preset only (the strictest setting).
      if (hideSystemNotes) return null;
      return (
        <MessageBlock role="system" label="system" content={message.content} createdAt={message.createdAt} />
      );
    default: {
      const _exhaustive: never = message.role;
      void _exhaustive;
      return <Text>unknown message</Text>;
    }
  }
}

/**
 * R7 (Agent 4) — flicker reduction.
 *
 * The committed messages list paints once per `messages` array
 * change (and again whenever a tool's status changes via
 * `toolCallStates`). Without memoisation, every parent re-render —
 * including the high-frequency ones triggered by `currentOutput`
 * updates while streaming, every keystroke into `setDraft`, and
 * the per-second `ThinkingSpinner` ticks — would re-render every
 * `MessageRow`, which in turn re-renders every nested `MessageBlock`,
 * `ToolCallBlock`, and `UsageFooter`.
 *
 * The custom comparator is intentionally conservative:
 *   - `message` is compared by identity AND by `id`/`content`/
 *     `tokensInput`/`tokensOutput`/`durationMs`/`toolCalls.length`.
 *     Most messages in the array are immutable history items; the
 *     parent splices new items in as fresh references, which the
 *     identity check catches first. The deeper field checks only
 *     run if a caller mutates a message in place (which we don't,
 *     but the safety net is cheap).
 *   - `toolCallStates` is compared by reference. The parent
 *     reassigns the Map whenever any tool's state advances, so a
 *     per-id deep walk would buy us nothing on the common path.
 *     If the parent passes the same Map reference, no tool state
 *     has changed and we can safely skip the row repaint — even
 *     though some OTHER row might want to repaint, the child
 *     `<ToolCallBlock>` already short-circuits via its own memo.
 *   - `modelName` and `sessionTotalOut` are primitives.
 */
function messageRowPropsAreEqual(
  prev: MessageRowProps,
  next: MessageRowProps,
): boolean {
  if (prev.modelName !== next.modelName) return false;
  if (prev.sessionTotalOut !== next.sessionTotalOut) return false;
  if (prev.toolCallStates !== next.toolCallStates) return false;
  // COST-FOOTER-PROPS-SECTION — cumulative cost props feed the UsageFooter.
  if (prev.sessionCostUsd !== next.sessionCostUsd) return false;
  if (prev.todayCostUsd !== next.todayCostUsd) return false;
  if (prev.isLastMessage !== next.isLastMessage) return false;
  // COST-FOOTER-PROPS-SECTION-END
  // OUTPUT-FILTER-SECTION — refresh on any filter change so render
  // guards re-evaluate. The slice is rebuilt by useMemo in the parent
  // only when its inputs change, so referential equality is safe.
  if (prev.outputFilters !== next.outputFilters) return false;
  if (prev.message === next.message) return true;
  // Defensive deep-ish check for in-place mutations that would
  // otherwise be missed by an identity test. We compare the fields
  // that actually feed the rendered output.
  const a = prev.message;
  const b = next.message;
  if (a.id !== b.id) return false;
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
  if (a.createdAt !== b.createdAt) return false;
  if (a.tokensInput !== b.tokensInput) return false;
  if (a.tokensOutput !== b.tokensOutput) return false;
  if (a.durationMs !== b.durationMs) return false;
  if (a.model !== b.model) return false;
  if ((a.toolCalls?.length ?? 0) !== (b.toolCalls?.length ?? 0)) return false;
  // R16 (Agent 4) — `thinking` is attached structurally by app.tsx's
  // withThinking() helper. We compare it here so a late-arriving
  // thinking attachment (committed after the visible content lands)
  // forces a row repaint and the user sees the new <ThinkingBlock>.
  if (a.thinking !== b.thinking) return false;
  return true;
}

const MessageRow = React.memo(MessageRowImpl, messageRowPropsAreEqual);

/**
 * Single-line separator drawn between messages of different roles.
 * Uses middle-dot `·` to stay visually quiet — now in muted purple.
 *
 * L3 — wrapped in React.memo so parent-driven re-renders (every
 * streaming chunk while a Separator sits in the pending tail) don't
 * recompute the dim text. No props → the default comparator always
 * returns true after first render.
 */
const Separator = React.memo(function Separator(): React.JSX.Element {
  return (
    <Box paddingX={1}>
      <Text color={dimSeparator} dimColor>
        {'·'.repeat(40)}
      </Text>
    </Box>
  );
});

/**
 * Render the active overlay (if any). Returns `null` when `overlay`
 * is undefined so the InputBar falls through. Each branch wires the
 * overlay's callbacks straight through; the parent is responsible for
 * dispatching state updates + closing the overlay on response.
 */
function OverlayRenderer({
  overlay,
  config,
}: {
  readonly overlay: OverlayState | undefined;
  readonly config: AppConfig;
}): React.JSX.Element | null {
  if (overlay === undefined) return null;
  switch (overlay.kind) {
    case 'permissions':
      return (
        <PermissionsOverlay
          config={config}
          onToggle={overlay.onToggle}
          onAcceptAll={overlay.onAcceptAll}
          onClose={overlay.onClose}
        />
      );
    case 'context':
      return (
        <ContextOverlay
          contextPercent={overlay.contextPercent}
          totalTokens={overlay.totalTokens}
          maxTokens={overlay.maxTokens}
          messageCount={overlay.messageCount}
          activeSkills={overlay.activeSkills}
          localcodeMd={overlay.localcodeMd}
          onClose={overlay.onClose}
        />
      );
    case 'ctxsize':
      return (
        <CtxSizeOverlay
          currentMaxTokens={overlay.currentMaxTokens}
          currentKeepAlive={overlay.currentKeepAlive}
          currentResponseTimeout={overlay.currentResponseTimeout}
          onApply={overlay.onApply}
          onClose={overlay.onClose}
        />
      );
    case 'resume':
      return (
        <ResumeOverlay
          sessions={overlay.sessions}
          onSelect={overlay.onSelect}
          onClose={overlay.onClose}
        />
      );
    case 'usage':
      return (
        <UsageDashboard
          data={overlay.data}
          onRefresh={overlay.onRefresh}
          onClose={overlay.onClose}
          {...(overlay.onSelectSession !== undefined
            ? { onSelectSession: overlay.onSelectSession }
            : {})}
          {...(overlay.isRefreshing !== undefined
            ? { isRefreshing: overlay.isRefreshing }
            : {})}
        />
      );
    case 'cost':
      return (
        <CostDashboard
          turns={overlay.turns}
          onClose={overlay.onClose}
          {...(overlay.sessionLabel !== undefined
            ? { sessionLabel: overlay.sessionLabel }
            : {})}
        />
      );
    case 'perf':
      return (
        <TokenVisualizer
          samples={overlay.samples}
          onClose={overlay.onClose}
          {...(overlay.liveTokensPerSec !== undefined
            ? { liveTokensPerSec: overlay.liveTokensPerSec }
            : {})}
          {...(overlay.liveCacheHitPct !== undefined
            ? { liveCacheHitPct: overlay.liveCacheHitPct }
            : {})}
          {...(overlay.liveLatencyMs !== undefined
            ? { liveLatencyMs: overlay.liveLatencyMs }
            : {})}
        />
      );
    // BRANCHES-MOUNT-SECTION (overlay case)
    case 'branch':
      return (
        <BranchPicker
          rows={overlay.rows}
          activeSessionId={overlay.activeSessionId}
          onSwitch={overlay.onSwitch}
          onCreate={overlay.onCreate}
          onDelete={overlay.onDelete}
          onClose={overlay.onClose}
        />
      );
    default: {
      const _exhaustive: never = overlay;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * R6 (Agent 8) — slash-input classification.
 *
 * The decision tree:
 *   1. Empty / whitespace-only → `text` (caller short-circuits anyway).
 *   2. Starts with `//` → `literal-slash`: strip ONE leading `/`,
 *      forward to the LLM.
 *   3. Does not start with `/` → `text`: forward to the LLM.
 *   4. Starts with `/`:
 *      a. Extract the first word after `/` up to the first whitespace.
 *      b. If that first word is NOT a clean identifier
 *         (`^[a-zA-Z][a-zA-Z0-9_-]*$`) → it's a path/URL fragment.
 *         Forward to the LLM as text (e.g. `/Users/foo/bar`,
 *         `/var/log/x`, `/123start`).
 *      c. Look up the first word against the registry
 *         (case-insensitive). If found → dispatch as a `command`,
 *         even when args contain `/` (e.g. `/permissions add /etc/x`).
 *      d. Not registered AND the rest of the input contains another
 *         `/` → it's a path with a misleading first segment
 *         (e.g. `/usr/local/bin`, `/foo/bar`). Forward as `text`.
 *      e. Not registered AND no further `/` → it's either a typo
 *         (`/help-typo`) or a not-yet-registered command. Dispatch
 *         as a `command`; the unknown-command echo will print
 *         "Unknown command: …".
 *
 * This function is exported only as a private helper for callers in
 * this module; the test surface remains `SlashRegistry`.
 */
export type SubmitDecision =
  | { readonly kind: 'command'; readonly name: string; readonly args: string }
  | { readonly kind: 'literal-slash'; readonly text: string }
  | { readonly kind: 'bash'; readonly command: string }
  | { readonly kind: 'literal-bang'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string };

const CLEAN_IDENT_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Stable empty-array sentinel for the `pendingQueue` prop fallback.
 * Holding a single module-level reference (rather than `[]` per render)
 * keeps the `nextQueuedPreview` / `flush` effect dependency arrays
 * referentially stable when no host has wired the queue prop.
 */
const EMPTY_QUEUE: readonly string[] = Object.freeze([]);

export function classifySubmit(
  text: string,
  registry: readonly SlashCommand[],
): SubmitDecision {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: 'text', text };

  // R20 (Agent 4) — Bash mode: a leading `!` (NOT `!!`) routes the
  // remainder to the host's `onBashExecute` callback for local shell
  // execution. The model never sees these, so quick checks like
  // `!ls`, `!git status`, `!npm test` don't pollute the chat
  // history. `!!literal !text` is the escape hatch — strips ONE
  // leading `!` and forwards as plain text. Bare `!` (no command
  // body) falls through to text so the user can still send a
  // single exclamation mark to the model.
  if (trimmed.startsWith('!!')) {
    return { kind: 'literal-bang', text: trimmed.slice(1) };
  }
  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim();
    if (command.length > 0) {
      return { kind: 'bash', command };
    }
    // Bare `!` — treat as text so the model receives the punctuation.
    return { kind: 'text', text };
  }

  // `//literal text` → strip ONE leading slash, treat as text.
  if (trimmed.startsWith('//')) {
    return { kind: 'literal-slash', text: trimmed.slice(1) };
  }
  if (!trimmed.startsWith('/')) {
    return { kind: 'text', text };
  }

  // Extract the first word after the leading `/`.
  const rest = trimmed.slice(1);
  const spaceIdx = rest.search(/\s/);
  const firstWord = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();

  // Bare `/` (no first word) — dispatch as command so the unknown-
  // command echo handles it (this is the Enter-on-just-`/` case).
  if (firstWord.length === 0) {
    return { kind: 'command', name: '', args: '' };
  }

  // `/Users/...` etc — first segment isn't a clean identifier (it
  // contains a `/`, a digit-leading start, or other punctuation).
  // Note: `firstWord` here cannot contain whitespace (we sliced at
  // the first whitespace). It CAN contain `/` — e.g. `Users/foo`
  // when the user typed `/Users/foo`. CLEAN_IDENT_RE rejects that.
  const isCleanIdent = CLEAN_IDENT_RE.test(firstWord);
  if (!isCleanIdent) {
    return { kind: 'text', text };
  }

  // Clean identifier first word. Try the registry first — if it's a
  // known command, dispatch with whatever args follow (paths, urls,
  // anything goes in args).
  const needle = firstWord.toLowerCase();
  const known = registry.some((c) => c.name.toLowerCase() === needle);
  if (known) {
    return { kind: 'command', name: firstWord, args };
  }

  // Unknown but clean-ident first word. If the remainder of the input
  // contains another `/`, this is almost certainly a path rather than
  // a typo'd command. Forward as text so the LLM sees it.
  // Important: `rest` here is everything after the leading `/`. We
  // already know `firstWord` itself has no `/` (clean ident). So if
  // `rest` contains a `/` it must be in the args portion.
  if (rest.includes('/')) {
    return { kind: 'text', text };
  }

  // Single-segment unknown command (`/foo`, `/help-typo`). Dispatch
  // so the unknown-command echo prints a hint. Edge case: `/usr` will
  // also fall through here and get an "Unknown command" message —
  // that's acceptable and consistent with R4 behaviour.
  return { kind: 'command', name: firstWord, args };
}

// TODO: centralize input dispatch. We currently host 5 sibling
// `useInput` handlers (this screen's Esc + Ctrl+R/X handlers, plus
// InputBar, SlashMenu, ApprovalPrompt, DiffView). Each is gated by
// its own `isActive` flag (H1 / M7) which works, but a single
// top-level dispatcher that routes keystrokes based on the active
// mode (`approval | overlay | input`) would eliminate the entire
// class of keystroke-leak bugs by construction rather than by
// individual gates. Out of scope for the v1 audit fix; revisit if
// the gate pattern starts drifting.
function ChatScreen({
  config,
  projectRoot,
  sessionId,
  messages,
  toolCallStates,
  isStreaming,
  currentOutput,
  pendingApproval,
  thinkingStartedAt,
  contextPercent,
  slashCommands,
  onSubmit,
  onApprove,
  onReject,
  onApproveAllInTurn,
  onApproveForSession,
  onSlashExecute,
  onCancel,
  skillOverlay = false,
  onSkillSubmit,
  onSkillCancel,
  modelName,
  sessionTotalOut,
  overlay,
  locale,
  currentThinking,
  responseTimeoutSeconds,
  onBashExecute,
  lastTurnError,
  onClearTurnError,
  pendingQueue: pendingQueueProp,
  onEnqueuePending,
  onClearPending,
  todos,
  // AGENT-PANEL-SECTION (Wave 5A — TA team)
  agentWorkers,
  leadStreaming = false,
  currentConversant = 'lead',
  agentFocusMode = false,
  agentSelectedIdx = 0,
  onAgentFocusEnter,
  onAgentFocusExit,
  onAgentSelectNext,
  onAgentSelectPrev,
  onAgentAttach,
  onAgentDetach,
  // OUTPUT-FILTER-SECTION — start
  outputFilters,
  onCycleOutputFilter,
  // OUTPUT-FILTER-SECTION — end
  // READING-MODE-SECTION — start
  readingMode = false,
  onToggleReadingMode,
  // READING-MODE-SECTION — end
  // BRANCHES-MOUNT-SECTION (destructure)
  branchChain,
  onOpenBranchPicker,
  // BRANCHES-MOUNT-SECTION (destructure end)
  // SUGGEST-MOUNT-SECTION (Wave 6B)
  suggestEnabled,
  // VIM-INDICATOR-MOUNT-SECTION (Wave 6B)
  vimMode,
  // AGENT-TAIL-RENDER-SECTION (Wave 6B)
  agentTailEntries,
  // SNIPPET-MODE-MOUNT-SECTION (Wave 6B)
  snippetRing,
  // MODEL-SWAP-MOUNT-SECTION (Wave 6B)
  onOpenModelSwap,
  // PROACTIVE-MOUNT-SECTION (Wave 6D)
  proactiveSuggestion,
  proactivePanelVisible = true,
  // PROACTIVE-MOUNT-SECTION-END
  // COST-FORECAST-SECTION (destructure)
  nextTurnEstimateUsd,
  nextTurnEstimateUnknown,
  // COST-FORECAST-SECTION (destructure end)
  // COST-FOOTER-PROPS-SECTION (destructure)
  sessionCostUsd,
  todayCostUsd,
  // COST-FOOTER-PROPS-SECTION (destructure end)
}: ChatScreenProps): React.JSX.Element {
  // LOCALE-APPLY-SECTION — surface strings come from the active locale
  // via `useT()`. Re-renders automatically when the parent's
  // `LocaleProvider` value flips, so `/language ru` updates the empty-
  // state hint and queue banners without unmounting ChatScreen.
  const { t } = useT();
  // LOCALE-APPLY-SECTION-END

  // OUTPUT-FILTER-SECTION — start
  // Resolved filter snapshot — when no prop passed, default to "all
  // categories visible" (legacy behaviour for any caller / test that
  // doesn't yet plumb the slice).
  const resolvedFilters = useMemo(
    () => ({
      thinking: outputFilters?.thinking ?? true,
      toolCalls: outputFilters?.toolCalls ?? true,
      systemNotes: outputFilters?.systemNotes ?? true,
    }),
    [outputFilters?.thinking, outputFilters?.toolCalls, outputFilters?.systemNotes],
  );
  // OUTPUT-FILTER-SECTION — end
  // AGENT-PANEL-SECTION (Wave 5A) — track terminal columns for the
  // panel's narrow-terminal preview fallback (<60 cols drops the
  // last-message preview).
  const termColumns = useTerminalWidth();
  const [draft, setDraft] = useState<string>('');

  // TOC-SECTION + TIMELINE-SECTION + SEARCH-SECTION (Wave 6B) — local
  // navigation state. All three default to OFF so casual users still
  // see the un-cluttered chat surface; opt-in via Ctrl+T / Ctrl+Y /
  // Ctrl+F. The state lives here (and not in the reducer) because it
  // is purely view-state: no persistence, no cross-component impact.
  const [tocVisible, setTocVisible] = useState<boolean>(false);
  const [tocSelectedIdx, setTocSelectedIdx] = useState<number>(0);
  const [timelineVisible, setTimelineVisible] = useState<boolean>(false);
  const [timelineCursor, setTimelineCursor] = useState<number>(-1);
  const [searchVisible, setSearchVisible] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchCursor, setSearchCursor] = useState<number>(-1);
  // WATCH-PANEL-MOUNT-SECTION — live snapshot of `ProcessMonitor`
  // entries. Subscribes to the monitor's `output` / `exit` events
  // (which fire whenever a watched child emits a line or terminates)
  // and re-snaps the registry. The panel itself renders nothing when
  // the list is empty so this is zero-cost for users who never call
  // `/watch`. The wall-clock "duration" timer ticks every second via
  // a separate interval so the running label stays live even when no
  // event has fired recently.
  const [watchedProcesses, setWatchedProcesses] = useState<
    readonly WatchedProcess[]
  >(() => getProcessMonitor().list());
  useEffect(() => {
    const monitor = getProcessMonitor();
    const refresh = (): void => {
      setWatchedProcesses(monitor.list());
    };
    monitor.on('output', refresh);
    monitor.on('exit', refresh);
    // Initial sync — covers the case where a watch was registered
    // before this effect ran (e.g. via the slash command during the
    // first render frame).
    refresh();
    // 1 Hz tick for the duration label. Cheap — just rebuilds the
    // snapshot from the same in-memory map; React diffs the result.
    const interval = setInterval(refresh, 1000);
    return () => {
      monitor.off('output', refresh);
      monitor.off('exit', refresh);
      clearInterval(interval);
    };
  }, []);
  // WATCH-PANEL-MOUNT-SECTION-END
  // M2 — `inputKey` is now ONLY bumped on overlay-close, where we need
  // to force ink to fully unmount→remount the InputBar so it repaints
  // the row immediately (without this the InputBar stays invisible
  // until the user types something). All the other reset paths
  // (submit success, slash-cancel, bash dispatch, etc.) bump
  // `resetTrigger` instead, which clears the editor state in place
  // via a `useEffect` inside InputBar — no churn, no relayout.
  const [inputKey, setInputKey] = useState<number>(0);
  const [resetTrigger, setResetTrigger] = useState<number>(0);
  const bumpResetTrigger = useCallback(() => {
    setResetTrigger((n) => n + 1);
  }, []);

  // SELECTION-CURSOR-SECTION (Wave 6B / snippet mode) — view-state only.
  // The currently focused chat-message row used by the selection cursor
  // and agent-tail navigation. -1 means "nothing focused yet". The host
  // does NOT persist this — it's transient view chrome.
  const [selectionCursor, setSelectionCursor] = useState<number>(-1);
  const [selectionAnchor, setSelectionAnchor] = useState<number>(-1);
  // SNIPPET-MODE-MOUNT-SECTION + MODEL-SWAP-MOUNT-SECTION — local flags
  // for the snippet selection mode and the model-swap mode. Lifted to
  // this section so all keystroke handlers below can reference them.
  const [snippetSelectActive, setSnippetSelectActive] = useState<boolean>(false);
  const [modelSwapActive, setModelSwapActive] = useState<boolean>(false);
  // Reset selection anchor when leaving select mode.
  useEffect(() => {
    if (!snippetSelectActive) {
      setSelectionAnchor(-1);
    }
  }, [snippetSelectActive]);

  // AGENT-TAIL-RENDER-SECTION — index of the inline-agent block that
  // currently owns Enter/Right in 'agent-tail' mode + per-entry expand
  // state. Drives the `focused` and `expanded` props passed into
  // <AgentInlineMessage>. Lives in component state because the panel
  // is parallel chrome (display only) — the agent-tail-store is a
  // pure source of truth and never mutates focus/expansion.
  const [agentTailFocusIdx, setAgentTailFocusIdx] = useState<number>(0);
  const [agentTailExpanded, setAgentTailExpanded] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  const [agentTailVisible, setAgentTailVisible] = useState<boolean>(false);

  // SUGGEST-MOUNT-SECTION — local "user toggled /suggest off" override.
  // Defaults to the `suggestEnabled` prop when supplied; otherwise true.
  const [suggestOnLocal, setSuggestOnLocal] = useState<boolean>(
    suggestEnabled ?? true,
  );
  useEffect(() => {
    if (typeof suggestEnabled === 'boolean') setSuggestOnLocal(suggestEnabled);
  }, [suggestEnabled]);

  /**
   * R23/R24/R25 (Agent 4) — streaming output throttle (leading + trailing).
   *
   * Background (R23): bind `<StreamOutput text={currentOutput} />`
   * directly to the reducer-owned `currentOutput` and ink repaints the
   * dynamic Box on every SSE delta — ~20Hz with the 50ms inter-chunk
   * cadence of LM Studio. Combined with the 80ms spinner tick and
   * 500ms thinking-dot tick, that flickers heavily on code-heavy
   * answers (long lines + frequent newlines amplify the redraw cost).
   *
   * R23 added a trailing 100ms throttle: a `setTimeout` deferred each
   * commit by 100ms. That smoothed out flicker — but it ALSO delayed
   * the FIRST chunk by 100ms, which on top of the model's own warm-up
   * latency (LM Studio routinely takes 1–3s to begin emitting tokens)
   * produced a perceived "frozen terminal" UX: the user hit Enter and
   * stared at a blank dynamic area until the throttle fired. The
   * spinner did mount immediately, but the visible-output band stayed
   * empty for the full warm-up + 100ms throttle, which read as "stuck".
   *
   * R24 fix: switch to LEADING + TRAILING throttle.
   *   - First chunk after an idle gap (≥THROTTLE_MS since last commit) →
   *     render IMMEDIATELY. The first visible token reaches the screen
   *     with zero added latency, so the user sees the model "wake up"
   *     the moment it actually does.
   *   - Subsequent chunks within the throttle window → coalesce. A single
   *     trailing timer commits the latest pending text at the window
   *     boundary, so a burst of 5 chunks in 50ms still produces one
   *     paint instead of five.
   *   - After the trailing fire, the next chunk arriving ≥THROTTLE_MS later
   *     again counts as a leading edge → renders immediately.
   *
   * R25 tuning: bumped the trailing window from 100ms to 150ms.
   * Users running the CLI on TTYs that buffer ANSI sequences poorly
   * (e.g. macOS Terminal.app, certain SSH multiplexers) reported a
   * jittery feel during code-block streams — long lines + frequent
   * newlines + 10Hz repaint added up to a "snowy" rerender. Dropping
   * the rate to ~6.7Hz quiets the layout without holding any tokens
   * back: the throttle never DROPS chunks, it only delays them by at
   * most one window, and the next leading edge still flushes the
   * latest pending text in a single paint. We also fast-path
   * line-boundary commits: if the new chunk introduces a `\n`, flush
   * immediately so the terminal advances cleanly line-by-line and
   * code blocks render with their natural cadence (one row at a time)
   * rather than appearing in 150ms gulps.
   *
   * Net result: peak mid-stream repaint rate is ~6.7Hz (down from
   * ~10Hz in R24), the initial-paint latency is still bounded by SSE
   * arrival time, and visible newlines never sit in the throttle
   * buffer.
   *
   * Edge cases (unchanged from R23):
   *   - Stream end: `isStreaming` flips false → flush IMMEDIATELY so
   *     the final chunk isn't dropped before `chat-state.ts:
   *     END_STREAM` clears `currentOutput`. We also clear any pending
   *     trailing timer to avoid a no-op fire after unmount.
   *   - Stream start: `START_STREAM` resets `currentOutput` to ''. We
   *     match by syncing `renderedOutput` to '' so a stale tail from
   *     the previous turn doesn't flash onto the next response.
   *   - `lastRenderRef` is reset on stream end so the next stream's
   *     first chunk always hits the leading-edge fast path (otherwise
   *     a fast follow-up turn within THROTTLE_MS of the previous flush
   *     would briefly trail through the throttle path).
   */
  const STREAM_THROTTLE_MS = 150;
  const [renderedOutput, setRenderedOutput] = useState<string>('');
  const pendingOutputRef = useRef<string>('');
  const lastRenderRef = useRef<number>(0);
  const lastRenderedTextRef = useRef<string>('');
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    pendingOutputRef.current = currentOutput;

    // Immediate flush on stream end OR parent-reset (currentOutput
    // cleared). Cancel any pending trailing fire so it can't race the
    // synchronous flush below.
    if (!isStreaming || currentOutput.length === 0) {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      // Reset the leading-edge clock so the NEXT stream's first chunk
      // always hits the immediate path even if it arrives within
      // STREAM_THROTTLE_MS of this flush (e.g. the queued-input drain
      // re-streams quickly).
      lastRenderRef.current = 0;
      lastRenderedTextRef.current = currentOutput;
      setRenderedOutput(currentOutput);
      return undefined;
    }

    const now = Date.now();
    const elapsed = now - lastRenderRef.current;

    // R25 — line-boundary fast path. If the unrendered tail of the
    // pending output contains a newline, flush immediately so the
    // terminal advances cleanly row-by-row. Code blocks especially
    // benefit: the user sees each line land on its own paint instead
    // of waiting for the throttle window to close. Cheap to compute
    // (we only inspect the delta, not the whole buffer) and bounded
    // because the delta is at most one SSE chunk.
    const lastRendered = lastRenderedTextRef.current;
    const hasNewlineInDelta =
      currentOutput.length > lastRendered.length &&
      currentOutput.startsWith(lastRendered) &&
      currentOutput.indexOf('\n', lastRendered.length) !== -1;
    if (hasNewlineInDelta) {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      lastRenderRef.current = now;
      lastRenderedTextRef.current = currentOutput;
      setRenderedOutput(currentOutput);
      return undefined;
    }

    // Leading edge — first chunk after the idle window renders right
    // away. Also covers the very first chunk of a fresh stream, since
    // `lastRenderRef.current === 0` makes `elapsed` huge.
    if (elapsed >= STREAM_THROTTLE_MS) {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      lastRenderRef.current = now;
      lastRenderedTextRef.current = currentOutput;
      setRenderedOutput(currentOutput);
      return undefined;
    }

    // Trailing edge — schedule the next commit at the throttle
    // boundary. If a timer is already armed, leave it: it will fire
    // at the right moment and pick up the latest
    // `pendingOutputRef.current` value.
    if (pendingTimerRef.current === null) {
      pendingTimerRef.current = setTimeout(() => {
        lastRenderRef.current = Date.now();
        lastRenderedTextRef.current = pendingOutputRef.current;
        pendingTimerRef.current = null;
        setRenderedOutput(pendingOutputRef.current);
      }, STREAM_THROTTLE_MS - elapsed);
    }
    return undefined;
  }, [currentOutput, isStreaming]);

  // Mount-only cleanup: clear any in-flight trailing-edge timer when
  // the screen unmounts. The main throttle effect deliberately doesn't
  // clear-on-rerun (we WANT pending timers to persist across rapid
  // chunk-driven reruns so the trailing fire still happens), so this
  // sibling effect handles the unmount case.
  useEffect(() => {
    return () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, []);

  /**
   * User submission history, oldest → newest. Fed to InputBar for the
   * ↑/↓ navigation (Task 9).
   *
   * M4 — collapsed the ref+state pair into a single useState +
   * functional-updater pattern. The old ref existed so two synchronous
   * pushes in the same render tick couldn't lose the second entry —
   * but `setHistory(prev => [...prev, payload])` gives us the same
   * guarantee while halving the bookkeeping.
   */
  const [history, setHistory] = useState<readonly string[]>([]);

  /**
   * Queue of messages the user typed while streaming (Task 6 / R-typeahead).
   *
   * Single source of truth lives in the reducer
   * (`chatState.pendingQueue`) and reaches us via the `pendingQueue`
   * prop. ChatScreen owns NO local mirror — enqueue + clear flow back
   * to the host via `onEnqueuePending` / `onClearPending`.
   *
   * Flush policy: when `isStreaming` flips false (and no approval is
   * pending AND no `lastTurnError` is set), we concatenate the entire
   * queue with `\n\n`, dispatch `onClearPending()`, then dispatch ONE
   * `onSubmit(...)` call. The model sees the type-ahead as a single
   * combined turn, mirroring Claude Code's behaviour.
   *
   * The empty-array fallback keeps unit tests and any pre-prop callers
   * working: with no queue prop the screen behaves exactly as before.
   */
  const pendingQueue = pendingQueueProp ?? EMPTY_QUEUE;
  /**
   * Re-entrancy guard for the flush effect. The queue can be drained at
   * most once per (isStreaming → false) transition; flipping this back
   * to false on the next streaming start re-arms the next flush. Stops
   * a second `done` event (or a fast prop oscillation) from re-firing
   * `onSubmit` with the same concatenated text.
   */
  const flushedRef = useRef<boolean>(false);
  /**
   * Transient toast surface for queue-related status lines.
   *
   *   - "Queued — will send after current turn" on enqueue.
   *   - "Answer the approval prompt first" on enqueue blocked by
   *     pendingApproval.
   *
   * We use ephemeral local state (cleared on a 2.5s timer) instead of
   * pushing into the chat-message log because that would require
   * crossing the parent boundary (app.tsx owns Message dispatch) and
   * the message would then persist in scrollback. A short toast is the
   * lighter touch.
   */
  const [queueToast, setQueueToast] = useState<string | null>(null);
  const queueToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M9 — track the screen's mount state so a deferred toast clear
  // can't fire `setQueueToast(null)` against an unmounted tree (which
  // would throw "Can't perform a React state update on an unmounted
  // component"). We flip this on the cleanup of an effect below.
  const isMountedRef = useRef<boolean>(true);
  const showQueueToast = useCallback((text: string): void => {
    setQueueToast(text);
    if (queueToastTimerRef.current !== null) {
      clearTimeout(queueToastTimerRef.current);
    }
    queueToastTimerRef.current = setTimeout(() => {
      queueToastTimerRef.current = null;
      // Short-circuit when the screen has gone away mid-timer.
      if (!isMountedRef.current) return;
      setQueueToast(null);
    }, 2500);
  }, []);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (queueToastTimerRef.current !== null) {
        clearTimeout(queueToastTimerRef.current);
        queueToastTimerRef.current = null;
      }
    };
  }, []);
  /**
   * Two-press Esc-to-clear-queue tracker. First Esc cancels the
   * stream as today; a second Esc within ESC_DOUBLE_PRESS_MS ALSO
   * clears the pending queue (so the user can abort a runaway turn
   * without sending the type-ahead they regret). Single Esc keeps the
   * queue intact, matching the task spec.
   */
  const ESC_DOUBLE_PRESS_MS = 1500;
  const lastEscAtRef = useRef<number>(0);

  const overlayActive = overlay !== undefined || skillOverlay;

  /**
   * R23 (Agent 4) — BUG 1 FIX (overlay close → InputBar restore).
   *
   * When an overlay (e.g. `/ctxsize`) closes, the conditional render
   * below switches from `<OverlayRenderer>` back to the InputBar row.
   * Ink's terminal-cursor model leaves stale rows where the overlay
   * was painted: the InputBar mounts but ink doesn't repaint the
   * area until the next state change (e.g. the user starts typing).
   * The user perceives this as "the InputBar disappeared" until they
   * hit a key.
   *
   * Fix: bump `inputKey` whenever `overlayActive` flips from true →
   * false. The `key` prop change forces InputBar (which already
   * keys on `inputKey`) to fully unmount → remount, which forces
   * ink to repaint the row immediately. We also reset the draft so
   * stale text from a previous open isn't accidentally restored.
   *
   * We intentionally do NOT bump on overlay OPEN — when an overlay
   * mounts it owns input, so the soon-to-be-hidden InputBar doesn't
   * need a remount. Only the close transition matters.
   */
  const prevOverlayActiveRef = useRef<boolean>(overlayActive);
  useEffect(() => {
    if (prevOverlayActiveRef.current && !overlayActive) {
      // Overlay just closed — force a fresh InputBar render so ink
      // repaints the row immediately rather than waiting for the
      // next keystroke.
      setInputKey((k) => k + 1);
    }
    prevOverlayActiveRef.current = overlayActive;
  }, [overlayActive]);
  // The slash autocomplete menu opens only for drafts that look like a
  // command being typed: a single `/`, or `/<clean-ident>` with no
  // further `/` characters in the draft. `//` is the documented
  // literal-text escape hatch and is excluded. R6: paths like
  // `/Users/foo` no longer pop the menu — the first segment after `/`
  // must be a clean identifier AND the draft must not already contain
  // a path separator beyond it.
  const slashMenuOpen = useMemo(() => {
    if (overlayActive) return false;
    if (pendingApproval !== null) return false;
    if (!draft.startsWith('/')) return false;
    if (draft.startsWith('//')) return false;
    const after = draft.slice(1);
    // Bare `/` — show full command list as the user types.
    if (after.length === 0) return true;
    const spaceIdx = after.search(/\s/);
    const firstWord = spaceIdx === -1 ? after : after.slice(0, spaceIdx);
    if (!CLEAN_IDENT_RE.test(firstWord)) return false;
    // If the user has already typed another `/` later in the draft
    // (e.g. `/Users/foo` or `/permissions add /etc/x`) — keep the menu
    // open ONLY when the first word matches a registered command, so
    // path pastes don't show "No commands match" but real command
    // continuations still autocomplete.
    if (after.includes('/')) {
      const needle = firstWord.toLowerCase();
      return slashCommands.some((c) => c.name.toLowerCase() === needle);
    }
    return true;
  }, [draft, overlayActive, pendingApproval, slashCommands]);

  // Re-arm the flush guard whenever a fresh stream starts. Without
  // this, a flush that triggers its own stream would still see
  // `flushedRef.current === true` after that stream ended and skip the
  // next legitimate type-ahead drain.
  useEffect(() => {
    if (isStreaming) {
      flushedRef.current = false;
    }
  }, [isStreaming]);

  /**
   * Type-ahead-while-busy flush. When the streaming gate opens AND no
   * approval is pending AND the queue has content, concatenate the
   * entire queue with `\n\n` (so the items read as separate paragraphs
   * to the model) and submit as a single turn. We then `CLEAR` locally
   * so the next user input starts from an empty queue.
   *
   * Double-flush guard: `flushedRef` blocks a second invocation within
   * the same gate-open window; it resets on the next stream start.
   *
   * Esc-cancel semantics: when the user hits Esc, the parent flips
   * `isStreaming` to false via its own cancel path (`done` SSE event).
   * That triggers this effect just like a natural stream end, so the
   * queue still flushes — matching the spec ("user may want to cancel
   * a runaway turn but still send their typed-ahead text"). Double-Esc
   * within ESC_DOUBLE_PRESS_MS clears the queue BEFORE this effect
   * runs (see the useInput handler), which suppresses the flush.
   */
  useEffect(() => {
    if (isStreaming) return;
    if (pendingApproval !== null) return;
    if (pendingQueue.length === 0) return;
    if (flushedRef.current) return;
    // Fix 2 (type-ahead error gate): a failed turn pauses the
    // auto-flush so we don't fan a single transient error into a
    // toast spam. The user has to press Retry / Discard / send a new
    // message to resume.
    if (lastTurnError !== null && lastTurnError !== undefined) return;

    flushedRef.current = true;
    const concatenated = pendingQueue.join('\n\n');
    // Clear the reducer-owned queue BEFORE onSubmit so the next
    // streaming-time enqueue starts from an empty slice. The host
    // dispatches `CLEAR_PENDING` synchronously, which means the next
    // ChatScreen render observes `pendingQueue.length === 0` and the
    // flush guard re-arms cleanly on the next stream start.
    if (onClearPending !== undefined) onClearPending();
    // M4 — functional updater; no extra ref required.
    setHistory((prev) => [...prev, concatenated]);
    onSubmit(concatenated);
  }, [isStreaming, lastTurnError, onClearPending, onSubmit, pendingApproval, pendingQueue]);

  const submit = useCallback(
    (rawText: string) => {
      // SNIPPET-MODE-MOUNT-SECTION — expand `@clip-N` references against
      // the snippet ring before any classification or routing. Unknown
      // ids pass through verbatim so typos remain visible to the user.
      const ring = snippetRing ?? getSnippetRing();
      const { text: expanded } = expandClipReferences(rawText, ring);
      const text = expanded.trim();
      if (text.length === 0) return;

      // R6 (Agent 8) — slash-routing classification. The R4 fix was too
      // aggressive: ANY input starting with a single `/` was intercepted
      // as a slash command, which broke the natural workflow of pasting
      // a macOS path (`/Users/foo/screenshot.png`), a Linux log path
      // (`/var/log/system.log`), or any other file/URL beginning with
      // `/`. The user expected the model to see those literally so the
      // `fetch_image` (or analogous) tool could pick them up.
      //
      // The new contract:
      //   1. `//literal text` is the explicit escape — strip ONE
      //      leading slash, treat the rest as text, send to the model.
      //   2. A bare `/` or `/<simple-ident>[ args]` is a command:
      //      the first segment after `/` matches `[a-zA-Z][a-zA-Z0-9_-]*`
      //      AND there are no more `/` characters in the input (or the
      //      ident IS a registered command, in which case args may
      //      contain slashes — `/permissions add /etc/foo`).
      //   3. Anything else (`/Users/foo`, `/var/log`, `/usr/local/bin`,
      //      `/123abc`, …) is treated as plain text and forwarded to
      //      the LLM. Pastes win. Path-shaped input is no longer
      //      eaten by the slash router.
      const decision = classifySubmit(text, slashCommands);

      // R20 (Agent 4) — Bash mode: forward the command body to the
      // host's `onBashExecute` callback (Agent 8 R17 will hook this
      // up to `execa`). When the host hasn't supplied the callback
      // (e.g. unit tests, or older app.tsx revisions), we fall
      // through to the text path — `payload` keeps the literal `!`
      // prefix so the message is recognisable. This matches the
      // graceful-degradation strategy used elsewhere in this
      // component (skill overlay, slash overlays).
      if (decision.kind === 'bash') {
        if (onBashExecute !== undefined) {
          onBashExecute(decision.command);
          setDraft('');
          bumpResetTrigger();
          return;
        }
        // Fall through: rebuild a text-shaped decision so the rest
        // of the handler runs unchanged. We send the original `!cmd`
        // verbatim — the model can decide what to do with it.
      }

      if (decision.kind === 'command') {
        // Duplicate-dispatch guard: when the SlashMenu autocomplete is
        // open and at least one command matches the typed prefix, the
        // menu's own Enter handler (`handleSlashSelect`) has already
        // dispatched on this very keystroke. The InputBar's TextInput
        // also fires onSubmit for the same Enter, which is what brought
        // us here — we must short-circuit so the command doesn't run
        // twice (e.g. opening + immediately reopening an overlay, or
        // re-applying a config write). We still clear the draft to
        // keep the input bar in sync.
        const cleanedPrefix = decision.name.toLowerCase();
        const menuHadMatch = slashCommands.some((c) =>
          c.name.toLowerCase().startsWith(cleanedPrefix),
        );
        if (slashMenuOpen && menuHadMatch) {
          setDraft('');
          bumpResetTrigger();
          return;
        }

        // Case-insensitive lookup mirrors SlashRegistry.get(). The
        // registry stores names lower-cased, so `/Permissions` and
        // `/PERMISSIONS` should resolve identically.
        const needle = decision.name.toLowerCase();
        const cmd = slashCommands.find((c) => c.name.toLowerCase() === needle);
        if (cmd !== undefined) {
          onSlashExecute(cmd, decision.args);
        } else {
          // Unknown slash command — render a hint via a synthetic
          // command. We dispatch through `onSlashExecute` so the
          // message lands in the chat log via the parent's `print`
          // helper (the same channel real commands use). This keeps
          // the bug-tracker UX consistent and, critically, stops the
          // input from leaking to `streamChat`.
          const displayName = decision.name.length === 0 ? '/' : `/${decision.name}`;
          const unknown: SlashCommand = {
            name: '__unknown__',
            description: 'Unknown command echo',
            usage: '',
            execute: (_a, ctx) => {
              ctx.print(
                `Unknown command: ${displayName}. Type /help for the list.`,
              );
            },
          };
          onSlashExecute(unknown, decision.args);
        }
        setDraft('');
        bumpResetTrigger();
        return;
      }

      // Anything that reaches this point forwards to the LLM. The
      // discriminants we still need to flatten:
      //   - `literal-slash` (`//foo` → `/foo`) — already stripped.
      //   - `literal-bang`  (`!!foo` → `!foo`) — already stripped.
      //   - `text`          — verbatim.
      //   - `bash` (no callback wired) — fall back to verbatim text
      //     so the user's draft isn't silently dropped.
      const payload =
        decision.kind === 'bash' ? `!${decision.command}` : decision.text;

      // Non-blocking submit (Task 6 / R-typeahead): while streaming,
      // enqueue locally instead of dispatching to onSubmit. The flush
      // effect will concatenate and send when the stream ends.
      //
      // pendingApproval blocks enqueueing entirely — the user MUST
      // answer y/n first. We surface a transient toast so the keypress
      // isn't silently dropped.
      if (pendingApproval !== null) {
        showQueueToast(t('chat.toast.answerApprovalFirst'));
        // Keep the draft so the user can retry after answering.
        return;
      }
      if (isStreaming) {
        // The reducer's `ENQUEUE_PENDING` rejects whitespace-only
        // entries; we mirror that guard here so the toast doesn't
        // promise queueing for an input that won't be queued.
        if (payload.trim().length === 0) {
          setDraft('');
          bumpResetTrigger();
          return;
        }
        // Single source of truth: dispatch upward instead of writing a
        // local mirror. The host (`app.tsx`) translates this into a
        // `chatDispatch({ type: 'ENQUEUE_PENDING', text: payload })`.
        if (onEnqueuePending !== undefined) onEnqueuePending(payload);
        showQueueToast(t('chat.toast.queued'));
        setDraft('');
        bumpResetTrigger();
        return;
      }

      // M4 — functional updater replaces the historyRef pair.
      setHistory((prev) => [...prev, payload]);
      onSubmit(payload);
      setDraft('');
      bumpResetTrigger();
    },
    [
      bumpResetTrigger,
      isStreaming,
      onBashExecute,
      onEnqueuePending,
      onSlashExecute,
      onSubmit,
      pendingApproval,
      showQueueToast,
      slashCommands,
      slashMenuOpen,
      snippetRing,
    ],
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      const parts = draft.slice(1).split(/\s+/);
      const rest = parts.slice(1).join(' ');
      onSlashExecute(cmd, rest);
      setDraft('');
      bumpResetTrigger();
    },
    [bumpResetTrigger, draft, onSlashExecute],
  );

  const handleSlashCancel = useCallback(() => {
    setDraft('');
    bumpResetTrigger();
  }, [bumpResetTrigger]);

  // Fix 2 (type-ahead error gate): when the queue is paused due to a
  // failed turn, Ctrl+R retries (clears the error → flush effect
  // drains the queue), Ctrl+X discards (clears queue + error). Slash
  // commands and bash inputs always bypass the queue, so /model,
  // /provider etc. keep working with the queue paused.
  // Migrated to InputDispatcher: subscribes for mode='input'. The
  // dispatcher only fires when overlayActive=false AND pendingApproval
  // is null (those flip the mode to 'overlay'/'approval'), so the
  // earlier defensive bails are redundant — kept for belt-and-braces.
  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (lastTurnError === null || lastTurnError === undefined) return;
        if (!key.ctrl) return;
        if (input === 'r') {
          if (onClearTurnError) onClearTurnError();
          showQueueToast('Retrying queued messages…');
          return true;
        }
        if (input === 'x') {
          if (onClearPending !== undefined) onClearPending();
          if (onClearTurnError) onClearTurnError();
          showQueueToast('Discarded queued messages');
          return true;
        }
      },
      [lastTurnError, onClearPending, onClearTurnError, showQueueToast],
    ),
  );

  // AGENT-PANEL-SECTION (Wave 5A — TA team)
  // Tab in normal input mode -> enter agent-focus IF there are workers
  // to navigate. Without workers there's nothing to attach to so Tab is
  // a no-op (we deliberately don't intercept it so future Tab-based
  // features can claim it). Once in agent-focus, ↑/↓ select, Enter
  // attaches, Tab or Esc exits without committing.
  const workerCount = agentWorkers?.length ?? 0;
  useInputModeHandler(
    'input',
    useCallback(
      ({ key }) => {
        if (!key.tab) return;
        if (workerCount <= 0) return;
        if (onAgentFocusEnter !== undefined) onAgentFocusEnter();
        return true;
      },
      [workerCount, onAgentFocusEnter],
    ),
  );
  // Esc while attached to a worker (but NOT in focus mode) returns to
  // the lead. We only handle this when the lead isn't actively
  // streaming — Esc-during-stream still triggers cancel via the
  // streaming handler below (which runs first in the LIFO walk because
  // this handler is mounted earlier).
  useInputModeHandler(
    'input',
    useCallback(
      ({ key }) => {
        if (!key.escape) return;
        if (currentConversant === 'lead') return;
        if (isStreaming) return; // let stream-cancel handler win
        if (onAgentDetach !== undefined) onAgentDetach();
        return true;
      },
      [currentConversant, isStreaming, onAgentDetach],
    ),
  );
  // Agent-focus mode handlers — own ↑/↓/Enter/Tab/Esc.
  useInputModeHandler(
    'agent-focus',
    useCallback(
      ({ key }) => {
        if (key.upArrow) {
          if (onAgentSelectPrev !== undefined) onAgentSelectPrev();
          return true;
        }
        if (key.downArrow) {
          if (onAgentSelectNext !== undefined) onAgentSelectNext();
          return true;
        }
        if (key.return) {
          if (
            workerCount > 0 &&
            agentSelectedIdx >= 0 &&
            agentSelectedIdx < workerCount &&
            onAgentAttach !== undefined
          ) {
            const target = agentWorkers?.[agentSelectedIdx];
            if (target !== undefined) onAgentAttach(target.agentId);
          }
          return true;
        }
        if (key.tab || key.escape) {
          if (onAgentFocusExit !== undefined) onAgentFocusExit();
          return true;
        }
        return undefined;
      },
      [
        agentSelectedIdx,
        agentWorkers,
        onAgentAttach,
        onAgentFocusExit,
        onAgentSelectNext,
        onAgentSelectPrev,
        workerCount,
      ],
    ),
  );

  // ESC-CANCEL-SECTION — start
  // Top-level: Esc-to-cancel while streaming (and no overlay is
  // competing for input). Double-Esc within ESC_DOUBLE_PRESS_MS also
  // clears the pending queue so the user can drop typed-ahead text
  // they regret. Single Esc keeps the queue intact (the flush will
  // still run on the cancel-driven `done` event).
  //
  // BUG FIX (Wave 8C): On Esc-cancel we ALSO restore the last user
  // message into the InputBar so the user can edit/re-send without
  // retyping. This requires:
  //   1) Reading `messages` via a ref to avoid re-subscribing the
  //      handler on every message append (and to avoid a stale
  //      closure binding to an old `messages` snapshot).
  //   2) Calling `setDraft(lastUserText)` — but InputBar OWNS its
  //      buffer once mounted and ignores `value` prop changes. So we
  //      ALSO bump `inputKey` to force a fresh InputBar mount that
  //      hydrates `value={draft}` as the initial editor state.
  //
  // After cancel the parent's `done` SSE handler flips `isStreaming`
  // false, so the runtime is immediately available for the next turn —
  // no extra reset needed here (mirrors the X5 disconnect-recovery
  // invariant: a cancel must NEVER leave the runtime wedged).
  //
  // Migrated to InputDispatcher: dispatcher only routes to mode='input'
  // when neither overlay nor approval prompt owns input, so the
  // earlier defensive bails are redundant.
  //
  // `messagesRef` keeps a live reference to the latest messages array
  // so the Esc handler can scan for the last user message WITHOUT
  // adding `messages` to its useCallback deps (which would tear down
  // and re-create the dispatcher subscription on every chunk arrival).
  const messagesRef = useRef<readonly Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useInputModeHandler(
    'input',
    useCallback(
      ({ key }) => {
        if (!key.escape) return;

        const now = Date.now();
        const sinceLast = now - lastEscAtRef.current;
        const isDoublePress =
          lastEscAtRef.current !== 0 && sinceLast <= ESC_DOUBLE_PRESS_MS;

        if (isDoublePress && pendingQueue.length > 0) {
          if (onClearPending !== undefined) onClearPending();
          showQueueToast('Cleared queued messages');
          lastEscAtRef.current = 0;
        } else {
          lastEscAtRef.current = now;
        }

        if (isStreaming) {
          onCancel();
          // Bug 2 — restore the most-recent user message into the
          // composer so the user can edit/re-send without retyping.
          // We scan messagesRef backwards for `role === 'user'`. Skip
          // when no user message exists yet (cancelling the very first
          // turn before submit — defensive; in practice unreachable).
          const snapshot = messagesRef.current;
          let restoreText: string | null = null;
          for (let i = snapshot.length - 1; i >= 0; i--) {
            const m = snapshot[i];
            if (m !== undefined && m.role === 'user') {
              const c = m.content;
              if (typeof c === 'string') restoreText = c;
              break;
            }
          }
          if (restoreText !== null && restoreText.length > 0) {
            setDraft(restoreText);
            // Force InputBar to remount so it re-hydrates from the new
            // `value` prop (InputBar owns its buffer once mounted and
            // ignores `value` updates — see InputBar.tsx line ~1186).
            setInputKey((k) => k + 1);
          }
        }
        return true;
      },
      [
        isStreaming,
        onCancel,
        onClearPending,
        pendingQueue.length,
        showQueueToast,
      ],
    ),
  );
  // ESC-CANCEL-SECTION — end

  const header = useMemo(
    () => (
      <Header
        model={config.model.current}
        contextPercent={contextPercent}
        backend={config.backend.type}
      />
    ),
    [config.backend.type, config.model.current, contextPercent],
  );

  // TOC-SECTION — derive the TOC entry list from user turns. Stable
  // across non-message renders (e.g. streaming chunks), so the memo
  // dependency is just `messages`.
  const tocEntries: readonly ConversationTOCEntry[] = useMemo(
    () => buildTOCEntries(messages),
    [messages],
  );

  // TIMELINE-SECTION — derive the flat event list for the bar.
  const timelineEvents: readonly TimelineEvent[] = useMemo(
    () => buildTimelineEvents(messages),
    [messages],
  );

  // SEARCH-SECTION — compute the flat hit list whenever the visible
  // query changes or messages mutate. An empty query short-circuits
  // to a stable empty array reference (saves the dependent useMemos
  // downstream).
  const searchHits: readonly MessageHit[] = useMemo(() => {
    if (!searchVisible) return [];
    if (searchQuery.trim().length === 0) return [];
    return findMatches(messages, searchQuery);
  }, [messages, searchQuery, searchVisible]);

  // OUTPUT-FILTER-SECTION (Wave 6A2) — Shift+H cycles the output
  // filter. We only intercept the capital-H form (ink reports the
  // shifted key as input='H' with `key.shift` set true on most
  // terminals; some report shift unset but the input letter stays
  // upper-case, so we check the literal character). Skipping when
  // ctrl/meta are pressed keeps the binding from colliding with
  // ctrl-chorded shortcuts.
  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (key.ctrl || key.meta) return;
        if (input !== 'H') return;
        if (onCycleOutputFilter !== undefined) onCycleOutputFilter();
        return true;
      },
      [onCycleOutputFilter],
    ),
  );
  // READING-MODE-SECTION (Wave 6A2) — F (uppercase only — Shift+F)
  // toggles reading mode. Lowercase 'f' is preserved for the SEARCH
  // chord above (Ctrl+F) and as a literal text char in the composer.
  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (key.ctrl || key.meta) return;
        if (input !== 'F') return;
        if (onToggleReadingMode !== undefined) onToggleReadingMode();
        return true;
      },
      [onToggleReadingMode],
    ),
  );

  // CLIPBOARD-PASTE-SECTION
  // `draftRef` mirrors the controlled draft string so the async
  // clipboard handler below can read the latest snapshot without
  // adding `draft` to its useCallback deps (which would re-create the
  // dispatcher subscription on every keystroke — see the comparable
  // `messagesRef` rationale above).
  const draftRef = useRef<string>(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Ctrl+V — capture an image off the system clipboard and route it
  // through the existing image-attach pipeline.
  //
  // Background: terminals do NOT propagate OS clipboard images on a
  // native paste (Cmd+V on macOS / Shift+Insert on Linux) — only text
  // crosses the boundary. So when the user has a screenshot on their
  // clipboard and pastes, the terminal drops the image entirely. To
  // attach it we have to reach OUT to the clipboard ourselves. Ctrl+V
  // is reachable inside the TTY (terminals only intercept the platform-
  // native paste combo, not Ctrl+V), so we own it as the "attach
  // clipboard image" hotkey.
  //
  // Flow:
  //   1. `readClipboardImage()` returns null on every "no image / tool
  //      missing / unsupported platform" case. We surface a short
  //      toast and stop — no other Ctrl+V semantics in this codebase
  //      so falling through silently is fine.
  //   2. On success we write the bytes to
  //      `~/.localcode/clipboard-images/<ts>-<short-id>.<ext>` and
  //      append the absolute path to the current draft.
  //   3. Forcing an InputBar remount via `inputKey` makes InputBar
  //      re-hydrate `value={draft}` as its initial editor state. The
  //      existing bare-path auto-promote (`promoteBareImagePaths`)
  //      then sniffs the file on Enter and substitutes an image
  //      PasteToken — same end-to-end pipeline as a Finder drag-drop.
  //   4. The InputBar's `composeFullText` appends the standard
  //      fetch_image hint when ANY image token is in the composition,
  //      so non-Anthropic models still get the cue.
  //
  // Errors all degrade to a toast — we never crash the composer.
  // Async work happens inside the handler; we ignore the returned
  // promise (the dispatcher signature is sync) and let the chain
  // self-resolve.
  const handleClipboardPaste = useCallback(async (): Promise<void> => {
    let image: Awaited<ReturnType<typeof readClipboardImage>> = null;
    try {
      image = await readClipboardImage();
    } catch {
      image = null;
    }
    if (image === null) {
      // Nothing to attach. Surface a soft toast so the user knows the
      // keystroke landed but the clipboard was empty / unsupported.
      showQueueToast(t('chat.toast.clipboardNoImage'));
      return;
    }
    const dir = path.join(os.homedir(), '.localcode', 'clipboard-images');
    let fullpath: string;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ext = image.mime === 'image/png' ? 'png' : 'jpg';
      const stamp = Date.now();
      // Short id keeps filenames tidy; collisions across same-ms
      // captures are negligible at a human-paced Ctrl+V.
      const id = Math.random().toString(36).slice(2, 10);
      fullpath = path.join(dir, `${stamp}-${id}.${ext}`);
      fs.writeFileSync(fullpath, image.bytes);
    } catch {
      showQueueToast(t('chat.toast.clipboardSaveFailed'));
      return;
    }
    // CLIPBOARD-SUBMIT-SECTION
    // Ctrl+V semantics: "attach the clipboard image AND send the
    // current draft together as one turn". We compose the existing
    // text (`draft`) + the saved file path on its own line, then
    // route through `submit()` exactly as if the user had typed and
    // pressed Enter.
    //
    // Why not just hydrate the InputBar buffer? InputBar deliberately
    // ignores `value` prop updates after mount (it owns its editor
    // state once mounted), so the only way to inject the path into
    // the visible buffer would be a key bump — and `setInputKey` is
    // an approved-sites-only list (see
    // `tests/ui/chatscreen-input-gating.test.ts` M2). Auto-submitting
    // on Ctrl+V gives a clean "attach + send" UX in one keystroke,
    // matches user expectation (Ctrl+V already implies "do the paste
    // action now"), and avoids the inputKey-churn guardrail entirely.
    //
    // `submit()` routes through `classifySubmit` → text branch → the
    // pendingApproval / isStreaming gates → onSubmit. Bare paths flow
    // to the model as text, and `app.tsx` (see the
    // `User pasted an image URL` hint there) recognises image paths
    // and surfaces a `fetch_image` cue to non-vision models.
    const savedPath = fullpath;
    const draftSnapshot = draftRef.current;
    const payload =
      draftSnapshot.trim().length === 0
        ? savedPath
        : `${draftSnapshot}\n${savedPath}`;
    submit(payload);
    // CLIPBOARD-SUBMIT-SECTION-END
    showQueueToast(t('chat.toast.clipboardImageAttached'));
  }, [showQueueToast, submit, t]);

  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (!key.ctrl) return;
        // ink reports Ctrl+V as input === 'v' with key.ctrl set; on
        // some terminals the raw SYN byte (\x16) lands instead.
        // Match either so the binding is robust across emulators.
        if (input !== 'v' && input !== '\x16') return;
        // Fire-and-forget — the dispatcher signature is sync, the
        // clipboard read is async. Errors are swallowed inside the
        // handler so an unhandled rejection can't crash the TUI.
        void handleClipboardPaste();
        return true;
      },
      [handleClipboardPaste],
    ),
  );
  // CLIPBOARD-PASTE-SECTION-END

  // NAV-MODES-SECTION — Ctrl-key handlers for the three navigation
  // aids. All three subscribe to `'input'` mode (the dispatcher will
  // skip them automatically while an overlay or approval prompt owns
  // the screen). Each handler returns `true` so the keystroke is
  // marked consumed and does NOT leak into the composer below.
  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (!key.ctrl) return;
        // Ctrl+T — toggle the conversation TOC.
        if (input === 't') {
          setTocVisible((v) => !v);
          return true;
        }
        // Ctrl+Y — toggle the session timeline.
        if (input === 'y') {
          setTimelineVisible((v) => !v);
          return true;
        }
        // Ctrl+F — open / focus the search bar. Closing happens via
        // Esc from inside the search-active branch below.
        if (input === 'f') {
          setSearchVisible(true);
          setSearchCursor((c) => (c < 0 ? 0 : c));
          return true;
        }
        // BRANCHES-MOUNT-SECTION (keybinding)
        // Ctrl+B — open the branch picker overlay. Falls through when
        // the host has not wired `onOpenBranchPicker` (legacy callers,
        // unit tests).
        if (input === 'b' && onOpenBranchPicker !== undefined) {
          onOpenBranchPicker();
          return true;
        }
        // BRANCHES-MOUNT-SECTION (keybinding end)
        // SNIPPET-MODE-MOUNT-SECTION — Ctrl+S enters snippet select mode.
        if (input === 's') {
          setSnippetSelectActive(true);
          // Seed selection cursor onto the most recent message so
          // ↑/↓ navigation starts from a sensible anchor.
          setSelectionCursor((c) =>
            c < 0 ? Math.max(0, messages.length - 1) : c,
          );
          return true;
        }
        // MODEL-SWAP-MOUNT-SECTION — Ctrl+M opens the model swap overlay.
        // Falls through when the host hasn't wired the callback so the
        // keystroke doesn't get eaten silently.
        if (input === 'm' && onOpenModelSwap !== undefined) {
          setModelSwapActive(true);
          onOpenModelSwap();
          // Note: host callback closes its overlay via the existing
          // overlay machinery — when it returns, the overlay-active
          // path takes over and our 'model-swap' mode is dormant.
          // Reset our local flag eagerly so a follow-up Esc resolves
          // to 'input' rather than re-entering swap.
          setModelSwapActive(false);
          return true;
        }
        // AGENT-TAIL-RENDER-SECTION — Ctrl+G toggles the inline panel.
        if (input === 'g') {
          setAgentTailVisible((v) => !v);
          return true;
        }
        return undefined;
      },
      [
        onOpenBranchPicker,
        onOpenModelSwap,
        messages.length,
      ],
    ),
  );

  // SUGGEST-MOUNT-SECTION — Alt+1 / Alt+2 / Alt+3 picks the suggestion.
  // The follow-up generator is cheap (regex over the last assistant
  // message); we recompute on demand so the hotkey always lands on the
  // current suggestion set. Ink reports Alt+digit via `key.meta === true`
  // and `input === '1'|'2'|'3'`.
  const lastAssistantContent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m !== undefined && m.role === 'assistant') return m.content;
    }
    return '';
  }, [messages]);
  const followUpSuggestions: readonly FollowUpSuggestion[] = useMemo(() => {
    if (!suggestOnLocal) return [];
    if (isStreaming) return [];
    if (lastAssistantContent.length === 0) return [];
    return generateFollowUps(lastAssistantContent);
  }, [suggestOnLocal, isStreaming, lastAssistantContent]);
  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (!key.meta) return;
        if (followUpSuggestions.length === 0) return;
        const idx =
          input === '1' ? 0 : input === '2' ? 1 : input === '3' ? 2 : -1;
        if (idx < 0) return;
        const pick = followUpSuggestions[idx];
        if (pick === undefined) return;
        setDraft((d) => (d.length === 0 ? pick.payload : `${d} ${pick.payload}`));
        return true;
      },
      [followUpSuggestions],
    ),
  );

  // SNIPPET-MODE-MOUNT-SECTION — select-mode handler. Owns ↑/↓, Y, Esc.
  useInputModeHandler(
    'select',
    useCallback(
      ({ input, key }) => {
        if (key.escape) {
          setSnippetSelectActive(false);
          setSelectionAnchor(-1);
          return true;
        }
        if (key.upArrow) {
          if (key.shift && selectionAnchor < 0) setSelectionAnchor(selectionCursor);
          setSelectionCursor((c) => Math.max(0, c - 1));
          return true;
        }
        if (key.downArrow) {
          if (key.shift && selectionAnchor < 0) setSelectionAnchor(selectionCursor);
          setSelectionCursor((c) =>
            Math.min(Math.max(0, messages.length - 1), c + 1),
          );
          return true;
        }
        if (input === 'y' || input === 'Y') {
          // Copy the focused message's text (or the range if anchor
          // was set via Shift+arrow) to the snippet ring.
          const ring = snippetRing ?? getSnippetRing();
          const lo =
            selectionAnchor < 0
              ? selectionCursor
              : Math.min(selectionAnchor, selectionCursor);
          const hi =
            selectionAnchor < 0
              ? selectionCursor
              : Math.max(selectionAnchor, selectionCursor);
          const lines: string[] = [];
          for (let i = lo; i <= hi; i++) {
            const m = messages[i];
            if (m !== undefined) lines.push(m.content);
          }
          if (lines.length > 0) {
            const { clipId } = ring.push(lines.join('\n'));
            showQueueToast(`Copied to @${clipId}`);
          }
          setSnippetSelectActive(false);
          setSelectionAnchor(-1);
          return true;
        }
        return undefined;
      },
      [
        messages,
        selectionAnchor,
        selectionCursor,
        showQueueToast,
        snippetRing,
      ],
    ),
  );

  // MODEL-SWAP-MOUNT-SECTION — Esc returns to input mode without
  // changes. The actual model picker is the existing overlay machinery,
  // so this handler exists primarily so a stray Esc inside the brief
  // window between Ctrl+M and overlay-open doesn't fall through to the
  // streaming-cancel handler.
  useInputModeHandler(
    'model-swap',
    useCallback(
      ({ key }) => {
        if (key.escape) {
          setModelSwapActive(false);
          return true;
        }
        return undefined;
      },
      [],
    ),
  );

  // AGENT-TAIL-RENDER-SECTION — ↑/↓/Enter/Esc handlers for the inline
  // agent panel. The list size is derived from `agentTailEntries`.
  useInputModeHandler(
    'agent-tail',
    useCallback(
      ({ key }) => {
        const total = agentTailEntries?.length ?? 0;
        if (key.escape) {
          setAgentTailVisible(false);
          return true;
        }
        if (key.upArrow) {
          setAgentTailFocusIdx((i) => Math.max(0, i - 1));
          return true;
        }
        if (key.downArrow) {
          setAgentTailFocusIdx((i) => Math.min(Math.max(0, total - 1), i + 1));
          return true;
        }
        if (key.return || key.rightArrow) {
          const target = (agentTailEntries ?? [])[agentTailFocusIdx];
          if (target !== undefined) {
            setAgentTailExpanded((prev) => {
              const next = new Map(prev);
              next.set(target.id, !(prev.get(target.id) ?? false));
              return next;
            });
          }
          return true;
        }
        return undefined;
      },
      [agentTailEntries, agentTailFocusIdx],
    ),
  );

  // NAV-MODES-SECTION — TOC navigation. Active only when the TOC is
  // visible AND no overlay/approval owns the screen. We use ↑/↓ for
  // selection and Enter to "jump" — jumping in this terminal-owned
  // scrollback world means moving the timeline cursor to the same
  // message so the user can correlate the position visually.
  useInputModeHandler(
    'input',
    useCallback(
      ({ key }) => {
        if (!tocVisible) return;
        if (tocEntries.length === 0) return;
        if (key.upArrow) {
          setTocSelectedIdx((i) => Math.max(0, i - 1));
          return true;
        }
        if (key.downArrow) {
          setTocSelectedIdx((i) => Math.min(tocEntries.length - 1, i + 1));
          return true;
        }
        if (key.return) {
          // Snap the timeline cursor to the matching message — best we
          // can do without owning the terminal scrollback. Tests pin
          // this behaviour.
          const entry = tocEntries[tocSelectedIdx];
          if (entry !== undefined) {
            // Find the timeline event whose messageIndex matches.
            const idx = timelineEvents.findIndex(
              (e) => e.messageIndex === entry.messageIndex,
            );
            if (idx >= 0) setTimelineCursor(idx);
          }
          return true;
        }
        return undefined;
      },
      [tocVisible, tocEntries, timelineEvents, tocSelectedIdx],
    ),
  );

  // NAV-MODES-SECTION — Timeline navigation: `g` (first) / `G` (last).
  // Capital G is Shift+g — ink reports input='G' with shift flag set.
  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (!timelineVisible) return;
        if (timelineEvents.length === 0) return;
        if (key.ctrl || key.meta) return;
        if (input === 'g' && !key.shift) {
          setTimelineCursor(0);
          return true;
        }
        if (input === 'G' || (input === 'g' && key.shift)) {
          setTimelineCursor(timelineEvents.length - 1);
          return true;
        }
        return undefined;
      },
      [timelineVisible, timelineEvents],
    ),
  );

  // NAV-MODES-SECTION — Search-active handlers: n / p / Esc and
  // printable input (we layer a tiny inline editor here so the user
  // can type their query without leaving 'input' mode).
  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (!searchVisible) return;
        // Esc — close + clear highlights. We also reset the query so
        // a re-open starts fresh.
        if (key.escape) {
          setSearchVisible(false);
          setSearchQuery('');
          setSearchCursor(-1);
          return true;
        }
        // n / p — step the cursor across hits. Plain letters, NOT
        // ctrl-chorded, so they're easy to press while reading.
        if (input === 'n' && !key.ctrl && !key.meta) {
          setSearchCursor((c) => stepCursor(c, searchHits.length, 'next'));
          return true;
        }
        if (input === 'p' && !key.ctrl && !key.meta) {
          setSearchCursor((c) => stepCursor(c, searchHits.length, 'prev'));
          return true;
        }
        // Backspace edits the query.
        if (key.backspace || key.delete) {
          setSearchQuery((q) => q.slice(0, -1));
          setSearchCursor(-1);
          return true;
        }
        // Printable input — append to query. Filter to non-control
        // characters so arrow/function keys don't pollute it.
        if (
          input.length > 0 &&
          !key.ctrl &&
          !key.meta &&
          !key.upArrow &&
          !key.downArrow &&
          !key.leftArrow &&
          !key.rightArrow &&
          !key.return &&
          !key.tab
        ) {
          setSearchQuery((q) => `${q}${input}`);
          setSearchCursor(-1);
          return true;
        }
        return undefined;
      },
      [searchVisible, searchHits.length],
    ),
  );

  // Small footer note shown beside the prompt.
  const footerInfo = useMemo(() => {
    const sess = sessionId === null ? 'new session' : `session ${sessionId.slice(0, 8)}`;
    const root = projectRoot.length > 40 ? `…${projectRoot.slice(-37)}` : projectRoot;
    return `${sess} · ${root}`;
  }, [projectRoot, sessionId]);

  const effectiveModelName = modelName ?? config.model.current ?? 'assistant';

  /**
   * R7 (Agent 4) — flicker reduction.
   *
   * `<NoxMini>` and `<NoxTamagotchi>` only depend on `isStreaming`.
   * Without these `useMemo`s, every parent re-render — including the
   * frequent ones from `setDraft` (every keystroke) and `currentOutput`
   * updates (every stream chunk) — would re-run the components,
   * mounting fresh React elements and forcing ink to repaint the
   * pixel rows even when the streaming state hadn't changed. By
   * caching the element on the `isStreaming` boolean, we let ink
   * preserve identity between renders and the mascot's internal
   * blink/breath intervals run uninterrupted.
   *
   * (We can't apply `React.memo` to `Nox.tsx` itself — that file is
   * outside this round's edit ownership. Stabilising the React
   * element here achieves the same outcome from the call-site.)
   */
  const noxTamagotchiElement = useMemo(
    () => <NoxTamagotchi active={isStreaming} />,
    [isStreaming],
  );

  /**
   * R18 (Agent 4) — flicker fix via `<Static>`.
   *
   * Committed messages now render through ink's `<Static>` component,
   * which paints each item ONCE on first append and never re-renders
   * it afterwards (it's positioned absolutely above the live render
   * tree and the painted cells become "stable scrollback" the user's
   * terminal owns natively). This eliminates the flicker storm we
   * used to see while streaming — every spinner/timer/keystroke tick
   * previously bumped the parent and forced ink to re-emit the entire
   * committed history, which on slow terminals showed up as cursor
   * jumps and an inability to scroll up (the auto-redraw kept yanking
   * the viewport back to the bottom).
   *
   * Contract notes for `<Static>`:
   *   - The `items` array MUST be append-only. New committed messages
   *     are spliced onto the end of `messages`; existing entries are
   *     never reordered or replaced (see `chatState.ts` —
   *     APPEND_MESSAGE pushes; REPLACE_MESSAGES is a session-resume
   *     reset which we handle below via the `key` prop).
   *   - Each item must have a stable, unique key. `Message.id` is a
   *     ULID generated at append time, so it is unique for the
   *     lifetime of the array.
   *   - Role-transition separators are folded INTO the row render
   *     (rather than being separate items) so the `Static` item list
   *     stays a 1-to-1 map with `messages` — keeps the index math
   *     trivial and matches `Static`'s expectation that items don't
   *     interleave with side-channel structure.
   *
   * Session-resume reset:
   *   When the user runs `/resume` we wholesale-replace the messages
   *   array, which would leave `<Static>`'s internal `index` pointing
   *   past the new end and skip everything. We side-step that by
   *   keying `<Static>` on `sessionId` — a different session forces
   *   `<Static>` to re-mount with `index = 0`, repainting the loaded
   *   history once. `'new'` is a sentinel for the pre-session boot
   *   phase so the key transitions cleanly when the first session
   *   gets created.
   *
   * The dynamic area (live thinking, stream output, spinner, timer,
   * approvals) stays OUTSIDE `<Static>` — those re-render every tick
   * by design and live in a small bottom region so the redraw cost
   * is bounded.
   */
  const narrowedMessages = useMemo(
    () => messages as readonly MessageWithThinking[],
    [messages],
  );
  const staticKey = sessionId ?? 'new';

  /**
   * C1 / H3 — `<Static>` items must be FINAL before commit. The previous
   * implementation closed over `toolCallStates` + `sessionTotalOut` in
   * the renderer, so new callback identity reached only NEW items;
   * already-painted rows kept stale state forever (pending tool calls
   * visually frozen in scrollback). Fix: split `narrowedMessages` into
   *
   *   - `staticMessages` (everything that is FULLY settled —
   *     `<Static>` paints once),
   *   - `pendingMessages` (the trailing rows whose tool calls are
   *     still streaming or whose usage footer hasn't landed —
   *     rendered in the dynamic area until they settle).
   *
   * A row is "final" when (a) all its tool calls have a terminal
   * status (`done` or `error`), AND (b) for assistants, the usage
   * footer (tokens/duration) is present. Anything younger sits in
   * the dynamic area where re-renders are fine.
   */
  const isMessageFinal = useCallback(
    (m: MessageWithThinking): boolean => {
      if (m.role === 'user' || m.role === 'system' || m.role === 'tool') {
        return true;
      }
      // assistant — check tool calls first.
      if (m.toolCalls !== undefined) {
        for (const tc of m.toolCalls) {
          const st = toolCallStates?.get(tc.id);
          const status = st?.status ?? 'pending';
          if (status === 'pending' || status === 'running') return false;
        }
      }
      // Usage footer: prefer present-and-finite. If neither tokens nor
      // duration are populated yet we treat the row as still settling
      // — the parent commits these inline on the same dispatch that
      // ends the stream, so the next render after END_STREAM will
      // see them and the row promotes to <Static>.
      const hasUsage =
        (typeof m.tokensOutput === 'number' && Number.isFinite(m.tokensOutput)) ||
        (typeof m.durationMs === 'number' && Number.isFinite(m.durationMs));
      if (!hasUsage) return false;
      return true;
    },
    [toolCallStates],
  );

  // Split point — walk from the tail; once we find an item that's not
  // final, everything FROM that point onwards is dynamic. This keeps
  // the static prefix monotonically growing (a hard requirement of
  // `<Static>` — items can never move out of the prefix once
  // committed).
  const splitIndex = useMemo(() => {
    let i = narrowedMessages.length;
    while (i > 0) {
      const m = narrowedMessages[i - 1];
      if (m === undefined) break;
      if (isMessageFinal(m)) break;
      i -= 1;
    }
    return i;
  }, [narrowedMessages, isMessageFinal]);

  const staticMessages = useMemo(
    () => narrowedMessages.slice(0, splitIndex),
    [narrowedMessages, splitIndex],
  );
  const pendingMessages = useMemo(
    () => narrowedMessages.slice(splitIndex),
    [narrowedMessages, splitIndex],
  );

  /**
   * Render a single committed (FINAL) message for `<Static>`. Deps
   * shrink to `[staticMessages, effectiveModelName]` — `toolCallStates`
   * + `sessionTotalOut` are NOT dependencies because by the time a
   * row is in `staticMessages` its tool calls are settled (so the
   * captured `toolCallStates` snapshot has its terminal entries) and
   * the usage footer is already populated on the message itself.
   */
  const renderStaticItem = useCallback(
    (current: MessageWithThinking, index: number): React.ReactNode => {
      const prev = index > 0 ? staticMessages[index - 1] : undefined;
      const showSeparator = prev !== undefined && prev.role !== current.role;
      return (
        <Box key={current.id} flexDirection="column">
          {showSeparator && <Separator />}
          <MessageRow
            message={current}
            toolCallStates={toolCallStates}
            modelName={effectiveModelName}
            sessionTotalOut={sessionTotalOut}
            outputFilters={resolvedFilters}
          />
        </Box>
      );
    },
    // Intentionally exclude `toolCallStates` and `sessionTotalOut`:
    // by the time a row reaches <Static> these are stable for it.
    // `resolvedFilters` is also excluded — the Static prefix is the
    // committed scrollback (terminal-owned), and re-painting it on a
    // filter toggle would either ghost rows in scrollback or duplicate
    // them. Filter changes therefore only affect future messages +
    // the dynamic tail; the committed log stays as-was when the row
    // first landed. This matches Claude Code's behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staticMessages, effectiveModelName],
  );

  const nextQueuedPreview = useMemo(() => {
    const first = pendingQueue[0];
    if (first === undefined) return null;
    return first.length <= 40 ? first : `${first.slice(0, 39)}…`;
  }, [pendingQueue]);

  // FIX #25: NoxBig visible only when there is genuinely nothing going
  // on — no messages, no streaming, no approval, no overlay. As soon
  // as the first message lands the big splash disappears, giving the
  // illusion that it scrolled away with history.
  const showNoxBig =
    messages.length === 0 &&
    !isStreaming &&
    pendingApproval === null &&
    !overlayActive &&
    currentOutput.length === 0;

  // HOTFIX: dispatcher needs an actual pump from ink. Without a
  // top-level `useInput` calling `dispatcher.dispatch(...)`, NO
  // keystroke ever reaches subscribers — InputBar appeared dead.
  // The mode is computed from screen state (approval > overlay >
  // agent-focus > input).
  //
  // AGENT-PANEL-SECTION (Wave 5A — TA team): agent-focus sits BELOW
  // approval/overlay so a stray Tab during an approval prompt doesn't
  // accidentally hijack y/n routing — the user must dismiss the
  // approval first. It sits ABOVE 'input' so the panel's ↑/↓/Enter/Esc
  // win over the composer's history nav.
  // SNIPPET-MODE-MOUNT-SECTION + MODEL-SWAP-MOUNT-SECTION +
  // AGENT-TAIL-RENDER-SECTION — three new local mode flags. They are
  // mutually exclusive with overlay/approval/agent-focus (those flip
  // the dispatcher higher in the precedence ladder) so we only need
  // to layer them BELOW agent-focus. (state declared above)
  const inputMode: InputMode =
    pendingApproval !== null
      ? 'approval'
      : overlayActive
        ? 'overlay'
        : agentFocusMode
          ? 'agent-focus'
          : modelSwapActive
            ? 'model-swap'
            : snippetSelectActive
              ? 'select'
              : agentTailVisible
                ? 'agent-tail'
                : 'input';

  // SEARCH-SECTION (Wave 6B) — the search bar element. Rendered at
  // the very top of the chat tree (above <Static>) so it doesn't
  // disturb the terminal-owned scrollback rows. Stays mounted as a
  // small ephemeral bar — turning it off via Esc unmounts it.
  const searchBar = searchVisible ? (
    <ConversationSearch
      visible={searchVisible}
      query={searchQuery}
      totalMatches={searchHits.length}
      cursorIndex={searchCursor}
    />
  ) : null;

  return (
    <InputDispatcherProvider mode={inputMode}>
      <InputPump />
      <Box flexDirection="column">
      {/* BRANCHES-MOUNT-SECTION (breadcrumb)
          Branching sessions — single-line trail at the top of the chat.
          Component auto-hides when there's only the unnamed root (clean
          default). Above <Static> so the breadcrumb is never repainted
          mid-stream. */}
      {branchChain !== undefined && branchChain.length > 0 ? (
        <BranchBreadcrumb chain={branchChain} />
      ) : null}

      {/* SEARCH-SECTION — Ctrl+F search bar. Sits above <Static> so the
          dynamic re-paints (cursor stepping, query edits) don't ever
          touch the committed scrollback. Off by default. */}
      {searchBar}

      {/* Committed message log — rendered through ink's <Static> so
          each row paints exactly once and the terminal owns the
          scrollback. The list is append-only (see `renderStaticItem`
          comment); resume re-mounts via the `key` prop.

          R26 (Agent 4) — `<Static>` MUST stay mounted across overlay
          open/close transitions. Conditionally unmounting it would
          leave the previously-painted rows in scrollback (those cells
          are owned by the terminal, not ink) AND on remount ink would
          re-emit every item to stdout, producing a duplicate copy of
          the entire chat history below the overlay's exit point. So
          even when an overlay is active and the rest of the chat tree
          is skipped (see below), <Static> renders unconditionally. */}
      {/*
        C2 — pass `staticMessages` directly. Spreading into a fresh
        array on every render forced ink to diff the items list even
        when nothing new had landed; the memoised slice is stable
        until the split point itself moves. The readonly→mutable
        cast satisfies ink's signature without copying.
      */}
      <Static key={staticKey} items={staticMessages as MessageWithThinking[]}>
        {renderStaticItem}
      </Static>

      {/*
        R26 (Agent 4) — overlay-active short-circuit.

        When ANY overlay is active (slash-command overlay or skill
        overlay) the user sees only the overlay's UI; the chat-tree's
        dynamic area, slash autocomplete menu, queued-pill, and input
        row are all visually replaced. Rendering them anyway burns
        CPU on JSX construction + reconciliation that never reaches
        the terminal — the overlay covers those cells either way.

        Skipping the chat tree saves measurable work on every
        overlay-driven re-render (e.g. the user typing inside
        CtxSizeOverlay's number input bumps that overlay's state and
        propagates a parent re-render up to ChatScreen). The siblings
        we skip are:
          - the live-output dynamic Box (NoxBig / empty-state hint /
            ThinkingBlock / StreamOutput / ThinkingSpinner /
            StreamTimer / DiffView / ApprovalPrompt)
          - SlashMenu (`slashMenuOpen` already returns false during
            overlay, so this was already cheap — but the JSX still
            evaluated)
          - the queued-messages pill (rare during overlay use)
          - the InputBar row (NoxMini + InputBar + NoxTamagotchi)

        We DO keep:
          - <Static> above (scrollback safety, see comment)
          - <Header> below (model / context / backend bar should
            remain visible while configuring)
          - footer (session id / project root)

        On overlay close, R23's `inputKey` bump still fires (the
        `useEffect` watching `overlayActive`), forcing a fresh
        InputBar mount so ink repaints the row immediately.
      */}
      {overlayActive ? (
        overlay !== undefined ? (
          <OverlayRenderer overlay={overlay} config={config} />
        ) : (
          <SkillInputOverlay
            onSubmit={(payload) => {
              onSkillSubmit?.(payload);
            }}
            onCancel={() => {
              onSkillCancel?.();
            }}
          />
        )
      ) : (
        <>
          {/* Dynamic area — re-renders on every parent tick. Kept
              short so the redraw cost stays bounded:
                - empty-state hint / NoxBig splash (only when there are
                  no messages anyway)
                - "pending" messages whose tool roundtrips / usage
                  footer haven't settled yet (C1 — must NOT enter
                  <Static> while still in flight, otherwise stale
                  tool-call state freezes in scrollback)
                - live thinking-channel buffer
                - in-flight assistant streaming text
                - spinner + elapsed-seconds timer
                - pending approval prompt (DiffView / ApprovalPrompt) —
                  MUST be dynamic, since its callbacks need fresh
                  closures every render.

              TOC-SECTION — when the TOC is visible we wrap the dynamic
              column in a row container with the TOC on the LEFT. The
              terminal owns committed history rows via <Static>, so the
              TOC is bounded by the dynamic area's height. This is the
              pragmatic compromise: a full-height left rail would risk
              painting through scrollback rows the terminal can't redraw. */}
          <Box flexDirection={tocVisible ? 'row' : 'column'}>
          {tocVisible && (
            <ConversationTOC
              visible={tocVisible}
              entries={tocEntries}
              selectedIdx={tocSelectedIdx}
            />
          )}
          <Box flexDirection="column" paddingY={1} flexGrow={1}>
            {showNoxBig && <NoxBig />}

            {/* C1 — pending tail: messages whose tool calls haven't
                terminalised or whose usage footer hasn't landed yet.
                Promotes into <Static> automatically once
                `isMessageFinal` flips true (see `splitIndex`). */}
            {pendingMessages.length > 0 && (
              <Box flexDirection="column">
                {pendingMessages.map((m, i) => {
                  // Show a separator if the row before this one (in
                  // the FULL list, not just the pending slice) had a
                  // different role. For i===0 we look at the last
                  // static message; otherwise at the previous
                  // pending row.
                  const prev =
                    i === 0
                      ? staticMessages[staticMessages.length - 1]
                      : pendingMessages[i - 1];
                  const showSep = prev !== undefined && prev.role !== m.role;
                  // COST-FOOTER-PROPS-SECTION — only annotate the most
                  // recent pending row with cumulative cost data.
                  const isLast = i === pendingMessages.length - 1;
                  return (
                    <Box key={m.id} flexDirection="column">
                      {showSep && <Separator />}
                      <MessageRow
                        message={m}
                        toolCallStates={toolCallStates}
                        modelName={effectiveModelName}
                        sessionTotalOut={sessionTotalOut}
                        outputFilters={resolvedFilters}
                        // COST-FOOTER-PROPS-SECTION (thread)
                        sessionCostUsd={sessionCostUsd}
                        todayCostUsd={todayCostUsd}
                        isLastMessage={isLast}
                        // COST-FOOTER-PROPS-SECTION (thread end)
                      />
                    </Box>
                  );
                })}
              </Box>
            )}

            {messages.length === 0 && !isStreaming && pendingApproval === null && (
              <Box paddingX={1} marginTop={1}>
                {/* LOCALE-APPLY-SECTION */}
                <Text color={textMuted}>{t('chat.emptyHint')}</Text>
                {/* LOCALE-APPLY-SECTION-END */}
              </Box>
            )}

            {/* H2 — mount only when there's real thinking content.
                The previous `isStreaming || …` condition mounted the
                block for every streaming turn, including from
                non-thinking models, which painted a phantom
                "💭 Thinking…" header above the assistant reply.
                Dropping `isStreaming` keeps the block invisible
                until the first thinking-channel delta lands; the
                internal `text.trim().length === 0 && !isActive`
                guard in ThinkingBlock stays as defence-in-depth. */}
            {/* FILTER-RENDER-SECTION — live thinking buffer respects
                the same filter as committed thinking blocks. */}
            {currentThinking !== undefined &&
              currentThinking.length > 0 &&
              resolvedFilters.thinking && (
                <ThinkingBlock
                  text={currentThinking}
                  isActive={isStreaming}
                />
              )}

            {isStreaming && renderedOutput.length > 0 && <StreamOutput text={renderedOutput} />}

            {isStreaming && thinkingStartedAt !== null && (
              <ThinkingSpinner startedAt={thinkingStartedAt} locale={locale} />
            )}

            {/* R17 (Agent 4) — live "⏱ Processing Xs / Ys timeout"
                indicator, placed just below the spinner so the user
                has the elapsed seconds and the abort threshold within
                a single visual unit. Renders only when streaming AND
                a timeout limit is supplied by the parent (graceful
                degradation for tests/legacy callers that haven't
                wired the prop yet). */}
            {isStreaming &&
              thinkingStartedAt !== null &&
              responseTimeoutSeconds !== undefined && (
                <StreamTimer
                  startedAt={thinkingStartedAt}
                  timeoutSeconds={responseTimeoutSeconds}
                  isStreaming={isStreaming}
                />
              )}

            {pendingApproval !== null && pendingApproval.kind === 'diff' && (
              <DiffView
                filePath={pendingApproval.filePath ?? '(file)'}
                diffString={pendingApproval.diffString ?? ''}
                onApprove={() => onApprove(pendingApproval.id)}
                onReject={() => onReject(pendingApproval.id)}
                onEdit={pendingApproval.onEdit}
              />
            )}
            {pendingApproval !== null && pendingApproval.kind !== 'diff' && (
              <ApprovalPrompt
                title={pendingApproval.title}
                description={pendingApproval.description}
                onApprove={() => onApprove(pendingApproval.id)}
                onReject={() => onReject(pendingApproval.id)}
                {...(onApproveAllInTurn !== undefined &&
                (pendingApproval.kind === 'command' ||
                  pendingApproval.toolName === 'run_command' ||
                  pendingApproval.toolName === 'write_file' ||
                  pendingApproval.toolName === 'edit_file' ||
                  pendingApproval.toolName === 'multi_edit')
                  ? {
                      onApproveAllInTurn: () =>
                        onApproveAllInTurn(pendingApproval.id),
                    }
                  : {})}
                {...(onApproveForSession !== undefined &&
                pendingApproval.toolName === 'run_command'
                  ? {
                      onApproveForSession: () =>
                        onApproveForSession(pendingApproval.id),
                    }
                  : {})}
              />
            )}
          </Box>
          {/* TOC-SECTION — close the row wrapper opened above when the
              TOC is visible. Kept as a single closing Box regardless
              of `tocVisible` so the React tree shape is stable. */}
          </Box>

          {/* SlashMenu pops ABOVE the InputBar when active. */}
          {slashMenuOpen && (
            <SlashMenu
              query={draft}
              commands={slashCommands}
              onSelect={handleSlashSelect}
              onCancel={handleSlashCancel}
            />
          )}

          {/* Queued-messages indicator above the InputBar.
              Design choice: a single-line dim pill matching the spec's
              "↳ N messages queued (will send after this turn)" style.
              Renders only when `pendingQueue.length > 0`. The previous
              preview-of-first-entry pill was dropped — the count alone
              is less noisy and matches Claude Code's surface. */}
          {/* Fix 2: error-paused banner. Sits ABOVE the queue indicator
              so the user reads "queue paused → why → action" in
              order. Renders only when the queue has content and the
              previous turn errored — silent on a clean failure with
              an empty queue. */}
          {lastTurnError !== null &&
            lastTurnError !== undefined &&
            pendingQueue.length > 0 && (
              <Box paddingX={1}>
                {/* LOCALE-APPLY-SECTION */}
                <Text color={noxPalette.yellow}>
                  {t('chat.queuePausedBanner')}
                </Text>
                {/* LOCALE-APPLY-SECTION-END */}
              </Box>
            )}

          {pendingQueue.length > 0 && (
            <Box paddingX={1}>
              {/* LOCALE-APPLY-SECTION — keyed plural variants so Russian
                  can use the locale-correct form (1 сообщение / N
                  сообщений) without ad-hoc plural rules at the call site. */}
              <Text color={textMuted} dimColor>
                {pendingQueue.length === 1
                  ? t('chat.queueCountOne')
                  : t('chat.queueCountMany', { n: pendingQueue.length })}
                {nextQueuedPreview !== null && pendingQueue.length === 1 && (
                  <Text color={textMuted} dimColor>{` — ${nextQueuedPreview}`}</Text>
                )}
              </Text>
              {/* LOCALE-APPLY-SECTION-END */}
            </Box>
          )}

          {/* Transient toast (enqueue confirmation / approval-block
              warning / queue-cleared). Auto-clears after 2.5s via
              `showQueueToast`. Sits above the InputBar so the user's
              eye lands on it after pressing Enter. */}
          {queueToast !== null && (
            <Box paddingX={1}>
              <Text color={noxPalette.yellow}>{queueToast}</Text>
            </Box>
          )}

          {/* todo_write task summary — terse one-liner above the InputBar. */}
          <TasksLine todos={todos ?? []} />

          {/* PROACTIVE-MOUNT-SECTION (Wave 6D) — single-line dim hint
              proposing a sub-agent spawn when the heuristic detector
              picks up a strong signal. Sits directly above the InputBar
              so the user's eye lands on it without competing with the
              streaming text region. The panel itself renders `null`
              when there is no qualifying suggestion, so it costs zero
              rows in the common case. */}
          <ProactiveSuggestionsPanel
            suggestion={proactiveSuggestion ?? null}
            visible={proactivePanelVisible}
          />
          {/* PROACTIVE-MOUNT-SECTION-END */}

          {/* COST-FORECAST-SECTION (render) — next-turn cost preview
              chip rendered directly above the InputBar. Self-hides
              when the active backend is local or the estimate is
              below the noise floor. See the component definition
              earlier in this file for the colour ladder + format. */}
          <CostForecastChip
            estimateUsd={nextTurnEstimateUsd}
            unknown={nextTurnEstimateUnknown}
          />
          {/* COST-FORECAST-SECTION (render end) */}

          {/* Bug #2 fix: input row is now edge-to-edge. NoxMini and the
              two `<Box width={1} />` spacers were dropped so the
              InputBar starts at column 0. The Tamagotchi (which already
              reflects streaming state via `active={isStreaming}`)
              continues to live in a sticky bottom-right slot rendered
              unconditionally below — see the post-overlay block.

              READING-MODE-SECTION (Wave 6A2) — when readingMode is on,
              replace the composer + AgentPanel with a single dim
              banner. The keystroke handler above still sees F (the
              dispatcher's mode stays 'input' because no overlay is
              open) so F still toggles back out. */}
          {readingMode ? (
            <Box paddingX={1}>
              {/* LOCALE-APPLY-SECTION */}
              <Text color={noxPalette.yellow} dimColor>
                {t('chat.readingMode')}
              </Text>
              {/* LOCALE-APPLY-SECTION-END */}
            </Box>
          ) : (
            <>
              {/* WATCH-PANEL-MOUNT-SECTION — single-row process strip.
                  Hidden when zero processes are watched; mounts above
                  the InputBar so the user sees state changes adjacent
                  to their next action. ChatScreen owns the
                  `watchedProcesses` snapshot (refreshed by the
                  ProcessMonitor subscription + 1 Hz interval defined
                  above), so this is purely presentational. */}
              <WatchPanel
                processes={watchedProcesses}
                columns={termColumns}
              />
              {/* WATCH-PANEL-MOUNT-SECTION-END */}
              <Box flexDirection="row" alignItems="center" width="100%">
                <Box flexGrow={1} flexShrink={1} flexBasis="0%">
                  <InputBar
                    key={inputKey}
                    value={draft}
                    onChange={setDraft}
                    onSubmit={submit}
                    history={history}
                    disableHistoryNav={slashMenuOpen}
                    // M2 — `resetTrigger` clears the editor state in place
                    // (no unmount→mount churn) after submit / slash-cancel /
                    // bash dispatch. `inputKey` is reserved for the
                    // overlay-close path where ink needs the full repaint.
                    resetTrigger={resetTrigger}
                    // H1 — disable the InputBar's useInput while an approval
                    // prompt owns the screen. Without this, the `y` keystroke
                    // that confirmed the prompt leaked into the next draft
                    // (the dispatcher saw the same y on the next render and
                    // appended it to the buffer). `overlayActive` is handled
                    // by the conditional render above (InputBar is unmounted
                    // entirely while an overlay is up).
                    disabled={pendingApproval !== null}
                    placeholder={
                      // LOCALE-APPLY-SECTION
                      pendingApproval !== null
                        ? t('chat.placeholderApproval')
                        : isStreaming
                          ? t('chat.placeholderStreaming')
                          : undefined
                      // LOCALE-APPLY-SECTION-END
                    }
                  />
                </Box>
              </Box>

              {/* AGENT-PANEL-SECTION (Wave 5A — TA team) — multi-agent worker
                  list rendered UNDER the InputBar. Only mounts when there is
                  at least one worker. The panel itself is purely
                  presentational; navigation state + handlers come from the
                  host via props (app.tsx owns the orchestrator subscription
                  and dispatches the reducer actions). Suppressed in reading
                  mode (parent branch above). */}
              {agentWorkers !== undefined && agentWorkers.length > 0 && (
                <AgentPanel
                  workers={agentWorkers}
                  leadModel={effectiveModelName}
                  leadStreaming={leadStreaming || isStreaming}
                  selectedIdx={agentSelectedIdx}
                  focused={agentFocusMode}
                  currentConversant={currentConversant}
                  columns={termColumns}
                />
              )}

              {/* SUGGEST-MOUNT-SECTION (Wave 6B) — three ghost rows of
                  proposed follow-ups under each committed assistant
                  message. Auto-hide while streaming so the rows don't
                  flicker on every chunk; toggled off via /suggest. */}
              {followUpSuggestions.length > 0 && (
                <SuggestedFollowUps
                  suggestions={followUpSuggestions}
                  visible={suggestOnLocal}
                />
              )}

              {/* VIM-INDICATOR-MOUNT-SECTION (Wave 6B) — small mode chip
                  beneath the composer. Renders only when the user has
                  opted into vim via `config.editor.vimMode`. */}
              {config.editor?.vimMode === true && vimMode !== undefined && (
                <Box paddingX={1}>
                  <Text color={textMuted} dimColor>
                    {`-- ${vimMode.toUpperCase()} --`}
                  </Text>
                </Box>
              )}

              {/* SNIPPET-MODE-MOUNT-SECTION (Wave 6B) — banner shown only
                  while select mode is active. Pure indicator; ↑/↓/Y/Esc
                  are wired via the dispatcher above. */}
              {snippetSelectActive && (
                <Box paddingX={1}>
                  {/* LOCALE-APPLY-SECTION */}
                  <Text color={noxPalette.yellow} dimColor>
                    {t('chat.selectMode', {
                      row: selectionCursor + 1,
                      total: messages.length,
                    })}
                  </Text>
                  {/* LOCALE-APPLY-SECTION-END */}
                </Box>
              )}

              {/* MODEL-SWAP-MOUNT-SECTION (Wave 6B) — banner shown only
                  while swap mode is active (typically a single frame
                  between Ctrl+M and the overlay opening). */}
              {modelSwapActive && (
                <Box paddingX={1}>
                  {/* LOCALE-APPLY-SECTION */}
                  <Text color={noxPalette.yellow} dimColor>
                    {t('chat.modelSwap')}
                  </Text>
                  {/* LOCALE-APPLY-SECTION-END */}
                </Box>
              )}

              {/* AGENT-TAIL-RENDER-SECTION (Wave 6B) — inline panel of
                  recent TeamBus messages. Toggled via Ctrl+G. The list
                  is bounded by the store's per-session cap. */}
              {agentTailVisible &&
                agentTailEntries !== undefined &&
                agentTailEntries.length > 0 && (
                  <Box flexDirection="column" marginTop={1}>
                    {agentTailEntries.map((entry, idx) => (
                      <AgentInlineMessage
                        key={entry.id}
                        entry={entry}
                        focused={idx === agentTailFocusIdx}
                        expanded={agentTailExpanded.get(entry.id) === true}
                        onToggleExpand={() => {
                          setAgentTailExpanded((prev) => {
                            const next = new Map(prev);
                            next.set(entry.id, !(prev.get(entry.id) ?? false));
                            return next;
                          });
                        }}
                      />
                    ))}
                  </Box>
                )}
            </>
          )}
        </>
      )}

      {/* Bug #1 fix: NoxTamagotchi is hoisted OUT of the overlay
          short-circuit and the input-row block so it stays visible at
          all times — during overlays, streaming, approval, AND on the
          empty-state splash. Pinned bottom-right via a flex row with
          `justifyContent="flex-end"`. The NoxBig splash sits above
          this in the dynamic area and is unaffected. */}
      <Box flexDirection="row" justifyContent="flex-end" width="100%">
        {noxTamagotchiElement}
      </Box>

      {/* Header BELOW the input (Task 3). Stays rendered even when an
          overlay is active so the model name / backend / context bar
          remain visible while the user is configuring. */}
      <Box marginTop={1}>{header}</Box>

      {/* TIMELINE-SECTION (Wave 6B) — 1-row density bar. Off by default;
          toggled via Ctrl+Y. Sits BELOW the header (the closest analogue
          to the spec's "below StatusPill" location in this codebase). */}
      {timelineVisible && (
        <SessionTimeline
          visible={timelineVisible}
          columns={termColumns}
          events={timelineEvents}
          cursorIndex={timelineCursor}
        />
      )}

      <Box paddingX={1}>
        <Text color={textMuted}>{footerInfo}</Text>
      </Box>
      </Box>
    </InputDispatcherProvider>
  );
}

/**
 * Top-level keystroke pump for the InputDispatcher. Lives inside the
 * provider; ink calls our `useInput` for every key, and we forward the
 * event into the dispatcher which routes to the active mode's
 * subscribers. Without this, NO keystroke reaches any subscribed
 * component (InputBar / SlashMenu / ApprovalPrompt / DiffView), and
 * the TUI input bar appears completely dead.
 *
 * Returns `null` — invisible pump component.
 */
function InputPump(): React.JSX.Element | null {
  const dispatcher = useInputDispatcher();
  useInput((input, key) => {
    if (dispatcher === null) return;
    dispatcher.dispatch({ input, key });
  });
  return null;
}

export default ChatScreen;
