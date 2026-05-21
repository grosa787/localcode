/**
 * SessionManager — branching sessions ("/branch").
 *
 * Verifies:
 *   - createBranch copies the parent's prefix INCLUSIVE of the anchor.
 *   - createBranch at the latest message copies the entire history.
 *   - getBranches returns the whole family (root + descendants).
 *   - getBranchTree builds a recursive tree.
 *   - getBranchChain returns root→current.
 *   - archiveBranch flips branch_archived; refuses to archive a root.
 *
 * All tests use `:memory:` SQLite — no filesystem side-effects.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '@/sessions/db';
import {
  SessionDbError,
  SessionManager,
} from '@/sessions/session-manager';
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

describe('SessionManager.createBranch', () => {
  test('copies entire history when no anchor supplied', () => {
    const parent = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(parent.id, msg('user', 'hello'));
    sm.addMessage(parent.id, msg('assistant', 'hi back'));
    sm.addMessage(parent.id, msg('user', 'second turn'));

    const branch = sm.createBranch(parent.id, 'experiment-A');

    const branchMessages = sm.getAllMessages(branch.id);
    expect(branchMessages.map((m) => m.content)).toEqual([
      'hello',
      'hi back',
      'second turn',
    ]);
    // Branch's row carries the metadata.
    const rows = sm.getBranches(parent.id);
    const me = rows.find((r) => r.id === branch.id);
    expect(me).toBeDefined();
    expect(me?.branchName).toBe('experiment-A');
    expect(me?.parentSessionId).toBe(parent.id);
    expect(me?.divergedAt).toBeDefined();
  });

  test('copies inclusive prefix up to anchor message', () => {
    const parent = sm.createSession('/p', 'm', 'ollama');
    const m1 = msg('user', 'one');
    const m2 = msg('assistant', 'two');
    const m3 = msg('user', 'three');
    const m4 = msg('assistant', 'four');
    sm.addMessage(parent.id, m1);
    sm.addMessage(parent.id, m2);
    sm.addMessage(parent.id, m3);
    sm.addMessage(parent.id, m4);

    const branch = sm.createBranch(parent.id, 'fork', m2.id);

    const branchMessages = sm.getAllMessages(branch.id);
    expect(branchMessages.map((m) => m.content)).toEqual(['one', 'two']);

    const me = sm.getBranches(parent.id).find((r) => r.id === branch.id);
    expect(me?.divergedAt).toBe(m2.id);
  });

  test('rejects empty branch name', () => {
    const parent = sm.createSession('/p', 'm', 'ollama');
    expect(() => sm.createBranch(parent.id, '   ')).toThrow(SessionDbError);
  });

  test('rejects unknown parent session', () => {
    expect(() => sm.createBranch('does-not-exist', 'x')).toThrow(
      SessionDbError,
    );
  });

  test('rejects anchor that does not belong to parent', () => {
    const a = sm.createSession('/p', 'm', 'ollama');
    const b = sm.createSession('/p', 'm', 'ollama');
    const m1 = msg('user', 'foreign');
    sm.addMessage(b.id, m1);
    expect(() => sm.createBranch(a.id, 'x', m1.id)).toThrow(SessionDbError);
  });

  test('copy is a single transaction — partial failure rolls back', () => {
    // We can't easily inject a partial failure here, but the API
    // contract is: if creation throws, no branch row should appear.
    const parent = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(parent.id, msg('user', 'hi'));

    const before = sm.listSessions(100).length;
    expect(() => sm.createBranch(parent.id, '', undefined)).toThrow();
    const after = sm.listSessions(100).length;
    expect(after).toBe(before);
  });

  test('child session inherits project/model/backend', () => {
    const parent = sm.createSession('/p', 'qwen2.5', 'ollama');
    sm.addMessage(parent.id, msg('user', 'hi'));
    const branch = sm.createBranch(parent.id, 'A');
    const reloaded = sm.getSession(branch.id);
    expect(reloaded?.projectRoot).toBe('/p');
    expect(reloaded?.model).toBe('qwen2.5');
    expect(reloaded?.backend).toBe('ollama');
  });
});

describe('SessionManager.getBranches', () => {
  test('returns root + all descendants for any session in the family', () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'r1'));
    const childA = sm.createBranch(root.id, 'A');
    const childB = sm.createBranch(root.id, 'B');
    const grand = sm.createBranch(childA.id, 'A.deep');

    // Calling from ANY family member returns the entire family.
    for (const start of [root.id, childA.id, childB.id, grand.id]) {
      const fam = sm.getBranches(start);
      const ids = fam.map((b) => b.id).sort();
      expect(ids).toEqual([root.id, childA.id, childB.id, grand.id].sort());
    }
  });

  test('messageCount reflects copied prefix', () => {
    const parent = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(parent.id, msg('user', 'one'));
    sm.addMessage(parent.id, msg('user', 'two'));
    const branch = sm.createBranch(parent.id, 'A');

    const fam = sm.getBranches(parent.id);
    const me = fam.find((b) => b.id === branch.id);
    const parentInfo = fam.find((b) => b.id === parent.id);
    expect(me?.messageCount).toBe(2);
    expect(parentInfo?.messageCount).toBe(2);
  });

  test('returns empty for unknown session', () => {
    expect(sm.getBranches('does-not-exist')).toEqual([]);
  });
});

describe('SessionManager.getBranchTree', () => {
  test('builds a recursive tree from a root', () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'r'));
    const a = sm.createBranch(root.id, 'A');
    const b = sm.createBranch(root.id, 'B');
    const aDeep = sm.createBranch(a.id, 'A.deep');

    const tree = sm.getBranchTree(root.id);
    expect(tree).not.toBeNull();
    expect(tree?.id).toBe(root.id);
    // 2 children at the root: A and B.
    expect(tree?.children.map((c) => c.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    // A's child should be aDeep.
    const aNode = tree?.children.find((c) => c.id === a.id);
    expect(aNode?.children.map((c) => c.id)).toEqual([aDeep.id]);
  });

  test('returns null for unknown id', () => {
    expect(sm.getBranchTree('does-not-exist')).toBeNull();
  });
});

describe('SessionManager.getBranchChain', () => {
  test('returns root → current chain', () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'one'));
    const a = sm.createBranch(root.id, 'A');
    const deep = sm.createBranch(a.id, 'deep');

    const chain = sm.getBranchChain(deep.id);
    expect(chain.map((c) => c.id)).toEqual([root.id, a.id, deep.id]);
    expect(chain[1]?.branchName).toBe('A');
    expect(chain[2]?.branchName).toBe('deep');
  });

  test('single-entry for the root itself', () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    const chain = sm.getBranchChain(root.id);
    expect(chain.length).toBe(1);
    expect(chain[0]?.id).toBe(root.id);
    expect(chain[0]?.parentSessionId).toBeNull();
  });
});

describe('SessionManager.archiveBranch', () => {
  test('flips branch_archived to true', () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'x'));
    const branch = sm.createBranch(root.id, 'A');

    sm.archiveBranch(branch.id);

    const fam = sm.getBranches(root.id);
    const me = fam.find((b) => b.id === branch.id);
    expect(me?.branchArchived).toBe(true);
  });

  test('refuses to archive a root', () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    expect(() => sm.archiveBranch(root.id)).toThrow(SessionDbError);
  });

  test('throws on unknown session', () => {
    expect(() => sm.archiveBranch('does-not-exist')).toThrow(SessionDbError);
  });
});

describe('SessionManager.findBranchRoot', () => {
  test('returns the session itself when no parent', () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    expect(sm.findBranchRoot(root.id)).toBe(root.id);
  });

  test('walks up to the root from any descendant', () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'x'));
    const a = sm.createBranch(root.id, 'A');
    const deep = sm.createBranch(a.id, 'deep');
    expect(sm.findBranchRoot(deep.id)).toBe(root.id);
    expect(sm.findBranchRoot(a.id)).toBe(root.id);
  });

  test('returns null for unknown session', () => {
    expect(sm.findBranchRoot('nope')).toBeNull();
  });
});
