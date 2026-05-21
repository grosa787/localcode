/**
 * Tests for `edit_notebook` (B2). Two-phase: preview + commit.
 *
 * Coverage:
 *   - Replace cell: preview shows diff, commit writes new source, outputs cleared.
 *   - Insert cell: bounds at start/end/middle, cell shifts.
 *   - Delete cell: bounds check, surrounding cells shift.
 *   - Rejects mode='replace' without newSource (Zod superRefine).
 *   - Path traversal blocked on both phases.
 *   - Re-validation: bounds error between preview and commit is surfaced.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdir,
  copyFile,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitEditNotebook, editNotebook } from '@/tools/notebook-edit';

const FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'sample.ipynb',
);

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-nbedit-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function setupFixture(): Promise<string> {
  const rel = 'nb.ipynb';
  await copyFile(FIXTURE, path.join(tmpRoot, rel));
  return rel;
}

describe('editNotebook (preview)', () => {
  test('replace mode: returns diff-like preview without modifying file', async () => {
    const rel = await setupFixture();
    const before = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    const res = await editNotebook(
      {
        path: rel,
        mode: 'replace',
        cellIndex: 1,
        newSource: "print('updated')",
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.requiresApproval).toBe(true);
    expect(res.output).toContain('Replace cell 1');
    expect(res.output).toContain('--- old source');
    expect(res.output).toContain('+++ new source');
    // File unchanged before commit.
    expect(await fsReadFile(path.join(tmpRoot, rel), 'utf8')).toBe(before);
  });

  test('insert mode: shows growth and new source preview', async () => {
    const rel = await setupFixture();
    const res = await editNotebook(
      {
        path: rel,
        mode: 'insert',
        cellIndex: 1,
        cellType: 'markdown',
        newSource: '## new section',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('Insert markdown cell at index 1');
    expect(res.output).toContain('3 → 4 cells');
  });

  test('delete mode: shows shrink and removed source', async () => {
    const rel = await setupFixture();
    const res = await editNotebook(
      { path: rel, mode: 'delete', cellIndex: 0 },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('Delete cell 0');
    expect(res.output).toContain('3 → 2 cells');
    expect(res.output).toContain('# Sample Notebook');
  });

  test("rejects mode='replace' without newSource via Zod", async () => {
    const rel = await setupFixture();
    const res = await editNotebook(
      { path: rel, mode: 'replace', cellIndex: 0 },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/newSource/);
  });

  test('rejects insert without cellType', async () => {
    const rel = await setupFixture();
    const res = await editNotebook(
      { path: rel, mode: 'insert', cellIndex: 0, newSource: 'x' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/cellType/);
  });

  test('rejects unknown mode at the schema layer', async () => {
    const rel = await setupFixture();
    const res = await editNotebook(
      {
        path: rel,
        // intentionally invalid mode
        mode: 'nuke' as unknown as 'replace',
        cellIndex: 0,
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Invalid args/);
  });

  test('rejects path that escapes project root', async () => {
    const res = await editNotebook(
      {
        path: '../../etc/passwd',
        mode: 'replace',
        cellIndex: 0,
        newSource: 'x',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Path traversal blocked/);
  });

  test('rejects out-of-range cellIndex with helpful message', async () => {
    const rel = await setupFixture();
    const res = await editNotebook(
      { path: rel, mode: 'delete', cellIndex: 99 },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/out of range/);
  });

  test('rejects non-.ipynb extension', async () => {
    const rel = 'plain.txt';
    await fsWriteFile(path.join(tmpRoot, rel), '{}', 'utf8');
    const res = await editNotebook(
      { path: rel, mode: 'replace', cellIndex: 0, newSource: 'x' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Not a Jupyter notebook/);
  });
});

describe('commitEditNotebook', () => {
  test('replace writes new source and clears outputs/execution_count', async () => {
    const rel = await setupFixture();
    const res = await commitEditNotebook(
      {
        path: rel,
        mode: 'replace',
        cellIndex: 1,
        newSource: "print('replaced')",
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/Replaced cell 1/);
    const onDisk = JSON.parse(
      await fsReadFile(path.join(tmpRoot, rel), 'utf8'),
    ) as {
      cells: Array<{
        source: string;
        outputs?: unknown[];
        execution_count?: number | null;
      }>;
    };
    expect(onDisk.cells[1]?.source).toBe("print('replaced')");
    expect(onDisk.cells[1]?.outputs).toEqual([]);
    expect(onDisk.cells[1]?.execution_count).toBeNull();
  });

  test('insert grows cells by 1 and assigns a fresh id', async () => {
    const rel = await setupFixture();
    const res = await commitEditNotebook(
      {
        path: rel,
        mode: 'insert',
        cellIndex: 1,
        cellType: 'code',
        newSource: 'y = 99',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const onDisk = JSON.parse(
      await fsReadFile(path.join(tmpRoot, rel), 'utf8'),
    ) as { cells: Array<{ id?: string; source: string }> };
    expect(onDisk.cells.length).toBe(4);
    expect(onDisk.cells[1]?.source).toBe('y = 99');
    expect(typeof onDisk.cells[1]?.id).toBe('string');
    expect(onDisk.cells[1]?.id?.length).toBeGreaterThan(0);
  });

  test('delete removes the target cell and shrinks count', async () => {
    const rel = await setupFixture();
    const res = await commitEditNotebook(
      { path: rel, mode: 'delete', cellIndex: 0 },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const onDisk = JSON.parse(
      await fsReadFile(path.join(tmpRoot, rel), 'utf8'),
    ) as { cells: Array<{ id?: string; cell_type: string }> };
    expect(onDisk.cells.length).toBe(2);
    // Original markdown cell at index 0 is gone — new index 0 is the
    // former index 1 (code cell with print).
    expect(onDisk.cells[0]?.cell_type).toBe('code');
  });

  test('insert at end (cellIndex === cells.length) is accepted', async () => {
    const rel = await setupFixture();
    const res = await commitEditNotebook(
      {
        path: rel,
        mode: 'insert',
        cellIndex: 3,
        cellType: 'markdown',
        newSource: 'appended',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const onDisk = JSON.parse(
      await fsReadFile(path.join(tmpRoot, rel), 'utf8'),
    ) as { cells: Array<{ source: string }> };
    expect(onDisk.cells.length).toBe(4);
    expect(onDisk.cells[3]?.source).toBe('appended');
  });

  test('re-validates bounds at commit time (file mutated)', async () => {
    const rel = await setupFixture();
    // Externally shrink the notebook to 1 cell so cellIndex=2 becomes invalid.
    const original = JSON.parse(
      await fsReadFile(path.join(tmpRoot, rel), 'utf8'),
    ) as { cells: unknown[] };
    const shrunken = { ...original, cells: [original.cells[0]] };
    await fsWriteFile(
      path.join(tmpRoot, rel),
      JSON.stringify(shrunken),
      'utf8',
    );
    const res = await commitEditNotebook(
      { path: rel, mode: 'delete', cellIndex: 2 },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/File modified since preview|out of range/);
  });

  test('rejects path traversal at commit too', async () => {
    const res = await commitEditNotebook(
      {
        path: '../../etc/passwd',
        mode: 'delete',
        cellIndex: 0,
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Path traversal blocked/);
  });
});
