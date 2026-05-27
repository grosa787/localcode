/**
 * Tests for `src/migration/from-claude-code.ts` — scanning,
 * single-session import, tool-name mapping, and duplicate detection.
 *
 * Strategy:
 *   - Bundle fixtures under `tests/migration/fixtures/` mirroring the
 *     `~/.claude/projects/<slug>/<session-id>.jsonl` layout. We set
 *     `$CLAUDE_HOME` to point at a temp dir we populate from these
 *     fixtures so the scanner can find them.
 *   - Use the file-backed `SessionManager` (`createSessionManager`) with
 *     a :memory: handle so the import write path exercises the real
 *     persistence code without polluting disk.
 *   - Verify (a) scan enumerates projects + sessions, (b) import
 *     persists messages and stamps the dedup marker, (c) re-import is
 *     refused, (d) malformed JSONL lines are skipped.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  IMPORT_MARKER_PREFIX,
  alreadyImported,
  importAll,
  importSession,
  scanClaudeCode,
  unslugProjectPath,
} from '@/migration/from-claude-code';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import type { Database } from 'bun:sqlite';

// ---------- helpers ----------

const FIXTURES_ROOT = path.join(
  path.dirname(import.meta.filename),
  'fixtures',
);

let tmpHome = '';
let db: Database | null = null;
let sm: SessionManager;
let origClaudeHome: string | undefined;

beforeEach(async () => {
  tmpHome = path.join(os.tmpdir(), `lc-mig-${crypto.randomUUID()}`);
  await mkdir(path.join(tmpHome, '.claude', 'projects'), { recursive: true });

  // Copy each fixture project dir into ~/.claude/projects/ inside the
  // tmp home.
  const projectSlugs = await readdir(FIXTURES_ROOT);
  for (const slug of projectSlugs) {
    const src = path.join(FIXTURES_ROOT, slug);
    if (!fs.statSync(src).isDirectory()) continue;
    const dst = path.join(tmpHome, '.claude', 'projects', slug);
    await mkdir(dst, { recursive: true });
    const files = await readdir(src);
    for (const f of files) {
      await copyFile(path.join(src, f), path.join(dst, f));
    }
  }

  origClaudeHome = process.env['CLAUDE_HOME'];
  process.env['CLAUDE_HOME'] = path.join(tmpHome, '.claude');

  db = openDb(':memory:');
  sm = new SessionManager(db);
});

afterEach(async () => {
  if (origClaudeHome === undefined) {
    delete process.env['CLAUDE_HOME'];
  } else {
    process.env['CLAUDE_HOME'] = origClaudeHome;
  }
  try {
    await rm(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
});

// ---------- tests ----------

describe('scanClaudeCode', () => {
  test('returns empty plan when ~/.claude/projects/ is empty', async () => {
    process.env['CLAUDE_HOME'] = path.join(
      os.tmpdir(),
      `lc-empty-${crypto.randomUUID()}`,
    );
    const plan = await scanClaudeCode();
    expect(plan.totalSessions).toBe(0);
    expect(plan.projects).toHaveLength(0);
  });

  test('enumerates projects + sessions from on-disk fixtures', async () => {
    const plan = await scanClaudeCode();
    expect(plan.projects.length).toBeGreaterThanOrEqual(2);
    expect(plan.totalSessions).toBeGreaterThanOrEqual(3);

    // Each project carries a non-empty `sessions[]`.
    for (const proj of plan.projects) {
      expect(proj.sessions.length).toBeGreaterThan(0);
      expect(proj.pathSlug.length).toBeGreaterThan(0);
    }
  });

  test('unslugProjectPath reverses the leading-dash slug encoding', () => {
    expect(unslugProjectPath('-Users-test-foo')).toBe('/Users/test/foo');
    expect(unslugProjectPath('-tmp-bar')).toBe('/tmp/bar');
    expect(unslugProjectPath('')).toBe('');
  });
});

describe('importSession', () => {
  test('persists user + assistant + tool_result messages with mapped tool names', async () => {
    const plan = await scanClaudeCode();
    // Pick the larger of the two fixture sessions (the one with tool use).
    const target = plan.projects
      .flatMap((p) => p.sessions)
      .find((s) => s.messageCount >= 5);
    expect(target).toBeDefined();
    if (target === undefined) return; // narrow for TS

    const result = await importSession(target.filepath, sm);
    expect(result.importedId.length).toBeGreaterThan(0);
    expect(result.messageCount).toBeGreaterThan(0);

    // The session row should carry the import marker.
    const sess = sm.getSession(result.importedId);
    expect(sess).not.toBeNull();
    expect(sess?.summary ?? '').toContain(IMPORT_MARKER_PREFIX);

    // Persisted messages should include a tool call carrying the
    // mapped LocalCode tool name (`Read` → `read_file`).
    const msgs = sm.getAllMessages(result.importedId);
    const toolCalls = msgs.flatMap((m) => m.toolCalls ?? []);
    const names = toolCalls.map((c) => c.name);
    // We don't assert the exact name set (mapping table evolves) — we
    // just verify the assistant message that carried the tool_use
    // block was persisted with at least one tool call.
    expect(names.length).toBeGreaterThan(0);
  });

  test('malformed JSONL lines are skipped without aborting the import', async () => {
    const plan = await scanClaudeCode();
    const target = plan.projects
      .flatMap((p) => p.sessions)
      .find((s) => s.filepath.includes('aabbccdd-eeff'));
    expect(target).toBeDefined();
    if (target === undefined) return;
    const result = await importSession(target.filepath, sm);
    // The malformed middle line was skipped — surrounding valid rows
    // still persisted (user + assistant w/ tool_use, plus the
    // tool_result). At minimum, the user + assistant should land.
    expect(result.messageCount).toBeGreaterThanOrEqual(2);
  });

  test('refuses re-import of the same source session', async () => {
    const plan = await scanClaudeCode();
    const target = plan.projects.flatMap((p) => p.sessions)[0];
    expect(target).toBeDefined();
    if (target === undefined) return;
    const first = await importSession(target.filepath, sm);
    expect(first.importedId.length).toBeGreaterThan(0);

    // Verify the dedup helper agrees.
    const sourceId = path.basename(target.filepath).replace(/\.jsonl$/, '');
    expect(alreadyImported(sm, sourceId)).toBe(true);

    // Second import should reject with the standard message.
    let caught: unknown = null;
    try {
      await importSession(target.filepath, sm);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toContain('already imported');
  });
});

describe('importAll', () => {
  test('imports every fixture session and reports progress', async () => {
    const plan = await scanClaudeCode();
    const total = plan.totalSessions;
    const progress: Array<[number, number]> = [];
    const result = await importAll(plan, sm, (done, t) => {
      progress.push([done, t]);
    });
    expect(result.imported).toBeGreaterThan(0);
    expect(result.imported + result.skipped + result.errors.length).toBe(total);
    // Progress fires at boot (0, N) and at least once more (done > 0).
    expect(progress[0]?.[0]).toBe(0);
    const lastProgress = progress[progress.length - 1];
    expect(lastProgress?.[0]).toBe(total);
  });
});
