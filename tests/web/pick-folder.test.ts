/**
 * Unit tests for the native folder-picker spawn helper and the
 * `/api/pick-folder` REST handler. Tests use a stubbed runner so the
 * real OS dialog never opens during CI.
 */

import { describe, expect, test } from 'bun:test';

import { handlePickFolder } from '@/web/api/projects';
import {
  pickFolderNative,
  type PickFolderInternals,
} from '@/web/api/pick-folder';
import type { ApiDeps } from '@/web/api';
import type { PickFolderResponse } from '@/web/protocol/rest-types';

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function fakeRunner(outcome: SpawnOutcome): PickFolderInternals['runner'] {
  return async () => outcome;
}

const stubDeps: ApiDeps = {} as unknown as ApiDeps;

function callHandler(
  body: unknown | null,
  internals?: PickFolderInternals,
): Promise<Response> {
  const init: RequestInit = { method: 'POST' };
  if (body !== null) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const url = new URL('http://localhost/api/pick-folder');
  return handlePickFolder(new Request(url, init), url, stubDeps, internals);
}

describe('pickFolderNative', () => {
  test('darwin: returns the trimmed path on success', async () => {
    const result = await pickFolderNative(
      {},
      {
        platformOverride: 'darwin',
        runner: fakeRunner({
          stdout: '/Users/me/Code/my-app\n',
          stderr: '',
          code: 0,
          timedOut: false,
        }),
      },
    );
    expect(result).toEqual({
      path: '/Users/me/Code/my-app',
      cancelled: false,
      platform: 'darwin',
    });
  });

  test('darwin: cancellation surfaces as cancelled:true, path:null', async () => {
    const result = await pickFolderNative(
      {},
      {
        platformOverride: 'darwin',
        runner: fakeRunner({
          stdout: '',
          stderr: 'User canceled.',
          code: 1,
          timedOut: false,
        }),
      },
    );
    expect(result.cancelled).toBe(true);
    expect(result.path).toBeNull();
    expect(result.platform).toBe('darwin');
  });

  test('linux: returns unsupported when neither zenity nor kdialog is present', async () => {
    const result = await pickFolderNative(
      {},
      {
        platformOverride: 'linux',
        which: async () => false,
        runner: fakeRunner({ stdout: '', stderr: '', code: 0, timedOut: false }),
      },
    );
    expect(result.platform).toBe('unsupported');
    expect(result.path).toBeNull();
    expect(result.cancelled).toBe(false);
  });

  test('linux: zenity success path', async () => {
    const result = await pickFolderNative(
      {},
      {
        platformOverride: 'linux',
        which: async (cmd) => cmd === 'zenity',
        runner: fakeRunner({
          stdout: '/home/me/proj\n',
          stderr: '',
          code: 0,
          timedOut: false,
        }),
      },
    );
    expect(result).toEqual({
      path: '/home/me/proj',
      cancelled: false,
      platform: 'linux',
    });
  });

  test('unsupported platform short-circuits', async () => {
    const result = await pickFolderNative(
      {},
      {
        platformOverride: 'unsupported',
        runner: fakeRunner({ stdout: 'x', stderr: '', code: 0, timedOut: false }),
      },
    );
    expect(result).toEqual({
      path: null,
      cancelled: false,
      platform: 'unsupported',
    });
  });
});

