/**
 * /resume — R3 additions: 2-line-per-session format with summary preview,
 * collapsed whitespace, truncation at 120 chars, and `(no summary yet)`
 * placeholder for null summaries.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import { createResumeCommand } from '@/commands/cmd-resume';
import type { AppConfig, CommandContext, Screen, Session } from '@/types/global';
import { getDefaultConfig } from '@/config/defaults';

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

function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  const ctx: CommandContext = {
    projectRoot: '/tmp',
    sessionId: null,
    config,
    print: (t) => output.push(t),
    setScreen: (_screen: Screen) => {
      /* no-op */
    },
  };
  return { ctx, output };
}

function seedSession(opts: {
  title?: string | null;
  summary?: string | null;
  model?: string;
}): Session {
  const s = sm.createSession('/tmp', opts.model ?? 'qwen2.5-coder', 'ollama');
  if (opts.title !== undefined && opts.title !== null) {
    sm.updateTitle(s.id, opts.title);
  }
  if (opts.summary !== undefined && opts.summary !== null) {
    sm.updateSummary(s.id, opts.summary);
  }
  return s;
}

describe('/resume — two-line-per-session format', () => {
  test('each session entry prints a primary line + a secondary summary-preview line', async () => {
    seedSession({ title: 'alpha', summary: 'short summary' });
    seedSession({ title: 'beta', summary: null });
    seedSession({
      title: 'gamma',
      summary:
        'This is a very long summary that is going to exceed the 120-character preview cap so we can verify truncation works consistently across different sessions, sessions, sessions, more.',
    });

    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);

    const joined = output.join('\n');
    // Header + 3 session blocks (2 lines each) + footer = 8 lines.
    expect(output.length).toBe(8);

    // Header and footer.
    expect(output[0]).toContain('Recent sessions (3)');
    expect(output[output.length - 1]).toContain('Use /resume <idPrefix>');

    // `(no summary yet)` placeholder appears for the session without
    // a summary.
    expect(joined).toContain('(no summary yet)');

    // Long summary truncated to 120 chars ending with "..." in the
    // secondary line.
    const truncLine = output.find(
      (l) => l.includes('└─') && l.endsWith('...'),
    );
    expect(truncLine).toBeDefined();
    if (truncLine) {
      // The bit after the tree marker should be at most 120 chars.
      const previewIdx = truncLine.indexOf('└─');
      expect(previewIdx).toBeGreaterThanOrEqual(0);
      const preview = truncLine.slice(previewIdx + '└─'.length).trim();
      expect(preview.length).toBe(120);
    }

    // Summary-less session line says `(no summary yet)`.
    const tree = output.filter((l) => l.includes('└─'));
    expect(tree.some((l) => l.includes('(no summary yet)'))).toBe(true);
    expect(tree.some((l) => l.includes('short summary'))).toBe(true);
  });

  test('no sessions prints a friendly empty notice', async () => {
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toMatch(/No sessions/);
  });
});

describe('/resume <idPrefix>', () => {
  test('unambiguous prefix triggers loadSession', async () => {
    const s = seedSession({ title: 't1', summary: 'hi' });
    const captured: { id: string | null } = { id: null };
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async (id: string) => {
        captured.id = id;
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute(s.id.slice(0, 8), ctx);
    expect(captured.id).toBe(s.id);
    expect(output.join('\n')).toContain('Resumed session');
  });

  test('unknown prefix prints "No session matching"', async () => {
    seedSession({ title: 't1', summary: null });
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async () => {
        /* noop */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('zzzzzzzzz', ctx);
    expect(output.join('\n')).toMatch(/No session matching/);
  });
});

describe('/resume — summary preview edge cases', () => {
  test('whitespace-only summary renders as `(no summary yet)`', async () => {
    seedSession({ title: 'ws', summary: '   \n\t\n  ' });
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async () => {
        /* noop */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('(no summary yet)');
  });

  test('multi-line summary is collapsed to a single line', async () => {
    seedSession({
      title: 'ml',
      summary: 'line one\nline two\nline three',
    });
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async () => {
        /* noop */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const tree = output.filter((l) => l.includes('└─'));
    expect(tree[0]).toContain('line one line two line three');
    // Exactly one secondary line per session
    expect(tree.length).toBe(1);
  });
});
