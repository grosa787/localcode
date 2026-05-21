import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb } from '@/sessions/db';
import { SessionManager, titleFromFirstMessage } from '@/sessions/session-manager';
import type { Database } from 'bun:sqlite';
import type { Message } from '@/types/global';

let db: Database | null = null;
let sm: SessionManager;

beforeEach(() => {
  db = openDb(':memory:');
  sm = new SessionManager(db);
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
});

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    ...extra,
  };
}

describe('SessionManager.createSession', () => {
  test('returns a session with an id + timestamps', () => {
    const s = sm.createSession('/tmp/proj', 'qwen', 'ollama');
    expect(s.id).toBeTruthy();
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.updatedAt).toBe(s.createdAt);
    expect(s.projectRoot).toBe('/tmp/proj');
    expect(s.model).toBe('qwen');
    expect(s.backend).toBe('ollama');
    expect(s.title).toBeNull();
  });
});

describe('SessionManager.addMessage / getMessages round-trip', () => {
  test('preserves role, content, and toolCalls for assistant messages', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    const assistant = msg('assistant', 'I will call', {
      toolCalls: [
        { id: 't1', name: 'read_file', arguments: { path: 'a.ts' } },
      ],
    });
    sm.addMessage(s.id, assistant);

    const tool = msg('tool', 'file contents', {
      toolCallId: 't1',
      toolName: 'read_file',
    });
    sm.addMessage(s.id, tool);

    const user = msg('user', 'hi');
    sm.addMessage(s.id, user);

    const messages = sm.getMessages(s.id);
    expect(messages).toHaveLength(3);

    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.content).toBe('I will call');
    expect(messages[0]?.toolCalls).toEqual([
      { id: 't1', name: 'read_file', arguments: { path: 'a.ts' } },
    ]);

    expect(messages[1]?.role).toBe('tool');
    expect(messages[1]?.toolCallId).toBe('t1');
    expect(messages[1]?.toolName).toBe('read_file');

    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.content).toBe('hi');
  });
});

describe('SessionManager.listSessions', () => {
  test('orders descending by updated_at', () => {
    const a = sm.createSession('/p', 'm', 'ollama');
    // Force a tick between updates.
    const b = sm.createSession('/p', 'm', 'ollama');
    // Touch `a` last by adding a message after `b`.
    sm.addMessage(a.id, msg('user', 'bump'));

    const list = sm.listSessions();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]?.id).toBe(a.id);
    expect(list[1]?.id).toBe(b.id);
  });

  test('default limit is 20', () => {
    for (let i = 0; i < 30; i += 1) sm.createSession('/p', 'm', 'ollama');
    expect(sm.listSessions()).toHaveLength(20);
  });

  test('custom limit honoured', () => {
    for (let i = 0; i < 10; i += 1) sm.createSession('/p', 'm', 'ollama');
    expect(sm.listSessions(5)).toHaveLength(5);
  });
});

describe('SessionManager.updateTitle', () => {
  test('sets a session title', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    sm.updateTitle(s.id, 'my session');
    const reloaded = sm.getSession(s.id);
    expect(reloaded?.title).toBe('my session');
  });
});

describe('SessionManager.getSession', () => {
  test('returns null for unknown ids', () => {
    expect(sm.getSession('no-such-id')).toBeNull();
  });
});

describe('SessionManager.deleteSession', () => {
  test('removes session and cascades messages', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'hello'));
    sm.addMessage(s.id, msg('assistant', 'hi back'));

    expect(sm.getMessages(s.id)).toHaveLength(2);
    sm.deleteSession(s.id);
    expect(sm.getSession(s.id)).toBeNull();
    expect(sm.getMessages(s.id)).toEqual([]);
  });
});

describe('Per-message model column', () => {
  test('round-trips the model name on assistant messages', () => {
    const s = sm.createSession('/p', 'qwen', 'ollama');
    sm.addMessage(
      s.id,
      msg('assistant', 'hello', { model: 'deepseek-coder:33b' }),
    );
    const messages = sm.getMessages(s.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.model).toBe('deepseek-coder:33b');
  });

  test('rows persisted without a model read back as undefined', () => {
    // Simulate a "legacy" row written before the column existed by
    // inserting via addMessage without supplying `model` — the helper
    // stores NULL, mirroring what the runMigrations ALTER TABLE would
    // have populated for pre-existing rows.
    const s = sm.createSession('/p', 'qwen', 'ollama');
    sm.addMessage(s.id, msg('assistant', 'hi from legacy'));
    const messages = sm.getMessages(s.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.model).toBeUndefined();
  });

  test('addMessage options.model wins over message.model', () => {
    const s = sm.createSession('/p', 'qwen', 'ollama');
    sm.addMessage(
      s.id,
      msg('assistant', 'hi', { model: 'inline-model' }),
      { model: 'options-model' },
    );
    const messages = sm.getMessages(s.id);
    expect(messages[0]?.model).toBe('options-model');
  });
});

describe('titleFromFirstMessage helper', () => {
  test('collapses whitespace and trims', () => {
    expect(titleFromFirstMessage('  hello\n\nworld   ')).toBe('hello world');
  });

  test('truncates long strings with an ellipsis', () => {
    const title = titleFromFirstMessage('x'.repeat(200));
    expect(title.length).toBe(61); // 60 chars + ellipsis
    expect(title.endsWith('…')).toBe(true);
  });
});
