/**
 * Unit tests for the sandbox profile / argv builders.
 *
 * These are pure-function tests — no spawn, no filesystem touches —
 * so they run on every platform.
 */
import { describe, test, expect } from 'bun:test';

import {
  buildDockerArgs,
  buildFirejailArgs,
  buildSandboxExecProfile,
} from '@/tools/sandbox';

describe('buildSandboxExecProfile', () => {
  test('default-denies + allows reads + restricts writes', () => {
    const profile = buildSandboxExecProfile({
      cwd: '/tmp/proj',
      allowNetwork: false,
      allowWritePaths: [],
    });
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow process*)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain('(allow file-write*');
    // The cwd is one of the allowed write subpaths.
    expect(profile).toContain('"/tmp/proj"');
    // Network is denied by default — no `(allow network*)` line.
    expect(profile).not.toContain('(allow network*)');
    expect(profile).toContain(';; network denied');
  });

  test('allowNetwork=true emits the network* allow rule', () => {
    const profile = buildSandboxExecProfile({
      cwd: '/tmp/proj',
      allowNetwork: true,
      allowWritePaths: [],
    });
    expect(profile).toContain('(allow network*)');
    expect(profile).not.toContain(';; network denied');
  });

  test('allowWritePaths are added as subpath rules', () => {
    const profile = buildSandboxExecProfile({
      cwd: '/tmp/proj',
      allowNetwork: false,
      allowWritePaths: ['/var/cache/bun', '/Users/me/.npm'],
    });
    expect(profile).toContain('(subpath "/tmp/proj")');
    expect(profile).toContain('(subpath "/var/cache/bun")');
    expect(profile).toContain('(subpath "/Users/me/.npm")');
  });

  test('non-absolute and empty paths are ignored', () => {
    const profile = buildSandboxExecProfile({
      cwd: '/tmp/proj',
      allowNetwork: false,
      allowWritePaths: ['', 'relative/path', '/abs/ok'],
    });
    expect(profile).toContain('(subpath "/abs/ok")');
    expect(profile).not.toContain('"relative/path"');
  });

  test('duplicate paths are deduplicated', () => {
    const profile = buildSandboxExecProfile({
      cwd: '/tmp/proj',
      allowNetwork: false,
      allowWritePaths: ['/tmp/proj', '/tmp/proj', '/var/log'],
    });
    const matches = profile.match(/\(subpath "\/tmp\/proj"\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('paths with embedded quotes are escaped into Scheme strings', () => {
    const profile = buildSandboxExecProfile({
      cwd: '/tmp/proj',
      allowNetwork: false,
      allowWritePaths: ['/weird"path'],
    });
    expect(profile).toContain('"/weird\\"path"');
  });
});

describe('buildFirejailArgs', () => {
  test('includes --quiet, --read-only=/, --private-tmp', () => {
    const args = buildFirejailArgs({
      cwd: '/tmp/proj',
      allowNetwork: true,
      allowWritePaths: [],
    });
    expect(args).toContain('--quiet');
    expect(args).toContain('--read-only=/');
    expect(args).toContain('--private-tmp');
  });

  test('allowNetwork=false adds --net=none', () => {
    const args = buildFirejailArgs({
      cwd: '/tmp/proj',
      allowNetwork: false,
      allowWritePaths: [],
    });
    expect(args).toContain('--net=none');
  });

  test('allowNetwork=true omits --net=none', () => {
    const args = buildFirejailArgs({
      cwd: '/tmp/proj',
      allowNetwork: true,
      allowWritePaths: [],
    });
    expect(args).not.toContain('--net=none');
  });

  test('cwd + allowWritePaths emitted as --read-write= entries', () => {
    const args = buildFirejailArgs({
      cwd: '/tmp/proj',
      allowNetwork: true,
      allowWritePaths: ['/var/cache/bun', '/Users/me/.npm'],
    });
    expect(args).toContain('--read-write=/tmp/proj');
    expect(args).toContain('--read-write=/var/cache/bun');
    expect(args).toContain('--read-write=/Users/me/.npm');
  });

  test('non-absolute write paths are dropped', () => {
    const args = buildFirejailArgs({
      cwd: '/tmp/proj',
      allowNetwork: true,
      allowWritePaths: ['relative'],
    });
    expect(args.some((a) => a.includes('relative'))).toBe(false);
  });
});

describe('buildDockerArgs', () => {
  test('mounts cwd as /workspace and sets working dir', () => {
    const args = buildDockerArgs(
      {
        cwd: '/tmp/proj',
        allowNetwork: true,
        allowWritePaths: [],
      },
      'alpine:3.20',
    );
    expect(args).toEqual([
      'run',
      '--rm',
      '-i',
      '-w',
      '/workspace',
      '-v',
      '/tmp/proj:/workspace',
      'alpine:3.20',
    ]);
  });

  test('allowNetwork=false adds --network=none', () => {
    const args = buildDockerArgs(
      {
        cwd: '/tmp/proj',
        allowNetwork: false,
        allowWritePaths: [],
      },
      'alpine:3.20',
    );
    expect(args).toContain('--network=none');
  });

  test('extra allowWritePaths get bind-mounted at their host path', () => {
    const args = buildDockerArgs(
      {
        cwd: '/tmp/proj',
        allowNetwork: true,
        allowWritePaths: ['/var/cache/bun'],
      },
      'alpine:3.20',
    );
    expect(args.join(' ')).toContain('-v /var/cache/bun:/var/cache/bun');
  });

  test('cwd is not double-mounted when also in allowWritePaths', () => {
    const args = buildDockerArgs(
      {
        cwd: '/tmp/proj',
        allowNetwork: true,
        allowWritePaths: ['/tmp/proj'],
      },
      'alpine:3.20',
    );
    const cwdMounts = args.filter((a) => a === '/tmp/proj:/tmp/proj');
    expect(cwdMounts.length).toBe(0);
  });
});
