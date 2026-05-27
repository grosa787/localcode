/**
 * /compress — summarise the entire current chat context into a compact
 * single-message summary, freeing up context space while preserving
 * project memory across long sessions (FIX #34).
 *
 * Subcommand surface (Round-5 minimal scope):
 *
 *   /compress                → compress the whole in-memory history
 *                              into a single summary message and
 *                              replace the older slice. Optionally pass
 *                              `--keep-last N` to retain the last N
 *                              messages verbatim (default 0).
 *   /compress --keep-last 6  → keep the last 6 messages verbatim,
 *                              summarise the rest.
 *
 * The actual summarisation step is delegated to a thin wrapper around
 * `LLMAdapter.streamChat` (the `llm` dep): we issue a one-turn chat
 * with a fixed system role + a prompt produced by `buildCompressPrompt`,
 * accumulate the streamed text, and feed it back into
 * `ContextManager.compress(summarizer, opts)` as the summary.
 *
 * If a `sessionId` is currently active and a `sessionManager` was
 * provided, the resulting summary is also persisted to the session row
 * (`Session.summary`) so a subsequent `/resume` can re-inject it.
 *
 * The command never throws into the host: any failure is reported to
 * the user via `ctx.print` and the in-memory context is left untouched
 * (because `ContextManager.compress` only mutates state on success).
 */

import type { SlashCommand, CommandContext, Message, Backend } from '@/types/global';
import type { ContextManager } from '@/llm/context-manager';
import type { StreamChatParams } from '@/types/message';
import type { SessionManager } from '@/sessions/session-manager';
// COMPRESS-STRATEGY-SECTION
import {
  applyCompressStrategy,
  chooseCompressStrategy,
  resolveCheapModel,
  type CompressStrategyName,
} from '@/llm/compress-strategy';
import { dedupReadResults } from '@/llm/semantic-dedup';
// COMPRESS-STRATEGY-SECTION-END

/**
 * Minimal LLM-adapter surface needed by `/compress`. Mirrors the
 * `streamChat` method on `LLMAdapter` but kept narrow so tests can
 * inject a fake without standing up the whole adapter.
 *
 * The compress flow only needs single-turn streamed text — no tools,
 * no tool-call accumulation. Callers wire this through to whatever
 * adapter the app currently has live (Ollama / LM Studio / custom).
 */
export interface CompressLLM {
  streamChat: (params: StreamChatParams) => Promise<void>;
}

/**
 * Result shape returned by `ContextManager.compress`. Declared locally
 * rather than imported because Agent 2 R5 owns the type definition in
 * the context manager — keeping this loose here avoids tight coupling
 * if the field set evolves.
 */
interface CompressResult {
  oldCount: number;
  newCount: number;
  tokensSaved: number;
  summary: string;
}

/**
 * Options forwarded to `ContextManager.compress`. Currently only
 * `keepLast` (number of recent messages to retain verbatim).
 */
interface CompressOptions {
  keepLast?: number;
}

/**
 * Subset of `ContextManager` we depend on. Declared as an interface
 * (not the concrete class) so tests can pass a stub without
 * constructing a real ContextManager.
 */
export interface CompressContextManager {
  getMessages(): Message[];
  compress(
    summarizer: (messages: Message[]) => Promise<string>,
    opts?: CompressOptions,
  ): Promise<CompressResult>;
  // COMPRESS-STRATEGY-SECTION — optional surface used by the
  // strategy-aware execution path (dedup / summarize / truncate). Kept
  // optional so existing callers (and tests) that satisfy only the
  // legacy `getMessages` + `compress` contract keep working.
  replaceAll?: (messages: readonly Message[]) => void;
  // COMPRESS-STRATEGY-SECTION-END
}

export interface CompressDeps {
  contextManager: CompressContextManager;
  /**
   * Pure function that turns the messages-to-summarise into the user
   * prompt for the summary call. Provided by Agent 2 R5
   * (`buildCompressPrompt`). Kept as an injected dep so tests can
   * substitute a deterministic stub.
   */
  buildCompressPrompt: (messages: Message[]) => string;
  /**
   * LLM adapter used to perform the actual summary call. Only
   * `streamChat` is required.
   */
  llm: CompressLLM;
  /**
   * Session manager used to persist the resulting summary on the
   * current session row. Optional — when undefined, the summary is
   * applied in-memory only (e.g. tests that run without a SQLite
   * session).
   */
  sessionManager?: SessionManager;
  /**
   * Callable returning the current session id, or null when no
   * session is active. Implemented as a thunk (rather than a static
   * value) so the command always sees the latest id even after
   * `/clear` has rotated sessions.
   */
  getSessionId: () => string | null;
  // COMPRESS-STRATEGY-SECTION — strategy-aware compression. When
  // `getBackend` is provided the command picks one of
  // `dedup | summarize | truncate` and applies it via
  // `contextManager.replaceAll`. Without `getBackend` (or without
  // `replaceAll`) the legacy summarise path runs unchanged.
  getBackend?: () => Backend | null;
  // COMPRESS-STRATEGY-SECTION-END
}

