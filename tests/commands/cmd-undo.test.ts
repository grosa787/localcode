/**
 * Wave 5A (TA team) — `/undo` slash command.
 *
 *   - /undo            restores the most recent snapshot
 *   - /undo <n>        restores the last `n` snapshots in LIFO order
 *   - /undo list       prints the snapshot stack
 *
 * Snapshots are popped off the in-memory `FileSnapshotStack` and the
 * pre-mutation contents are written back to disk. A snapshot whose
 * `contentBefore` is `null` represents a new-file mutation; undoing
 * that means deleting the file.
 *
 * Restoration is filesystem-driven, so each test uses a temp dir.
 * Failures inside `restoreOne` are reported as `✗ <path> — …` lines,
 * never thrown — `/undo` is best-effort so a single broken entry
 * cannot derail the rest of the rollback.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSnapshotStack } from '@/sessions/file-snapshot-stack';
import { createUndoCommand } from '@/commands/cmd-undo';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-undo-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  config.model.current = 'm';
  config.model.available = ['m'];
  config.onboarding.completed = true;
  const ctx: CommandContext = {
    projectRoot: tmpDir,
    sessionId: null,
    config,
    print: (t: string) => output.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, output };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('/undo — list form (read-only)', () => {
  test('reports "no mutations recorded" when the stack is empty', async () => {
    const stack = new FileSnapshotStack();
    const { ctx, output } = buildCtx();
    const cmd = createUndoCommand({ stack, projectRoot: tmpDir });
    await cmd.execute('list', ctx);
    expect(output.join('\n')).toContain('No file mutations recorded yet');
  });

  test('prints the snapshot stack newest-first with tool name + path', async () => {
    const stack = new FileSnapshotStack();
    stack.push('a.ts', 'before-a', 'write_file');
    stack.push('b.ts', 'before-b', 'edit_file');
    stack.push('new.ts', null, 'write_file');
    const { ctx, output } = buildCtx();
    const cmd = createUndoCommand({ stack, projectRoot: tmpDir });
    await cmd.execute('list', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('newest first');
    expect(joined).toContain('write_file');
    expect(joined).toContain('edit_file');
    expect(joined).toContain('a.ts');
    expect(joined).toContain('b.ts');
    expect(joined).toContain('new.ts');
    expect(joined).toContain('[new file]');
  });
});

describe('/undo — restore most recent snapshot', () => {
  test('restores the file contents to the pre-mutation state', async () => {
    const target = path.join(tmpDir, 'a.ts');
    await writeFile(target, 'after-content', 'utf8');
    const stack = new FileSnapshotStack();
    stack.push('a.ts', 'before-content', 'write_file');

    const { ctx, output } = buildCtx();
    const cmd = createUndoCommand({ stack, projectRoot: tmpDir });
    await cmd.execute('', ctx);

    expect(await readFile(target, 'utf8')).toBe('before-content');
    expect(output.join('\n')).toContain('restored');
    // The stack is now empty.
    expect(stack.size).toBe(0);
  });

  test('reports "nothing to undo" when stack is empty', async () => {
    const stack = new FileSnapshotStack();
    const { ctx, output } = buildCtx();
    const cmd = createUndoCommand({ stack, projectRoot: tmpDir });
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('No file mutations to undo');
  });

  test('contentBefore=null deletes the file (undoing a creation)', async () => {
    const target = path.join(tmpDir, 'created.ts');
    await writeFile(target, 'new content', 'utf8');
    const stack = new FileSnapshotStack();
    stack.push('created.ts', null, 'write_file');

    const { ctx, output } = buildCtx();
    const cmd = createUndoCommand({ stack, projectRoot: tmpDir });
    await cmd.execute('', ctx);

    expect(await fileExists(target)).toBe(false);
    expect(output.join('\n')).toContain('deleted');
  });
});

describe('/undo <n> — multi-step restore', () => {
  test('restores the last N snapshots in LIFO order', async () => {
    const aPath = path.join(tmpDir, 'a.ts');
    const bPath = path.join(tmpDir, 'b.ts');
    const cPath = path.join(tmpDir, 'c.ts');
    await writeFile(aPath, 'after-a', 'utf8');
    await writeFile(bPath, 'after-b', 'utf8');
    await writeFile(cPath, 'after-c', 'utf8');

    const stack = new FileSnapshotStack();
    stack.push('a.ts', 'before-a', 'write_file');
    stack.push('b.ts', 'before-b', 'write_file');
    stack.push('c.ts', 'before-c', 'write_file');

    const { ctx } = buildCtx();
    const cmd = createUndoCommand({ stack, projectRoot: tmpDir });
    await cmd.execute('3', ctx);

    expect(await readFile(aPath, 'utf8')).toBe('before-a');
    expect(await readFile(bPath, 'utf8')).toBe('before-b');
    expect(await readFile(cPath, 'utf8')).toBe('before-c');
    expect(stack.size).toBe(0);
  });

  test('/undo <n> with N greater than stack size restores all available', async () => {
    const aPath = path.join(tmpDir, 'a.ts');
    await writeFile(aPath, 'after', 'utf8');

    const stack = new FileSnapshotStack();
    stack.push('a.ts', 'before', 'write_file');

    const { ctx, output } = buildCtx();
    const cmd = createUndoCommand({ stack, projectRoot: tmpDir });
    await cmd.execute('5', ctx);

    expect(await readFile(aPath, 'utf8')).toBe('before');
    expect(stack.size).toBe(0);
    expect(output.join('\n')).toContain('Restored 1');
  });

  test('/undo with a non-numeric argument prints usage and does nothing', async () => {
    const stack = new FileSnapshotStack();
    stack.push('a.ts', 'before', 'write_file');

    const { ctx, output } = buildCtx();
    const cmd = createUndoCommand({ stack, projectRoot: tmpDir });
    await cmd.execute('garbage', ctx);

    expect(output.join('\n')).toContain('Usage');
    // Stack is untouched.
    expect(stack.size).toBe(1);
  });
});
