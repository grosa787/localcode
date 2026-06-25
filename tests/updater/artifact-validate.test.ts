import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isRunnableBundleHead,
  isRunnableBundleFile,
} from '@/updater/artifact-validate';

const tmpDirs: string[] = [];
function freshFile(name: string, bytes: Uint8Array | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-artifact-'));
  tmpDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('isRunnableBundleHead — rejects non-JS artifacts', () => {
  test('empty → reject', () => {
    expect(isRunnableBundleHead(new Uint8Array(0)).ok).toBe(false);
  });
  test('gzip magic (the real corruption) → reject with reason', () => {
    const r = isRunnableBundleHead(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('gzip');
  });
  test('zip magic (PK) → reject', () => {
    const r = isRunnableBundleHead(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('zip');
  });
  test('ELF magic → reject', () => {
    const r = isRunnableBundleHead(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02]));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ELF');
  });
  test('Mach-O magic → reject (non-text)', () => {
    // 0xfeedfacf (64-bit Mach-O) — non-printable bytes up front.
    expect(isRunnableBundleHead(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe])).ok).toBe(false);
    expect(isRunnableBundleHead(new Uint8Array([0xfe, 0xed, 0xfa, 0xcf])).ok).toBe(false);
  });
});

describe('isRunnableBundleHead — accepts JS bundles', () => {
  test('shebang bun bundle → ok', () => {
    const head = new TextEncoder().encode('#!/usr/bin/env bun\n// @bun\nvar x=1;');
    expect(isRunnableBundleHead(head).ok).toBe(true);
  });
  test('// @bun marker (no shebang) → ok', () => {
    const head = new TextEncoder().encode('// @bun\nvar localcode=1;');
    expect(isRunnableBundleHead(head).ok).toBe(true);
  });
  test('plain JS text → ok', () => {
    const head = new TextEncoder().encode('var x = 1;\nconsole.log(x);');
    expect(isRunnableBundleHead(head).ok).toBe(true);
  });
});

describe('isRunnableBundleFile — file-based', () => {
  test('a gzip file (the exact failure mode) → reject', async () => {
    const p = freshFile('cli.js', new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x6c, 0x15]));
    const r = await isRunnableBundleFile(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('gzip');
  });
  test('a real-looking bun bundle file → ok', async () => {
    const p = freshFile('cli.js', '#!/usr/bin/env bun\n// @bun\nvar _ = 1;\n');
    expect((await isRunnableBundleFile(p)).ok).toBe(true);
  });
  test('missing file → reject (no throw)', async () => {
    const r = await isRunnableBundleFile(join(tmpdir(), 'does-not-exist-xyz', 'cli.js'));
    expect(r.ok).toBe(false);
  });
});
