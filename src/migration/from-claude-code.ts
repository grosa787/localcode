/**
 * Migration: Claude Code → LocalCode session importer.
 *
 * Claude Code (Anthropic's CLI) persists each conversation as one JSONL
 * file under `~/.claude/projects/<project-path-slug>/<sessionId>.jsonl`.
 * Each line is one event; the schema overlaps loosely with LocalCode's
 * `Message`. This module:
 *
 *   1. Scans the on-disk tree to enumerate projects + sessions
 *      (no parsing of contents — cheap dir-walk + stat).
 *   2. Stream-parses a single JSONL into LocalCode `Message`s, rewriting
 *      tool names via {@link mapClaudeCodeTool}.
 *   3. Persists the mapped messages into the local SQLite store via
 *      `SessionManager.createSession` + `addMessage`, tagging the new
 *      session id so re-imports of the same source are detectable.
 *
 * Design constraints:
 *   - No network, no LLM calls. Pure local file → SQLite.
 *   - Skips already-imported sessions by checking for the
 *     `importedFrom:<sourceSessionId>` marker stored in the session
 *     `summary` field (the only free-form column we own without a
 *     schema change in `src/sessions/`).
 *   - Stream-reads .jsonl so even multi-megabyte Claude Code sessions
 *     don't peak memory.
 *   - Never throws on malformed lines — bad rows are skipped with a
 *     console.warn, the rest of the file imports cleanly.
 */

import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { Message } from '@/types/global';
import type { SessionManager } from '@/sessions/session-manager';
import { titleFromFirstMessage } from '@/sessions/session-manager';

import { mapClaudeCodeTool } from './tool-map';

// ---------- Public shapes ----------

/**
 * A single Claude Code session discovered on disk. The shape is
 * deliberately small — the overlay only needs enough to render a row
 * and call `importSession(filepath, ...)`.
 */
export interface ClaudeCodeSession {
  /** Source session id (filename without `.jsonl`). */
  readonly sessionId: string;
  /** Absolute path to the .jsonl on disk. */
  readonly filepath: string;
  /** Number of event lines in the file (best-effort line count). */
  readonly messageCount: number;
  /** First event timestamp (epoch ms); 0 when undetectable. */
  readonly firstTs: number;
  /** Last event timestamp (epoch ms); 0 when undetectable. */
  readonly lastTs: number;
  /** First user message content, truncated to 80 chars; '' when absent. */
  readonly preview: string;
}

/**
 * A Claude Code project bucket. `pathSlug` is the literal directory
 * name under `~/.claude/projects/`; `absolutePath` is the best-effort
 * reconstruction by replacing leading `-` with `/`.
 */
export interface ClaudeCodeProject {
  readonly pathSlug: string;
  readonly absolutePath: string;
  readonly sessions: ClaudeCodeSession[];
}

/** Aggregate scan result. */
export interface ImportPlan {
  readonly projects: ClaudeCodeProject[];
  readonly totalSessions: number;
}

/** Per-session import outcome. */
export interface ImportSessionResult {
  /** LocalCode session id created for this import (UUID). */
  readonly importedId: string;
  /** Number of `Message`s persisted (post tool-mapping). */
  readonly messageCount: number;
  /** De-duped warnings emitted by the tool mapper for this session. */
  readonly toolMapWarnings: string[];
}

/** Aggregate result of `importAll`. */
export interface ImportAllResult {
  readonly imported: number;
  readonly skipped: number;
  readonly errors: string[];
}

// ---------- Internal helpers ----------

/**
 * Resolve the `~/.claude/projects/` root. `CLAUDE_HOME` env override is
 * honoured first (used by tests + power users who relocate the dir).
 */
function resolveClaudeProjectsRoot(homeDir?: string): string {
  const override = process.env['CLAUDE_HOME'];
  if (override !== undefined && override.length > 0) {
    return path.join(override, 'projects');
  }
  const base = homeDir ?? homedir();
  return path.join(base, '.claude', 'projects');
}

/**
 * Reconstruct an absolute path from the Claude Code dir slug.
 *
 * Claude Code mangles `/Users/foo/Documents/myrepo` into
 * `-Users-foo-Documents-myrepo` (replaces every `/` with `-`).
 * Reversal is heuristic — paths with literal `-` characters in their
 * components are ambiguous — but produces a usable label.
 */
export function unslugProjectPath(slug: string): string {
  if (slug.length === 0) return '';
  if (slug.startsWith('-')) {
    return '/' + slug.slice(1).replace(/-/g, '/');
  }
  return slug.replace(/-/g, '/');
}

