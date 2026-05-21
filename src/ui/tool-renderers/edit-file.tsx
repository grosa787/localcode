/**
 * TOOL-RENDERERS-SECTION — diff renderer for `edit_file` / `multi_edit`
 * / `write_file`.
 *
 * The tool layer surfaces the diff via `<InlineDiffView>` from
 * `ChatScreen` (it reads `toolCallStates.get(id).diffPreview`), so when
 * the commit step itself runs we just summarise the outcome:
 *
 *   ✎ <path>  +N -M lines
 *
 * If the tool's output happens to BE a unified diff (e.g. it came back
 * from the preview path that returns the full patch in `output`), we
 * render it as a small green/red diff block, keying off the unified
 * diff header markers (`---`, `+++`, `@@`).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import type {
  RenderToolResult,
  ToolRendererResult,
} from './types.js';
import FileRef from '../components/FileRef.js';

// RUN-AFFECTED-TESTS-SECTION
/**
 * Module-level dispatcher for the "Run relevant tests" inline button.
 *
 * The renderer is a pure function of (args, result, ctx) and cannot
 * thread a host callback through its signature without changing
 * `RenderToolResult` (out of scope for this section). Instead, the
 * composition root registers a handler here at boot; the button section
 * below calls it on dispatch. When no handler is registered the button
 * still renders (so users see the hint) but acts as a no-op note.
 *
 * The handler MUST route through the normal approval flow — the
 * `dispatchRunCommand` call below never spawns a process directly; it
 * is expected to wire into the chat runtime's `run_command` path which
 * gates on the user's permission profile / approval callback.
 */
export type RunAffectedTestsHandler = (info: {
  readonly changedFilePath: string;
  readonly projectRoot?: string;
}) => void;

let runAffectedTestsHandler: RunAffectedTestsHandler | null = null;

export function registerRunAffectedTestsHandler(
  handler: RunAffectedTestsHandler | null,
): void {
  runAffectedTestsHandler = handler;
}

export function getRunAffectedTestsHandler(): RunAffectedTestsHandler | null {
  return runAffectedTestsHandler;
}

/**
 * Programmatic entry point — invoked by the keyboard shortcut binding
 * in app.tsx (`Ctrl+T` when the last tool call was a successful file
 * edit) and by tests asserting the dispatch surface. Returns true when
 * a handler was wired and called, false otherwise.
 */
export function dispatchRunAffectedTests(info: {
  readonly changedFilePath: string;
  readonly projectRoot?: string;
}): boolean {
  if (runAffectedTestsHandler === null) return false;
  try {
    runAffectedTestsHandler(info);
    return true;
  } catch {
    // A throwing host handler shouldn't crash the renderer — swallow
    // and report dispatch failure to the caller.
    return false;
  }
}

interface RunAffectedTestsButtonProps {
  readonly path: string;
}

/** Small ghost-button line rendered below a successful edit summary. */
function RunAffectedTestsButton({
  path,
}: RunAffectedTestsButtonProps): React.JSX.Element {
  const label = '▷ Run relevant tests (Ctrl+T)';
  // The path is passed verbatim to the dispatch handler; the renderer
  // itself is presentation-only and never runs a command.
  void path;
  return (
    <Box flexDirection="row" paddingLeft={4} marginTop={0}>
      <Text color={textMuted} dimColor>
        {label}
      </Text>
    </Box>
  );
}
// RUN-AFFECTED-TESTS-SECTION-END

interface EditArgs {
  readonly path?: unknown;
}

function getPath(args: Record<string, unknown>): string | undefined {
  const p = (args as EditArgs).path;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

function looksLikeUnifiedDiff(output: string): boolean {
  return (
    /^---\s/m.test(output) &&
    /^\+\+\+\s/m.test(output) &&
    /^@@\s/m.test(output)
  );
}

interface ParsedLine {
  readonly kind: 'add' | 'remove' | 'context' | 'header' | 'hunk' | 'meta';
  readonly text: string;
}

function classify(line: string): ParsedLine {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:')) {
    return { kind: 'header', text: line };
  }
  if (line.startsWith('@@')) return { kind: 'hunk', text: line };
  if (line.startsWith('\\')) return { kind: 'meta', text: line };
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'remove', text: line.slice(1) };
  if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1) };
  return { kind: 'meta', text: line };
}

