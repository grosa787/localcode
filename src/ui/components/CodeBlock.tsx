/**
 * `<CodeBlock>` — beautiful, themed renderer for fenced code blocks.
 *
 * ROADMAP #3 (Agent C): replaces the previous tiny inline `CodeBlock`
 * helper inside `MessageBlock.tsx` with a proper component that:
 *   - applies syntax highlighting via `cli-highlight` + the Nox palette
 *     (see `src/ui/highlighting/syntax-highlight.ts`),
 *   - shows a subtle bordered frame with a coloured language header,
 *   - renders left-padded line numbers and a vertical gutter,
 *   - truncates very long blocks (default 200 lines) so the chat log
 *     does not blow up on a 4000-line file paste,
 *   - falls back to a muted plain-text rendering when the language is
 *     unknown or the highlighter throws.
 *
 * The component is wrapped in `React.memo` with a custom comparator so
 * a parent re-render (e.g. streaming chunk arrival) does not trigger a
 * full re-tokenisation of every committed code block in the chat log.
 *
 * NB: ink renders strings containing ANSI escape sequences correctly —
 * a `<Text>{coloured}</Text>` cell preserves the escapes in the
 * terminal stream. So we tokenise once and pass the coloured string to
 * `<Text>`, *without* unwrapping per-token spans (that would be both
 * unnecessary and significantly slower on long files).
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { highlightCode, resolveLanguage } from '../highlighting/syntax-highlight.js';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
// MERMAID-DISPATCH-SECTION (TUI): the renderer routes ```mermaid blocks
// to the ASCII diagram renderer instead of plain syntax-highlighting.
import { parseMermaid } from '../mermaid/parser.js';
import { renderMermaidAscii } from '../mermaid/ascii-renderer.js';

export interface CodeBlockProps {
  /**
   * Language hint as it appeared on the opening fence (`ts`, `python`,
   * `Dockerfile`, etc). Pass `undefined` to trigger heuristic detection.
   */
  readonly language?: string;
  /** Raw source text. Newlines preserved exactly. */
  readonly code: string;
  /** Default true — gutter with right-aligned line numbers. */
  readonly showLineNumbers?: boolean;
  /**
   * Cap to apply before render. Default 200; lines beyond the cap are
   * dropped and a `... [N more]` row is shown instead.
   */
  readonly maxLines?: number;
  /**
   * When true, suppress the bordered frame entirely and emit raw
   * highlighted lines. Used by the live-streaming code path to avoid a
   * partial border around an in-progress block.
   */
  readonly frameless?: boolean;
  /**
   * Optional override for the header label. When omitted the resolved
   * language id is shown; pass an empty string to skip the header
   * altogether (useful for inline previews).
   */
  readonly headerOverride?: string;
}

const DEFAULT_MAX_LINES = 200;

/**
 * Replace empty lines with a single space so ink does not collapse a
 * blank row to zero height — keeps the visual rhythm of the original
 * source intact.
 */
function nonEmpty(line: string): string {
  return line.length === 0 ? ' ' : line;
}

interface GutterProps {
  readonly lineNumber: number;
  readonly width: number;
}

function Gutter({ lineNumber, width }: GutterProps): React.JSX.Element {
  // Right-align the number, then add the gutter glyph + a space.
  const num = String(lineNumber).padStart(width, ' ');
  return (
    <Box flexDirection="row">
      <Text color={textMuted} dimColor>
        {num}
      </Text>
      <Text color={dimSeparator}>{' │ '}</Text>
    </Box>
  );
}

interface HeaderProps {
  readonly label: string;
  readonly truncated: boolean;
  readonly visibleLines: number;
  readonly totalLines: number;
}

function Header(props: HeaderProps): React.JSX.Element {
  const { label, truncated, visibleLines, totalLines } = props;
  const counter = truncated
    ? `${visibleLines}/${totalLines} lines`
    : `${totalLines} ${totalLines === 1 ? 'line' : 'lines'}`;
  return (
    <Box flexDirection="row">
      <Text color={noxPalette.light} bold>
        {`▸ ${label}`}
      </Text>
      <Text color={textMuted}>{`  · ${counter}`}</Text>
    </Box>
  );
}

// MERMAID-DISPATCH-SECTION (TUI): self-contained diagram renderer.
// Parses + lays out once per (code, width) pair and renders the
// resulting lines into a bordered frame consistent with CodeBlock.
interface MermaidAsciiBlockProps {
  readonly code: string;
  readonly frameless: boolean;
}