/**
 * Best-effort parse of an ISO-8601 timestamp string into epoch ms.
 * Returns 0 on any failure so callers can sort cleanly without
 * branching on undefined.
 */
function parseTs(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Read a JSONL file line-by-line via Bun's web-stream APIs. Lines are
 * yielded as raw strings (no JSON.parse here — the caller filters/
 * narrows). Skips empty lines.
 *
 * We use `Bun.file(...).stream()` so even large files don't load fully
 * into memory. Falls back to a synchronous read if the streaming API
 * misbehaves on a given filesystem (rare).
 */
async function* readJsonlLines(filepath: string): AsyncGenerator<string> {
  const file = Bun.file(filepath);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) buf += decoder.decode(value, { stream: true });
      if (done) break;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) yield line;
        nl = buf.indexOf('\n');
      }
    }
    // Drain decoder + tail.
    buf += decoder.decode();
    if (buf.length > 0) yield buf;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Narrow an unknown value to a plain Record. Used everywhere we need
 * to poke at JSONL-derived data without producing `any`.
 */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * Pull a string field off an object, returning '' when absent or wrong
 * type. Keeps call sites simple.
 */
function strField(obj: Record<string, unknown> | null, key: string): string {
  if (obj === null) return '';
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Coerce the message.content field — which Claude Code stores as
 * either a plain string or an array of content blocks — into a flat
 * string. Tool-use blocks are excluded (those become separate
 * `toolCalls`); text/thinking blocks are concatenated.
 */
function flattenContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  const parts: string[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec === null) continue;
    const type = strField(rec, 'type');
    if (type === 'text') {
      const text = strField(rec, 'text');
      if (text.length > 0) parts.push(text);
    } else if (type === 'thinking') {
      // Skip thinking blocks — LocalCode doesn't persist them inline.
    } else if (type === 'tool_result') {
      // Tool results carry their own content nested under `.content`.
      const inner = rec['content'];
      const innerFlat = flattenContent(inner);
      if (innerFlat.length > 0) parts.push(innerFlat);
    }
    // `tool_use` blocks are surfaced separately via extractToolCalls.
  }
  return parts.join('\n');
}

/**
 * Pull any `tool_use` blocks out of a Claude Code assistant content
 * array and project them onto LocalCode's `ToolCall` shape (with
 * Claude Code → LocalCode name mapping applied).
 *
 * Returns an empty array when there are no tool calls (the common path
 * for plain-text assistant messages).
 */
function extractToolCalls(
  raw: unknown,
  warnings: Set<string>,
): { calls: Message['toolCalls']; calls_count: number } {
  if (!Array.isArray(raw)) return { calls: undefined, calls_count: 0 };
  const calls: NonNullable<Message['toolCalls']> = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec === null) continue;
    if (strField(rec, 'type') !== 'tool_use') continue;
    const name = strField(rec, 'name');
    if (name.length === 0) continue;
    const mapped = mapClaudeCodeTool(name);
    if (mapped.warning.length > 0) warnings.add(mapped.warning);
    const input = asRecord(rec['input']) ?? {};
    const id = strField(rec, 'id');
    calls.push({
      id: id.length > 0 ? id : `cc-${calls.length}`,
      name: mapped.mappedName,
      arguments: input,
    });
  }
  return { calls: calls.length > 0 ? calls : undefined, calls_count: calls.length };
}

// ---------- Public API ----------

/**
 * Walk `~/.claude/projects/` (or `$CLAUDE_HOME/projects/`) and produce
 * an `ImportPlan` describing every project + session we could discover.
 *
 * Cheap: never opens the JSONL bodies beyond a tiny header probe to
 * extract the preview + timestamp pair.
 */
