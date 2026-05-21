/**
 * Tests for `read_notebook` (B2).
 *
 * Coverage:
 *   - Parses the sample fixture and surfaces the expected cell summary.
 *   - Rejects nbformat 3 / non-JSON / non-existent paths.
 *   - Trims oversized outputs and the per-cell output cap.
 *   - Blocks path traversal escapes (resolveSafePathStrict).
 *   - `includeOutputs: false` strips outputs from the response.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdir,
  copyFile,
  writeFile as fsWriteFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readNotebook } from '@/tools/notebook-read';

const FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'sample.ipynb',
);

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-nbread-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('readNotebook', () => {
  test('parses the sample fixture and exposes cells', async () => {
    const rel = 'nb.ipynb';
    await copyFile(FIXTURE, path.join(tmpRoot, rel));
    const res = await readNotebook(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output) as {
      nbformat: number;
      kernel: string | null;
      language: string | null;
      cellCount: number;
      cells: Array<{
        index: number;
        id: string | null;
        cell_type: 'code' | 'markdown' | 'raw';
        source: string;
        outputs: Array<{ output_type: string; text?: string }>;
      }>;
    };
    expect(parsed.nbformat).toBe(4);
    expect(parsed.kernel).toBe('python3');
    expect(parsed.language).toBe('python');
    expect(parsed.cellCount).toBe(3);
    expect(parsed.cells[0]?.cell_type).toBe('markdown');
    expect(parsed.cells[1]?.source).toContain("print('hello world')");
    // text/plain stream output trimmed in but present.
    const out = parsed.cells[1]?.outputs[0];
    expect(out?.output_type).toBe('stream');
    expect(out?.text).toContain('hello world');
  });

  test('rejects nbformat 3 with a helpful error', async () => {
    const rel = 'old.ipynb';
    const notebook = {
      cells: [],
      metadata: {},
      nbformat: 3,
      nbformat_minor: 0,
    };
    await fsWriteFile(
      path.join(tmpRoot, rel),
      JSON.stringify(notebook),
      'utf8',
    );
    const res = await readNotebook(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/nbformat 3/);
    expect(res.error ?? '').toMatch(/nbformat 4 is accepted/);
  });

  test('rejects non-JSON content', async () => {
    const rel = 'bad.ipynb';
    await fsWriteFile(path.join(tmpRoot, rel), 'not json at all', 'utf8');
    const res = await readNotebook(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/not valid JSON/);
  });

  test('trims long text/plain output and caps outputs per cell', async () => {
    const longText = 'x'.repeat(5000);
    const rel = 'long.ipynb';
    const notebook = {
      cells: [
        {
          cell_type: 'code' as const,
          id: 'c1',
          metadata: {},
          source: ['print()'],
          execution_count: 1,
          outputs: [
            { output_type: 'stream', name: 'stdout', text: [longText] },
            // 10 more execute_results with text/plain — only first 5
            // should be retained then a "... more outputs omitted ..." note.
            ...Array.from({ length: 10 }, (_, i) => ({
              output_type: 'execute_result' as const,
              data: { 'text/plain': [`line ${i}`] },
              metadata: {},
              execution_count: i + 1,
            })),
          ],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    await fsWriteFile(
      path.join(tmpRoot, rel),
      JSON.stringify(notebook),
      'utf8',
    );
    const res = await readNotebook(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output) as {
      cells: Array<{
        outputs: Array<{ output_type: string; note?: string; text?: string }>;
      }>;
    };
    const cellOuts = parsed.cells[0]?.outputs ?? [];
    // First stream output got truncation marker (text > 2000 chars cap).
    expect(cellOuts[0]?.text).toContain('chars truncated');
    // Total outputs surfaced should be 5 (max cap) plus one trailing note.
    expect(cellOuts.length).toBeLessThanOrEqual(6);
    expect(cellOuts[cellOuts.length - 1]?.output_type).toBe('note');
  });

  test('rejects path that escapes project root', async () => {
    const res = await readNotebook(
      { path: '../../etc/passwd' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Path traversal blocked/);
  });

  test('reports missing files cleanly', async () => {
    const res = await readNotebook(
      { path: 'missing.ipynb' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/File not found/);
  });

  test('includeOutputs=false strips outputs from cells', async () => {
    const rel = 'nb.ipynb';
    await copyFile(FIXTURE, path.join(tmpRoot, rel));
    const res = await readNotebook(
      { path: rel, includeOutputs: false },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output) as {
      cells: Array<{ outputs: unknown[] }>;
    };
    for (const cell of parsed.cells) {
      expect(cell.outputs.length).toBe(0);
    }
  });
});
