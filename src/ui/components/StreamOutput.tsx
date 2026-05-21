/**
 * Renders streaming assistant text with progressive syntax highlighting.
 *
 * Round 13 (Agent C, ROADMAP #3) — replaces the old "single Text cell"
 * implementation with a structure-aware renderer:
 *
 *   - Completed fenced code blocks (i.e. an opening ``` followed
 *     somewhere later by a closing ```) are passed to `<CodeBlock>` and
 *     get FULL syntax highlighting, just like committed messages.
 *   - The open / in-flight code block (text after the *last* unmatched
 *     opening ``` with no closing ``` yet) is rendered in a frameless
 *     muted-text variant. We do NOT highlight it because re-tokenising
 *     on every chunk would (a) churn CPU, (b) potentially highlight
 *     half-typed identifiers as wrong tokens. As soon as the closing
 *     fence arrives, the block flips to the highlighted view in the
 *     same render pass.
 *   - Plain prose between blocks renders as `<Text>` with the usual
 *     assistant colour and inline-code inflection.
 *
 * The component remains memoised on its single `text` prop. Because
 * the parsing is `useMemo`-ised on `text`, identical buffers (which
 * happen during the live streaming feedback loop) skip all work.
 *
 * Layout: kept inside a `<Box paddingX={1}>` to mirror the original
 * spacing — visual rhythm with the surrounding chat must not change.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import CodeBlock from './CodeBlock.js';
import { normaliseLanguage } from '../highlighting/syntax-highlight.js';
import { assistantText, inlineCode, textMuted } from '../theme.js';

export interface StreamOutputProps {
  readonly text: string;
}

interface CompletedSegment {
  readonly kind: 'text' | 'code';
  readonly lang?: string;
  readonly body: string;
}

interface StreamPlan {
  readonly segments: readonly CompletedSegment[];
  /**
   * The "live" tail — content after the last unmatched opening fence,
   * if any. Rendered as muted plain text until the closing fence
   * arrives.
   */
  readonly liveTail?: { readonly lang?: string; readonly body: string };
  /**
   * Trailing prose with no open fence. Rendered with the usual
   * assistant text colour and inline-code highlighting.
   */
  readonly trailingText?: string;
}

/**
 * Walk the buffer once, classifying spans into completed text /
 * completed code / live-code-tail / trailing-text. We deliberately
 * mirror the parser used in `MessageBlock.parseSegments` so the visual
 * transition from "streaming" to "committed" doesn't reflow content.
 */
function planStream(raw: string): StreamPlan {
  const segments: CompletedSegment[] = [];
  const lines = raw.split('\n');

  let inCode = false;
  let codeLang: string | undefined;
  let buf: string[] = [];

  const flushTextSegment = (): void => {
    if (buf.length === 0) return;
    // Trim leading / trailing blank-only lines for completed segments
    // so the visual rhythm matches MessageBlock.parseSegments.
    while (buf.length > 0 && (buf[0] ?? '').trim().length === 0) buf.shift();
    while (buf.length > 0 && (buf[buf.length - 1] ?? '').trim().length === 0)
      buf.pop();
    if (buf.length === 0) return;
    segments.push({ kind: 'text', body: buf.join('\n') });
    buf = [];
  };

  const flushCodeSegment = (): void => {
    segments.push({ kind: 'code', lang: codeLang, body: buf.join('\n') });
    buf = [];
    codeLang = undefined;
  };

  for (const line of lines) {
    const fence = /^```(.*)$/.exec(line);
    if (fence !== null) {
      if (inCode) {
        flushCodeSegment();
        inCode = false;
      } else {
        flushTextSegment();
        inCode = true;
        const langPart = (fence[1] ?? '').trim();
        codeLang = langPart.length > 0 ? langPart : undefined;
      }
      continue;
    }
    buf.push(line);
  }

  if (inCode) {
    // Live tail — open fence, no close yet.
    return {
      segments,
      liveTail: { lang: codeLang, body: buf.join('\n') },
    };
  }

  // No live code block — we DO emit the trailing text even if it's
  // pure whitespace, because during streaming the user sees this band
  // grow character-by-character and trimming would visibly delete
  // their just-typed words.
  if (buf.length === 0) {
    return { segments };
  }
  return { segments, trailingText: buf.join('\n') };
}

/**
 * Inline-code colourisation for a streaming text line. Mirrors
 * `MessageBlock.renderTextLineWithInlineCode` so prose looks identical
 * across the live and committed states.
 *
 * Returns a `<Text>` element (NEVER a bare string) so it can sit
 * inside a `<Box>` without ink throwing a runtime error.
 */
function renderTextLineWithInlineCode(
  line: string,
  textColour: string,
): React.JSX.Element {
  if (line.length === 0) {
    return <Text color={textColour}>{' '}</Text>;
  }
  const parts = line.split(/(`[^`\n]+`)/g);
  if (parts.length <= 1) {
    return <Text color={textColour}>{line}</Text>;
  }
  return (
    <Text color={textColour}>
      {parts.map((part, i) => {
        if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
          const inner = part.slice(1, -1);
          return (
            <Text key={`s-ic-${i}`}>
              <Text color={textMuted}>{'`'}</Text>
              {inlineCode(inner)}
              <Text color={textMuted}>{'`'}</Text>
            </Text>
          );
        }
        return part;
      })}
    </Text>
  );
}