export async function scanClaudeCode(homeDir?: string): Promise<ImportPlan> {
  const root = resolveClaudeProjectsRoot(homeDir);
  if (!existsSync(root)) {
    return { projects: [], totalSessions: 0 };
  }
  let st;
  try {
    st = statSync(root);
  } catch {
    return { projects: [], totalSessions: 0 };
  }
  if (!st.isDirectory()) {
    return { projects: [], totalSessions: 0 };
  }

  const projects: ClaudeCodeProject[] = [];
  let totalSessions = 0;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return { projects: [], totalSessions: 0 };
  }

  for (const slug of projectDirs.sort()) {
    const projDir = path.join(root, slug);
    let projStat;
    try {
      projStat = statSync(projDir);
    } catch {
      continue;
    }
    if (!projStat.isDirectory()) continue;

    let files: string[];
    try {
      files = await readdir(projDir);
    } catch {
      continue;
    }
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort();

    const sessions: ClaudeCodeSession[] = [];
    for (const fname of jsonlFiles) {
      const filepath = path.join(projDir, fname);
      const sessionId = fname.replace(/\.jsonl$/, '');
      try {
        const probe = await probeSession(filepath, sessionId);
        sessions.push(probe);
      } catch {
        // Skip files we can't read — surface as zero-msg entries so the
        // overlay can still show them with a warning.
        sessions.push({
          sessionId,
          filepath,
          messageCount: 0,
          firstTs: 0,
          lastTs: 0,
          preview: '(unreadable)',
        });
      }
    }

    if (sessions.length > 0) {
      projects.push({
        pathSlug: slug,
        absolutePath: unslugProjectPath(slug),
        sessions,
      });
      totalSessions += sessions.length;
    }
  }

  return { projects, totalSessions };
}

const PREVIEW_MAX = 80;

/**
 * Cheap scan of a single .jsonl: count lines, pick first/last
 * timestamp, and extract the first user-message preview. Streams the
 * file so multi-megabyte sessions don't blow memory.
 */
async function probeSession(
  filepath: string,
  sessionId: string,
): Promise<ClaudeCodeSession> {
  let count = 0;
  let firstTs = 0;
  let lastTs = 0;
  let preview = '';

  for await (const line of readJsonlLines(filepath)) {
    count += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (rec === null) continue;
    const ts = parseTs(rec['timestamp']);
    if (ts > 0) {
      if (firstTs === 0) firstTs = ts;
      lastTs = ts;
    }
    if (preview.length === 0 && strField(rec, 'type') === 'user') {
      const msg = asRecord(rec['message']);
      const flat = flattenContent(msg?.['content']);
      const normalized = flat.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) {
        preview =
          normalized.length > PREVIEW_MAX
            ? normalized.slice(0, PREVIEW_MAX - 1) + '…'
            : normalized;
      }
    }
  }

  return { sessionId, filepath, messageCount: count, firstTs, lastTs, preview };
}

/**
 * Import a single .jsonl into the local SQLite store via
 * `SessionManager`. Creates a fresh LocalCode session, persists each
 * mapped message, and tags the session summary with
 * `importedFrom:<sourceSessionId>` so re-imports are detectable.
 *
 * Throws on catastrophic IO / DB failures; per-line parse errors are
 * swallowed (counted in console.warn) so a single bad row never
 * aborts the whole import.
 */
