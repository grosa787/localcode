/**
 * /diff — full-screen diff viewer. Resolves a `DiffEntry[]` from git
 * and hands it off to `<DiffViewer>` via the `openViewer` callback the
 * composition root injects. Tests cover the entry-resolution layer +
 * the openViewer wiring + failure paths.
 *
 *   - Working tree vs HEAD → entries with mode='modified' / 'created' /
 *     'deleted' carrying before/after text.
 *   - Two-ref form → diff between commits.
 *   - Single-file form → entry just for that file.
 *   - Clean working tree → "No changes." (entries.length === 0).
 *   - Non-git directory → "/diff failed: Not a git repository or no
 *     changes." (the wrapper surfaces the friendly message).
 *   - openViewer wired → fires with the resolved entries instead of the
 *     text fallback summary.
 *
 * The command shells out to `git`, so each test seeds a tmp working
 * tree via `git init`, commits a baseline, then mutates it.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execa } from 'execa';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDiffCommand, type DiffEntry } from '@/commands/cmd-diff';
import type { AppConfig, CommandContext } from '@/types/global';
import { getDefaultConfig } from '@/config/defaults';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-diff-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function initRepo(dir: string): Promise<void> {
  // Init a fresh repo. Force user.name/email via env vars so the test
  // environment doesn't depend on the host's git config.
  const env = {
    GIT_AUTHOR_NAME: 'tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
  };
  await execa('git', ['init', '--initial-branch=main'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(path.join(dir, 'a.txt'), 'line1\nline2\n', 'utf8');
  await execa('git', ['add', '.'], { cwd: dir, env });
  await execa('git', ['commit', '-m', 'initial'], { cwd: dir, env });
}

function buildCtx(projectRoot: string): {
  ctx: CommandContext;
  output: string[];
} {
  const output: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  const ctx: CommandContext = {
    projectRoot,
    sessionId: null,
    config,
    print: (t: string) => output.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, output };
}

describe('/diff command — entry resolution', () => {
  test('modified working-tree file resolves to a DiffEntry with before/after', async () => {
    await initRepo(tmpDir);
    await writeFile(
      path.join(tmpDir, 'a.txt'),
      'line1\nline2\nline3-NEW\n',
      'utf8',
    );

    let captured: readonly DiffEntry[] | null = null;
    const cmd = createDiffCommand({
      projectRoot: tmpDir,
      openViewer: (entries) => {
        captured = entries;
      },
    });
    const { ctx, output } = buildCtx(tmpDir);
    await cmd.execute('', ctx);

    // openViewer fired with entries — text fallback was bypassed.
    expect(output).toHaveLength(0);
    expect(captured).not.toBeNull();
    const entries = captured as unknown as readonly DiffEntry[];
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(entry.filePath).toBe('a.txt');
      expect(entry.mode).toBe('modified');
      expect(entry.before).toContain('line2');
      expect(entry.after).toContain('line3-NEW');
    }
  });

  test('clean working tree → prints "No changes." and does NOT open the viewer', async () => {
    await initRepo(tmpDir);

    let opened = 0;
    const cmd = createDiffCommand({
      projectRoot: tmpDir,
      openViewer: () => {
        opened += 1;
      },
    });
    const { ctx, output } = buildCtx(tmpDir);
    await cmd.execute('', ctx);

    expect(output).toContain('No changes.');
    expect(opened).toBe(0);
  });

  test('non-git directory → prints friendly "/diff failed" surface', async () => {
    // `tmpDir` is freshly mkdir'd but never `git init`-ed.
    const cmd = createDiffCommand({ projectRoot: tmpDir });
    const { ctx, output } = buildCtx(tmpDir);
    await cmd.execute('', ctx);

    // The wrapper prefixes the friendly message with `/diff failed:`.
    expect(output).toHaveLength(1);
    expect(output[0]).toBe('/diff failed: Not a git repository or no changes.');
  });

  test('text-fallback summary fires when openViewer is omitted', async () => {
    await initRepo(tmpDir);
    await writeFile(
      path.join(tmpDir, 'a.txt'),
      'line1\nline2\nADDED\n',
      'utf8',
    );

    // No `openViewer` wired — the headless-test path.
    const cmd = createDiffCommand({ projectRoot: tmpDir });
    const { ctx, output } = buildCtx(tmpDir);
    await cmd.execute('', ctx);

    const joined = output.join('\n');
    expect(joined).toContain('Diff summary');
    expect(joined).toContain('a.txt');
    expect(joined).toContain('[modified]');
  });

  test('single-file form resolves to one entry for that path', async () => {
    await initRepo(tmpDir);
    await writeFile(
      path.join(tmpDir, 'a.txt'),
      'line1\nline2\nMODIFIED\n',
      'utf8',
    );

    let captured: readonly DiffEntry[] | null = null;
    const cmd = createDiffCommand({
      projectRoot: tmpDir,
      openViewer: (entries) => {
        captured = entries;
      },
    });
    const { ctx } = buildCtx(tmpDir);
    await cmd.execute('a.txt', ctx);

    expect(captured).not.toBeNull();
    const entries = captured as unknown as readonly DiffEntry[];
    expect(entries.length).toBe(1);
    expect(entries[0]?.filePath).toBe('a.txt');
    expect(entries[0]?.mode).toBe('modified');
  });
});
