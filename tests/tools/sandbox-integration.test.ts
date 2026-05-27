/**
 * Integration tests — spawn real `sandbox-exec` / `firejail` /
 * passthrough commands through the runner.
 *
 * The macOS-specific tests are skipped on Linux/Windows. The Linux
 * firejail test is skipped when the binary is not installed (so the
 * suite is green on macOS dev machines and on CI Ubuntu runners
 * without firejail).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSandboxRunner,
  findFirejailBinary,
  NoneRunner,
  SandboxExecRunner,
  _resetNoSandboxWarning,
  _resetFallbackWarnings,
  _setSandboxPlatformOverride,
} from '@/tools/sandbox';
import { executeCommand } from '@/tools/run-command';

const isDarwin = process.platform === 'darwin';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const hasSandboxExec = isDarwin && existsSync(SANDBOX_EXEC);
const firejailBinary = findFirejailBinary();
const isLinux = process.platform === 'linux';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-sbx-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
  _resetNoSandboxWarning();
  _resetFallbackWarnings();
});

afterEach(async () => {
  _setSandboxPlatformOverride(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('NoneRunner — passthrough', () => {
  test('echo "hello" succeeds and reports sandboxed=false', async () => {
    const runner = new NoneRunner();
    const res = await runner.run('echo hello', {
      cwd: tmpRoot,
      allowNetwork: true,
      allowWritePaths: [],
      timeoutMs: 5_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.sandboxed).toBe(false);
  });

  test('non-zero exit is reported, not thrown', async () => {
    const runner = new NoneRunner();
    const res = await runner.run('sh -c "exit 7"', {
      cwd: tmpRoot,
      allowNetwork: true,
      allowWritePaths: [],
      timeoutMs: 5_000,
    });
    expect(res.exitCode).toBe(7);
    expect(res.sandboxed).toBe(false);
  });
});

describe('SandboxExecRunner — macOS only', () => {
  test.skipIf(!hasSandboxExec)(
    'echo "hello" runs inside sandbox-exec and reports sandboxed=true',
    async () => {
      const runner = new SandboxExecRunner();
      const res = await runner.run('echo hello', {
        cwd: tmpRoot,
        allowNetwork: true,
        allowWritePaths: [tmpRoot],
        timeoutMs: 5_000,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('hello');
      expect(res.sandboxed).toBe(true);
    },
  );

  test.skipIf(!hasSandboxExec)(
    'writes to the cwd succeed (cwd is implicitly allowed)',
    async () => {
      const runner = new SandboxExecRunner();
      const targetFile = path.join(tmpRoot, 'inside.txt');
      const res = await runner.run(`echo ok > "${targetFile}"`, {
        cwd: tmpRoot,
        allowNetwork: true,
        allowWritePaths: [],
        timeoutMs: 5_000,
      });
      expect(res.exitCode).toBe(0);
      const content = await readFile(targetFile, 'utf8');
      expect(content.trim()).toBe('ok');
    },
  );

  test.skipIf(!hasSandboxExec)(
    'writes to a path outside the scratch zones + cwd are denied',
    async () => {
      // The default profile carves out /tmp and /var/folders (so most
      // dev commands work), so this test writes into the user's home
      // dir which is NOT in the default allow list. We pre-create the
      // file via Node fs (outside the sandbox) so the sandboxed write
      // attempt fails on the open(O_WRONLY|O_TRUNC) rather than mkdir.
      const homeDir = os.homedir();
      const target = path.join(homeDir, `.localcode-sbx-test-${crypto.randomUUID()}`);
      await writeFile(target, 'initial', 'utf8');
      try {
        const runner = new SandboxExecRunner();
        const res = await runner.run(`echo blocked > "${target}"`, {
          cwd: tmpRoot,
          allowNetwork: true,
          allowWritePaths: [],
          timeoutMs: 5_000,
        });
        // sandbox-exec writes a "Operation not permitted" / "Sandbox:
        // ... deny file-write-data ..." line to stderr and the shell
        // returns non-zero. The WRITE must not have landed — that's
        // the actual security contract.
        const after = await readFile(target, 'utf8');
        expect(after.trim()).toBe('initial');
        expect(res.exitCode).not.toBe(0);
      } finally {
        try {
          await rm(target, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
  );

  test.skipIf(!hasSandboxExec)(
    'network is denied when allowNetwork=false (curl fails)',
    async () => {
      const runner = new SandboxExecRunner();
      // Use a 1.5s connect-timeout so the test stays fast even if
      // network is somehow reachable.
      const res = await runner.run(
        'curl --connect-timeout 2 -sS -o /dev/null https://example.com',
        {
          cwd: tmpRoot,
          allowNetwork: false,
          allowWritePaths: [],
          timeoutMs: 10_000,
        },
      );
      // curl returns non-zero on connect failure (typically 7 or 28).
      expect(res.exitCode).not.toBe(0);
    },
  );

  test.skipIf(!hasSandboxExec)(
    'network allowed when allowNetwork=true (loopback connect succeeds in echo)',
    async () => {
      // Don't rely on external network — just verify the sandbox
      // doesn't block a trivial command when network is allowed.
      const runner = new SandboxExecRunner();
      const res = await runner.run('echo network-ok', {
        cwd: tmpRoot,
        allowNetwork: true,
        allowWritePaths: [],
        timeoutMs: 5_000,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('network-ok');
    },
  );
});

describe('FirejailRunner — Linux only', () => {
  const haveFirejail = isLinux && firejailBinary !== null;
  test.skipIf(!haveFirejail)(
    'echo "hello" runs inside firejail and reports sandboxed=true',
    async () => {
      if (firejailBinary === null) return; // Type guard
      // Dynamic import so the file even loads on macOS without
      // resolving the binary path.
      const { FirejailRunner } = await import('@/tools/sandbox/firejail');
      const runner = new FirejailRunner(firejailBinary);
      const res = await runner.run('echo hello', {
        cwd: tmpRoot,
        allowNetwork: true,
        allowWritePaths: [tmpRoot],
        timeoutMs: 10_000,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('hello');
      expect(res.sandboxed).toBe(true);
    },
  );
});

describe('executeCommand — wired through sandbox layer', () => {
  test('backend=none preserves legacy behaviour (echo works)', async () => {
    const res = await executeCommand(
      { command: 'echo wired' },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        sandboxConfig: {
          backend: 'none',
          allowNetwork: true,
          allowWritePaths: [],
          timeoutMs: 30_000,
        },
      },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('wired');
  });

  test('per-call sandbox=false opt-out runs through direct exec', async () => {
    const res = await executeCommand(
      { command: 'echo opt-out', sandbox: false },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        // Even though we'd auto-pick a sandbox here, the per-call
        // override bypasses it.
        sandboxConfig: {
          backend: 'auto',
          allowNetwork: true,
          allowWritePaths: [],
          timeoutMs: 30_000,
        },
      },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('opt-out');
  });

  test('factory result is honoured (none returns expected output)', async () => {
    const runner = createSandboxRunner({
      backend: 'none',
      allowNetwork: true,
      allowWritePaths: [],
      timeoutMs: 5_000,
    });
    const res = await executeCommand(
      { command: 'echo factory' },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        sandboxRunner: runner,
        sandboxConfig: {
          backend: 'none',
          allowNetwork: true,
          allowWritePaths: [],
          timeoutMs: 5_000,
        },
      },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('factory');
  });

  test.skipIf(!hasSandboxExec)(
    'macOS: executeCommand routes through sandbox-exec via auto-detect',
    async () => {
      const res = await executeCommand(
        { command: 'echo sandboxed' },
        {
          projectRoot: tmpRoot,
          dangerouslyAllowAll: false,
          sandboxConfig: {
            backend: 'sandbox-exec',
            allowNetwork: true,
            allowWritePaths: [tmpRoot],
            timeoutMs: 5_000,
          },
        },
      );
      expect(res.success).toBe(true);
      expect(res.output).toContain('sandboxed');
    },
  );

  test('spawn failure inside runner falls back to direct exec', async () => {
    // Use a stub runner that always throws to exercise the catch path.
    const throwingRunner = {
      id: 'sandbox-exec' as const,
      run: async () => {
        throw new Error('synthetic spawn failure');
      },
    };
    const res = await executeCommand(
      { command: 'echo fallback' },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        sandboxRunner: throwingRunner,
        sandboxConfig: {
          backend: 'sandbox-exec',
          allowNetwork: true,
          allowWritePaths: [],
          timeoutMs: 5_000,
        },
      },
    );
    expect(res.success).toBe(true);
    // Direct-exec fallback still produces the expected output.
    expect(res.output).toContain('fallback');
  });

  test('legacy call (no sandboxConfig) still works via default config', async () => {
    const res = await executeCommand(
      { command: 'echo legacy' },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
      },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('legacy');
  });
});
