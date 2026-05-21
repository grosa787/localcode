/**
 * TUI ↔ Web shared-session test.
 *
 * The /web slash command relies on both surfaces hitting the same
 * SQLite database (WAL mode, busy_timeout=5000) so messages written
 * from the TUI side become visible to a web-side SessionManager reading
 * the same file.
 *
 * We don't boot the actual web server here — that's a runtime concern.
 * Instead we simulate the topology: two SessionManager instances bound
 * to the same on-disk file, write from the "TUI" side, read from the
 * "web" side, and confirm equality.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import type { Message } from '@/types/global';

let tmp = '';
let dbPath = '';

beforeEach(async () => {
  tmp = path.join(os.tmpdir(), `lc-tui-web-${crypto.randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  dbPath = path.join(tmp, 'sessions.db');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('TUI + Web → shared SQLite database', () => {
  test('messages written by the "TUI" SessionManager are visible to the "web" SessionManager', () => {
    // Two separate SessionManager instances reading from the same file.
    // The default DB caching in `db.ts` is bypassed because we use
    // `openDb(path)` directly which always opens a fresh handle.
    const tuiMgr = new SessionManager(openDb(dbPath));
    const webMgr = new SessionManager(openDb(dbPath));

    const sess = tuiMgr.createSession(
      '/tmp/proj',
      'qwen2.5-coder:7b',
      'ollama',
    );

    const msgA: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'hello from the TUI',
      createdAt: Date.now(),
    };
    tuiMgr.addMessage(sess.id, msgA);

    // Web side observes the message.
    const fromWeb = webMgr.getAllMessages(sess.id);
    expect(fromWeb.length).toBe(1);
    expect(fromWeb[0]?.content).toBe('hello from the TUI');
    expect(fromWeb[0]?.role).toBe('user');

    // Write again from the web side; the TUI sees it back.
    const msgB: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'ack from the web',
      createdAt: Date.now() + 1,
    };
    webMgr.addMessage(sess.id, msgB);
    const fromTui = tuiMgr.getAllMessages(sess.id);
    expect(fromTui.length).toBe(2);
    const contents = fromTui.map((m) => m.content);
    expect(contents).toContain('hello from the TUI');
    expect(contents).toContain('ack from the web');
  });

  test('session listed from one side is loadable by the other', () => {
    const tuiMgr = new SessionManager(openDb(dbPath));
    const webMgr = new SessionManager(openDb(dbPath));

    const created = tuiMgr.createSession('/tmp/proj', 'gpt-4o', 'openai');
    const loaded = webMgr.getSession(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.model).toBe('gpt-4o');
    expect(loaded?.projectRoot).toBe('/tmp/proj');
  });
});
