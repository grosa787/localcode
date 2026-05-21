/**
 * LspClient tests — exercise the JSON-RPC framing, request/response
 * correlation, error propagation, and notification dispatch using a
 * scripted fake child process. No real LSP server is spawned.
 */

import { describe, expect, test } from 'bun:test';

import { LspClient, pathToUri, uriToPath } from '@/ontology/lsp-client';
import type { SpawnedChild } from '@/mcp/transport-stdio';

interface FakeChildController {
  child: SpawnedChild;
  /** Push a single frame from the server to the client. */
  serverSend: (json: string) => void;
  /** Collected raw frames written by the client (parsed payloads). */
  clientWrote: () => Array<Record<string, unknown>>;
  /** Trigger child exit. */
  exit: (code?: number) => void;
}

function makeFakeChild(): FakeChildController {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  const writtenChunks: Uint8Array[] = [];
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      writtenChunks.push(chunk);
    },
  });

  let exitResolve: ((value: number) => void) | null = null;
  const exited = new Promise<number>((res) => {
    exitResolve = res;
  });

  const child: SpawnedChild = {
    stdout,
    stderr,
    stdin,
    exited,
    pid: 42,
    kill: () => {
      if (exitResolve !== null) {
        exitResolve(0);
        exitResolve = null;
      }
    },
  };

  const encoder = new TextEncoder();
  const serverSend = (json: string): void => {
    const body = encoder.encode(json);
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
    const framed = new Uint8Array(header.byteLength + body.byteLength);
    framed.set(header, 0);
    framed.set(body, header.byteLength);
    stdoutController?.enqueue(framed);
  };

  const clientWrote = (): Array<Record<string, unknown>> => {
    const decoder = new TextDecoder('utf-8');
    let merged = new Uint8Array(0);
    for (const c of writtenChunks) {
      const next = new Uint8Array(merged.byteLength + c.byteLength);
      next.set(merged, 0);
      next.set(c, merged.byteLength);
      merged = next;
    }
    const text = decoder.decode(merged);
    const out: Array<Record<string, unknown>> = [];
    let cursor = 0;
    while (cursor < text.length) {
      const terminator = text.indexOf('\r\n\r\n', cursor);
      if (terminator === -1) break;
      const header = text.slice(cursor, terminator);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (m === null || m[1] === undefined) break;
      const len = Number.parseInt(m[1], 10);
      const start = terminator + 4;
      const json = text.slice(start, start + len);
      try {
        out.push(JSON.parse(json) as Record<string, unknown>);
      } catch {
        /* swallow malformed frames */
      }
      cursor = start + len;
    }
    return out;
  };

  return {
    child,
    serverSend,
    clientWrote,
    exit: (code = 0) => {
      if (exitResolve !== null) {
        exitResolve(code);
        exitResolve = null;
      }
    },
  };
}

describe('LspClient — handshake', () => {
  test('initialize handshake correlates request and response', async () => {
    const fake = makeFakeChild();
    const client = new LspClient({
      command: 'fake-lsp',
      spawn: () => fake.child,
    });

    // Reply to initialize as soon as it lands.
    setTimeout(() => {
      const frames = fake.clientWrote();
      const init = frames.find((f) => f['method'] === 'initialize');
      expect(init).toBeDefined();
      const id = init?.['id'] as number;
      fake.serverSend(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            capabilities: {},
            serverInfo: { name: 'fake', version: '1.0' },
          },
        }),
      );
    }, 10);

    await client.start();
    expect(client.rawInitializeResult).toBeDefined();
    await client.close();
  });
});

describe('LspClient — request correlation', () => {
  test('two concurrent requests get distinct ids and matching responses', async () => {
    const fake = makeFakeChild();
    const client = new LspClient({
      command: 'fake-lsp',
      spawn: () => fake.child,
    });

    // Auto-respond to anything by echoing id.
    const stop = setInterval(() => {
      const frames = fake.clientWrote();
      for (const f of frames) {
        if (f['id'] === undefined || f['method'] === undefined) continue;
        const id = f['id'] as number;
        if (id < 0) continue; // skip negative shutdown ids
        const method = f['method'] as string;
        if (method === 'initialize') {
          fake.serverSend(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: { capabilities: {}, serverInfo: { name: 'x', version: '1' } },
            }),
          );
        } else {
          fake.serverSend(
            JSON.stringify({ jsonrpc: '2.0', id, result: { echoed: method, id } }),
          );
        }
      }
    }, 5);

    await client.start();
    const [a, b] = await Promise.all([
      client.request('textDocument/documentSymbol', {}),
      client.request('textDocument/references', {}),
    ]);
    clearInterval(stop);

    expect((a as { echoed: string }).echoed).toBe('textDocument/documentSymbol');
    expect((b as { echoed: string }).echoed).toBe('textDocument/references');
    expect((a as { id: number }).id).not.toBe((b as { id: number }).id);

    await client.close();
  });
});

describe('LspClient — error responses reject', () => {
  test('error response rejects the pending promise', async () => {
    const fake = makeFakeChild();
    const client = new LspClient({
      command: 'fake-lsp',
      spawn: () => fake.child,
    });

    const respond = setInterval(() => {
      for (const f of fake.clientWrote()) {
        if (f['method'] === 'initialize' && typeof f['id'] === 'number') {
          fake.serverSend(
            JSON.stringify({
              jsonrpc: '2.0',
              id: f['id'],
              result: { capabilities: {}, serverInfo: { name: 'x', version: '1' } },
            }),
          );
        } else if (typeof f['id'] === 'number' && f['id'] >= 1 && f['method'] !== 'initialize') {
          fake.serverSend(
            JSON.stringify({
              jsonrpc: '2.0',
              id: f['id'],
              error: { code: -32603, message: 'boom' },
            }),
          );
        }
      }
    }, 5);

    await client.start();
    await expect(
      client.request('textDocument/documentSymbol', {}),
    ).rejects.toThrow(/boom/);

    clearInterval(respond);
    await client.close();
  });
});

describe('URI helpers', () => {
  test('round-trips a unix path', () => {
    const uri = pathToUri('/abs/path/file.ts');
    expect(uri.startsWith('file:///abs')).toBe(true);
    expect(uriToPath(uri)).toBe('/abs/path/file.ts');
  });

  test('encodes spaces', () => {
    const uri = pathToUri('/has space/x.ts');
    expect(uri).toContain('%20');
    expect(uriToPath(uri)).toBe('/has space/x.ts');
  });
});