function DiffBlock({ raw }: { readonly raw: string }): React.JSX.Element {
  const lines = raw.split('\n').map(classify);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        switch (line.kind) {
          case 'header':
            return (
              <Text key={`d-${i}`} color={noxPalette.highlight}>
                {line.text}
              </Text>
            );
          case 'hunk':
            return (
              <Text key={`d-${i}`} color={noxPalette.light}>
                {line.text}
              </Text>
            );
          case 'add':
            return (
              <Text key={`d-${i}`} color="#86efac">
                {`+ ${line.text}`}
              </Text>
            );
          case 'remove':
            return (
              <Text key={`d-${i}`} color="#fca5a5">
                {`- ${line.text}`}
              </Text>
            );
          case 'context':
            return (
              <Text key={`d-${i}`} color={textMuted}>
                {`  ${line.text}`}
              </Text>
            );
          case 'meta':
          default:
            return (
              <Text key={`d-${i}`} color={textMuted} italic>
                {line.text}
              </Text>
            );
        }
      })}
    </Box>
  );
}

/**
 * Try to recover a `+A/-R lines` summary from the post-commit string
 * the tool emits, e.g. `Edited foo.ts: 10 → 15 lines (+5)`.
 */
function parseEditSummary(output: string): {
  readonly path?: string;
  readonly summary?: string;
} {
  const m = /^Edited\s+([^:]+):\s*(.+)$/.exec(output.trim());
  if (m === null) return {};
  return { path: m[1], summary: m[2] };
}

function EditFileRenderer({
  args,
  result,
}: {
  readonly args: Record<string, unknown>;
  readonly result: ToolRendererResult;
}): React.JSX.Element | null {
  const raw = result.output ?? '';
  const path = getPath(args);
  // Path with no output (commit path that wrote silently) — render the
  // bare badge.
  if (raw.length === 0 && path !== undefined) {
    return (
      <Box flexDirection="column" paddingLeft={3} marginTop={0}>
        <Box flexDirection="row">
          <Text color={noxPalette.highlight}>{'✎ '}</Text>
          <FileRef path={path} showBadge={false} />
        </Box>
        {/* RUN-AFFECTED-TESTS-SECTION */}
        {result.status === 'done' && (
          <RunAffectedTestsButton path={path} />
        )}
        {/* RUN-AFFECTED-TESTS-SECTION-END */}
      </Box>
    );
  }
  if (raw.length === 0) return null;
  if (looksLikeUnifiedDiff(raw)) {
    return (
      <Box flexDirection="column" paddingLeft={3} marginTop={0}>
        {path !== undefined && (
          <Box flexDirection="row">
            <Text color={noxPalette.highlight}>{'✎ '}</Text>
            <FileRef path={path} showBadge={false} />
          </Box>
        )}
        <Box paddingLeft={1} flexDirection="column">
          <DiffBlock raw={raw} />
        </Box>
      </Box>
    );
  }
  // Post-commit summary line.
  const summary = parseEditSummary(raw);
  if (summary.path !== undefined) {
    return (
      <Box flexDirection="column" paddingLeft={3} marginTop={0}>
        <Box flexDirection="row">
          <Text color={noxPalette.highlight}>{'✎ '}</Text>
          <FileRef path={summary.path} showBadge={false} />
          {summary.summary !== undefined && (
            <Text color={textMuted}>{`  ${summary.summary}`}</Text>
          )}
        </Box>
        {/* RUN-AFFECTED-TESTS-SECTION */}
        {result.status === 'done' && summary.path !== undefined && (
          <RunAffectedTestsButton path={summary.path} />
        )}
        {/* RUN-AFFECTED-TESTS-SECTION-END */}
      </Box>
    );
  }
  // Fallback: render the raw output as a muted preview but anchored
  // with the file badge.
  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={0}>
      {path !== undefined && (
        <Box flexDirection="row">
          <Text color={noxPalette.highlight}>{'✎ '}</Text>
          <FileRef path={path} showBadge={false} />
        </Box>
      )}
      <Box flexDirection="column" paddingLeft={1}>
        {raw.split('\n').map((line, i) => (
          <Text key={`ef-raw-${i}`} color={textMuted}>
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export const render: RenderToolResult = (args, result) => {
  if (result.status !== 'done') return null;
  return <EditFileRenderer args={args} result={result} />;
};
