/**
 * Chat prompt input row.
 *
 * Layout: bordered box containing `❯  <inline editor …>` — prompt
 * glyph on the left, the inline editor occupies the rest of the
 * line(s). The box is framed so the user can always tell at a glance
 * where typing lands.
 *
 * Features:
 *   - Round border around the whole row, coloured by focus state
 *     (brighter when editable, muted when `disabled`).
 *   - Typing is NEVER blocked — even during streaming. `disabled` is
 *     kept as an optional prop for legacy callers but no longer hides
 *     the editor; the border colour dims to hint the submission will be
 *     queued. While disabled, ALL key handling is suppressed (the input
 *     is fully inert).
 *   - ↑/↓ browse the caller-supplied history array. First ↑ jumps to
 *     the most recent entry, further ↑ walks older, ↓ walks newer; past
 *     the newest returns the draft to empty. Typing any printable
 *     character resets the browse pointer.
 *   - R7: `disableHistoryNav` lets a sibling component (e.g. a
 *     `<SlashMenu>`) own ↑/↓ exclusively while it is mounted.
 *   - **R9 — Shift+Enter inserts a literal newline.** Plain Enter still
 *     submits. Multi-line drafts grow the bordered box vertically: each
 *     committed line renders on its own row with the prompt glyph
 *     prefix, and the active line is the last row.
 *   - **R10 — Paste collapse (Claude Code-style).** Large pastes are
 *     collapsed into a `[Paste #N · X lines · Y chars]` placeholder
 *     pill so the visible buffer stays readable. The full text is
 *     stored internally and substituted back on Enter, so the model
 *     receives the unabridged content. Backspace at the right of a
 *     placeholder removes it whole (and drops the underlying text).
 *   - **R20 — Bash-mode visual indicator.** When the active draft
 *     starts with `!` (and not `!!`, which is the literal-bang
 *     escape), the prompt glyph swaps from the lavender `❯` to a
 *     green `$` and a small `bash` chip is rendered beside it. This
 *     makes it impossible to miss that Enter is about to dispatch
 *     a local shell command (handled by `classifySubmit` in
 *     ChatScreen — Agent 4 R20 wires the classifier; Agent 8 R17
 *     hooks the actual `execa` call). The visual cue disappears the
 *     moment the user types `!!` (literal) or clears the leading
 *     bang.
 *   - **R21 — Image drag-drop.** When the user drops an image from
 *     Finder/Explorer, modern terminals (iTerm2 most notably) paste
 *     the absolute file path as plain text. We detect that — a single
 *     line that resolves to an existing image file under 10 MB — and
 *     transparently swap it for a paste-style placeholder whose
 *     underlying text is a `data:image/<subtype>;base64,…` URL. On
 *     submit the data URL becomes part of the message body, and the
 *     model can call `fetch_image` on it. The placeholder pill is
 *     coloured slightly differently (`🖼  Image: kitten.png · 234 KB`)
 *     so the user can tell it apart from a regular text paste.
 *
 * R9 implementation note — why we don't use `@inkjs/ui`'s `<TextInput>`:
 *   `<TextInput>` registers its own `useInput` handler that ALWAYS
 *   submits on `key.return` (it never inspects `key.shift`). Because
 *   ink fires every input listener on the same dispatch cycle and child
 *   `useEffect`s run before parents', `<TextInput>`'s `onSubmit` would
 *   always fire FIRST, before any wrapper had a chance to intercept the
 *   Shift+Enter combination. So instead this component owns the entire
 *   keystroke pipeline: a single `useInput` dispatches every key through
 *   our reducer and the renderer is a pair of inline `<Text>` blocks
 *   that mimic `<TextInput>`'s cursor-inversion trick (a single
 *   `inverse` cell at the cursor offset).
 *
 * R10 marker format note:
 *   Paste placeholders live inline inside the buffer as the literal
 *   string `\x02PASTE:<uuid>\x03` (STX + payload + ETX). STX/ETX are
 *   non-printable ASCII control chars that never originate from a
 *   real keystroke, so they make a safe sentinel. Helpers in this
 *   file treat each marker as an ATOMIC unit for cursor navigation,
 *   deletion and rendering.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dimSeparator, noxPalette, textMuted, theme } from '../theme.js';
import { useInputModeHandler, type InputEvent } from './InputDispatcher.js';
import StatusPill, { type StatusPillProps } from './StatusPill.js';
import InputBorder from './InputBorder.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
// AUTO-IMAGE-PROMOTE-SECTION imports — pure helpers; no React deps.
import {
  detectImagePathsInLine,
  looksLikeBareImagePath,
  MAX_IMAGE_BYTES as DETECT_MAX_IMAGE_BYTES,
} from '../composer/path-detection.js';
import { sniffImageMimeFromFile } from '@/util/mime-sniff';
import { convertHeicToPng } from '@/util/heic-convert';

/**
 * Wave 5A — terminal-width breakpoints used to drive the responsive
 * status-pill row. Exposed as constants so the unit tests can pin the
 * exact widths used at runtime.
 */
const PILL_BREAKPOINT_FULL = 80;
const PILL_BREAKPOINT_HIDE = 40;

/**
 * Pick the right pill layout for the given terminal width.
 *   - >= 80 cols → full pill (provider · model · pct% · profile · style)
 *   - 40..79 cols → compact pill (model · pct%)
 *   - < 40 cols  → hidden (the bordered editor still spans the row)
 *
 * Exposed for tests so we can lock down the breakpoint table without
 * having to mount the whole component.
 */
export function pickPillLayout(
  columns: number,
): { readonly compact: boolean; readonly hidden: boolean } {
  if (columns < PILL_BREAKPOINT_HIDE) return { compact: true, hidden: true };
  if (columns < PILL_BREAKPOINT_FULL) return { compact: true, hidden: false };
  return { compact: false, hidden: false };
}

export interface InputBarProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  /**
   * Optional — legacy callers may still pass this. The input is never
   * hidden, but the border colour dims so the user knows submissions
   * will be queued. While `disabled` is true, key handling is fully
   * inert (no editing, no submit, no history nav).
   */
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /**
   * Past user submissions in chronological order (oldest first). Used
   * by the ↑/↓ history navigation. Empty array disables the feature.
   */
  readonly history?: readonly string[];
  /**
   * Optional border colour override. Falls back to focus-aware default.
   */
  readonly borderColor?: string;
  /**
   * R7 — when true, suppress the ↑/↓ history navigation so sibling
   * consumers (e.g. an open `<SlashMenu>`) can own those keys.
   */
  readonly disableHistoryNav?: boolean;
  /**
   * M2 — monotonic counter watched by the editor. When it ticks up
   * the buffer is cleared (committed lines + active value + pastes
   * + history-browse) WITHOUT unmounting the component. The parent
   * uses this for the "post-submit clear" path so the user doesn't
   * pay an unmount→mount churn for every Enter (the old `inputKey`
   * remount cycle was load-bearing only for overlay-close — kept
   * there, see ChatScreen).
   */
  readonly resetTrigger?: number;
  /**
   * Wave 5A — optional status pill data. When ALL five fields are
   * supplied, the pill row is rendered above the bordered editor; when
   * any are missing, the row is omitted entirely. This keeps backward
   * compatibility with legacy callers (and tests) that construct
   * <InputBar> with just the editor props.
   */
  readonly status?: Pick<
    StatusPillProps,
    'provider' | 'model' | 'contextPercent' | 'profile' | 'outputStyle'
  >;
  /**
   * Wave 5A — toggle the footer hint row underneath the bordered
   * editor. Defaults to `true` so the hint is visible whenever a hint
   * makes sense; callers that don't want any chrome (e.g. confirm-only
   * prompts) can opt out by passing `false`.
   */
  readonly showHint?: boolean;
  /**
   * Wave 5A — terminal-width override for layout decisions. When
   * undefined the component reads the live width via
   * `useTerminalWidth()`. Tests inject a fixed value so they can
   * exercise the breakpoint table without having to mock ink's stdout
   * resize event.
   */
  readonly testColumns?: number;
}