const COMPRESS_NAME = 'compress';
const COMPRESS_DESCRIPTION =
  'Summarize the entire chat context into a compact summary, freeing up context space while preserving project memory.';
const COMPRESS_USAGE = '/compress [--keep-last N]';

const SUMMARY_PREVIEW_CHARS = 200;
const KEEP_LAST_PATTERN = /--keep-last\s+(\d+)/i;
// System prompt for the one-shot summary call. Kept terse: the real
// shape of "what to summarise" is owned by `buildCompressPrompt`.
const SUMMARY_SYSTEM_PROMPT = 'You produce dense, faithful summaries.';

export function createCompressCommand(deps: CompressDeps): SlashCommand {
  const {
    contextManager,
    buildCompressPrompt,
    llm,
    sessionManager,
    getSessionId,
  } = deps;
  // COMPRESS-STRATEGY-SECTION
  const getBackend = deps.getBackend;
  const replaceAll = contextManager.replaceAll;
  const strategyEnabled =
    typeof getBackend === 'function' && typeof replaceAll === 'function';
  // COMPRESS-STRATEGY-SECTION-END

  return {
    name: COMPRESS_NAME,
    description: COMPRESS_DESCRIPTION,
    usage: COMPRESS_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const keepLast = parseKeepLast(args);

      const beforeCount = contextManager.getMessages().length;
      if (beforeCount === 0) {
        ctx.print('Nothing to compress — context is empty.');
        return;
      }

      // COMPRESS-STRATEGY-SECTION
      // Strategy-aware path. Picks `dedup | summarize | truncate` based
      // on the active backend + the dedup-savings estimate. The legacy
      // path is preserved verbatim below for callers that don't wire
      // `getBackend` / `replaceAll`.
      if (strategyEnabled) {
        const backend = getBackend !== undefined ? getBackend() : null;
        if (backend !== null && replaceAll !== undefined) {
          await runStrategyPath({
            backend,
            contextManager,
            replaceAll,
            llm,
            buildCompressPrompt,
            sessionManager,
            sessionId: getSessionId(),
            ctx,
          });
          return;
        }
      }
      // COMPRESS-STRATEGY-SECTION-END

      ctx.print('Compressing context… (this may take a moment)');

      const summarizer = async (msgs: Message[]): Promise<string> => {
        return runSummary(llm, buildCompressPrompt, msgs);
      };

      let result: CompressResult;
      try {
        result = await contextManager.compress(summarizer, { keepLast });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Compression failed: ${msg}`);
        return;
      }

      const saved = Math.max(0, result.tokensSaved);
      ctx.print(
        `✓ Compressed: ${result.oldCount} messages → ${result.newCount} (saved ~${saved} tokens).`,
      );
      if (result.summary.length > 0) {
        const preview =
          result.summary.length > SUMMARY_PREVIEW_CHARS
            ? `${result.summary.slice(0, SUMMARY_PREVIEW_CHARS)}…`
            : result.summary;
        ctx.print(`Summary: ${preview}`);
      }

      // Persist to session row when both a session and a manager are
      // available. Failures are surfaced but do NOT undo the in-memory
      // compression — context is already shorter and that's the
      // user-visible effect they asked for.
      const sessionId = getSessionId();
      if (sessionId && sessionManager && result.summary.length > 0) {
        try {
          sessionManager.updateSummary(sessionId, result.summary);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`(Warning: failed to persist summary to session: ${msg})`);
        }
      }
    },
  };
}

// ---------- helpers ----------

/**
 * Parse `--keep-last N` out of the raw arg string. Returns 0 (the safe
 * default) if absent or malformed. Negative / non-finite values are
 * clamped to 0.
 */
function parseKeepLast(args: string): number {
  const m = KEEP_LAST_PATTERN.exec(args);
  if (!m) return 0;
  const raw = m[1];
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Run a single one-shot streamed summary call and return the
 * accumulated text. The promise resolves with the trimmed summary on
 * `onDone({ error: undefined })` and rejects with whatever error the
 * adapter reported.
 */
async function runSummary(
  llm: CompressLLM,
  buildCompressPrompt: (messages: Message[]) => string,
  messages: Message[],
): Promise<string> {
  const prompt = buildCompressPrompt(messages);
  const now = Date.now();

  let buffer = '';
  await new Promise<void>((resolve, reject) => {
    void llm
      .streamChat({
        messages: [
          {
            id: 'compress-sys',
            role: 'system',
            content: SUMMARY_SYSTEM_PROMPT,
            createdAt: now,
          },
          {
            id: 'compress-usr',
            role: 'user',
            content: prompt,
            createdAt: now,
          },
        ],
        tools: [],
        onChunk: (text: string): void => {
          buffer += text;
        },
        onToolCalls: (): void => {
          // Summaries should never trigger tool calls; ignore if a
          // misbehaving model emits one.
        },
        onDone: (result): void => {
          if (result.error !== undefined) {
            reject(new Error(result.error));
            return;
          }
          resolve();
        },
      })
      .catch((cause: unknown) => {
        // streamChat documents itself as not throwing post-connection,
        // but defensive: surface any pre-stream errors as a rejection.
        const msg = cause instanceof Error ? cause.message : String(cause);
        reject(new Error(msg));
      });
  });

  return buffer.trim();
}

// COMPRESS-STRATEGY-SECTION
/**
 * Strategy-aware execution path. Picks one of
 * `dedup | summarize | truncate` via {@link chooseCompressStrategy}
 * and applies it via `contextManager.replaceAll`.
 *
 * Reporting matches the legacy path: "✓ Compressed: N → M (saved ~T
 * tokens). Strategy: X". The summary text (when present) is also
 * persisted to the session row so `/resume` can re-inject it.
 */
interface RunStrategyPathArgs {
  backend: Backend;
  contextManager: CompressContextManager;
  replaceAll: (messages: readonly Message[]) => void;
  llm: CompressLLM;
  buildCompressPrompt: (messages: Message[]) => string;
  sessionManager?: SessionManager;
  sessionId: string | null;
  ctx: CommandContext;
}

async function runStrategyPath(args: RunStrategyPathArgs): Promise<void> {
  const {
    backend,
    contextManager,
    replaceAll,
    llm,
    buildCompressPrompt,
    sessionManager,
    sessionId,
    ctx,
  } = args;

  const messages = contextManager.getMessages();
  const beforeCount = messages.length;

  // Dry-run dedup first so we can feed the savings estimate into the
  // selector. The dedup pass is pure / cheap (no LLM call).
  const dedupTrial = dedupReadResults(messages);

  const strategy: CompressStrategyName = chooseCompressStrategy({
    backend,
    messages,
    dedupSavingsTokens: dedupTrial.removedTokens,
  });

  ctx.print(
    `Compressing context… strategy: ${strategy}` +
      (strategy === 'summarize'
        ? ` (cheap model: ${resolveCheapModel(backend) ?? 'unknown'})`
        : ''),
  );

  const summarizer = async (msgs: readonly Message[]): Promise<string> => {
    return runSummary(llm, buildCompressPrompt, msgs.slice());
  };

  let outcome;
  try {
    outcome = await applyCompressStrategy({
      strategy,
      messages,
      summarize: summarizer,
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Compression failed: ${msg}`);
    return;
  }

  replaceAll(outcome.messages);
  const afterCount = outcome.messages.length;
  const saved = Math.max(0, outcome.removedTokens);
  ctx.print(
    `✓ Compressed: ${beforeCount} messages → ${afterCount} (saved ~${saved} tokens). Strategy: ${outcome.applied}.`,
  );

  if (outcome.summary !== undefined && outcome.summary.length > 0) {
    const preview =
      outcome.summary.length > SUMMARY_PREVIEW_CHARS
        ? `${outcome.summary.slice(0, SUMMARY_PREVIEW_CHARS)}…`
        : outcome.summary;
    ctx.print(`Summary: ${preview}`);

    if (sessionId && sessionManager) {
      try {
        sessionManager.updateSummary(sessionId, outcome.summary);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`(Warning: failed to persist summary to session: ${msg})`);
      }
    }
  }
}
// COMPRESS-STRATEGY-SECTION-END