describe('pickFolderNative — AppleScript injection containment (M6)', () => {
  // Spy runner: records every call so we can assert what was actually
  // delivered to osascript. Returns a benign cancellation outcome so
  // the function under test exits without further FS interaction.
  function spyRunner(): {
    runner: PickFolderInternals['runner'];
    calls: Array<{ cmd: string; args: readonly string[]; stdin?: string }>;
  } {
    const calls: Array<{ cmd: string; args: readonly string[]; stdin?: string }> = [];
    const runner: PickFolderInternals['runner'] = async (
      cmd,
      args,
      stdinInput,
    ) => {
      const entry: { cmd: string; args: readonly string[]; stdin?: string } = {
        cmd,
        args,
      };
      if (stdinInput !== undefined) entry.stdin = stdinInput;
      calls.push(entry);
      return { stdout: '', stderr: 'cancelled', code: 1, timedOut: false };
    };
    return { runner, calls };
  }

  test('darwin: prompt is delivered via stdin, NOT via -e argv', async () => {
    const { runner, calls } = spyRunner();
    await pickFolderNative(
      { prompt: 'normal title' },
      { platformOverride: 'darwin', runner },
    );
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.cmd).toBe('osascript');
    // No `-e` arg means the script has to come from stdin.
    expect(call?.args).not.toContain('-e');
    expect(call?.stdin).toBeDefined();
    expect(call?.stdin).toContain('choose folder with prompt');
    expect(call?.stdin).toContain('normal title');
  });

  test('darwin: injection-shaped prompt cannot break out of the string literal', async () => {
    const { runner, calls } = spyRunner();
    // Classic AppleScript-injection payload — closes the string,
    // continues with `& (do shell script "id") &` and reopens. With
    // the old `-e` argv path AND naive escaping, this would execute
    // `id` via `do shell script`.
    const evilPrompt = '") & (do shell script "id") & ("';
    await pickFolderNative(
      { prompt: evilPrompt },
      { platformOverride: 'darwin', runner },
    );
    expect(calls.length).toBe(1);
    const call = calls[0];
    // Critical assertion: the injected `do shell script` never
    // appears as live AppleScript — the inner quotes must have been
    // escaped (`\"`) before reaching stdin. We grep for the escaped
    // form to prove the escape ran.
    expect(call?.stdin).toBeDefined();
    expect(call?.stdin).toContain('\\"');
    // And we never go through -e argv where shell metacharacters
    // would matter for sub-processes.
    expect(call?.args).not.toContain('-e');
    // Defense-in-depth: even though stdin DOES contain the literal
    // characters `do shell script "id"`, they are inside an escaped
    // AppleScript string literal — i.e. preceded by `\"`, not a
    // closing `"`. The presence of the escape sequence is the
    // proof the quoting helper ran.
    const stdin = call?.stdin ?? '';
    // Count escaped quotes — must be at least 2 (the embedded `"id"`
    // gets escaped twice, plus the wrapping `")` and `("`).
    const escapedQuotes = (stdin.match(/\\"/g) ?? []).length;
    expect(escapedQuotes).toBeGreaterThanOrEqual(2);
  });
});

describe('handlePickFolder REST handler', () => {
  test('POST returns picked path as JSON', async () => {
    const res = await callHandler(
      { prompt: 'Pick one' },
      {
        platformOverride: 'darwin',
        runner: fakeRunner({
          stdout: '/tmp/x\n',
          stderr: '',
          code: 0,
          timedOut: false,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PickFolderResponse;
    expect(body).toEqual({
      path: '/tmp/x',
      cancelled: false,
      platform: 'darwin',
    });
  });

  test('POST with no body still works (prompt is optional)', async () => {
    const res = await callHandler(null, {
      platformOverride: 'darwin',
      runner: fakeRunner({
        stdout: '/Users/x\n',
        stderr: '',
        code: 0,
        timedOut: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PickFolderResponse;
    expect(body.path).toBe('/Users/x');
  });

  test('cancellation returns 200 with cancelled:true', async () => {
    const res = await callHandler(
      {},
      {
        platformOverride: 'darwin',
        runner: fakeRunner({
          stdout: '',
          stderr: 'User canceled.',
          code: 1,
          timedOut: false,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PickFolderResponse;
    expect(body.cancelled).toBe(true);
    expect(body.path).toBeNull();
  });

  test('unsupported platform reports platform:unsupported', async () => {
    const res = await callHandler(
      {},
      {
        platformOverride: 'unsupported',
        runner: fakeRunner({ stdout: '', stderr: '', code: 0, timedOut: false }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PickFolderResponse;
    expect(body.platform).toBe('unsupported');
    expect(body.path).toBeNull();
    expect(body.cancelled).toBe(false);
  });

  test('non-POST methods return 405', async () => {
    const url = new URL('http://localhost/api/pick-folder');
    const res = await handlePickFolder(
      new Request(url, { method: 'GET' }),
      url,
      stubDeps,
    );
    expect(res.status).toBe(405);
  });
});
