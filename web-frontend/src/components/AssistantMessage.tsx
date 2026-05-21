/**
 * AssistantMessage — left-aligned full-column row with markdown body.
 *
 * Spec:
 *   - 2px left accent bar (8px tall, first-line only) — visual mark.
 *   - Model name above content (12px, --text-muted).
 *   - Markdown body in --text-primary.
 *   - No bubble.
 *
 * The component accepts a `streaming` flag — while a chunk is in flight
 * we render a subtle blinking caret after the body. The chunked text is
 * appended in place by the parent (`ChatView`); we never animate token
 * appearance per spec ("appearance is the chunk arriving").
 *
 * Perf:
 *   - Wrapped in `React.memo` — props are primitive (content, model,
 *     streaming) so the default shallow compare is sufficient. Avoids
 *     re-rendering every committed assistant message on every Composer
 *     keystroke (long sessions hit hundreds of messages).
 *   - Markdown parse + highlight is `useMemo`'d on `[content]` so the
 *     parsed JSX tree is reused while the message is static. Streaming
 *     messages re-parse only when `content` actually changes (which is
 *     correct — the chunk has arrived).
 */
import { memo, useMemo, type JSX } from 'react';

import { Markdown } from '../util/markdown';
// VOICE-OUTPUT-SECTION (import) — TTS controls for assistant replies.
import { VoiceOutputButton } from './VoiceOutputButton';
// VOICE-OUTPUT-SECTION-END (import)

import styles from './AssistantMessage.module.css';

export interface AssistantMessageProps {
  /** Model identifier shown above the content (e.g. "claude-3-5-sonnet"). */
  model?: string | null;
  /** Markdown body. */
  content: string;
  /** True while the model is still streaming chunks into this message. */
  streaming?: boolean;
  // MESSAGE-COST-CHIP-SECTION
  /** USD cost for this row — persisted at addMessage time by SessionManager. */
  cost?: number;
  /** Input (prompt) token count for this turn. */
  tokensInput?: number;
  /** Output (completion) token count for this turn. */
  tokensOutput?: number;
  /** Wall-clock duration for this turn in ms. */
  durationMs?: number;
  // MESSAGE-COST-CHIP-SECTION-END
}

// MESSAGE-COST-CHIP-SECTION
/**
 * Format a USD number for the per-message chip. Mirrors
 * `formatCostCell` from `@/llm/pricing/cost-calculator` but kept inline
 * to avoid pulling the entire pricing module into the web bundle.
 */
function formatCostShort(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.005) return '$0.00';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Compact "1.2k" / "320" formatter for token counts. Avoids visual
 * noise from long numbers while preserving order-of-magnitude.
 */
function formatTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Compact duration formatter — milliseconds for sub-second turns,
 * seconds with one decimal otherwise.
 */
function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
// MESSAGE-COST-CHIP-SECTION-END

function AssistantMessageImpl({
  model,
  content,
  streaming = false,
  // MESSAGE-COST-CHIP-SECTION
  cost,
  tokensInput,
  tokensOutput,
  durationMs,
  // MESSAGE-COST-CHIP-SECTION-END
}: AssistantMessageProps): JSX.Element {
  const showModel = model !== undefined && model !== null && model.length > 0;
  const showEmpty = content.length === 0 && streaming;

  // Memoise the parsed markdown tree on `content`. Re-parsing the entire
  // markdown body and re-running the syntax highlighter on every parent
  // re-render (e.g. Composer keystroke causing ChatView to update) is the
  // dominant cost in long vibe-coding sessions.
  const markdownTree = useMemo(() => <Markdown source={content} />, [content]);

  // MESSAGE-COST-CHIP-SECTION
  // Render the chip only when at least one field is informative — a
  // pure-text reply with no telemetry shouldn't show a stub chip.
  const showCostChip =
    !streaming &&
    ((cost !== undefined && cost > 0) ||
      (tokensInput !== undefined && tokensInput > 0) ||
      (tokensOutput !== undefined && tokensOutput > 0));
  const chipParts: string[] = [];
  if (showCostChip) {
    if (showModel && model !== undefined && model !== null) {
      chipParts.push(model);
    }
    if (cost !== undefined && cost > 0) chipParts.push(formatCostShort(cost));
    if (tokensInput !== undefined && tokensInput > 0) {
      chipParts.push(`${formatTokensShort(tokensInput)} in`);
    }
    if (tokensOutput !== undefined && tokensOutput > 0) {
      chipParts.push(`${formatTokensShort(tokensOutput)} out`);
    }
    if (durationMs !== undefined && durationMs > 0) {
      chipParts.push(formatDurationShort(durationMs));
    }
  }
  // MESSAGE-COST-CHIP-SECTION-END

  return (
    <div
      className={styles.root}
      data-streaming={streaming ? 'true' : 'false'}
      role="article"
      aria-label="Assistant message"
    >
      <div className={styles.accent} aria-hidden="true" />
      <div className={styles.body}>
        {showModel ? (
          <div className={styles.model}>{model}</div>
        ) : null}
        {showEmpty ? (
          <div className={styles.placeholder}>
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
          </div>
        ) : (
          <div className={styles.markdown}>
            {markdownTree}
            {streaming ? <span className={styles.caret} aria-hidden="true" /> : null}
          </div>
        )}
        {/* VOICE-OUTPUT-SECTION — render the speak control only on fully
            committed messages (streaming pings re-render constantly so we
            wait until the body is final before mounting the button). */}
        {!streaming && content.length > 0 ? (
          <VoiceOutputButton text={content} />
        ) : null}
        {/* VOICE-OUTPUT-SECTION-END */}
        {/* MESSAGE-COST-CHIP-SECTION — single-line chip under the body.
            Only rendered when at least one telemetry field is non-zero
            so a pure-text reply doesn't show a stub. */}
        {showCostChip && chipParts.length > 0 ? (
          <div
            className={styles.costChip}
            data-testid="assistant-cost-chip"
            aria-label="Turn cost and token usage"
          >
            {chipParts.join(' · ')}
          </div>
        ) : null}
        {/* MESSAGE-COST-CHIP-SECTION-END */}
      </div>
    </div>
  );
}

export const AssistantMessage = memo(AssistantMessageImpl);
