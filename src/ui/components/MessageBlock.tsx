/**
 * A single structured turn rendered in the chat log.
 *
 * Replaces the inline MessageRow in ChatScreen for user/assistant/tool/
 * system messages. Adds:
 *   - A coloured left bar per role (purple/user, purple/assistant, gray/tool
 *     or system), plus the role label.
 *   - Structured assistant rendering: parses fenced code blocks
 *     ```lang …``` linearly and renders them in a muted bordered box
 *     with per-line numbers and a `▸ code (<lang>)` header.
 *   - Optional usage footer beneath assistant content via `UsageFooter`.
 *
 * Task 7: message separators + structured rendering.
 * Task 13: UsageFooter integration.
 * Task 22: `label` comes from the caller (ChatScreen passes the active
 *   model name for role==='assistant'; was 'You' for user but not any
 *   more — see below; 'tool: <name>' for tool; plain 'system' otherwise).
 *
 * Round 3 additions:
 *   - FIX #24: `role==='user'` no longer renders any textual label. The
 *     content is wrapped in `theme.userMessageBg` (purple bg + white fg)
 *     per line, prefixed by a lavender bar `▎`. Resembles the Claude
 *     Code chat UX. Multi-line content keeps its visual grouping
 *     because the bg is applied per line.
 *   - FIX #26: purple theme palette replaces raw ink colour names.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import UsageFooter from './UsageFooter.js';
import CodeBlock from './CodeBlock.js';
import { assistantText, inlineCode, noxPalette, textMuted, theme } from '../theme.js';
import {
  parseTables,
  type Alignment,
  type ParsedTable,
} from '../markdown/table-detector.js';

export type MessageBlockRole = 'user' | 'assistant' | 'system' | 'tool';

export interface MessageBlockProps {
  readonly role: MessageBlockRole;
  readonly label: string;
  readonly content: string;
  readonly createdAt?: number;
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly durationMs?: number;
  /** Session total output tokens; forwarded to UsageFooter on assistant. */
  readonly sessionTotalOut?: number;
  /**
   * Optional per-message model name. When provided (and non-empty), it
   * is rendered as the assistant role header in preference to `label`.
   * Lets callers attach the model that generated this specific message
   * so switching the active model mid-session does not retroactively
   * relabel committed history. `label` stays the fallback for legacy
   * call sites and for assistant rows persisted before the field
   * existed.
   */
  readonly model?: string;
  // COST-FOOTER-PROPS-SECTION (start)
  // Cumulative spend annotations forwarded straight through to the
  // underlying `UsageFooter`. Optional — when undefined / zero, the
  // footer omits the segments.
  readonly sessionCostUsd?: number;
  readonly todayCostUsd?: number;
  // COST-FOOTER-PROPS-SECTION (end)
}

/**
 * Ink/yoga renders text with a left vertical bar by using a single
 * glyph cell in a coloured Box column. This string is the bar glyph —
 * U+258E (LEFT ONE QUARTER BLOCK) looks like a thin vertical line.
 */
const BAR = '▎';

interface Segment {
  readonly kind: 'text' | 'code' | 'table';
  readonly lang?: string;
  readonly body: string;
  readonly table?: ParsedTable;
}

/**
 * Split markdown-ish assistant content into alternating text/code
 * segments. Fenced blocks are delimited by triple-backtick lines; the
 * opening fence may include a language identifier. Unterminated fences
 * at end-of-content are treated as code (mirrors most markdown renderers).
 */