interface TextSegmentProps {
  readonly body: string;
  readonly textColour: string;
}

function TextSegment({ body, textColour }: TextSegmentProps): React.JSX.Element {
  const lines = body.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={`stxt-${i}`} flexDirection="row">
          {renderTextLineWithInlineCode(line, textColour)}
        </Box>
      ))}
    </Box>
  );
}

interface LiveTailProps {
  readonly lang: string | undefined;
  readonly body: string;
}

function LiveTail({ lang, body }: LiveTailProps): React.JSX.Element {
  const lines = body.length > 0 ? body.split('\n') : [''];
  // Normalise the fence label so "ts" surfaces as "typescript" — the
  // header text matches what `<CodeBlock>` will show once the closing
  // fence arrives, which avoids visual jitter on the boundary.
  const resolved = normaliseLanguage(lang);
  const headerLabel =
    resolved !== undefined ? resolved : lang !== undefined && lang.length > 0 ? lang : 'code';
  return (
    <Box flexDirection="column" marginY={1}>
      <Box flexDirection="row">
        <Text color={textMuted} italic>
          {`▸ ${headerLabel}  · streaming…`}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={1}>
        {lines.map((line, i) => (
          <Text key={`live-${i}`} color={textMuted}>
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function StreamOutputImpl({ text }: StreamOutputProps): React.JSX.Element {
  // Drop a trailing newline so we don't render a phantom blank row at
  // the very bottom of the live buffer.
  const normalised = text.endsWith('\n') ? text.slice(0, -1) : text;
  // M8 — `useMemo([normalised])` is the cheap path: identical buffers
  // (which happen often during the throttle-driven feedback loop) skip
  // all work. True incremental parsing (caching the last fence
  // boundary, only re-parsing from that offset) is invasive enough
  // that we deliberately defer it — the throttle in ChatScreen
  // bounds re-runs to ~6.7 Hz on the hot path, which the linear
  // line walk handles comfortably for assistant replies under ~5k
  // lines. Revisit if profiling shows planStream as a hotspot.
  const plan = useMemo(() => planStream(normalised), [normalised]);

  // Empty buffer → render a placeholder space so the layout cell exists
  // but doesn't visibly stutter.
  if (
    plan.segments.length === 0 &&
    plan.liveTail === undefined &&
    plan.trailingText === undefined
  ) {
    return (
      <Box paddingX={1}>
        <Text>{' '}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {plan.segments.map((seg, i) => {
        if (seg.kind === 'code') {
          return (
            <CodeBlock
              key={`stream-seg-${i}`}
              language={seg.lang}
              code={seg.body}
            />
          );
        }
        return (
          <TextSegment
            key={`stream-seg-${i}`}
            body={seg.body}
            textColour={assistantText}
          />
        );
      })}
      {plan.liveTail !== undefined && (
        <LiveTail lang={plan.liveTail.lang} body={plan.liveTail.body} />
      )}
      {plan.trailingText !== undefined && (
        <TextSegment body={plan.trailingText} textColour={assistantText} />
      )}
    </Box>
  );
}

const StreamOutput = React.memo(StreamOutputImpl);

export default StreamOutput;
