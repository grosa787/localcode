/**
 * Tool-executor file-watcher integration test.
 *
 * Scenario:
 *   1. `read_file` records mtime + size snapshot via the tracker.
 *   2. External actor touches the file (mtime advances).
 *   3. `write_file` / `edit_file` triggers a synthetic "file changed
 *      externally" warning via `onAutoCheckResult` — but the mutation
 *      still runs (warning is additive).
 *
 * Also covers the negative cases:
 *   - No prior read recorded → no warning.
 *   - No external change → no warning.
 *   - Different session id → no warning (snapshots are partitioned).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, stat, utimes, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from '@/tools/read-file';
import {
  FileChangeTracker,
  setProcessFileChangeTracker,
} from '@/tools/file-tracker';
import { ToolExecutor } from '@/llm/tool-executor';
import type { Message, ToolResult } from '@/types/global';
import type { ToolHandlerMap } from '@/types/message';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-watcher-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
  setProcessFileChangeTracker(new FileChangeTracker());
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Build a minimal handler map. `write_file` records calls but doesn't
 * actually mutate disk — the test directly invokes `readFile()` for
 * the read side and uses a stand-in handler for the write side. This
 * keeps the test deterministic regardless of platform mtime quirks.
 */
function makeHandlers(): {
  handlers: ToolHandlerMap;
  writeCalls: Array<Record<string, unknown>>;
  editCalls: Array<Record<string, unknown>>;
} {
  const writeCalls: Array<Record<string, unknown>> = [];
  const editCalls: Array<Record<string, unknown>> = [];
  const handlers: ToolHandlerMap = {
    write_file: async (args: Record<string, unknown>): Promise<ToolResult> => {
      writeCalls.push(args);
      return { success: true, output: 'WRITTEN' };
    },
    edit_file: async (args: Record<string, unknown>): Promise<ToolResult> => {
      editCalls.push(args);
      return { success: true, output: 'EDITED' };
    },
    // lint_file stub keeps the post-commit auto-lint hook quiet.
    lint_file: async (): Promise<ToolResult> => ({
      success: true,
      output: 'No issues found.',
    }),
  };
  return { handlers, writeCalls, editCalls };
}

describe('ToolExecutor — file-watcher synthetic warning', () => {
  test('read then external mtime advance then write → synthetic warning emitted', async () => {
    const rel = 'note.txt';
    const abs = path.join(tmpRoot, rel);
    await fsWriteFile(abs, 'original content\n', 'utf8');

    // 1) Model reads the file. Tracker records mtime + size.
    await readFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false, sessionId: 'sess-X' },
    );

    // 2) External actor advances the mtime (and tweaks size for
    //    deterministic detection on coarse-mtime filesystems).
    await fsWriteFile(abs, 'EXTERNALLY OVERWRITTEN larger payload\n', 'utf8');
    // Force a future mtime so the test does not depend on the FS clock.
    const future = new Date(Date.now() + 60_000);
    await utimes(abs, future, future);

    // Sanity: stat actually reflects the new mtime.
    const fresh = await stat(abs);
    expect(fresh.mtimeMs).toBeGreaterThan(0);

    // 3) Build the executor wired to the same session and trigger a write.
    const { handlers, writeCalls } = makeHandlers();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false, // keep this test focused on file-watcher
      onAutoCheckResult: (m) => synthetics.push(m),
      projectRoot: tmpRoot,
      sessionId: 'sess-X',
    });

    const result = await exec.execute({
      id: 'c1',
      name: 'write_file',
      arguments: { path: rel, content: 'new model content' },
    });

    // Primary mutation still succeeds.
    expect(result.success).toBe(true);
    expect(result.output).toBe('WRITTEN');
    expect(writeCalls.length).toBe(1);

    // Synthetic warning was emitted alongside.
    expect(synthetics.length).toBe(1);
    const m = synthetics[0]!;
    expect(m.role).toBe('tool');
    expect(m.toolName).toBe('file_watcher');
    expect(m.content).toContain('was modified externally');
    expect(m.content).toContain(rel);
  });

  test('edit_file path also gets the warning', async () => {
    const rel = 'a.txt';
    const abs = path.join(tmpRoot, rel);
    await fsWriteFile(abs, 'hello\n', 'utf8');

    await readFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false, sessionId: 'sess-Y' },
    );
    await fsWriteFile(abs, 'completely different\n', 'utf8');
    const future = new Date(Date.now() + 60_000);
    await utimes(abs, future, future);

    const { handlers } = makeHandlers();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: false,
      onAutoCheckResult: (m) => synthetics.push(m),
      projectRoot: tmpRoot,
      sessionId: 'sess-Y',
    });

    const result = await exec.execute({
      id: 'c2',
      name: 'edit_file',
      arguments: { path: rel, find_text: 'hello', replace_text: 'hi' },
    });

    expect(result.success).toBe(true);
    expect(synthetics.length).toBe(1);
    expect(synthetics[0]!.content).toContain('was modified externally');
  });

  test('no warning when there was no prior read in this session', async () => {
    const rel = 'never-read.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'fresh\n', 'utf8');

    const { handlers } = makeHandlers();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      onAutoCheckResult: (m) => synthetics.push(m),
      projectRoot: tmpRoot,
      sessionId: 'sess-fresh',
    });

    const result = await exec.execute({
      id: 'c3',
      name: 'write_file',
      arguments: { path: rel, content: 'x' },
    });

    expect(result.success).toBe(true);
    expect(synthetics.length).toBe(0);
  });

  test('no warning when the file is unchanged since the read', async () => {
    const rel = 'stable.txt';
    const abs = path.join(tmpRoot, rel);
    await fsWriteFile(abs, 'static\n', 'utf8');

    await readFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false, sessionId: 'sess-stable' },
    );

    const { handlers } = makeHandlers();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      onAutoCheckResult: (m) => synthetics.push(m),
      projectRoot: tmpRoot,
      sessionId: 'sess-stable',
    });

    const result = await exec.execute({
      id: 'c4',
      name: 'write_file',
      arguments: { path: rel, content: 'static' }, // same mtime/size on disk because we never touched the file
    });

    expect(result.success).toBe(true);
    expect(synthetics.length).toBe(0);
  });

  test('different session id does not see the read snapshot', async () => {
    const rel = 'cross.txt';
    const abs = path.join(tmpRoot, rel);
    await fsWriteFile(abs, 'A\n', 'utf8');

    // Read happened in session-A.
    await readFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false, sessionId: 'sess-A' },
    );

    // External change.
    await fsWriteFile(abs, 'BBBBBBB\n', 'utf8');
    const future = new Date(Date.now() + 60_000);
    await utimes(abs, future, future);

    // Write attempted in session-B — should NOT see the warning.
    const { handlers } = makeHandlers();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      onAutoCheckResult: (m) => synthetics.push(m),
      projectRoot: tmpRoot,
      sessionId: 'sess-B',
    });

    await exec.execute({
      id: 'c5',
      name: 'write_file',
      arguments: { path: rel, content: 'x' },
    });
    expect(synthetics.length).toBe(0);
  });
});
