/**
 * Tests for the modified-args extension to `approval_response`.
 *
 * The SPA's Monaco-editable approval dialog can ship a `modifiedArgs`
 * record with the approval reply. The ApprovalBridge forwards them in
 * its resolution; the runtime's approval callback (composition root)
 * applies them in-place to the live `args` record so the executor's
 * commit phase sees the user's edits.
 */

import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';

import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { RuntimePool } from '@/web/runtime/runtime-pool';
import type { ChatRuntime } from '@/web/runtime/chat-runtime';
import {
  createSocketContext,
  createWsHandlers,
  type SocketContext,
  type WsDeps,
} from '@/web/server/ws';
import type { WSClientMessage } from '@/web/protocol/messages';

interface FakeSocket {
  data: SocketContext;
  sent: string[];
  closed: { code: number; reason: string } | null;
  send: (s: string) => void;
  close: (code: number, reason: string) => void;
}

function makeFakeSocket(): FakeSocket {
  return {
    data: createSocketContext(),
    sent: [],
    closed: null,
    send(text) {
      this.sent.push(text);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
  };
}

function makeDeps(): WsDeps {
  return {
    csrfToken: 'TOK',
    serverVersion: '0.1',
    workspaceRegistry: {} as WsDeps['workspaceRegistry'],
    sessionManager: {
      getMessages: () => [],
    } as unknown as WsDeps['sessionManager'],
    configManager: {
      update: () => ({}),
    } as unknown as WsDeps['configManager'],
    eventBus: new SessionEventBus(),
    approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
    runtimePool: new RuntimePool(),
    createRuntimeForSession: () => ({}) as ChatRuntime,
    applyProviderChange: async (req) => ({
      ok: true as const,
      backend: req.type,
      baseUrl: 'http://localhost',
      models: [],
      currentModel: '',
    }),
  };
}

async function dispatch(
  handlers: ReturnType<typeof createWsHandlers>,
  ws: FakeSocket,
  msg: WSClientMessage,
): Promise<void> {
  await handlers.onMessage(
    ws as unknown as ServerWebSocket<SocketContext>,
    JSON.stringify(msg),
  );
}

async function hello(deps: WsDeps): Promise<{
  h: ReturnType<typeof createWsHandlers>;
  ws: FakeSocket;
}> {
  const h = createWsHandlers(deps);
  const ws = makeFakeSocket();
  await dispatch(h, ws, { type: 'hello', csrf: 'TOK', clientId: 'c1' });
  ws.sent.length = 0;
  return { h, ws };
}

describe('approval_response.modifiedArgs', () => {
  test('approval without modifiedArgs resolves with approved only', async () => {
    const deps = makeDeps();
    const { h, ws } = await hello(deps);
    const pending = deps.approvalBridge.request(
      'tc-1',
      'write_file',
      { path: 'a.ts', content: 'original' },
      null,
      's1',
    );
    await dispatch(h, ws, {
      type: 'approval_response',
      toolCallId: 'tc-1',
      approved: true,
    });
    await expect(pending).resolves.toEqual({ approved: true });
  });

  test('modifiedArgs round-trips through bridge resolution', async () => {
    const deps = makeDeps();
    const { h, ws } = await hello(deps);
    const pending = deps.approvalBridge.request(
      'tc-2',
      'write_file',
      { path: 'src/index.ts', content: 'OLD' },
      null,
      's1',
    );
    await dispatch(h, ws, {
      type: 'approval_response',
      toolCallId: 'tc-2',
      approved: true,
      modifiedArgs: { content: 'EDITED BY USER' },
    });
    await expect(pending).resolves.toEqual({
      approved: true,
      modifiedArgs: { content: 'EDITED BY USER' },
    });
  });

  test('rejection with modifiedArgs still resolves as rejected', async () => {
    const deps = makeDeps();
    const { h, ws } = await hello(deps);
    const pending = deps.approvalBridge.request(
      'tc-3',
      'write_file',
      { path: 'a.ts' },
      null,
      's1',
    );
    await dispatch(h, ws, {
      type: 'approval_response',
      toolCallId: 'tc-3',
      approved: false,
      modifiedArgs: { content: 'ignored' },
    });
    await expect(pending).resolves.toEqual({
      approved: false,
      modifiedArgs: { content: 'ignored' },
    });
  });

  test('approval callback applies modifiedArgs to live args in-place', async () => {
    // Simulates the composition-root wiring: the executor's approval
    // callback receives a live args record; the runtime applies any
    // modifiedArgs from the SPA so the tool's commit phase observes
    // the user's edits.
    const bridge = new ApprovalBridge({ timeoutMs: 60_000 });
    const liveArgs: Record<string, unknown> = {
      path: 'foo.ts',
      content: 'original content',
    };
    const approvalCallback = async (
      _name: string,
      args: Record<string, unknown>,
    ): Promise<boolean> => {
      const resolution = await bridge.request(
        'tc-live',
        'write_file',
        args,
        null,
        'sess-1',
      );
      if (
        resolution.approved &&
        resolution.modifiedArgs !== undefined
      ) {
        for (const k of Object.keys(resolution.modifiedArgs)) {
          args[k] = resolution.modifiedArgs[k];
        }
      }
      return resolution.approved;
    };

    const pending = approvalCallback('write_file', liveArgs);
    // Simulate the WS handler firing on receipt of the response.
    bridge.resolve('tc-live', true, { content: 'NEW EDITED CONTENT' });
    const approved = await pending;

    expect(approved).toBe(true);
    expect(liveArgs.content).toBe('NEW EDITED CONTENT');
    // Untouched keys preserved.
    expect(liveArgs.path).toBe('foo.ts');
  });

  test('schema rejects malformed modifiedArgs (not an object)', async () => {
    const deps = makeDeps();
    const { h, ws } = await hello(deps);
    // Bad shape — modifiedArgs is a string, not a record.
    await dispatch(
      h,
      ws,
      {
        type: 'approval_response',
        toolCallId: 'tc-bad',
        approved: true,
        // Casting through unknown because the WSClientMessage union
        // disallows this at compile time — we want to confirm the Zod
        // runtime guard catches it.
        modifiedArgs: 'oops' as unknown as Record<string, unknown>,
      },
    );
    // Server emits a schema_invalid error frame; the bridge never sees
    // a resolve call.
    const types = ws.sent.map((s) => (JSON.parse(s) as { type: string }).type);
    expect(types).toContain('error');
  });
});
