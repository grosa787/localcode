/**
 * `/web` slash command tests.
 *
 * The command itself just wires user input to the host-supplied
 * `launchWeb` / `stopWeb` callbacks; we stub both so the test never
 * spawns a real Bun server.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { createWebCommand } from '@/commands/cmd-web';
import type { LaunchedWeb } from '@/commands/cmd-web';
import type { AppConfig, CommandContext } from '@/types/global';
import { getDefaultConfig } from '@/config/defaults';

interface Stub {
  launchCalls: Array<string | null>;
  stopCalls: number;
  openCalls: string[];
  bootCount: number;
  url: string;
  raise: Error | null;
  buildLaunched(): LaunchedWeb;
}

function makeStub(): Stub {
  const stub: Stub = {
    launchCalls: [],
    stopCalls: 0,
    openCalls: [],
    bootCount: 0,
    url: 'http://127.0.0.1:7777/#token=ABCDEF',
    raise: null,
    buildLaunched(): LaunchedWeb {
      return {
        url: stub.url,
        stop: async () => {
          stub.stopCalls += 1;
        },
      };
    },
  };
  return stub;
}

function buildCtx(sessionId: string | null = 'session-abc'): {
  ctx: CommandContext;
  out: string[];
} {
  const out: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  config.model.current = 'm';
  config.onboarding.completed = true;
  const ctx: CommandContext = {
    projectRoot: '/tmp/test-project',
    sessionId,
    config,
    print: (line) => out.push(line),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, out };
}

describe('/web — happy path', () => {
  let stub: Stub;
  beforeEach(() => {
    stub = makeStub();
  });

  test('launches the server with the current session and prints the public URL', async () => {
    const cmd = createWebCommand({
      launchWeb: async (sid: string | null) => {
        stub.launchCalls.push(sid);
        stub.bootCount += 1;
        // Echo the session into the URL so the test can confirm the
        // fragment got threaded.
        stub.url = `http://127.0.0.1:7777/#token=ABCDEF&session=${encodeURIComponent(sid ?? '')}`;
        return stub.buildLaunched();
      },
      stopWeb: async () => {
        stub.stopCalls += 1;
      },
      openBrowser: async (url) => {
        stub.openCalls.push(url);
      },
    });

    const { ctx, out } = buildCtx('session-abc');
    await cmd.execute('', ctx);

    expect(stub.launchCalls).toEqual(['session-abc']);
    expect(stub.bootCount).toBe(1);
    // Browser open should receive the full URL including the fragment.
    expect(stub.openCalls.length).toBe(1);
    expect(stub.openCalls[0]).toContain('#token=ABCDEF');
    expect(stub.openCalls[0]).toContain('session=session-abc');
    // The chat log must NOT leak the CSRF token (fragment stripped).
    const printed = out.join('\n');
    expect(printed).toContain('http://127.0.0.1:7777/');
    expect(printed).not.toContain('ABCDEF');
    expect(printed).toMatch(/Web server running/);
  });

  test('idempotent: second invocation reuses the host singleton (no double-spawn)', async () => {
    const cmd = createWebCommand({
      launchWeb: async (sid: string | null) => {
        stub.launchCalls.push(sid);
        // Production helper returns the same handle on subsequent calls
        // — we mirror that contract from the stub by incrementing the
        // bootCount only on the FIRST call.
        if (stub.bootCount === 0) stub.bootCount += 1;
        return stub.buildLaunched();
      },
      stopWeb: async () => {
        stub.stopCalls += 1;
      },
    });

    {
      const { ctx } = buildCtx();
      await cmd.execute('', ctx);
    }
    {
      const { ctx } = buildCtx();
      await cmd.execute('', ctx);
    }
    expect(stub.launchCalls.length).toBe(2);
    expect(stub.bootCount).toBe(1);
  });

  test('falls through gracefully when the launcher throws', async () => {
    const cmd = createWebCommand({
      launchWeb: async () => {
        throw new Error('port already in use');
      },
      stopWeb: async () => {
        stub.stopCalls += 1;
      },
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('', ctx);
    expect(out.join('\n')).toMatch(/port already in use/);
  });
});

describe('/web stop', () => {
  test('calls stopWeb and reports success', async () => {
    const stub = makeStub();
    const cmd = createWebCommand({
      launchWeb: async () => stub.buildLaunched(),
      stopWeb: async () => {
        stub.stopCalls += 1;
      },
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('stop', ctx);
    expect(stub.stopCalls).toBe(1);
    expect(out.join('\n')).toMatch(/stopped/i);
  });

  test('reports unknown subcommand', async () => {
    const stub = makeStub();
    const cmd = createWebCommand({
      launchWeb: async () => stub.buildLaunched(),
      stopWeb: async () => {
        stub.stopCalls += 1;
      },
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('frobnicate', ctx);
    expect(out.join('\n')).toMatch(/Unknown subcommand/);
    expect(stub.stopCalls).toBe(0);
  });
});

describe('/web with no active session', () => {
  test('passes null sessionId through and prints the "no active session" line', async () => {
    const stub = makeStub();
    const cmd = createWebCommand({
      launchWeb: async (sid: string | null) => {
        stub.launchCalls.push(sid);
        return stub.buildLaunched();
      },
      stopWeb: async () => {
        stub.stopCalls += 1;
      },
    });
    const { ctx, out } = buildCtx(null);
    await cmd.execute('', ctx);
    expect(stub.launchCalls).toEqual([null]);
    expect(out.join('\n')).toMatch(/no active session/i);
  });
});