function parseSegments(raw: string): Segment[] {
  const lines = raw.split(/\r?\n/);
  const segs: Segment[] = [];

  let inCode = false;
  let codeLang: string | undefined;
  let buf: string[] = [];

  const flushText = (): void => {
    if (buf.length === 0) return;
    // Drop leading/trailing blank runs but preserve internal formatting.
    while (buf.length > 0 && (buf[0] ?? '').trim().length === 0) buf.shift();
    while (buf.length > 0 && (buf[buf.length - 1] ?? '').trim().length === 0) buf.pop();
    if (buf.length === 0) return;
    segs.push({ kind: 'text', body: buf.join('\n') });
    buf = [];
  };

  const flushCode = (): void => {
    segs.push({ kind: 'code', lang: codeLang, body: buf.join('\n') });
    buf = [];
    codeLang = undefined;
  };

  for (const line of lines) {
    const fence = /^```(.*)$/.exec(line);
    if (fence !== null) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushText();
        inCode = true;
        const langPart = (fence[1] ?? '').trim();
        codeLang = langPart.length > 0 ? langPart : undefined;
      }
      continue;
    }
    buf.push(line);
  }

  // End-of-content: drain whichever mode we're in.
  if (inCode) {
    flushCode();
  } else {
    flushText();
  }

  // Pass 2: expand text segments into text/table sub-segments using the
  // shared GFM parser. Code segments are left untouched.
  const expanded: Segment[] = [];
  for (const s of segs) {
    if (s.kind !== 'text') {
      expanded.push(s);
      continue;
    }
    const tables = parseTables(s.body);
    for (const block of tables.blocks) {
      if (block.kind === 'text') {
        const trimmed = block.content.replace(/^\n+|\n+$/g, '');
        if (trimmed.length === 0) continue;
        expanded.push({ kind: 'text', body: trimmed });
      } else {
        expanded.push({ kind: 'table', body: '', table: block.table });
      }
    }
  }
  return expanded;
}

/** Visual width of a string for column-sizing. Strips ANSI just in case. */
function visualWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').length;
}

/** Pad a string to width `w` honouring alignment. */
function alignCell(text: string, w: number, align: Alignment): string {
  const len = visualWidth(text);
  if (len >= w) return text;
  const pad = w - len;
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return ' '.repeat(left) + text + ' '.repeat(right);
  }
  return text + ' '.repeat(pad);
}

interface TableViewProps {
  readonly table: ParsedTable;
  readonly textColor: string | undefined;
}

function TableView({ table, textColor }: TableViewProps): React.JSX.Element {
  const cols = table.headers.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = visualWidth(table.headers[c] ?? '');
    for (const row of table.rows) {
      const cell = row[c] ?? '';
      const cw = visualWidth(cell);
      if (cw > w) w = cw;
    }
    widths.push(Math.max(1, w));
  }
  const totalWidth =
    widths.reduce((a, b) => a + b, 0) +
    cols * 2 + // padX = 1 each side
    (cols + 1); // column separators '│'
  const sep = '─'.repeat(totalWidth);

  const renderRow = (
    cells: readonly string[],
    keyPrefix: string,
    bold: boolean,
  ): React.JSX.Element => (
    <Box flexDirection="row" key={keyPrefix}>
      <Text color={textMuted}>│</Text>
      {cells.map((cell, i) => {
        const align = table.alignments[i] ?? 'left';
        const w = widths[i] ?? 1;
        const padded = alignCell(cell, w, align);
        return (
          <React.Fragment key={`${keyPrefix}-c${i}`}>
            <Text color={textColor} bold={bold}>{` ${padded} `}</Text>
            <Text color={textMuted}>│</Text>
          </React.Fragment>
        );
      })}
    </Box>
  );

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={textMuted}>{sep}</Text>
      {renderRow(table.headers, 'th', true)}
      <Text color={textMuted}>{sep}</Text>
      {table.rows.map((row, ri) => renderRow(row, `tr-${ri}`, false))}
      {table.rows.length > 0 && <Text color={textMuted}>{sep}</Text>}
    </Box>
  );
}

/**
 * Render a single text segment (between fenced blocks) with inline-code
 * styling: single-backtick `…` spans get the warm-yellow accent.
 *
 * The split is regex-based and conservative — we only split on a single
 * backtick that is NOT adjacent to another backtick (so triple-backticks
 * outside of fenced contexts and double-backticks for literal markdown
 * are left as-is). Strings without inline code roundtrip unchanged.
 *
 * Returns a `<Text>` element (NEVER a bare string) so it can be safely
 * placed inside `<Box>` parents — ink rejects bare strings as Box
 * children with a runtime error.
 */
function renderTextLineWithInlineCode(
  line: string,
  textColour: string | undefined,
): React.JSX.Element {
  if (line.length === 0) {
    return <Text color={textColour}>{' '}</Text>;
  }
  // Split on `...` runs that don't contain backticks themselves. The
  // capture group keeps the inline code visible so we can restyle it.
  const parts = line.split(/(`[^`\n]+`)/g);
  if (parts.length <= 1) {
    return <Text color={textColour}>{line}</Text>;
  }
  return (
    <Text color={textColour}>
      {parts.map((part, i) => {
        if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
          // Strip the surrounding backticks; render the *contents* with
          // the inline-code colour but keep the backtick pair around
          // so users can still copy the source verbatim. The chalk-
          // styled `inlineCode(inner)` is a string with embedded ANSI
          // codes — `<Text>` renders it as-is.
          const inner = part.slice(1, -1);
          return (
            <Text key={`ic-${i}`}>
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

interface RoleHeaderProps {
  readonly role: MessageBlockRole;
  readonly label: string;
}

function RoleHeader({ role, label }: RoleHeaderProps): React.JSX.Element {
  // Tools use a different glyph: └─
  if (role === 'tool') {
    return (
      <Box flexDirection="row">
        <Text color={textMuted}>└─</Text>
        <Text>{' '}</Text>
        <Text color={noxPalette.light}>{label}</Text>
      </Box>
    );
  }
  if (role === 'assistant') {
    return (
      <Box flexDirection="row">
        <Text color={noxPalette.primary} bold>
          {BAR}
        </Text>
        <Text>{' '}</Text>
        <Text color={noxPalette.light} bold>
          {label}
        </Text>
      </Box>
    );
  }
  // system (fallback — user has its own renderer that skips the
  // label, so this branch is only reachable for 'system').
  return (
    <Box flexDirection="row">
      <Text color={textMuted} bold>
        {BAR}
      </Text>
      <Text>{' '}</Text>
      <Text color={textMuted} bold>
        {label}
      </Text>
    </Box>
  );
}

/**
 * FIX #24 — render a user message as a bar + bg-tinted content, with
 * no textual label. Multi-line content gets the bg applied per line
 * so wrapping keeps the visual grouping and doesn't leak the bg into
 * unrelated rows.
 */
function UserMessageBlock({ content }: { readonly content: string }): React.JSX.Element {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [''];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Box key={`u-line-${i}`} flexDirection="row">
            <Text>{theme.userMessageBar}</Text>
            <Text>{' '}</Text>
            <Text>{theme.userMessageBg(` ${line} `)}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function MessageBlockImpl(props: MessageBlockProps): React.JSX.Element {
  const { role, content } = props;
  // Per-message `model` wins over the caller-supplied `label` for
  // assistant rows. Other roles ignore it.
  const label =
    role === 'assistant' &&
    typeof props.model === 'string' &&
    props.model.length > 0
      ? props.model
      : props.label;

  // NOTE: hooks must be called unconditionally; any early-return based
  // on role has to happen after the hook calls.
  const segments = useMemo(() => {
    if (role === 'assistant') return parseSegments(content);
    // Non-assistant roles render content verbatim as a single text block.
    return [{ kind: 'text' as const, body: content }];
  }, [content, role]);

  // FIX #24 — user messages skip all label rendering and use the new
  // bg-tinted strip.
  if (role === 'user') {
    return <UserMessageBlock content={content} />;
  }

  // Tool messages are rendered indented, no bar.
  if (role === 'tool') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <RoleHeader role={role} label={label} />
        {content.length > 0 && (
          <Box paddingLeft={3} flexDirection="column">
            {content.split(/\r?\n/).map((line, i) => (
              <Text key={`tool-line-${i}`} color={textMuted}>
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  // Round 6 (Agent 4): assistant body text now renders in `assistantText`
  // (#e9d5ff, the lavender off-white from `noxPalette.white`). User
  // screenshots showed the previous inherited terminal-foreground colour
  // landed too dim on the dark theme. Other roles (`system`) keep the
  // default ink foreground because they're rarely-rendered fallbacks.
  const textColor = role === 'assistant' ? assistantText : undefined;

  return (
    <Box flexDirection="column" paddingX={1}>
      <RoleHeader role={role} label={label} />
      {segments.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {segments.map((seg, i) => {
            if (seg.kind === 'code') {
              return (
                <CodeBlock
                  key={`seg-${i}`}
                  language={seg.lang}
                  code={seg.body}
                />
              );
            }
            if (seg.kind === 'table' && seg.table) {
              return (
                <TableView
                  key={`seg-${i}`}
                  table={seg.table}
                  textColor={textColor}
                />
              );
            }
            return (
              <Box key={`seg-${i}`} flexDirection="column">
                {seg.body.split(/\r?\n/).map((line, j) => (
                  <Box key={`seg-${i}-line-${j}`} flexDirection="row">
                    {renderTextLineWithInlineCode(line, textColor)}
                  </Box>
                ))}
              </Box>
            );
          })}
        </Box>
      )}
      {role === 'assistant' && hasUsageData(props) && (
        <Box paddingLeft={2}>
          <UsageFooter
            tokensInput={props.tokensInput}
            tokensOutput={props.tokensOutput}
            durationMs={props.durationMs}
            sessionTotalOut={props.sessionTotalOut}
            // COST-FOOTER-PROPS-SECTION — forward through to footer.
            sessionCostUsd={props.sessionCostUsd}
            todayCostUsd={props.todayCostUsd}
            // COST-FOOTER-PROPS-SECTION-END
          />
        </Box>
      )}
    </Box>
  );
}

/**
 * R7 (Agent 4) — flicker reduction.
 *
 * Don't even mount the `<UsageFooter>` wrapper while the assistant
 * message has no usage numbers yet. Originally the wrapper was
 * unconditionally rendered for every assistant message and relied on
 * `UsageFooter` to return `null` when empty — but ink still allocated
 * a layout cell for the wrapping `<Box paddingLeft={2}>`, and a
 * subsequent transition from "no data" to "has data" would expand
 * that cell, shifting all rows below by one line. By skipping the
 * wrapper outright we get zero layout impact in the empty state and
 * a single clean transition when the numbers land.
 */
function hasUsageData(props: MessageBlockProps): boolean {
  if (props.tokensInput !== undefined && Number.isFinite(props.tokensInput))
    return true;
  if (props.tokensOutput !== undefined && Number.isFinite(props.tokensOutput))
    return true;
  if (
    props.durationMs !== undefined &&
    Number.isFinite(props.durationMs) &&
    props.durationMs > 0
  )
    return true;
  if (
    props.sessionTotalOut !== undefined &&
    Number.isFinite(props.sessionTotalOut) &&
    props.sessionTotalOut > 0
  )
    return true;
  return false;
}

/**
 * R7 (Agent 4) — flicker reduction.
 *
 * The chat log can grow to many committed messages (50–100+ in a long
 * session). Without memoisation, every parent re-render — and there's
 * one per streamed chunk while the assistant is generating — re-runs
 * `MessageBlock` for ALL committed messages, even though their props
 * never change after first paint. ink then issues a fresh ANSI write
 * to stdout for each row, which on a sluggish terminal manifests as
 * flicker / cursor jumps.
 *
 * Wrapping the implementation in `React.memo` short-circuits those
 * re-renders. The default referential-equality comparator works for
 * us because:
 *   1. `role`, `label`, `content` are primitives.
 *   2. `createdAt`, `tokensInput`, `tokensOutput`, `durationMs`,
 *      `sessionTotalOut` are primitives or undefined.
 *   3. Once a message is committed (its props captured into the
 *      `messages` array passed to ChatScreen), its identity is
 *      stable until a real change lands — at which point we DO want
 *      to repaint.
 * The streaming buffer is rendered separately by `<StreamOutput>` (and
 * now `<StreamingMessageBlock>`), so committed `MessageBlock` rows
 * stay fully memoised throughout the stream.
 */
const MessageBlock = React.memo(MessageBlockImpl);

export default MessageBlock;
