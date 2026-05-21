/**
 * `<CommandPalette>` — fuzzy-search modal across slash commands, recent
 * files, recent session titles, and registered tools. Triggered from
 * `<ChatScreen>` via `/` from an empty composer or Ctrl+K from anywhere.
 *
 * Visual layout:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Search: <query                                  >       │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  📜 Commands                                              │
 *   │    /permissions    Manage auto-approve list               │
 *   │  ▌ /provider       Switch backend / model URL             │
 *   │  📁 Files                                                 │
 *   │    src/app.tsx                                            │
 *   │    src/ui/screens/ChatScreen.tsx                          │
 *   │  💬 Sessions                                              │
 *   │    Fixing the OpenRouter 429 handler                      │
 *   │  🛠 Tools                                                 │
 *   │    read_file       Read a file from the project root      │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ↵ select · ↑↓ navigate · esc cancel                       │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Behaviour:
 *   - Empty query → show the top N items per category as a "recent /
 *     suggested" panel. Matches Sublime / VS Code / Raycast UX.
 *   - Typing a query runs the `fuzzyMatch` ranker (see ../fuzzy.ts) on
 *     every candidate, sorts descending, takes the top 30 across all
 *     categories. Matched characters render in the accent colour so
 *     the user can see why a row showed up.
 *   - ↑/↓ navigate the flat list. Wraps top/bottom.
 *   - Enter selects the highlighted row and calls `onSelect`. Caller
 *     decides whether to insert text into the composer, execute a
 *     command, or open a preview (session preview is built into this
 *     component — see the right-side pane).
 *   - Esc closes the palette without selecting anything.
 *
 * Selection types (returned via `onSelect`):
 *   - `{ kind: 'command', name }`      — caller inserts `/<name> `.
 *   - `{ kind: 'file',    path }`      — caller inserts `@<path>`.
 *   - `{ kind: 'session', id }`        — caller routes through /resume.
 *   - `{ kind: 'tool',    name, usage }`— caller may print a hint.
 *
 * Sub-pane for session preview:
 *   When the highlighted row is a session and `previewMessages` is
 *   provided by the caller, a 40%-width right pane renders the first 5
 *   messages of that session. This is purely a visual aid; pressing
 *   Enter once still triggers `onSelect` so the parent can run the
 *   resume flow.
 *
 * Keystroke ownership:
 *   The palette is mounted INSIDE the existing InputDispatcherProvider
 *   tree, so it subscribes to mode='overlay' via `useInputModeHandler`.
 *   While the palette is open the dispatcher owner (ChatScreen) is
 *   responsible for flipping its computed mode to 'overlay' so the
 *   InputBar / SlashMenu don't co-consume keystrokes.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useInputModeHandler, type InputEvent } from '../components/InputDispatcher.js';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
import { fuzzyMatch, type FuzzyMatch } from '../fuzzy.js';

/** Top-level selection contract returned to the parent. */
export type PaletteSelection =
  | { readonly kind: 'command'; readonly name: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'tool'; readonly name: string; readonly usage?: string };

/** One candidate row, flattened across categories before ranking. */
export interface PaletteCommand {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
}

export interface PaletteFile {
  /** Project-relative path, e.g. `src/ui/screens/ChatScreen.tsx`. */
  readonly path: string;
}

