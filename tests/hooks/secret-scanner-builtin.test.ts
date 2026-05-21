/**
 * HookEngine — built-in dispatcher test for the secret scanner.
 *
 * Asserts:
 *   - A `builtin: 'secret-scanner'` entry routes through the internal
 *     handler (no shell spawn) when the engine runs.
 *   - Unknown builtin names produce a structured error outcome.
 *   - `withBuiltinSecurityHooks` auto-prepends the built-in entry and
 *     respects the `enabled: false` toggle.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { HookEngine, type HookConfig } from '@/hooks';
import {
  SECRET_SCANNER_BUILTIN,
  SECRET_SCANNER_HOOK,
  withBuiltinSecurityHooks,
} from '@/security';

function newProject(): string {
  const root = path.join(os.tmpdir(), `localcode-builtin-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
  return root;
}

function stageFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  execFileSync('git', ['add', rel], { cwd: root, stdio: 'ignore' });
}

describe('HookEngine — builtin dispatch', () => {
  test('routes to secret-scanner builtin and blocks on findings', async () => {
    const root = newProject();
    try {
      stageFile(root, 'config.ts', 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
      const engine = new HookEngine({ hooks: [SECRET_SCANNER_HOOK] });
      const outcomes = await engine.run({
        trigger: 'PreToolUse',
        toolName: 'git_commit',
        projectRoot: root,
      });
      expect(outcomes.length).toBe(1);
      const outcome = outcomes[0];
      if (outcome === undefined) throw new Error('expected outcome');
      expect(outcome.blocked).toBe(true);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toContain('Secret scanner blocked');
      expect(outcome.stderr).toContain('aws-access-key');
      // Redacted, never raw
      expect(outcome.stderr).not.toContain('AKIAIOSFODNN7EXAMPLE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('clean staged diff produces no findings', async () => {
    const root = newProject();
    try {
      stageFile(root, 'foo.ts', 'export const x = 1;\n');
      const engine = new HookEngine({ hooks: [SECRET_SCANNER_HOOK] });
      const outcomes = await engine.run({
        trigger: 'PreToolUse',
        toolName: 'git_commit',
        projectRoot: root,
      });
      expect(outcomes.length).toBe(1);
      const outcome = outcomes[0];
      if (outcome === undefined) throw new Error('expected outcome');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.blocked).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('unknown builtin produces structured error', async () => {
    const hook: HookConfig = {
      trigger: 'PreToolUse',
      toolPattern: 'git_commit',
      builtin: 'does-not-exist',
      command: '(builtin: does-not-exist)',
      blocking: true,
    };
    const engine = new HookEngine({ hooks: [hook] });
    const outcomes = await engine.run({
      trigger: 'PreToolUse',
      toolName: 'git_commit',
      projectRoot: os.tmpdir(),
    });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.exitCode).toBe(-1);
    expect(outcomes[0]?.stderr).toContain('unknown builtin');
  });

  test('allowlist entries suppress matching findings', async () => {
    const root = newProject();
    try {
      stageFile(root, 'docs.ts', 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
      fs.mkdirSync(path.join(root, '.localcode'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.localcode', 'secret-allowlist.toml'),
        '[[allow]]\npattern = "AKIAIOSFODNN7EXAMPLE"\nreason = "docs example"\n',
        'utf8',
      );
      const engine = new HookEngine({ hooks: [SECRET_SCANNER_HOOK] });
      const outcomes = await engine.run({
        trigger: 'PreToolUse',
        toolName: 'git_commit',
        projectRoot: root,
      });
      expect(outcomes[0]?.exitCode).toBe(0);
      expect(outcomes[0]?.blocked).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not match against other tool names', async () => {
    const engine = new HookEngine({ hooks: [SECRET_SCANNER_HOOK] });
    const outcomes = await engine.run({
      trigger: 'PreToolUse',
      toolName: 'write_file',
      projectRoot: os.tmpdir(),
    });
    expect(outcomes.length).toBe(0);
  });
});

describe('withBuiltinSecurityHooks', () => {
  test('prepends scanner by default', () => {
    const out = withBuiltinSecurityHooks<HookConfig>([]);
    expect(out.length).toBe(1);
    expect(out[0]?.builtin).toBe(SECRET_SCANNER_BUILTIN);
  });

  test('omits scanner when explicitly disabled', () => {
    const out = withBuiltinSecurityHooks<HookConfig>([], { enabled: false });
    expect(out.length).toBe(0);
  });

  test('preserves existing user hooks', () => {
    const user: HookConfig = {
      trigger: 'PreToolUse',
      command: 'echo hi',
    };
    const out = withBuiltinSecurityHooks([user]);
    expect(out.length).toBe(2);
    expect(out.find((h) => h.builtin === SECRET_SCANNER_BUILTIN)).toBeDefined();
    expect(out.find((h) => h.command === 'echo hi')).toBeDefined();
  });
});
