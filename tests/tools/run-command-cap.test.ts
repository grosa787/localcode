/**
 * Output-cap tests for `run_command` (ROADMAP #1).
 *
 * Verifies:
 *   - Stdout under 50KB passes through unchanged.
 *   - Stdout over 50KB is trimmed and footer appended with byte info.
 *   - Stderr is trimmed independently of stdout.
 *   - Combined output never exceeds 100KB total.
 *   - Footer mentions grep/head/tail as actionable next steps.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeCommand } from '@/tools/run-command';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-runcmd-cap-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('executeCommand output cap', () => {
  test('small stdout passes through untrimmed', async () => {
    const res = await executeCommand(
      { command: 'echo small-output' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('small-output');
    expect(res.output).not.toContain('truncated');
  });

  test('stdout > 50KB is truncated with informative footer', async () => {
    // Generate ~80KB of output via repeated string. Each `printf '%s'` line
    // produces ~4KB; 20 iterations = ~80KB.
    const block = 'x'.repeat(4000);
    const cmd = `for i in $(seq 1 20); do printf '%s\\n' '${block}'; done`;
    const res = await executeCommand(
      { command: cmd },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    // Output should now contain the truncation footer.
    expect(res.output).toContain('truncated');
    expect(res.output).toMatch(/\d+ bytes/);
    expect(res.output).toMatch(/KB/);
    expect(res.output).toMatch(/grep|head|tail/);
    // Trimmed length should be roughly STREAM_CAP_BYTES (50_000) + footer.
    expect(res.output.length).toBeLessThanOrEqual(60_000);
    expect(res.output.length).toBeGreaterThan(50_000);
  });

  test('stderr > 50KB is truncated independently', async () => {
    const block = 'e'.repeat(4000);
    // Send everything to stderr so stdout stays empty.
    const cmd = `for i in $(seq 1 20); do printf '%s\\n' '${block}' 1>&2; done`;
    const res = await executeCommand(
      { command: cmd },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    // stderr block is emitted under [stderr] marker.
    expect(res.output).toContain('[stderr]');
    expect(res.output).toContain('stderr truncated');
  });

  test('both streams large: combined output capped at 100KB', async () => {
    const block = 'x'.repeat(4000);
    // 20 iterations of stdout (~80KB) + 20 iterations of stderr (~80KB).
    const cmd = `for i in $(seq 1 20); do printf '%s\\n' '${block}'; done; for i in $(seq 1 20); do printf '%s\\n' '${block}' 1>&2; done`;
    const res = await executeCommand(
      { command: cmd },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    // Combined stdout (50KB capped + footer) + "\n[stderr]\n" + stderr
    // (50KB capped + footer) ≈ ~100.1KB. Final safety net trims to 100KB +
    // a small footer addendum. Allow some slack for footer text.
    expect(res.output.length).toBeLessThanOrEqual(101_000);
  });

  test('non-zero exit with large stdout still trims output', async () => {
    const block = 'x'.repeat(4000);
    const cmd = `for i in $(seq 1 20); do printf '%s\\n' '${block}'; done; exit 7`;
    const res = await executeCommand(
      { command: cmd },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Exit 7/);
    expect(res.output).toContain('truncated');
    expect(res.output.length).toBeLessThanOrEqual(60_000);
  });
});