/**
 * R10 — A single paste captured in one input event. The `id` is a
 * UUID so it can live inside the buffer as a stable token; `number`
 * is the human-facing sequence ("Paste #1", "#2") which simply
 * counts how many pastes the current composition has accumulated.
 *
 * R21 — `kind` distinguishes regular text pastes (default) from image
 * drops. For image drops, `text` holds the `data:image/...;base64,...`
 * URL that becomes part of the submitted message; `label` overrides
 * the default `[Paste #N · X lines · Y chars]` rendering with a
 * filename + size pill (e.g. `Image: kitten.png · 234 KB`).
 */
interface PasteToken {
  readonly id: string;
  readonly number: number;
  readonly text: string;
  readonly kind?: 'text' | 'image';
  readonly label?: string;
}

/**
 * Internal editor state. `committedLines` are the lines already
 * finalised by Shift+Enter; the active row is `(value, cursorOffset)`.
 * `pastes` is keyed by paste id and persists for the lifetime of one
 * composition (cleared on submit / Esc / history-load). Submission
 * resolves every marker back to its underlying text.
 *
 * M5 — `committedLineIds` parallels `committedLines` and stores a
 * monotonically-increasing id per committed line, assigned at
 * Shift+Enter time. React keys read these IDs instead of the array
 * index, so deleting a middle row (e.g. backspace-merge of two lines)
 * doesn't churn unrelated rows. `committedLineSeq` is the source of
 * the next id; survives history loads + resets so two distinct lines
 * can't share an id within a composition.
 */
interface EditorState {
  readonly committedLines: readonly string[];
  readonly committedLineIds: readonly number[];
  readonly committedLineSeq: number;
  readonly value: string;
  readonly cursorOffset: number;
  readonly pastes: ReadonlyMap<string, PasteToken>;
  readonly pasteCounter: number;
}

const EMPTY_STATE: EditorState = {
  committedLines: [],
  committedLineIds: [],
  committedLineSeq: 0,
  value: '',
  cursorOffset: 0,
  pastes: new Map<string, PasteToken>(),
  pasteCounter: 0,
};

/**
 * Sentinel chars for the paste marker. STX (0x02) and ETX (0x03) are
 * ASCII control characters that never reach us through a normal
 * keypress — even bracketed-paste sequences are stripped by the TTY
 * by the time ink hands them over — so they make a safe in-band
 * delimiter.
 */
const STX = '\x02';
const ETX = '\x03';
const MARKER_PREFIX = `${STX}PASTE:`;
/** Matches `\x02PASTE:<uuid>\x03`. Anchored to the literal sentinels. */
const MARKER_REGEX = /\x02PASTE:([0-9a-f-]{36})\x03/g;

/** Build the in-band marker string for a paste id. */
function markerFor(id: string): string {
  return `${MARKER_PREFIX}${id}${ETX}`;
}

/**
 * Paste-detection threshold. The catch-all keystroke handler treats
 * any `input` matching this predicate as a single bulk paste — every
 * other input is inserted character-by-character.
 *
 * Two complementary heuristics:
 *   1. `>= 200` chars in a single event — even on slow paste, terminal
 *      readers chunk by line, so this catches "wall of text without
 *      newlines" cases.
 *   2. multi-line (`\n`) AND `>= 5` newlines — keeps small "two-line
 *      copy/paste" inputs inline (they read fine), only collapses real
 *      blocks of code/log/text.
 */
/**
 * R20 — Bash-mode predicate. Returns true when the buffer is "in bash
 * mode": starts with a single `!` and is NOT the literal-bang escape
 * (`!!`, used to send `!something` to the model verbatim).
 *
 * Pure helper so tests / callers in ChatScreen can share the same
 * decision logic without duplicating the prefix arithmetic. Trims
 * leading whitespace because the editor preserves indents while the
 * classification semantics are anchored to the first non-space char.
 */
export function isBashModeBuffer(value: string): boolean {
  // We look at the FIRST committed line (or the active line if there
  // are no committed lines). Bash mode is anchored to the start of
  // the WHOLE composition — typing `!ls` then Shift+Enter then `ok`
  // should still render the `$` glyph because the composed payload
  // begins with `!`.
  const ltrimmed = value.replace(/^\s+/, '');
  if (ltrimmed.length === 0) return false;
  if (ltrimmed.startsWith('!!')) return false;
  if (!ltrimmed.startsWith('!')) return false;
  // Bare `!` with no payload is treated as plain text by the
  // classifier; we don't activate the visual indicator either,
  // mirroring that behaviour so the user only sees the chip when
  // there's an actual command to dispatch.
  const afterBang = ltrimmed.slice(1).trim();
  return afterBang.length > 0;
}

function isPasteEvent(input: string): boolean {
  if (input.length >= 200) return true;
  if (!input.includes('\n')) return false;
  // Count newlines without allocating an array.
  let nl = 0;
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === 10) nl++;
  }
  return nl >= 4; // 4 newlines == 5 lines
}

/**
 * R21 — supported image extensions and the MIME type the `fetch_image`
 * tool is willing to accept. Keep this list in lock-step with
 * `ALLOWED_MIME_TYPES` in `src/tools/fetch-image.ts`.
 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Map a file extension to the MIME type used by fetch_image. */
function mimeTypeForExt(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

/** Format a byte count as a human-readable string (`234 KB`, `1.2 MB`). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * R21 — Image-drop heuristic.
 *
 * Modern terminals translate Finder/Explorer drag-drops into a paste of
 * the absolute file path. We treat any input that:
 *   - is exactly one line (no `\n`),
 *   - starts with `~`, `/`, `./`, `../`, or a Windows drive prefix,
 *   - ends with one of `.png|.jpg|.jpeg|.gif|.webp`,
 *   - resolves to an existing file under 10 MB,
 * as an image drop. The function returns `null` when any precondition
 * fails — callers fall back to the regular paste / character-insert
 * pipeline. The check is fully synchronous (it `fs.statSync`s once),
 * which is fine because the path-shape guard fires only on inputs that
 * are already a single short line.
 *
 * macOS quoted-path note — when a path contains spaces, iTerm2 wraps
 * the pasted string with single quotes (e.g. `'/Users/me/My Pic.png'`).
 * We strip a single leading + trailing pair of matching quotes and
 * un-escape the standard Bash backslash escapes (` `, `'`, `"`).
 */
function unwrapQuotedPath(raw: string): string {
  let s = raw.trim();
  // Strip a single matching pair of surrounding ' or " quotes.
  if (s.length >= 2) {
    const first = s.charAt(0);
    const last = s.charAt(s.length - 1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      s = s.slice(1, -1);
    }
  }
  // Un-escape `\<space>`, `\'`, `\"` — the most common Bash-style
  // escapes a terminal will insert into a drag-drop paste.
  s = s.replace(/\\(.)/g, (_match, ch) => ch);
  return s;
}

interface ImageDropMeta {
  readonly absPath: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly fileName: string;
}

function detectImageDrop(text: string): ImageDropMeta | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Must be a single line — embedded newlines disqualify the input.
  if (trimmed.includes('\n')) return null;
  // Sanity: too short to be a path, or absurdly long.
  if (trimmed.length < 6) return null;
  if (trimmed.length > 4096) return null;

  const candidate = unwrapQuotedPath(trimmed);
  if (candidate.length < 6) return null;

  // Path-shape guard: leading `~`, `/`, `./`, `../`, or a Windows drive
  // letter (e.g. `C:\…`). Anything else falls through to plain paste.
  const looksLikePath = /^[~/]|^[A-Za-z]:[\\/]|^\.\.?[\\/]/.test(candidate);
  if (!looksLikePath) return null;

  const lower = candidate.toLowerCase();
  const matchedExt = IMAGE_EXTENSIONS.find((e) => lower.endsWith(e));
  if (matchedExt === undefined) return null;

  // Resolve `~` and `~/...` to the user's home dir. Anything else is
  // taken verbatim — `path.resolve` would happily rewrite a relative
  // path, but for image drops we always expect an absolute path.
  let expanded = candidate;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  // Existence + size guard. Wrapped in try/catch because `fs.statSync`
  // throws on missing files and on sandboxed environments where the
  // path is unreadable — both are "not a drop, treat as plain text".
  try {
    const stat = fs.statSync(expanded);
    if (!stat.isFile()) return null;
    if (stat.size <= 0) return null;
    if (stat.size > MAX_IMAGE_BYTES) return null;
    return {
      absPath: expanded,
      mimeType: mimeTypeForExt(matchedExt),
      bytes: stat.size,
      fileName: path.basename(expanded),
    };
  } catch {
    return null;
  }
}

