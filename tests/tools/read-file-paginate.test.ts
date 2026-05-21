/**
 * Tests for `read_file` pagination + summary mode + auto-paginate.
 *
 * Covers:
 *   - Large file (>1 MB) without offset → first ~1 MB clamped to line
 *     boundary plus continuation footer naming the next offset.
 *   - Explicit offset returns the requested window; final page has no
 *     continuation footer.
 *   - `respondWithSummary: true` returns line count + size + head + tail.
 *   - Small files (legacy ≤100KB path) are returned verbatim — the
 *     existing 100KB/500-line truncation still applies between 100KB
 *     and 1MB.
 *   - markRead is invoked on every successful read.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from '@/tools/read-file';
import {
  FileChangeTracker,
  setProcessFileChangeTracker,
} from '@/tools/file-tracker';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-readfile-page-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
  // Reset the process tracker so cross-test state doesn't leak.
  setProcessFileChangeTracker(new FileChangeTracker());
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('read_file — large-file auto-paginate', () => {
  test('files >1 MB return first page with continuation footer', async () => {
    // Build > 1 MB of text. Use 50-byte lines so we land cleanly on
    // a line boundary inside 1 MB.
    const line = 'A'.repeat(49) + '\n';
    const lineRepetitions = 25_000; // 25000 * 50 = 1.25 MB
    const content = line.repeat(lineRepetitions);
    const totalLines = content.split('\n').length;
    const rel = 'big.txt';
    await fsWriteFile(path.join(tmpRoot, rel), content, 'utf8');

    const result = await readFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('--- File truncated at line');
    expect(result.output).toContain('--- Continue: read_file(');
    expect(result.output).toContain(`path: "${rel}"`);
    // The footer should mention "of <totalLines>" (the file's true total
    // — equals the line repetitions + 1 because the file ends with a `\n`
    // which yields one trailing empty line on split).
    expect(result.output).toContain(`of ${totalLines}`);
    // The first page should NOT contain the whole file.
    expect(result.output.length).toBeLessThan(content.length);
  });

  test('explicit offset returns a continuation page without echoing prior lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const rel = 'doc.txt';
    await fsWriteFile(path.join(tmpRoot, rel), lines.join('\n'), 'utf8');

    const result = await readFile(
      { path: rel, offset: 50, limit: 20 },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );

    expect(result.success).toBe(true);
    // First line of returned window must be line 50.
    expect(result.output.split('\n')[0]).toBe('line 50');
    // Twenty lines of body (50..69) then optional footer; the body
    // should contain line 69 but not line 70.
    expect(result.output).toContain('line 69');
    expect(result.output.split('\n').slice(0, 20).join('\n')).not.toContain('line 70');
    // 80 lines remain past the window → footer with next offset should appear.
    // Lines 50..69 were returned (offset 50, limit 20) → next page begins at 70.
    expect(result.output).toContain('--- Continue: read_file(');
    expect(result.output).toContain('offset: 70');
  });

  test('final-page window has no continuation footer', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
    const rel = 'tail.txt';
    await fsWriteFile(path.join(tmpRoot, rel), lines.join('\n'), 'utf8');

    const result = await readFile(
      { path: rel, offset: 90, limit: 100 },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('--- Continue: read_file(');
    expect(result.output).toContain('L100');
  });
});

describe('read_file — summary mode', () => {
  test('respondWithSummary returns counts plus head and tail', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `row-${i + 1}`);
    const rel = 'summary.txt';
    await fsWriteFile(path.join(tmpRoot, rel), lines.join('\n'), 'utf8');

    const result = await readFile(
      { path: rel, respondWithSummary: true },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('--- Summary of summary.txt ---');
    expect(result.output).toContain('Lines: 40');
    expect(result.output).toContain('--- First 20 lines ---');
    expect(result.output).toContain('row-1');
    expect(result.output).toContain('row-20');
    expect(result.output).toContain('--- Last 5 lines (of 40) ---');
    expect(result.output).toContain('row-40');
    // Mid-file rows MUST NOT appear in a summary.
    expect(result.output).not.toContain('row-25');
  });

  test('summary wins over explicit offset when both supplied', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `r${i + 1}`);
    const rel = 'mixed.txt';
    await fsWriteFile(path.join(tmpRoot, rel), lines.join('\n'), 'utf8');

    const result = await readFile(
      { path: rel, respondWithSummary: true, offset: 30, limit: 5 },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('--- Summary of');
    expect(result.output).toContain('Lines: 60');
  });
});

describe('read_file — markRead side effect', () => {
  test('successful read records a snapshot in the file tracker', async () => {
    const tracker = new FileChangeTracker();
    setProcessFileChangeTracker(tracker);
    const rel = 'tracked.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'hi\n', 'utf8');

    const result = await readFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false, sessionId: 's1' },
    );
    expect(result.success).toBe(true);

    const abs = path.join(tmpRoot, rel);
    expect(tracker.hasRead(abs, 's1')).toBe(true);
  });
});