export interface PaletteSession {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

export interface PaletteTool {
  readonly name: string;
  readonly description: string;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly commands: readonly PaletteCommand[];
  readonly files: readonly PaletteFile[];
  readonly sessions: readonly PaletteSession[];
  readonly tools: readonly PaletteTool[];
  /**
   * First-five message preview for the currently-highlighted session,
   * computed lazily by the parent when the cursor lands on a session
   * row. Optional — when omitted no preview pane renders.
   */
  readonly sessionPreview?: ReadonlyMap<string, readonly string[]>;
  readonly onSelect: (selection: PaletteSelection) => void;
  readonly onClose: () => void;
}

type Category = 'command' | 'file' | 'session' | 'tool';

interface RankedRow {
  readonly category: Category;
  /** Display label (haystack the fuzzy matcher scored against). */
  readonly label: string;
  /** Optional secondary text (description / timestamp / usage). */
  readonly secondary?: string;
  readonly match: FuzzyMatch;
  /** Selection payload returned to the parent on Enter. */
  readonly selection: PaletteSelection;
  /** Source id used to fetch a session preview, if applicable. */
  readonly sessionId?: string;
}

/** Cap displayed rows so the palette can't drown the terminal. */
export const PALETTE_MAX_ROWS = 30;

const CATEGORY_ICON: Record<Category, string> = {
  command: '/',
  file: '◆',
  session: '∙',
  tool: '+',
};

const CATEGORY_LABEL: Record<Category, string> = {
  command: 'Commands',
  file: 'Files',
  session: 'Sessions',
  tool: 'Tools',
};

/**
 * Render a label string with the matched character indices painted in
 * the accent colour. Falls back to a single `<Text>` when there are no
 * matches (empty-query "browse" mode).
 *
 * ink only renders nested `<Text>` runs correctly when they live as
 * siblings of plain text inside a parent `<Text>`, so we split the
 * label into a list of segments and emit them in order.
 */
function HighlightedLabel({
  label,
  match,
  active,
}: {
  readonly label: string;
  readonly match: FuzzyMatch;
  readonly active: boolean;
}): React.JSX.Element {
  const matchedSet = useMemo(
    () => new Set<number>(match.matchedIndices),
    [match.matchedIndices],
  );
  if (matchedSet.size === 0) {
    return (
      <Text color={active ? noxPalette.white : textMuted}>
        {label}
      </Text>
    );
  }
  const segments: Array<{ readonly text: string; readonly matched: boolean }> =
    [];
  let cursor = 0;
  let runIsMatched = matchedSet.has(0);
  for (let i = 0; i < label.length; i++) {
    const isMatched = matchedSet.has(i);
    if (isMatched !== runIsMatched) {
      segments.push({ text: label.slice(cursor, i), matched: runIsMatched });
      cursor = i;
      runIsMatched = isMatched;
    }
  }
  segments.push({ text: label.slice(cursor), matched: runIsMatched });

  return (
    <Text>
      {segments.map((seg, idx) => (
        <Text
          key={`seg-${idx}`}
          color={
            seg.matched
              ? noxPalette.highlight
              : active
                ? noxPalette.white
                : textMuted
          }
          bold={seg.matched}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Build the flat ranked list. Pure: takes the raw inputs + query and
 * returns the rows in display order. Exported for unit tests.
 */
export function buildRankedRows(
  query: string,
  commands: readonly PaletteCommand[],
  files: readonly PaletteFile[],
  sessions: readonly PaletteSession[],
  tools: readonly PaletteTool[],
): RankedRow[] {
  const rows: RankedRow[] = [];
  const emptyMatch: FuzzyMatch = { score: 0, matchedIndices: [] };
  const trimmed = query.trim();

  const pushCommand = (cmd: PaletteCommand, match: FuzzyMatch): void => {
    rows.push({
      category: 'command',
      label: `/${cmd.name}`,
      secondary: cmd.description,
      match,
      selection: { kind: 'command', name: cmd.name },
    });
  };
  const pushFile = (file: PaletteFile, match: FuzzyMatch): void => {
    rows.push({
      category: 'file',
      label: file.path,
      match,
      selection: { kind: 'file', path: file.path },
    });
  };
  const pushSession = (sess: PaletteSession, match: FuzzyMatch): void => {
    rows.push({
      category: 'session',
      label: sess.title.length > 0 ? sess.title : '(untitled)',
      secondary: formatRelativeTime(sess.updatedAt),
      match,
      selection: { kind: 'session', id: sess.id },
      sessionId: sess.id,
    });
  };
  const pushTool = (tool: PaletteTool, match: FuzzyMatch): void => {
    rows.push({
      category: 'tool',
      label: tool.name,
      secondary: tool.description,
      match,
      selection: { kind: 'tool', name: tool.name },
    });
  };

  if (trimmed.length === 0) {
    for (const c of commands) pushCommand(c, emptyMatch);
    for (const f of files) pushFile(f, emptyMatch);
    for (const s of sessions) pushSession(s, emptyMatch);
    for (const t of tools) pushTool(t, emptyMatch);
    return rows.slice(0, PALETTE_MAX_ROWS);
  }

  // Score every candidate. Multi-needle haystacks ("name + description")
  // let the user search either the literal command name or its prose.
  const scored: RankedRow[] = [];
  for (const c of commands) {
    const m = fuzzyMatch(query, `/${c.name} ${c.description}`);
    if (m.score === 0) continue;
    // Re-anchor highlight indices to the label-only portion (which we
    // render). Recompute against the displayed label so the highlight
    // is accurate.
    const labelMatch = fuzzyMatch(query, `/${c.name}`);
    scored.push({
      category: 'command',
      label: `/${c.name}`,
      secondary: c.description,
      match: labelMatch.score > 0 ? labelMatch : { score: m.score, matchedIndices: [] },
      selection: { kind: 'command', name: c.name },
    });
  }
  for (const f of files) {
    const m = fuzzyMatch(query, f.path);
    if (m.score === 0) continue;
    scored.push({
      category: 'file',
      label: f.path,
      match: m,
      selection: { kind: 'file', path: f.path },
    });
  }
  for (const s of sessions) {
    const haystack = s.title.length > 0 ? s.title : '(untitled)';
    const m = fuzzyMatch(query, haystack);
    if (m.score === 0) continue;
    scored.push({
      category: 'session',
      label: haystack,
      secondary: formatRelativeTime(s.updatedAt),
      match: m,
      selection: { kind: 'session', id: s.id },
      sessionId: s.id,
    });
  }
  for (const t of tools) {
    const m = fuzzyMatch(query, `${t.name} ${t.description}`);
    if (m.score === 0) continue;
    const labelMatch = fuzzyMatch(query, t.name);
    scored.push({
      category: 'tool',
      label: t.name,
      secondary: t.description,
      match: labelMatch.score > 0 ? labelMatch : { score: m.score, matchedIndices: [] },
      selection: { kind: 'tool', name: t.name },
    });
  }

  scored.sort((a, b) => b.match.score - a.match.score);
  return scored.slice(0, PALETTE_MAX_ROWS);
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function CommandPalette({
  open,
  commands,
  files,
  sessions,
  tools,
  sessionPreview,
  onSelect,
  onClose,
}: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState<string>('');
  const [cursor, setCursor] = useState<number>(0);

  const rows = useMemo(
    () => buildRankedRows(query, commands, files, sessions, tools),
    [query, commands, files, sessions, tools],
  );

  // Defensive clamp — if the filtered list shrinks below the current
  // cursor we'd otherwise paint a stale highlight.
  const safeCursor = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1);

  const handleInput = useCallback(
    (event: InputEvent): boolean => {
      if (!open) return false;
      const { input, key } = event;
      if (key.escape) {
        onClose();
        return true;
      }
      if (key.return) {
        const row = rows[safeCursor];
        if (row !== undefined) onSelect(row.selection);
        return true;
      }
      if (key.upArrow) {
        if (rows.length === 0) return true;
        setCursor((c) => (c - 1 + rows.length) % rows.length);
        return true;
      }
      if (key.downArrow || key.tab) {
        if (rows.length === 0) return true;
        setCursor((c) => (c + 1) % rows.length);
        return true;
      }
      if (key.ctrl && (input === 'k' || input === 'K')) {
        // Re-pressing Ctrl+K while open also closes — symmetric with
        // open. Matches Raycast / VS Code behaviour.
        onClose();
        return true;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setCursor(0);
        return true;
      }
      // Printable text appends to the query. ink's `useInput`
      // forwards `input` as the single-character string for most
      // typed keys; control combos arrive with `input === ''`.
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setCursor(0);
        return true;
      }
      return true; // swallow all other keys while open
    },
    [onClose, onSelect, open, rows, safeCursor],
  );

  // The palette is the topmost overlay when open, so it subscribes to
  // mode='overlay'. ChatScreen's computed mode lifts to 'overlay' when
  // `paletteOpen` is true; see app.tsx CMD-PALETTE-MOUNT-SECTION for
  // the wiring on the parent side.
  useInputModeHandler('overlay', handleInput);

  if (!open) return null;

  // Group rows by category for the section headers, preserving the
  // ranked order within each section.
  const groups: ReadonlyArray<{
    readonly category: Category;
    readonly rows: readonly RankedRow[];
  }> = (['command', 'file', 'session', 'tool'] as const).map((cat) => ({
    category: cat,
    rows: rows.filter((r) => r.category === cat),
  }));

  // Build a flat absolute index per row so the cursor's index maps to
  // the visible row regardless of grouping.
  const cursorRow = rows[safeCursor];
  const previewLines =
    cursorRow !== undefined &&
    cursorRow.sessionId !== undefined &&
    sessionPreview !== undefined
      ? (sessionPreview.get(cursorRow.sessionId) ?? null)
      : null;

  // Render the palette as a bordered modal. We do NOT swap the
  // ChatScreen's `<Static>` for it — the parent (app.tsx) renders this
  // ABOVE the InputBar row, while ChatScreen's overlay short-circuit
  // hides only the dynamic area when `overlay !== undefined`. The
  // palette uses its own modal frame here.
  return (
    <Box flexDirection="row" width="100%">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={noxPalette.light}
        paddingX={1}
        paddingY={0}
        flexGrow={1}
        flexShrink={1}
        flexBasis="0%"
      >
        {/* Search input row */}
        <Box flexDirection="row">
          <Text color={noxPalette.highlight} bold>
            {'❯ '}
          </Text>
          <Text color={noxPalette.white}>{query}</Text>
          <Text color={noxPalette.highlight} inverse>
            {' '}
          </Text>
        </Box>

        <Box>
          <Text color={dimSeparator}>{'─'.repeat(40)}</Text>
        </Box>

        {/* Grouped result list */}
        {rows.length === 0 ? (
          <Box paddingX={1}>
            <Text color={textMuted}>No matches for "{query}"</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {groups.map((group) => {
              if (group.rows.length === 0) return null;
              return (
                <Box
                  key={`group-${group.category}`}
                  flexDirection="column"
                  marginTop={0}
                >
                  <Text color={noxPalette.light} bold>
                    {CATEGORY_ICON[group.category]} {CATEGORY_LABEL[group.category]}
                  </Text>
                  {group.rows.map((row) => {
                    const absoluteIdx = rows.indexOf(row);
                    const active = absoluteIdx === safeCursor;
                    return (
                      <Box
                        key={`row-${group.category}-${absoluteIdx}-${row.label}`}
                        flexDirection="row"
                      >
                        <Text
                          color={active ? noxPalette.highlight : textMuted}
                        >
                          {active ? '▌ ' : '  '}
                        </Text>
                        <HighlightedLabel
                          label={row.label}
                          match={row.match}
                          active={active}
                        />
                        {row.secondary !== undefined && row.secondary.length > 0 && (
                          <Text color={textMuted}>
                            {'  '}
                            {truncate(row.secondary, 60)}
                          </Text>
                        )}
                      </Box>
                    );
                  })}
                </Box>
              );
            })}
          </Box>
        )}

        <Box marginTop={1}>
          <Text color={textMuted} dimColor>
            ↵ select · ↑↓ navigate · esc cancel
          </Text>
        </Box>
      </Box>

      {/* Optional preview pane for sessions */}
      {previewLines !== null && previewLines.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={dimSeparator}
          paddingX={1}
          paddingY={0}
          marginLeft={1}
          width="40%"
        >
          <Text color={noxPalette.light} bold>
            Preview
          </Text>
          <Box marginTop={1} flexDirection="column">
            {previewLines.slice(0, 5).map((line, i) => (
              <Text key={`preview-${i}`} color={textMuted}>
                {truncate(line, 60)}
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

export default CommandPalette;
