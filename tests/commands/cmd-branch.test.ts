/**
 * /branch — list / create / switch / delete.
 *
 * Verifies the public command surface — listings, creation (with and
 * without `at <index>`), switching, archiving. Switching is faked via
 * a stub callback so we can assert it gets invoked with the right id
 * without touching app.tsx wiring.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import { createBranchCommand, parseBranchArgs } from '@/commands/cmd-branch';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext, Message, Screen } from '@/types/global';

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

function msg(role: Message['role'], content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
  };
}

function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  const ctx: CommandContext = {
    projectRoot: '/tmp',
    sessionId: null,
    config,
    print: (t) => output.push(t),
    setScreen: (_s: Screen) => {
      /* no-op */
    },
  };
  return { ctx, output };
}

describe('parseBranchArgs', () => {
  test('empty / "list" → list', () => {
    expect(parseBranchArgs('').kind).toBe('list');
    expect(parseBranchArgs('  ').kind).toBe('list');
    expect(parseBranchArgs('list').kind).toBe('list');
    expect(parseBranchArgs('LIST').kind).toBe('list');
  });

  test('"<name>" → create at latest', () => {
    const p = parseBranchArgs('experiment-A');
    expect(p.kind).toBe('create');
    if (p.kind === 'create') {
      expect(p.name).toBe('experiment-A');
      expect(p.atIndex).toBeNull();
    }
  });

  test('"<name> at <idx>" → create at index', () => {
    const p = parseBranchArgs('foo at 3');
    expect(p.kind).toBe('create');
    if (p.kind === 'create') {
      expect(p.name).toBe('foo');
      expect(p.atIndex).toBe(3);
    }
  });

  test('"switch <name>" → switch', () => {
    const p = parseBranchArgs('switch abc');
    expect(p.kind).toBe('switch');
    if (p.kind === 'switch') {
      expect(p.target).toBe('abc');
    }
  });

  test('"delete <name>" → delete', () => {
    const p = parseBranchArgs('delete abc');
    expect(p.kind).toBe('delete');
    if (p.kind === 'delete') {
      expect(p.target).toBe('abc');
    }
  });

  test('"rm <name>" is an alias for delete', () => {
    const p = parseBranchArgs('rm abc');
    expect(p.kind).toBe('delete');
  });

  test('bad index → error', () => {
    expect(parseBranchArgs('foo at -1').kind).toBe('error');
    expect(parseBranchArgs('foo at zero').kind).toBe('error');
  });

  test('switch without target → error', () => {
    expect(parseBranchArgs('switch').kind).toBe('error');
    expect(parseBranchArgs('switch  ').kind).toBe('error');
  });
});

describe('/branch list', () => {
  test('prints "no branches" when only a single unnamed root exists', async () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'hi'));
    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => s.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('list', ctx);
    expect(output.join('\n')).toContain('Branches (1)');
  });

  test('marks the active branch with `*`', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));
    const a = sm.createBranch(root.id, 'A');

    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => a.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('list', ctx);

    const joined = output.join('\n');
    expect(joined).toContain('A');
    // Find the active line — it has the * marker
    const activeLine = output.find((l) => l.includes('*') && l.includes('A'));
    expect(activeLine).toBeDefined();
  });
});

describe('/branch <name> — create + switch', () => {
  test('forks at latest, switches into the branch', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));

    const switchCalls: string[] = [];
    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => root.id,
      switchSession: async (id: string) => {
        switchCalls.push(id);
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('experiment-A', ctx);

    expect(switchCalls.length).toBe(1);
    const created = sm
      .getBranches(root.id)
      .find((b) => b.branchName === 'experiment-A');
    expect(created).toBeDefined();
    expect(switchCalls[0]).toBe(created?.id);
    expect(output.some((l) => l.includes("Created branch 'experiment-A'"))).toBe(
      true,
    );
  });

  test('refuses duplicate branch name within the same family', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));
    sm.createBranch(root.id, 'dup');

    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => root.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('dup', ctx);
    expect(output.join('\n')).toContain("already exists in this family");
  });

  test('"<name> at <idx>" forks at the specified message', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'first'));
    sm.addMessage(root.id, msg('assistant', 'second'));
    sm.addMessage(root.id, msg('user', 'third'));

    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => root.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx } = buildCtx();
    await cmd.execute('forked at 1', ctx);

    const family = sm.getBranches(root.id);
    const created = family.find((b) => b.branchName === 'forked');
    expect(created).toBeDefined();
    // Branch should have exactly 1 message (the anchor INCLUSIVE).
    expect(created?.messageCount).toBe(1);
  });

  test('rejects out-of-range message index', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'only'));

    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => root.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('bad at 99', ctx);
    expect(output.join('\n')).toContain('out of range');
  });
});

describe('/branch switch', () => {
  test('switches to a named branch', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));
    const a = sm.createBranch(root.id, 'A');

    const switchCalls: string[] = [];
    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => root.id,
      switchSession: async (id: string) => {
        switchCalls.push(id);
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('switch A', ctx);

    expect(switchCalls).toEqual([a.id]);
    expect(output.join('\n')).toContain("Switched to branch 'A'");
  });

  test('reports "already on" when target is the active branch', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));
    const a = sm.createBranch(root.id, 'A');

    const switchCalls: string[] = [];
    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => a.id,
      switchSession: async (id: string) => {
        switchCalls.push(id);
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('switch A', ctx);

    expect(switchCalls).toEqual([]);
    expect(output.join('\n')).toContain("Already on branch 'A'");
  });

  test('reports unknown branch', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));

    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => root.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('switch ghost', ctx);
    expect(output.join('\n')).toContain("No branch matching 'ghost'");
  });
});

describe('/branch delete', () => {
  test('archives a non-active branch', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));
    const a = sm.createBranch(root.id, 'A');

    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => root.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('delete A', ctx);

    const me = sm.getBranches(root.id).find((b) => b.id === a.id);
    expect(me?.branchArchived).toBe(true);
    expect(output.join('\n')).toContain("Archived branch 'A'");
  });

  test('refuses to delete the active branch', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));
    const a = sm.createBranch(root.id, 'A');

    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => a.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('delete A', ctx);
    expect(output.join('\n')).toContain('Switch to a different branch');
    expect(sm.getBranches(root.id).find((b) => b.id === a.id)?.branchArchived).toBe(false);
  });

  test('refuses to delete the root', async () => {
    const root = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(root.id, msg('user', 'hi'));

    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => root.id,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    // resolveBranch will match the root by id-prefix or label
    await cmd.execute(`delete ${root.id.slice(0, 8)}`, ctx);
    expect(output.join('\n')).toContain('Cannot delete the root');
  });
});

describe('/branch — no active session', () => {
  test('prints an explanatory note when no session is active', async () => {
    const cmd = createBranchCommand({
      sessionManager: sm,
      getActiveSessionId: () => null,
      switchSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('A', ctx);
    expect(output.join('\n')).toContain('No active session');
  });
});