/**
 * R21 — Read an image file and return a `data:<mime>;base64,<payload>`
 * URL suitable for the `fetch_image` tool. Returns `null` if the read
 * fails (e.g. the file vanished between the stat and the read, or
 * permissions changed). Synchronous because we already paid the
 * stat cost in the detector and the file is bounded to 10 MB.
 */
function readImageAsDataUrl(meta: ImageDropMeta): string | null {
  try {
    const buf = fs.readFileSync(meta.absPath);
    if (buf.length === 0) return null;
    if (buf.length > MAX_IMAGE_BYTES) return null;
    const base64 = buf.toString('base64');
    return `data:${meta.mimeType};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * Tokenise a string by paste markers. Returns an array where each
 * element is either a raw text segment (`{ kind: 'text' }`) or a
 * marker (`{ kind: 'paste', id }`). Used by the cursor logic AND the
 * renderer.
 */
type Segment =
  | { readonly kind: 'text'; readonly text: string; readonly start: number }
  | { readonly kind: 'paste'; readonly id: string; readonly start: number; readonly length: number };

function tokenize(value: string): readonly Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  // Reset the regex's lastIndex to be safe (it's `/g`).
  MARKER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_REGEX.exec(value)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        kind: 'text',
        text: value.slice(lastIndex, match.index),
        start: lastIndex,
      });
    }
    segments.push({
      kind: 'paste',
      id: match[1] ?? '',
      start: match.index,
      length: match[0].length,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) {
    segments.push({
      kind: 'text',
      text: value.slice(lastIndex),
      start: lastIndex,
    });
  }
  return segments;
}

/**
 * Find the boundary of the marker (if any) that the offset is INSIDE.
 * Returns the marker's `[start, end)` range, or `null` if the offset
 * is in plain text. "Inside" includes the position immediately AFTER
 * the marker's last char only when `inclusiveEnd` is true.
 */
function findMarkerAt(
  value: string,
  offset: number,
  inclusiveEnd: boolean,
): { readonly start: number; readonly end: number; readonly id: string } | null {
  // We only have to scan from a point slightly before `offset` because
  // each marker is 44+ chars; tokenising is O(n) but n is small here.
  const segments = tokenize(value);
  for (const seg of segments) {
    if (seg.kind !== 'paste') continue;
    const end = seg.start + seg.length;
    if (offset > seg.start && offset < end) {
      return { start: seg.start, end, id: seg.id };
    }
    if (inclusiveEnd && offset === end) {
      return { start: seg.start, end, id: seg.id };
    }
  }
  return null;
}

/**
 * Move cursor one logical step left, jumping over a whole marker if
 * we land inside one. Returns the new offset (>= 0).
 */
function prevBoundary(value: string, offset: number): number {
  if (offset <= 0) return 0;
  // First, are we currently sitting at the END of a marker? If yes,
  // jump to its start.
  const m = findMarkerAt(value, offset, true);
  if (m !== null && m.end === offset) {
    return m.start;
  }
  return offset - 1;
}

/**
 * Move cursor one logical step right, jumping over a whole marker.
 */
function nextBoundary(value: string, offset: number): number {
  if (offset >= value.length) return value.length;
  // Are we sitting at the START of a marker? If yes, jump to its end.
  const m = findMarkerAt(value, offset, false);
  if (m !== null && m.start === offset) {
    return m.end;
  }
  return offset + 1;
}

/**
 * Delete the character or marker immediately to the LEFT of `offset`.
 * Returns the updated value, the new cursor offset, and the id of any
 * paste that should be removed from the `pastes` map.
 */
function deleteBackward(
  value: string,
  offset: number,
): { readonly value: string; readonly cursorOffset: number; readonly removedPasteId: string | null } {
  if (offset <= 0) return { value, cursorOffset: 0, removedPasteId: null };
  // If the char to the left is the END of a marker, delete the marker.
  const m = findMarkerAt(value, offset, true);
  if (m !== null && m.end === offset) {
    return {
      value: value.slice(0, m.start) + value.slice(m.end),
      cursorOffset: m.start,
      removedPasteId: m.id,
    };
  }
  return {
    value: value.slice(0, offset - 1) + value.slice(offset),
    cursorOffset: offset - 1,
    removedPasteId: null,
  };
}

/**
 * Resolve every marker in `value` back to its underlying paste text,
 * dropping orphan markers (no matching id in `pastes`).
 */
function expandMarkers(value: string, pastes: ReadonlyMap<string, PasteToken>): string {
  if (value.length === 0) return '';
  const segments = tokenize(value);
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'text') {
      out += seg.text;
    } else {
      const tok = pastes.get(seg.id);
      out += tok !== undefined ? tok.text : '';
    }
  }
  return out;
}

/**
 * Split an externally-supplied multi-line string into our editor
 * representation. Trailing newline yields an empty active line — this
 * is the natural cursor position after Shift+Enter on a hydrated draft.
 *
 * R10: external seed text is treated as plain (no markers) — pastes
 * are always created interactively.
 */
function splitMultiline(text: string): EditorState {
  if (text.length === 0) return EMPTY_STATE;
  const parts = text.split('\n');
  const last = parts[parts.length - 1] ?? '';
  const committedLines = parts.slice(0, -1);
  // M5 — allocate fresh monotonic ids for the seeded committed lines.
  const committedLineIds = committedLines.map((_, i) => i);
  return {
    ...EMPTY_STATE,
    committedLines,
    committedLineIds,
    committedLineSeq: committedLines.length,
    value: last,
    cursorOffset: last.length,
  };
}

// ATTACHMENT-SECTION start — `@image <path>` parser.
/**
 * Parse a line for the leading `@image <path>` (or `@img <path>`)
 * directive. Returns the path on match, `null` otherwise. The path may
 * be quoted (single or double) to handle filenames with spaces — we
 * reuse {@link unwrapQuotedPath} to normalise.
 */
function parseAtImageDirective(line: string): string | null {
  const trimmed = line.trimStart();
  const lower = trimmed.toLowerCase();
  let rest: string | null = null;
  if (lower.startsWith('@image ')) rest = trimmed.slice('@image '.length);
  else if (lower.startsWith('@img ')) rest = trimmed.slice('@img '.length);
  if (rest === null) return null;
  const path = rest.trim();
  if (path.length === 0) return null;
  return unwrapQuotedPath(path);
}

/**
 * Resolve a `@image` path (possibly `~`/`~/`-prefixed) to an absolute
 * filesystem path. Relative paths are taken verbatim — `fs.statSync`
 * will reject them, which is exactly what we want.
 */
function resolveAtImagePath(raw: string): string {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

/**
 * Read an image at `absPath`, returning the `ImageDropMeta` shape used
 * by the existing R21 pipeline. Returns `null` when the file is
 * missing, unreadable, empty, oversize, or has a non-whitelisted
 * extension. Same size cap (10 MB) and mime whitelist as `detectImageDrop`.
 */
function readImageMetaForAttach(absPath: string): ImageDropMeta | null {
  const lower = absPath.toLowerCase();
  const matchedExt = IMAGE_EXTENSIONS.find((e) => lower.endsWith(e));
  if (matchedExt === undefined) return null;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    if (stat.size <= 0) return null;
    if (stat.size > MAX_IMAGE_BYTES) return null;
    return {
      absPath,
      mimeType: mimeTypeForExt(matchedExt),
      bytes: stat.size,
      fileName: path.basename(absPath),
    };
  } catch {
    return null;
  }
}
// ATTACHMENT-SECTION end

// AUTO-IMAGE-PROMOTE-SECTION — bare-path auto-attach.
/**
 * Try to convert a bare image path (after detection by
 * `detectImagePathsInLine`) into the `ImageDropMeta` shape used by the
 * paste-token pipeline. Performs:
 *
 *   1. `fs.statSync` to confirm the file exists and is non-empty.
 *   2. Size cap (10 MB) — same value as `MAX_IMAGE_BYTES`.
 *   3. Magic-number MIME sniff. The sniff is the source of truth — a
 *      renamed `.png` that is really an EXE returns `null` and we
 *      reject the file.
 *   4. HEIC → PNG conversion if the sniffed type is `image/heic` and
 *      `sips`/`magick` is available. The converted PNG is what we
 *      ultimately attach (HEIC isn't accepted by any vision model we
 *      target).
 *
 * Returns `{ meta, warning }` — `warning` is a non-null short string
 * when HEIC conversion fails so the caller can surface a toast. When the
 * file is unreadable / unrecognised, the whole call returns `null`.
 */
interface BarePathAttachResult {
  readonly meta: ImageDropMeta;
  readonly warning: string | null;
}

function attachBarePath(absPath: string): BarePathAttachResult | null {
  // Cheap stat first — if the file doesn't exist or is too big, we
  // never pay the sniff/convert cost.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size <= 0) return null;
  if (stat.size > DETECT_MAX_IMAGE_BYTES) return null;

  // Magic-number sniff. Reject files whose actual bytes don't match
  // any supported image type — the extension can lie.
  const sniffed = sniffImageMimeFromFile(absPath);
  if (sniffed === null) return null;

  if (sniffed === 'image/heic') {
    const converted = convertHeicToPng(absPath);
    if (!converted.ok) {
      return {
        meta: {
          absPath,
          mimeType: 'image/heic',
          bytes: stat.size,
          fileName: path.basename(absPath),
        },
        warning: converted.message,
      };
    }
    // Re-stat the converted PNG so the pill shows the new size.
    let convertedStat: fs.Stats | null = null;
    try {
      convertedStat = fs.statSync(converted.outputPath);
    } catch {
      convertedStat = null;
    }
    const bytes = convertedStat ? convertedStat.size : stat.size;
    if (convertedStat !== null && convertedStat.size > DETECT_MAX_IMAGE_BYTES) {
      return null;
    }
    return {
      meta: {
        absPath: converted.outputPath,
        mimeType: 'image/png',
        bytes,
        fileName: path.basename(absPath),
      },
      warning: null,
    };
  }

  return {
    meta: {
      absPath,
      mimeType: sniffed,
      bytes: stat.size,
      fileName: path.basename(absPath),
    },
    warning: null,
  };
}

/**
 * Walk every line in the editor state and promote any line that is JUST
 * a bare image path (or up to MAX_PATHS_PER_LINE space-separated bare
 * paths) into image paste tokens. Mirrors `promoteAtImageDirectives`
 * but for the bare-path syntax — no `@image` directive required.
 *
 * Lines that fail the strict "JUST paths" test (mixed prose + paths)
 * stay verbatim so we never silently swallow user input. HEIC
 * conversion failures stash a warning into the returned `warnings`
 * array; callers can surface them via the toast system.
 */
function promoteBareImagePaths(
  state: EditorState,
  cwd: string,
): { state: EditorState; warnings: readonly string[] } {
  const allLines = [...state.committedLines, state.value];
  const nextPastes = new Map(state.pastes);
  let counter = state.pasteCounter;
  let mutated = false;
  const nextLines: string[] = [];
  const warnings: string[] = [];

  for (const line of allLines) {
    const expanded = expandMarkers(line, state.pastes);
    // Fast bail when the line obviously isn't a path. This keeps the
    // hot-loop cheap for prose lines.
    if (!looksLikeBareImagePath(expanded)) {
      nextLines.push(line);
      continue;
    }
    const matches = detectImagePathsInLine(expanded, cwd);
    if (matches.length === 0) {
      nextLines.push(line);
      continue;
    }
    // Replace the line with N markers, dropping the bare path text.
    const markers: string[] = [];
    let allOk = true;
    for (const m of matches) {
      const attached = attachBarePath(m.absolutePath);
      if (attached === null) {
        allOk = false;
        break;
      }
      const dataUrl = readImageAsDataUrl(attached.meta);
      if (dataUrl === null) {
        allOk = false;
        break;
      }
      if (attached.warning !== null) {
        warnings.push(attached.warning);
      }
      const id = crypto.randomUUID();
      counter += 1;
      const token: PasteToken = {
        id,
        number: counter,
        text: dataUrl,
        kind: 'image',
        label: `Image: ${attached.meta.fileName} · ${formatBytes(attached.meta.bytes)}`,
      };
      nextPastes.set(id, token);
      markers.push(markerFor(id));
    }
    if (allOk && markers.length > 0) {
      nextLines.push(markers.join(' '));
      mutated = true;
    } else {
      nextLines.push(line);
    }
  }

  if (!mutated) return { state, warnings };
  const committedLines = nextLines.slice(0, -1);
  const value = nextLines[nextLines.length - 1] ?? '';
  const committedLineIds: number[] = [];
  let seq = state.committedLineSeq;
  for (let i = 0; i < committedLines.length; i++) {
    const prevId = state.committedLineIds[i];
    if (typeof prevId === 'number') {
      committedLineIds.push(prevId);
    } else {
      committedLineIds.push(seq);
      seq += 1;
    }
  }
  return {
    state: {
      ...state,
      committedLines,
      committedLineIds,
      committedLineSeq: seq,
      value,
      cursorOffset: value.length,
      pastes: nextPastes,
      pasteCounter: counter,
    },
    warnings,
  };
}
// AUTO-IMAGE-PROMOTE-SECTION end

/**
 * ATTACHMENT-SECTION — Walk every line in the editor state and promote
 * any line that matches `@image <path>` (or `@img <path>`) into an
 * image paste token. The directive line is removed from the buffer
 * (so the user's prose stays clean) and replaced with the paste
 * marker; the underlying paste text is the `data:image/<mime>;base64,...`
 * URL the adapter will pick up.
 *
 * Lines whose path doesn't resolve to a readable image are left in
 * place — visible failure beats silent drop, the user can see what
 * went wrong and retry.
 *
 * Pure helper: takes a snapshot and returns a new snapshot.
 */
function promoteAtImageDirectives(state: EditorState): EditorState {
  const allLines = [...state.committedLines, state.value];
  const nextPastes = new Map(state.pastes);
  let counter = state.pasteCounter;
  let mutated = false;
  const nextLines: string[] = [];

  for (const line of allLines) {
    const expanded = expandMarkers(line, state.pastes);
    const candidate = parseAtImageDirective(expanded);
    if (candidate === null) {
      nextLines.push(line);
      continue;
    }
    const resolved = resolveAtImagePath(candidate);
    const meta = readImageMetaForAttach(resolved);
    if (meta === null) {
      // Failed resolve — leave the line as-is so the user notices.
      nextLines.push(line);
      continue;
    }
    const dataUrl = readImageAsDataUrl(meta);
    if (dataUrl === null) {
      nextLines.push(line);
      continue;
    }
    const id = crypto.randomUUID();
    counter += 1;
    const token: PasteToken = {
      id,
      number: counter,
      text: dataUrl,
      kind: 'image',
      label: `Image: ${meta.fileName} · ${formatBytes(meta.bytes)}`,
    };
    nextPastes.set(id, token);
    nextLines.push(markerFor(id));
    mutated = true;
  }

  if (!mutated) return state;
  const committedLines = nextLines.slice(0, -1);
  const value = nextLines[nextLines.length - 1] ?? '';
  // Preserve / extend the parallel id array. We always emit fresh ids
  // for new committed lines so the keys stay unique within the
  // composition.
  const committedLineIds: number[] = [];
  let seq = state.committedLineSeq;
  for (let i = 0; i < committedLines.length; i++) {
    const prevId = state.committedLineIds[i];
    if (typeof prevId === 'number') {
      committedLineIds.push(prevId);
    } else {
      committedLineIds.push(seq);
      seq += 1;
    }
  }
  return {
    ...state,
    committedLines,
    committedLineIds,
    committedLineSeq: seq,
    value,
    cursorOffset: value.length,
    pastes: nextPastes,
    pasteCounter: counter,
  };
}

/**
 * Compose the full text the editor currently represents, with paste
 * markers resolved back to their underlying text. This is what gets
 * sent to `onSubmit`.
 *
 * R21 — when at least one paste in the composition is an image drop,
 * append a one-line hint so non-Claude models (Qwen et al.) understand
 * they should call `fetch_image` on the inline data URL. Claude's
 * vision pipeline already handles the data URL natively but the hint
 * is harmless there too. The hint lives at the END of the message so
 * the user's words still lead the prompt.
 */
function composeFullText(state: EditorState): string {
  const lines = [
    ...state.committedLines.map((l) => expandMarkers(l, state.pastes)),
    expandMarkers(state.value, state.pastes),
  ];
  let composed = lines.join('\n');
  let hasImage = false;
  for (const tok of state.pastes.values()) {
    if (tok.kind === 'image') {
      hasImage = true;
      break;
    }
  }
  if (hasImage) {
    composed +=
      '\n[The user pasted an image. Call fetch_image with the data: URL above to view it.]';
  }
  return composed;
}

/**
 * Pre-formatted chalk renderer for the placeholder pill. Wrapped so
 * the same string of styling (`bgHex(darker).hex(white)` + space
 * padding) can be reused by every paste rendered.
 *
 * R21 — image pastes use the token's pre-baked `label` (which already
 * encodes the filename + size) and a slightly lighter purple-blue
 * background so the user can tell at a glance it's not a plain text
 * paste. A `🖼` glyph prefixes the text so even on terminals that
 * collapse the bg colour the type is still obvious.
 *
 * R25 — compact pill. The previous format
 * `[Paste #N · X lines · Y chars]` was 35–40 characters wide which
 * routinely wrapped to a second line on narrow terminals or when the
 * InputBar already had text beside it, breaking the bordered-row
 * layout. The new format is anchored to the most informative scalar:
 *   - multi-line text paste → `[#N: X lines]`         (≈12 chars)
 *   - single-line text paste → `[#N: <chars>c]`       (≈10 chars)
 *   - image drop            → `[🖼 abc...png · 234KB]` (≈22 chars)
 * The image filename is truncated to ≤24 chars (head + `...` + 3-char
 * tail) so even noisy macOS screenshot names like
 * `Screenshot 2026-04-27 at 20.45.32.png` collapse to something that
 * still fits on a single line. The whole pill is wrapped in a single
 * chalk bg call so it stays atomic during ink's segment splitting and
 * never gets a colour artifact at a wrap point.
 */
function truncateFilename(name: string, max: number): string {
  if (name.length <= max) return name;
  // Keep a hint of the extension by reserving the last 3 chars for
  // the suffix; everything else gets a head + ellipsis.
  // E.g. `Screenshot 2026-04-27 at 20.45.32.png` (max=24) →
  // `Screenshot 2026-...png`.
  const tail = name.slice(-3);
  const head = name.slice(0, Math.max(1, max - 3 - tail.length));
  return `${head}...${tail}`;
}

const renderPasteLabel = (token: PasteToken): string => {
  if (token.kind === 'image') {
    // The image token's `label` carries the verbose filename + size,
    // but for the pill we re-derive a tighter rendering. We keep the
    // label as a fallback in case a future caller hand-builds the
    // token without the structured filename in the text field.
    const fallback = token.label ?? `image#${token.number}`;
    // The label encodes `Image: <name> · <size>` (R21). Parse it
    // back to a compact form; if the format ever changes, fall back
    // to the raw label.
    const stripped = fallback.replace(/^Image:\s*/i, '');
    const parts = stripped.split(' · ');
    const rawName = parts[0] ?? `image#${token.number}`;
    const rawSize = parts[1] ?? '';
    const name = truncateFilename(rawName, 24);
    // Drop the space between number + KB/MB to save ~1 char per pill.
    const size = rawSize.replace(/\s+/g, '');
    const sizePart = size.length > 0 ? ` · ${size}` : '';
    const label = ` [🖼 ${name}${sizePart}] `;
    // Slightly bluer purple than the text-paste pill — sits visually
    // between the lavender accent and the dark frame so the image
    // pill reads as "different but related". `noxPalette.primary`
    // (#7c3aed) gives us that bluer-purple distinction without
    // breaking the brand palette.
    return chalk.bgHex(noxPalette.primary).hex(noxPalette.white)(label);
  }
  // Count newlines without splitting (cheaper, no array alloc).
  let nl = 0;
  for (let i = 0; i < token.text.length; i++) {
    if (token.text.charCodeAt(i) === 10) nl++;
  }
  const lines = nl + 1;
  const inner =
    lines === 1
      ? `#${token.number}: ${token.text.length}c`
      : `#${token.number}: ${lines} lines`;
  const label = ` [${inner}] `;
  return chalk.bgHex(noxPalette.darker).hex(noxPalette.white)(label);
};

/**
 * Render a line of the buffer (committed OR active), substituting
 * each paste marker with the styled pill. When `cursorOffset` is
 * provided, an inverse cell is drawn at that offset (treating each
 * marker as a single rendering unit).
 */
function renderLine(
  value: string,
  pastes: ReadonlyMap<string, PasteToken>,
  cursorOffset: number | null,
  baseColor: string,
): React.JSX.Element {
  if (value.length === 0) {
    if (cursorOffset === null) return <Text> </Text>;
    return <Text inverse> </Text>;
  }
  const segments = tokenize(value);
  const parts: React.ReactNode[] = [];
  // Track if the cursor has been visually drawn so we can append a
  // trailing inverse space if it sits past the very end.
  let cursorDrawn = false;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === 'text') {
      // The active text segment may host the cursor — split it so we
      // can put an `inverse` cell at exactly the right column.
      if (
        cursorOffset !== null &&
        cursorOffset >= seg.start &&
        cursorOffset < seg.start + seg.text.length
      ) {
        const local = cursorOffset - seg.start;
        const before = seg.text.slice(0, local);
        const at = seg.text.slice(local, local + 1);
        const after = seg.text.slice(local + 1);
        parts.push(
          <Text key={`t-${i}`} color={baseColor}>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>,
        );
        cursorDrawn = true;
      } else {
        parts.push(
          <Text key={`t-${i}`} color={baseColor}>
            {seg.text}
          </Text>,
        );
      }
    } else {
      const tok = pastes.get(seg.id);
      if (tok === undefined) {
        // Orphan marker — should never happen, but render a tiny
        // fallback so we don't crash. (Empty space keeps the layout
        // sane; the marker is still in the value so cursor logic is
        // unaffected.)
        parts.push(<Text key={`p-${i}`}> </Text>);
        continue;
      }
      const label = renderPasteLabel(tok);
      // The cursor can sit at the START of a marker — render an
      // inverse cell *before* the pill in that case.
      if (cursorOffset !== null && cursorOffset === seg.start) {
        parts.push(
          <Text key={`p-${i}`}>
            <Text inverse> </Text>
            {label}
          </Text>,
        );
        cursorDrawn = true;
      } else {
        parts.push(<Text key={`p-${i}`}>{label}</Text>);
      }
    }
  }

  // Cursor sits past the end of the buffer (e.g. after "hello|") —
  // append a trailing inverse space.
  if (cursorOffset !== null && !cursorDrawn && cursorOffset === value.length) {
    parts.push(
      <Text key="cursor-tail" inverse>
        {' '}
      </Text>,
    );
  }

  return <Text>{parts}</Text>;
}

/**
 * Render the placeholder hint with an inverse cell on the first
 * character to mark the cursor. Mirrors `<TextInput>`'s placeholder
 * rendering (chalk.inverse first char + chalk.dim rest), but uses
 * ink's native `<Text>` styling so we stay chalk-free here.
 */
function Placeholder({ text }: { readonly text: string }): React.JSX.Element {
  if (text.length === 0) {
    return <Text inverse> </Text>;
  }
  const first = text.slice(0, 1);
  const rest = text.slice(1);
  return (
    <Text>
      <Text inverse>{first}</Text>
      <Text dimColor>{rest}</Text>
    </Text>
  );
}

function InputBar({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder,
  history,
  borderColor,
  disableHistoryNav = false,
  resetTrigger,
  status,
  showHint = true,
  testColumns,
}: InputBarProps): React.JSX.Element {
  // Initial editor state hydrated from the externally-supplied `value`.
  // We honour `\n` in the seed so callers can prefill multi-line drafts
  // (e.g. an `/edit` slash command); future updates of the `value` prop
  // are NOT mirrored — we own the buffer once mounted, and the parent
  // is expected to remount us via a key bump if it really needs to
  // overwrite our state. This matches the pre-R9 contract (the old
  // `<TextInput>` was uncontrolled with `defaultValue={value}`).
  const [state, setState] = useState<EditorState>(() => splitMultiline(value));

  // M1 / M10 — keep a synchronously-updated mirror of `state` for the
  // useInput closure. The keypress dispatcher fires inside React's
  // event boundary and previously closed over the `state` it was
  // declared with. When multiple keystrokes landed in the same render
  // (image drop branch, paste collapse, cycleHistory snapshot), the
  // first one's `setState` left `state` stale until the next React
  // render — so the second one read the wrong snapshot and could
  // either drop the paste or snapshot an outdated draft into history.
  // The ref is updated in every render and read by the dispatcher so
  // every branch sees the latest values.
  const stateRef = useRef<EditorState>(state);
  stateRef.current = state;

  // History browsing state. `index === null` means "not browsing".
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const savedDraftRef = useRef<EditorState>(state);

  // Mirror the parent's controlled-value contract: emit the active line
  // on every change. The parent uses this for slash-menu detection
  // (which only inspects the start of the buffer), so we ONLY surface
  // the active row — committed lines are an internal-to-InputBar
  // detail until submit. We expand markers in the emitted value so
  // detection logic doesn't see our sentinel chars.
  const lastEmittedRef = useRef<string>(value);
  useEffect(() => {
    const expanded = expandMarkers(state.value, state.pastes);
    if (expanded !== lastEmittedRef.current) {
      lastEmittedRef.current = expanded;
      onChange(expanded);
    }
  }, [state.value, state.pastes, onChange]);

  // M2 — `resetTrigger` watcher. The parent ticks this when it wants
  // the editor cleared without paying a full unmount→mount churn. We
  // intentionally skip the initial render (lastSeenRef === undefined
  // on mount) so the first paint doesn't double-reset; subsequent
  // changes wipe state + history-browse + the lastEmitted mirror so
  // the next onChange fires for the empty-string snapshot.
  const lastResetTriggerRef = useRef<number | undefined>(resetTrigger);
  useEffect(() => {
    if (resetTrigger === undefined) return;
    if (lastResetTriggerRef.current === resetTrigger) return;
    lastResetTriggerRef.current = resetTrigger;
    setState(EMPTY_STATE);
    setHistoryIndex(null);
    savedDraftRef.current = EMPTY_STATE;
    lastEmittedRef.current = '';
  }, [resetTrigger]);

  /**
   * Replace the entire editor state with the given snapshot. Wraps the
   * useState setter so callers don't accidentally mutate.
   */
  const replaceState = useCallback((next: EditorState): void => {
    setState(next);
  }, []);

  /**
   * Apply a history entry: split it into committed/active rows and
   * exit browse mode is left to the caller. Multi-line entries (R9
   * forward-compat) get spread across `committedLines + value` so the
   * cursor lands at the end of the last line — natural for editing.
   */
  const loadHistoryEntry = useCallback(
    (entry: string): void => {
      replaceState(splitMultiline(entry));
    },
    [replaceState],
  );

  const cycleHistory = useCallback(
    (direction: 'older' | 'newer'): void => {
      if (history === undefined || history.length === 0) return;
      const maxIdx = history.length - 1;

      if (historyIndex === null) {
        if (direction === 'older') {
          // First ↑: snapshot the current draft and jump to the
          // newest history entry. M10 — read via stateRef so a
          // queued setState from the same render tick doesn't make
          // us snapshot a stale draft.
          savedDraftRef.current = stateRef.current;
          const entry = history[maxIdx] ?? '';
          setHistoryIndex(maxIdx);
          loadHistoryEntry(entry);
        }
        // First ↓ with no browse active: no-op.
        return;
      }

      if (direction === 'older') {
        const newIdx = Math.max(0, historyIndex - 1);
        if (newIdx === historyIndex) return;
        const entry = history[newIdx] ?? '';
        setHistoryIndex(newIdx);
        loadHistoryEntry(entry);
        return;
      }

      // direction === 'newer'
      const newIdx = historyIndex + 1;
      if (newIdx > maxIdx) {
        // Past newest: exit browse mode and clear the input.
        setHistoryIndex(null);
        savedDraftRef.current = EMPTY_STATE;
        replaceState(EMPTY_STATE);
        return;
      }
      const entry = history[newIdx] ?? '';
      setHistoryIndex(newIdx);
      loadHistoryEntry(entry);
    },
    [history, historyIndex, loadHistoryEntry, replaceState],
  );

  /**
   * Single-source-of-truth keypress dispatcher. We OWN the entire
   * pipeline (no `<TextInput>` co-listener), so this handler is the
   * only thing that mutates the editor state and decides when to fire
   * `onSubmit`. The order of branches matters: special keys (Esc,
   * Enter, arrows, backspace) are handled BEFORE the catch-all
   * `state.insert(input)` so e.g. the `\r` byte that accompanies
   * `key.return` doesn't slip in as text.
   *
   * Routed through the centralised InputDispatcher in `'input'` mode.
   * The dispatcher invokes us only when no `'approval'` / `'overlay'`
   * subscriber is on screen, which removes the entire class of
   * keystroke-leak bugs (e.g. `y` confirming an ApprovalPrompt and
   * also landing in this buffer) by construction. Returning `true`
   * marks the keystroke consumed; returning `false` lets a lower-
   * priority subscriber in the same mode (none today) see the same
   * key.
   */
  const inputHandler = useCallback(
    (event: InputEvent): boolean => {
      const { input, key } = event;
      if (disabled) {
        // Defence-in-depth: even though the parent should not route
        // us keys when an approval prompt is up, the dispatcher
        // currently keeps a subscription edge in `'input'` mode and
        // we want a hard local guard against acting on stale keys.
        // Returning `false` lets a sibling subscriber (e.g. the
        // ChatScreen Esc handler) still see the same key.
        return false;
      }

        // Esc clears the entire editor (committed + active) and exits
        // history browse mode. This is a stronger reset than the old
        // `<TextInput>` — useful now that there's a multi-line buffer
        // that would otherwise be a chore to clean line-by-line.
        if (key.escape) {
          setHistoryIndex(null);
          savedDraftRef.current = EMPTY_STATE;
          replaceState(EMPTY_STATE);
          // Fall through (`return false`) so the ChatScreen Esc
          // handler — also subscribed to `'input'` mode — sees the
          // same key and can run its cancel-stream / double-Esc
          // logic. This mirrors the pre-dispatcher behaviour where
          // both `useInput` calls fired on the same Esc.
          return false;
        }

        // SHIFT-ENTER-SECTION — start
        // Shift+Enter: commit the active line, start a new empty line.
        // The cursor lands at the start of the fresh line. ink's
        // useInput surfaces the modifier via `key.shift`; we must
        // inspect it BEFORE the plain-Enter branch below or the submit
        // path would swallow the keystroke and the user would see a
        // submit instead of a newline.
        if (key.return && key.shift) {
          setHistoryIndex(null);
          savedDraftRef.current = EMPTY_STATE;
          setState((prev) => ({
            ...prev,
            committedLines: [...prev.committedLines, prev.value],
            // M5 — assign a fresh monotonic id for the new committed line.
            committedLineIds: [...prev.committedLineIds, prev.committedLineSeq],
            committedLineSeq: prev.committedLineSeq + 1,
            value: '',
            cursorOffset: 0,
          }));
          return true;
        }
        // SHIFT-ENTER-SECTION — end

        // Plain Enter: submit the full text. We pass the composed
        // multi-line string to the parent and reset history state. The
        // parent typically follows up with a remount (key bump) which
        // resets `state` to its initial empty value — so we don't need
        // to reset it ourselves here, but we DO clear in case the
        // parent doesn't (defensive). M1 — read from stateRef so a
        // pending setState from earlier in the same dispatch tick
        // doesn't get lost.
        if (key.return) {
          // ATTACHMENT-SECTION — resolve any `@image <path>` directives
          // in the composition (across both committed and active lines)
          // before composing the full text. Each successful resolve
          // becomes an image-paste token whose underlying text is the
          // data URL; failed resolves leave the literal `@image ...`
          // verbatim so the user can see the failure on-screen.
          let promoted = promoteAtImageDirectives(stateRef.current);
          // AUTO-IMAGE-PROMOTE-SECTION — also promote bare image paths
          // pasted on their own line (e.g. dragged from Finder). Same
          // pure-helper semantics: failed resolves leave the line
          // untouched so the user can see what didn't match.
          const bareResult = promoteBareImagePaths(promoted, process.cwd());
          promoted = bareResult.state;
          const fullText = composeFullText(promoted);
          setHistoryIndex(null);
          savedDraftRef.current = EMPTY_STATE;
          replaceState(EMPTY_STATE);
          onSubmit(fullText);
          return true;
        }

        // History navigation (gated by `disableHistoryNav`). Note: the
        // SlashMenu also subscribes to `'input'` mode and consumes ↑/↓
        // before us, so when the menu is open we don't actually receive
        // arrows. The legacy `disableHistoryNav` prop remains as a
        // belt-and-braces gate for callers that haven't moved to the
        // dispatcher yet.
        if (key.upArrow) {
          if (disableHistoryNav) return true;
          cycleHistory('older');
          return true;
        }
        if (key.downArrow) {
          if (disableHistoryNav) return true;
          cycleHistory('newer');
          return true;
        }

        // Cursor movement within the active line. Markers are
        // navigated as a single unit (cursor jumps over them whole).
        if (key.leftArrow) {
          setState((prev) => ({
            ...prev,
            cursorOffset: prevBoundary(prev.value, prev.cursorOffset),
          }));
          return true;
        }
        if (key.rightArrow) {
          setState((prev) => ({
            ...prev,
            cursorOffset: nextBoundary(prev.value, prev.cursorOffset),
          }));
          return true;
        }

        // Backspace / delete. Special case: when the active line is
        // empty AND the cursor is at column 0, "absorb" the most recent
        // committed line back into the active line — the inverse of
        // Shift+Enter. This makes the multi-line editor feel
        // non-destructive (Backspace into an empty line doesn't lose
        // the line break, it un-commits it).
        //
        // R10: backspace at the right of a paste marker deletes the
        // ENTIRE marker and its underlying paste (one keystroke = one
        // visible unit gone, mirroring how the user perceives the pill).
        if (key.backspace || key.delete) {
          setState((prev) => {
            if (prev.value.length === 0 && prev.committedLines.length > 0) {
              const last = prev.committedLines[prev.committedLines.length - 1] ?? '';
              return {
                ...prev,
                committedLines: prev.committedLines.slice(0, -1),
                // M5 — drop the corresponding id so the rest of the
                // ids stay aligned with their visible rows.
                committedLineIds: prev.committedLineIds.slice(0, -1),
                value: last,
                cursorOffset: last.length,
              };
            }
            const result = deleteBackward(prev.value, prev.cursorOffset);
            // If we removed a paste marker, drop its entry from the
            // `pastes` map. We DO NOT renumber the remaining pastes —
            // that would shift the labels mid-composition and confuse
            // the user. The counter keeps growing monotonically until
            // the next submit.
            let nextPastes = prev.pastes;
            if (result.removedPasteId !== null) {
              const m = new Map(prev.pastes);
              m.delete(result.removedPasteId);
              nextPastes = m;
            }
            return {
              ...prev,
              value: result.value,
              cursorOffset: result.cursorOffset,
              pastes: nextPastes,
            };
          });
          // Any explicit edit exits history browse mode.
          if (historyIndex !== null) {
            setHistoryIndex(null);
            savedDraftRef.current = EMPTY_STATE;
          }
          return true;
        }

        // Tab is reserved (we don't insert literal tabs into the chat
        // prompt — most chat backends would render them ambiguously).
        // Suggestions/autocomplete are not used by InputBar; ignore.
        if (key.tab) return true;

        // Ctrl+<x> combinations are reserved for the host (e.g. the
        // ChatScreen Ctrl+R / Ctrl+X queue handlers also subscribed
        // to `'input'` mode). We never insert their textual byte —
        // and we return `false` so the screen-level subscriber sees
        // the same key.
        if (key.ctrl) return false;

        // Catch-all: treat as printable input. Any printable
        // keystroke also exits history browse mode (the user is
        // committing to a new draft).
        if (input.length > 0) {
          if (historyIndex !== null) {
            setHistoryIndex(null);
            savedDraftRef.current = EMPTY_STATE;
          }

          // R21 — image drag-drop. iTerm2 etc. paste the absolute file
          // path of a Finder/Explorer drop as plain text. We detect that
          // shape (single line, leading `/`, image extension, file
          // exists, < 10 MB) and substitute the drop for an image-kind
          // paste marker whose underlying text is a `data:image/...`
          // URL. The check fires only when the input is a candidate
          // path AND the active line is empty AND there are no
          // committed lines — i.e. the drop is the FIRST thing the
          // user contributed to the composition. This avoids
          // triggering on a user who happens to paste a path
          // mid-sentence; image drops always land into a fresh
          // editor.
          // M1 — read from stateRef so a setState scheduled earlier in
          // this dispatch (e.g. backspace + paste in a synthetic
          // burst) doesn't make us misjudge the "fresh editor" check.
          const refState = stateRef.current;
          const couldBeImageDrop =
            refState.committedLines.length === 0 &&
            refState.value.length === 0 &&
            !input.includes('\n') &&
            input.length >= 6 &&
            input.length <= 4096;
          if (couldBeImageDrop) {
            const meta = detectImageDrop(input);
            if (meta !== null) {
              const dataUrl = readImageAsDataUrl(meta);
              if (dataUrl !== null) {
                setState((prev) => {
                  const id = crypto.randomUUID();
                  const number = prev.pasteCounter + 1;
                  const token: PasteToken = {
                    id,
                    number,
                    text: dataUrl,
                    kind: 'image',
                    label: `Image: ${meta.fileName} · ${formatBytes(meta.bytes)}`,
                  };
                  const marker = markerFor(id);
                  const co = prev.cursorOffset;
                  const nextValue =
                    prev.value.slice(0, co) + marker + prev.value.slice(co);
                  const nextPastes = new Map(prev.pastes);
                  nextPastes.set(id, token);
                  return {
                    ...prev,
                    value: nextValue,
                    cursorOffset: co + marker.length,
                    pastes: nextPastes,
                    pasteCounter: number,
                  };
                });
                return true;
              }
              // readImageAsDataUrl failed — fall through and treat as
              // a normal paste/text insert. Better to leak the path
              // into the buffer than swallow the user's input.
            }
          }

          // R10 — large/multi-line input is a paste. Collapse it into
          // a single placeholder marker; store the underlying text in
          // the `pastes` map so submit can substitute it back.
          if (isPasteEvent(input)) {
            setState((prev) => {
              const id = crypto.randomUUID();
              const number = prev.pasteCounter + 1;
              const token: PasteToken = { id, number, text: input, kind: 'text' };
              const marker = markerFor(id);
              const co = prev.cursorOffset;
              const nextValue = prev.value.slice(0, co) + marker + prev.value.slice(co);
              const nextPastes = new Map(prev.pastes);
              nextPastes.set(id, token);
              return {
                ...prev,
                value: nextValue,
                cursorOffset: co + marker.length,
                pastes: nextPastes,
                pasteCounter: number,
              };
            });
            return true;
          }

          setState((prev) => ({
            ...prev,
            value:
              prev.value.slice(0, prev.cursorOffset) +
              input +
              prev.value.slice(prev.cursorOffset),
            cursorOffset: prev.cursorOffset + input.length,
          }));
          return true;
        }
        // Unknown / empty input event — don't consume, let any other
        // subscriber in the same `'input'` mode see it.
        return false;
    },
    [
      // M1 — `state` is intentionally NOT in the deps array; the
      // dispatcher reads via `stateRef.current` so its closure
      // identity stays stable across renders. This avoids the
      // dispatcher re-registering the subscription on every render.
      cycleHistory,
      disableHistoryNav,
      disabled,
      historyIndex,
      onSubmit,
      replaceState,
    ],
  );
  useInputModeHandler('input', inputHandler);

  // R20 — Bash-mode detection: the first committed line takes
  // priority because that's where the leading `!` sits once the user
  // grew the buffer with Shift+Enter. Empty committed buffer falls
  // back to the active row (most common case: single-line `!ls`).
  const bashProbe =
    state.committedLines.length > 0
      ? expandMarkers(state.committedLines[0] ?? '', state.pastes)
      : expandMarkers(state.value, state.pastes);
  const isBashMode = !disabled && isBashModeBuffer(bashProbe);

  // FIX #26 — purple accents: active border is lavender, dimmed state
  // falls back to the dim-separator purple (still visible on dark bg).
  // R12: switched the dim case from `noxPalette.darker` (#4c1d95, almost
  // invisible on black) to `dimSeparator` so even disabled input bars
  // keep a perceivable frame.
  // R20: bash-mode flips the border to a soft green so the entire row
  // (not just the prompt glyph) signals "this is a local shell call".
  const effectiveBorderColor =
    borderColor ??
    (disabled ? dimSeparator : isBashMode ? '#86efac' : noxPalette.light);
  const promptGlyph = disabled
    ? theme.muted('❯')
    : isBashMode
      ? chalk.hex('#86efac').bold('$')
      : theme.prompt;
  const placeholderText = placeholder ?? 'Type a message or /command…';

  // Decide whether to show the placeholder. Convention: only when both
  // the active line and the committed buffer are empty.
  const showPlaceholder = useMemo(
    () => state.committedLines.length === 0 && state.value.length === 0,
    [state.committedLines.length, state.value.length],
  );

  // Wave 5A — pick the pill layout based on terminal width. `testColumns`
  // wins when supplied (used by layout tests); otherwise we subscribe
  // to ink's stdout resize stream via `useTerminalWidth`.
  const liveColumns = useTerminalWidth();
  const columns = testColumns ?? liveColumns;
  const pillLayout = useMemo(() => pickPillLayout(columns), [columns]);

  // The status pill row renders only when the parent supplied the full
  // status payload. When any field is missing we omit the whole row so
  // legacy callers (tests, web mirrors, the onboarding shell) keep
  // their compact single-bar look.
  const pillNode =
    status !== undefined && !pillLayout.hidden ? (
      <StatusPill
        provider={status.provider}
        model={status.model}
        contextPercent={status.contextPercent}
        profile={status.profile}
        outputStyle={status.outputStyle}
        compact={pillLayout.compact}
      />
    ) : null;

  // Round 6: the bordered row stretches to the full available width
  // using the canonical flexbox "fill remaining space" pattern.
  //   flexGrow={1}     → take any leftover space
  //   flexShrink={1}   → shrink before overflowing the parent
  //   flexBasis="0%"   → don't reserve content-sized space; start from 0
  //                       and grow into whatever is free.
  //
  // R9: the box is now `flexDirection="column"` so committed lines stack
  // above the active line. Each row is its own `flexDirection="row"`
  // child with the prompt glyph + content. The first row uses the
  // bright/dim prompt glyph the same way as before; subsequent rows
  // use a continuation marker so the user can tell at a glance which
  // row holds the cursor.
  //
  // Wave 5A — the bordered editor itself is unchanged so existing
  // tests (input-bar-disabled, chatscreen-input-gating source-shape
  // checks) keep matching. The new pill row sits above it; the hint
  // row sits below.
  const editorBox = (
    <InputBorder focused={!disabled} borderColor={effectiveBorderColor}>
      {state.committedLines.map((line, i) => {
        // M5 — content-stable key derived from the monotonic id
        // assigned at Shift+Enter time. Falls back to the array index
        // only when the id slot is missing (shouldn't happen, but is a
        // safe degradation if the parallel arrays ever drift).
        const id = state.committedLineIds[i] ?? i;
        return (
          <Box key={`cl-${id}`} flexDirection="row">
            <Text color={textMuted}>┊</Text>
            <Text> </Text>
            <Box flexGrow={1} flexShrink={1} flexBasis="0%">
              {renderLine(line, state.pastes, null, noxPalette.white)}
            </Box>
          </Box>
        );
      })}
      <Box flexDirection="row">
        <Text>{promptGlyph}</Text>
        <Text> </Text>
        {isBashMode && (
          <>
            <Text color="#86efac" bold>
              bash
            </Text>
            <Text> </Text>
          </>
        )}
        <Box flexGrow={1} flexShrink={1} flexBasis="0%">
          {showPlaceholder ? (
            <Placeholder text={placeholderText} />
          ) : (
            renderLine(
              state.value,
              state.pastes,
              disabled ? null : state.cursorOffset,
              noxPalette.white,
            )
          )}
        </Box>
      </Box>
      {isBashMode && (
        <Box paddingLeft={2}>
          <Text color={textMuted} dimColor>
            $ Bash mode — output goes to chat only, model won't see it
          </Text>
        </Box>
      )}
    </InputBorder>
  );

  // Wave 5A — footer hint row. Sits below the bordered editor and lists
  // the four keystrokes the user actually cares about. Rendered in
  // `textMuted` so it never competes with the editor; collapsed on very
  // narrow terminals (< 40 cols) where every column counts.
  const hintNode =
    showHint && !pillLayout.hidden ? (
      <Box paddingX={1}>
        <Text color={textMuted} dimColor>
          {pillLayout.compact
            ? '↵ send · ⇧↵ newline · / commands'
            : '↵ send · ⇧↵ newline · ⇥ agent · / commands · ! bash'}
        </Text>
      </Box>
    ) : null;

  return (
    <Box flexDirection="column" width="100%" flexGrow={1} flexShrink={1} flexBasis="0%">
      {pillNode}
      {editorBox}
      {hintNode}
    </Box>
  );
}

export default InputBar;

/**
 * Internal pure helpers exposed for unit tests in
 * `tests/ui/input-bar-shift-enter.test.ts`. Not part of the public API —
 * external callers should NOT depend on these. Kept under a single
 * `__test__` namespace export so accidental usage in app code is easy
 * to spot in code review.
 */
export const __test__ = {
  splitMultiline,
  composeFullText,
  isPasteEvent,
  isBashModeBuffer,
  detectImageDrop,
  unwrapQuotedPath,
  formatBytes,
  mimeTypeForExt,
  readImageAsDataUrl,
  pickPillLayout,
  PILL_BREAKPOINT_FULL,
  PILL_BREAKPOINT_HIDE,
  // ATTACHMENT-SECTION test exports.
  parseAtImageDirective,
  promoteAtImageDirectives,
  readImageMetaForAttach,
  // AUTO-IMAGE-PROMOTE-SECTION test exports.
  attachBarePath,
  promoteBareImagePaths,
};
