import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const installSh = join(repoRoot, 'install.sh');

describe('install.sh', () => {
  test('parses with bash -n (no syntax errors)', () => {
    const r = spawnSync('bash', ['-n', installSh], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  test('is executable and starts with bash shebang', () => {
    const mode = statSync(installSh).mode & 0o111;
    expect(mode).not.toBe(0);
    const head = readFileSync(installSh, 'utf8').split('\n', 1)[0];
    expect(head).toMatch(/^#!\/usr\/bin\/env bash$|^#!\/bin\/bash$/);
  });

  test('--help prints usage without side effects', () => {
    const r = spawnSync('bash', [installSh, '--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LocalCode installer');
    expect(r.stdout).toContain('--uninstall');
    expect(r.stdout).toContain('--update');
    expect(r.stdout).toContain('--dir');
  });

  test('unknown flag exits non-zero with helpful message', () => {
    const r = spawnSync('bash', [installSh, '--definitely-not-a-real-flag'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unknown flag');
  });

  test('--dir without value errors out', () => {
    const r = spawnSync('bash', [installSh, '--dir'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--dir requires a value');
  });

  test('script references the canonical repo URL', () => {
    const body = readFileSync(installSh, 'utf8');
    expect(body).toContain('grosa787/localcode');
    expect(body).toContain('https://bun.sh/install');
  });
});
