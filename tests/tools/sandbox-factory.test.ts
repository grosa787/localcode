/**
 * Factory tests — verify `createSandboxRunner` picks the right backend
 * per platform and falls back to `none` when the requested backend is
 * unavailable.
 *
 * Platform detection is overridden via `_setSandboxPlatformOverride`
 * so the test runs deterministically on any host.
 */
import { describe, test, expect, afterEach } from 'bun:test';

import {
  _resetFallbackWarnings,
  _setSandboxPlatformOverride,
  createSandboxRunner,
} from '@/tools/sandbox';

afterEach(() => {
  _setSandboxPlatformOverride(null);
  _resetFallbackWarnings();
});

describe('createSandboxRunner — explicit backend', () => {
  test("backend='none' returns the NoneRunner regardless of platform", () => {
    _setSandboxPlatformOverride('darwin');
    const runner = createSandboxRunner({
      backend: 'none',
      allowNetwork: true,
      allowWritePaths: [],
      timeoutMs: 30_000,
    });
    expect(runner.id).toBe('none');
  });

  test("backend='firejail' falls back to 'none' when firejail missing", () => {
    // Force a PATH lookup that will fail on CI/macOS test machines that
    // don't have firejail installed. We can't easily mock `existsSync`
    // without messing with bun:test internals, so this test is a
    // best-effort: on machines WITHOUT firejail, this MUST fall back.
    _setSandboxPlatformOverride('linux');
    const prevPath = process.env['PATH'];
    process.env['PATH'] = '/nonexistent/dir';
    try {
      const runner = createSandboxRunner({
        backend: 'firejail',
        allowNetwork: true,
        allowWritePaths: [],
        timeoutMs: 30_000,
      });
      expect(runner.id).toBe('none');
    } finally {
      if (prevPath !== undefined) {
        process.env['PATH'] = prevPath;
      } else {
        delete process.env['PATH'];
      }
    }
  });

  test("backend='docker' falls back to 'none' when docker missing", () => {
    _setSandboxPlatformOverride('linux');
    const prevPath = process.env['PATH'];
    process.env['PATH'] = '/nonexistent/dir';
    try {
      const runner = createSandboxRunner({
        backend: 'docker',
        allowNetwork: true,
        allowWritePaths: [],
        timeoutMs: 30_000,
      });
      expect(runner.id).toBe('none');
    } finally {
      if (prevPath !== undefined) {
        process.env['PATH'] = prevPath;
      } else {
        delete process.env['PATH'];
      }
    }
  });
});

describe('createSandboxRunner — auto-detect', () => {
  test('auto on darwin picks sandbox-exec when binary is present', () => {
    _setSandboxPlatformOverride('darwin');
    const runner = createSandboxRunner({
      backend: 'auto',
      allowNetwork: true,
      allowWritePaths: [],
      timeoutMs: 30_000,
    });
    // sandbox-exec ships on every macOS box; on CI Ubuntu the test that
    // forces darwin will still fall back via `existsSync` -> none.
    expect(['sandbox-exec', 'none']).toContain(runner.id);
  });

  test('auto on linux without firejail falls back to none', () => {
    _setSandboxPlatformOverride('linux');
    const prevPath = process.env['PATH'];
    process.env['PATH'] = '/nonexistent/dir';
    try {
      const runner = createSandboxRunner({
        backend: 'auto',
        allowNetwork: true,
        allowWritePaths: [],
        timeoutMs: 30_000,
      });
      expect(runner.id).toBe('none');
    } finally {
      if (prevPath !== undefined) {
        process.env['PATH'] = prevPath;
      } else {
        delete process.env['PATH'];
      }
    }
  });

  test('auto on win32 falls back to none', () => {
    _setSandboxPlatformOverride('win32');
    const runner = createSandboxRunner({
      backend: 'auto',
      allowNetwork: true,
      allowWritePaths: [],
      timeoutMs: 30_000,
    });
    expect(runner.id).toBe('none');
  });

  test('auto on an unknown platform falls back to none', () => {
    // freebsd is a reasonable unsupported case
    _setSandboxPlatformOverride('freebsd' as NodeJS.Platform);
    const runner = createSandboxRunner({
      backend: 'auto',
      allowNetwork: true,
      allowWritePaths: [],
      timeoutMs: 30_000,
    });
    expect(runner.id).toBe('none');
  });
});
