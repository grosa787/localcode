/**
 * TOOL-RENDERERS-SECTION — `read_file` rich renderer.
 *
 * Renders a mini code preview of the file body:
 *   - language detected from the extension (or content sniff),
 *   - line numbers in the gutter,
 *   - folded view when the body exceeds 40 lines (first 20 + last 5,
 *     with a `--- (N lines hidden) ---` separator).
 *
 * Re-uses `<CodeBlock>` for syntax highlighting + framing so the visual
 * vocabulary matches assistant-rendered code fences. The cached
 * highlighter (`src/ui/highlighting/syntax-highlight.ts`) keeps the cost
 * to one FNV lookup per re-render.
 */

import React from 'react';
import { Box, Text } from 'ink';
import CodeBlock from '../components/CodeBlock.js';
import { textMuted } from '../theme.js';
import type {
  RenderToolResult,
  ToolRendererResult,
} from './types.js';
import { normaliseLanguage } from '../highlighting/syntax-highlight.js';

const FOLD_THRESHOLD = 40;
const FOLD_HEAD = 20;
const FOLD_TAIL = 5;

/** Map a path extension to a fence label `<CodeBlock>` understands. */
function extensionLanguage(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  if (ext.length === 0) return undefined;
  // Let normaliseLanguage decide whether the extension maps to a known
  // language id; unknown ones return undefined and CodeBlock falls
  // back to plaintext.
  return normaliseLanguage(ext) ?? ext;
}

/**
 * Drop the pagination/truncation footer that `read_file` appends when
 * it auto-paginates a >1MB file. The body above the footer is real
 * source; the footer is metadata we surface separately as a meta line.
 */
function splitBodyAndFooter(output: string): {
  readonly body: string;
  readonly footer?: string;
} {
  // The two patterns the tool uses (search literal substring — these
  // strings are emitted verbatim by src/tools/read-file.ts).
  const FOOTER_PREFIXES = [
    '\n--- File truncated at line ',
    '\n\n[... file truncated:',
    '\n--- Summary of ',
    '\n--- End summary;',
  ];
  for (const prefix of FOOTER_PREFIXES) {
    const idx = output.indexOf(prefix);
    if (idx > 0) {
      return {
        body: output.slice(0, idx),
        footer: output.slice(idx + 1), // skip the leading newline
      };
    }
  }
  return { body: output };
}

interface FoldedView {
  readonly text: string;
  readonly hiddenCount: number;
}

/**
 * Apply the head/tail fold when the body has more lines than the
 * threshold. The returned `text` already contains the separator line
 * so the caller can splice it into the code preview as-is.
 */
function applyFold(raw: string): FoldedView | null {
  const lines = raw.split('\n');
  if (lines.length <= FOLD_THRESHOLD) return null;
  const head = lines.slice(0, FOLD_HEAD);
  const tail = lines.slice(lines.length - FOLD_TAIL);
  const hidden = lines.length - FOLD_HEAD - FOLD_TAIL;
  const separator = `--- (${hidden} lines hidden) ---`;
  const text = [...head, separator, ...tail].join('\n');
  return { text, hiddenCount: hidden };
}

interface ReadFileArgs {
  readonly path?: unknown;
  readonly respondWithSummary?: unknown;
}

function getPath(args: Record<string, unknown>): string | undefined {
  const p = (args as ReadFileArgs).path;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

function isSummaryMode(args: Record<string, unknown>): boolean {
  return (args as ReadFileArgs).respondWithSummary === true;
}

function ReadFileRenderer({
  args,
  result,
}: {
  readonly args: Record<string, unknown>;
  readonly result: ToolRendererResult;
}): React.JSX.Element | null {
  const path = getPath(args);
  if (path === undefined) return null;
  const raw = result.output ?? '';
  if (raw.length === 0) return null;
  const { body, footer } = splitBodyAndFooter(raw);
  // Summary mode is metadata-heavy; render it as a labelled block
  // without the gutter — it's not source code.
  if (isSummaryMode(args)) {
    return (
      <Box flexDirection="column" paddingLeft={3} marginTop={0}>
        <Text color={textMuted}>{`Summary of ${path}`}</Text>
        <Box flexDirection="column" paddingLeft={1}>
          {raw.split('\n').map((line, i) => (
            <Text key={`rf-summary-${i}`} color={textMuted}>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }
  const fold = applyFold(body);
  const sourceForPreview = fold !== null ? fold.text : body;
  const language = extensionLanguage(path);
  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={0}>
      <CodeBlock
        code={sourceForPreview}
        language={language}
        headerOverride={path}
        showLineNumbers
        maxLines={FOLD_THRESHOLD + 5}
      />
      {footer !== undefined && footer.length > 0 && (
        <Box flexDirection="column" paddingLeft={1}>
          {footer.split('\n').map((line, i) => (
            <Text key={`rf-foot-${i}`} color={textMuted}>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

export const render: RenderToolResult = (args, result) => {
  if (result.status !== 'done') return null;
  const out = result.output;
  if (typeof out !== 'string' || out.length === 0) return null;
  return <ReadFileRenderer args={args} result={result} />;
};