function MermaidAsciiBlock(props: MermaidAsciiBlockProps): React.JSX.Element {
  const { code, frameless } = props;
  const cols = typeof process !== 'undefined' && process.stdout !== undefined
    ? (process.stdout.columns ?? 80)
    : 80;
  // Leave 4 cells for the border + padding so long edges don't wrap.
  const width = Math.max(24, cols - 6);
  const lines = useMemo(() => {
    try {
      const ast = parseMermaid(code);
      return renderMermaidAscii(ast, { width });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [`[mermaid] render error: ${msg}`];
    }
  }, [code, width]);
  const header = (
    <Box flexDirection="row">
      <Text color={noxPalette.light} bold>{'▸ mermaid'}</Text>
      <Text color={textMuted}>{`  · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}</Text>
    </Box>
  );
  const renderedLines = lines.map((line, i) => (
    <Text key={`mermaid-line-${i}`}>{line.length === 0 ? ' ' : line}</Text>
  ));
  if (frameless) {
    return (
      <Box flexDirection="column">
        {header}
        {renderedLines}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginY={1}>
      {header}
      <Box
        flexDirection="column"
        paddingX={1}
        borderStyle="round"
        borderColor={dimSeparator}
      >
        {renderedLines}
      </Box>
    </Box>
  );
}

function CodeBlockImpl(props: CodeBlockProps): React.JSX.Element {
  const {
    language,
    code,
    showLineNumbers = true,
    maxLines = DEFAULT_MAX_LINES,
    frameless = false,
    headerOverride,
  } = props;

  // MERMAID-DISPATCH-SECTION (TUI): handle ```mermaid blocks specially.
  if (language !== undefined && language.toLowerCase().trim() === 'mermaid') {
    return (
      <MermaidAsciiBlock code={code} frameless={frameless} />
    );
  }

  // Memoise the per-line highlighted output so streaming parents
  // (which re-render frequently) don't re-tokenise on every tick.
  const data = useMemo(() => {
    const allLines = code.split('\n');
    const truncated = allLines.length > maxLines;
    const visible = truncated ? allLines.slice(0, maxLines) : allLines;
    const visibleSrc = visible.join('\n');
    const resolvedLang = resolveLanguage(language, visibleSrc);
    const highlighted = highlightCode(visibleSrc, resolvedLang);
    const lines = highlighted.split('\n');
    return {
      lines,
      truncated,
      totalLines: allLines.length,
      visibleLines: visible.length,
      resolvedLang,
    };
  }, [code, language, maxLines]);

  const { lines, truncated, totalLines, visibleLines, resolvedLang } = data;
  const gutterWidth = String(visibleLines).length;
  const headerLabel =
    headerOverride !== undefined ? headerOverride : resolvedLang ?? 'code';

  const renderLines = (): React.JSX.Element[] =>
    lines.map((line, i) => (
      <Box key={`cb-line-${i}`} flexDirection="row">
        {showLineNumbers && <Gutter lineNumber={i + 1} width={gutterWidth} />}
        <Text>{nonEmpty(line)}</Text>
      </Box>
    ));

  const renderTruncationFooter = (): React.JSX.Element | null => {
    if (!truncated) return null;
    const remaining = totalLines - visibleLines;
    return (
      <Box flexDirection="row" paddingTop={0}>
        <Text color={textMuted} italic>
          {`… ${remaining} more line${remaining === 1 ? '' : 's'} (truncated)`}
        </Text>
      </Box>
    );
  };

  if (frameless) {
    return (
      <Box flexDirection="column">
        {headerLabel.length > 0 && (
          <Header
            label={headerLabel}
            truncated={truncated}
            visibleLines={visibleLines}
            totalLines={totalLines}
          />
        )}
        {renderLines()}
        {renderTruncationFooter()}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      {headerLabel.length > 0 && (
        <Header
          label={headerLabel}
          truncated={truncated}
          visibleLines={visibleLines}
          totalLines={totalLines}
        />
      )}
      <Box
        flexDirection="column"
        paddingX={1}
        borderStyle="round"
        borderColor={dimSeparator}
      >
        {renderLines()}
        {renderTruncationFooter()}
      </Box>
    </Box>
  );
}

/**
 * Custom comparator: avoid unnecessary re-renders during streaming.
 * Once `code` and `language` are stable (committed messages), the
 * memoised tokenisation should never re-run.
 */
function arePropsEqual(prev: CodeBlockProps, next: CodeBlockProps): boolean {
  if (prev.code !== next.code) return false;
  if (prev.language !== next.language) return false;
  if ((prev.showLineNumbers ?? true) !== (next.showLineNumbers ?? true))
    return false;
  if ((prev.maxLines ?? DEFAULT_MAX_LINES) !== (next.maxLines ?? DEFAULT_MAX_LINES))
    return false;
  if ((prev.frameless ?? false) !== (next.frameless ?? false)) return false;
  if (prev.headerOverride !== next.headerOverride) return false;
  return true;
}

const CodeBlock = React.memo(CodeBlockImpl, arePropsEqual);

export default CodeBlock;