export async function importSession(
  filepath: string,
  sessionManager: SessionManager,
  options?: { projectRoot?: string; model?: string; backend?: string },
): Promise<ImportSessionResult> {
  const sourceSessionId = path
    .basename(filepath)
    .replace(/\.jsonl$/, '');

  // Duplicate-detection: scan existing sessions for our marker. This is
  // O(n) on the recent-session list — acceptable for typical user
  // databases. We bound the scan to 200 entries (mirrors /resume).
  if (alreadyImported(sessionManager, sourceSessionId)) {
    throw new Error(`already imported: ${sourceSessionId}`);
  }

  const projectRoot =
    options?.projectRoot ??
    unslugProjectPath(path.basename(path.dirname(filepath)));
  const model = options?.model ?? 'claude-code-import';
  const backend = options?.backend ?? 'anthropic';

  const session = sessionManager.createSession(projectRoot, model, backend);

  // Tag the session with the import marker (re-used as a poor-man's
  // "imported" flag). Title is taken from the first user message
  // post-parse below.
  sessionManager.updateSummary(
    session.id,
    `${IMPORT_MARKER_PREFIX}${sourceSessionId}`,
  );

  const warnings = new Set<string>();
  let persisted = 0;
  let titleSet = false;

  for await (const line of readJsonlLines(filepath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[migration] skipping malformed line in ${filepath}`);
      continue;
    }
    const rec = asRecord(parsed);
    if (rec === null) continue;

    const type = strField(rec, 'type');
    const createdAt = parseTs(rec['timestamp']) || Date.now();
    const msgRec = asRecord(rec['message']);
    const modelHint = strField(msgRec, 'model');

    if (type === 'user') {
      const content = flattenContent(msgRec?.['content']);
      if (content.length === 0) continue;
      const message: Message = {
        id: `cc-u-${persisted}-${createdAt}`,
        role: 'user',
        content,
        createdAt,
      };
      sessionManager.addMessage(session.id, message);
      persisted += 1;
      if (!titleSet) {
        try {
          sessionManager.updateTitle(
            session.id,
            titleFromFirstMessage(content),
          );
          titleSet = true;
        } catch {
          /* ignore — title is cosmetic */
        }
      }
      continue;
    }

    if (type === 'assistant') {
      const content = flattenContent(msgRec?.['content']);
      const { calls } = extractToolCalls(msgRec?.['content'], warnings);
      // Skip an entirely empty assistant turn (no text, no tool calls).
      if (content.length === 0 && (calls === undefined || calls.length === 0)) {
        continue;
      }
      const message: Message = {
        id: `cc-a-${persisted}-${createdAt}`,
        role: 'assistant',
        content,
        createdAt,
        ...(modelHint.length > 0 ? { model: modelHint } : {}),
        ...(calls !== undefined ? { toolCalls: calls } : {}),
      };
      sessionManager.addMessage(session.id, message);
      persisted += 1;
      continue;
    }

    if (type === 'tool_use') {
      // Standalone tool_use rows — rare; usually nested inside an
      // assistant message. We still surface them by writing a one-line
      // assistant stub so the chronological log preserves the call.
      const toolName = strField(rec, 'tool');
      const mapped = mapClaudeCodeTool(toolName);
      if (mapped.warning.length > 0) warnings.add(mapped.warning);
      const input = asRecord(rec['input']) ?? {};
      const id = strField(rec, 'id');
      const message: Message = {
        id: `cc-tu-${persisted}-${createdAt}`,
        role: 'assistant',
        content: '',
        createdAt,
        toolCalls: [
          {
            id: id.length > 0 ? id : `cc-tu-${persisted}`,
            name: mapped.mappedName,
            arguments: input,
          },
        ],
      };
      sessionManager.addMessage(session.id, message);
      persisted += 1;
      continue;
    }

    if (type === 'tool_result') {
      const toolUseId = strField(rec, 'tool_use_id');
      const content = flattenContent(rec['content']);
      const message: Message = {
        id: `cc-tr-${persisted}-${createdAt}`,
        role: 'tool',
        content,
        createdAt,
        toolCallId: toolUseId,
      };
      sessionManager.addMessage(session.id, message);
      persisted += 1;
      continue;
    }
    // Unknown event type — skipped silently. Claude Code emits a few
    // bookkeeping rows (`system`, `summary`, etc.) we don't need to
    // import.
  }

  return {
    importedId: session.id,
    messageCount: persisted,
    toolMapWarnings: Array.from(warnings),
  };
}

/**
 * Import every session in an `ImportPlan`. Streams progress via the
 * supplied callback (`done` ranges 0..total inclusive).
 *
 * Per-session failures are caught and aggregated into `errors` — the
 * loop never aborts on a single bad import.
 */
export async function importAll(
  plan: ImportPlan,
  sessionManager: SessionManager,
  onProgress: (done: number, total: number) => void,
): Promise<ImportAllResult> {
  const total = plan.totalSessions;
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  let done = 0;
  onProgress(0, total);
  for (const proj of plan.projects) {
    for (const sess of proj.sessions) {
      try {
        await importSession(sess.filepath, sessionManager, {
          projectRoot: proj.absolutePath,
        });
        imported += 1;
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        if (msg.startsWith('already imported:')) {
          skipped += 1;
        } else {
          errors.push(`${sess.sessionId}: ${msg}`);
        }
      }
      done += 1;
      onProgress(done, total);
    }
  }
  return { imported, skipped, errors };
}

// ---------- Duplicate-detection helpers ----------

/**
 * Prefix stored in `session.summary` to mark an imported row. Chosen
 * over a plain UUID so the round-trip is human-debuggable when
 * inspecting the SQLite file by hand.
 */
export const IMPORT_MARKER_PREFIX = 'importedFrom:claude-code:';

/**
 * Returns true when a LocalCode session already exists carrying the
 * `importedFrom:claude-code:<sourceSessionId>` marker. Bounded scan
 * (`listSessions(200)`) so the lookup stays cheap.
 */
export function alreadyImported(
  sessionManager: SessionManager,
  sourceSessionId: string,
): boolean {
  const marker = `${IMPORT_MARKER_PREFIX}${sourceSessionId}`;
  let recent;
  try {
    recent = sessionManager.listSessions(200);
  } catch {
    return false;
  }
  for (const s of recent) {
    if (s.summary !== null && s.summary.startsWith(marker)) return true;
  }
  return false;
}
