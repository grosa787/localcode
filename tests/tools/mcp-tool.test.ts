/**
 * Tests for src/tools/mcp-tool.ts
 *
 * Uses a manually constructed MCPRegistry with injected fake transports
 * so no real subprocesses are spawned and no network calls are made.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MCPRegistry, setProcessMcpRegistry } from '@/mcp/registry';
import type { McpServerConfig } from '@/types/global';
import {
  buildMcpToolHandlerMap,
  buildMcpToolSchema,
  mcpToolName,
} from '@/tools/mcp-tool';

// ---------- Fake transport helpers ----------

/**
 * Build a minimal fake registry slot by directly calling internal
 * methods.  We use the public API: construct, start() with a fake
 * transport via opts.spawn / opts.fetchImpl injected.
 *
 * Rather than fighting with the transport layer, we test by driving the
 * registry through a controlled HTTP transport whose fetch is injected.
 */

function makeJsonRpc(id: string, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/**
 * Construct a registry whose single HTTP server returns the given tool
 * list from tools/list and the given result from tools/call.
 */
function makeRegistryWithHttpServer(
  serverName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
  callResult: { content: Array<{ type: 'text'; text: string }>; isError?: boolean },
  opts: { simulateCallError?: boolean } = {},
): MCPRegistry {
  let callCount = 0;

  const fakeFetch = async (
    _url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const method = body['method'] as string | undefined;
    const id = body['id'] as string;

    if (method === 'initialize') {
      const result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' },
      };
      return new Response(makeJsonRpc(id, result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'notifications/initialized') {
      return new Response(makeJsonRpc(id, {}), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'tools/list') {
      return new Response(
        makeJsonRpc(id, { tools }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (method === 'tools/call') {
      callCount++;
      if (opts.simulateCallError === true) {
        throw new Error('simulated network error');
      }
      return new Response(
        makeJsonRpc(id, callResult),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };

  const reg = new MCPRegistry({ fetchImpl: fakeFetch as unknown as typeof fetch });
  return reg;
}

// ---------- Helper: boot a registry and wait for ready ----------

async function bootRegistry(
  reg: MCPRegistry,
  serverName: string,
): Promise<MCPRegistry> {
  const cfg: McpServerConfig = {
    type: 'http',
    url: 'http://localhost:9999/mcp',
  };
  await reg.start({ [serverName]: cfg });
  return reg;
}

// ---------- Tests ----------

describe('mcpToolName', () => {
  test('formats with double-underscore separators', () => {
    expect(mcpToolName('github', 'search_repos')).toBe('mcp__github__search_repos');
  });

  test('handles server names with underscores', () => {
    expect(mcpToolName('my_server', 'do_thing')).toBe('mcp__my_server__do_thing');
  });
});

describe('buildMcpToolHandlerMap', () => {
  let reg: MCPRegistry;

  afterEach(async () => {
    await reg.dispose();
  });

  test('produces one handler per registered tool', async () => {
    reg = makeRegistryWithHttpServer(
      'fs',
      [
        { name: 'read_resource', description: 'Read a resource' },
        { name: 'list_resources', description: 'List resources' },
      ],
      { content: [{ type: 'text', text: 'ok' }] },
    );
    await bootRegistry(reg, 'fs');

    const map = buildMcpToolHandlerMap(reg);
    expect(Object.keys(map)).toContain('mcp__fs__read_resource');
    expect(Object.keys(map)).toContain('mcp__fs__list_resources');
    expect(Object.keys(map)).toHaveLength(2);
  });

  test('calling a handler invokes registry.callTool with correct args', async () => {
    const callArgs: Array<{ serverName: string; toolName: string; args: Record<string, unknown> }> = [];
    const fakeFetch = async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      const method = body['method'] as string | undefined;
      const id = body['id'] as string;

      if (method === 'initialize') {
        return new Response(makeJsonRpc(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'myserver', version: '1.0' },
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (method === 'tools/list') {
        return new Response(makeJsonRpc(id, {
          tools: [{ name: 'greet', description: 'Greet someone' }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (method === 'tools/call') {
        const params = body['params'] as Record<string, unknown> | undefined;
        callArgs.push({
          serverName: 'myserver',
          toolName: (params?.['name'] as string) ?? '',
          args: (params?.['arguments'] as Record<string, unknown>) ?? {},
        });
        return new Response(makeJsonRpc(id, {
          content: [{ type: 'text', text: 'Hello, world!' }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };

    reg = new MCPRegistry({ fetchImpl: fakeFetch as unknown as typeof fetch });
    await bootRegistry(reg, 'myserver');

    const map = buildMcpToolHandlerMap(reg);
    const handler = map['mcp__myserver__greet'];
    expect(handler).toBeDefined();

    const ctx = { projectRoot: '/tmp', dangerouslyAllowAll: false };
    const result = await handler!.preview({ name: 'Alice' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toBe('Hello, world!');
    expect(callArgs).toHaveLength(1);
    expect(callArgs[0]?.toolName).toBe('greet');
    expect(callArgs[0]?.args).toEqual({ name: 'Alice' });
  });

  test('an error from callTool produces { success: false }', async () => {
    reg = makeRegistryWithHttpServer(
      'broken',
      [{ name: 'do_thing' }],
      { content: [] },
      { simulateCallError: true },
    );
    await bootRegistry(reg, 'broken');

    const map = buildMcpToolHandlerMap(reg);
    const handler = map['mcp__broken__do_thing'];
    expect(handler).toBeDefined();

    const ctx = { projectRoot: '/tmp', dangerouslyAllowAll: false };
    const result = await handler!.preview({}, ctx);

    expect(result.success).toBe(false);
    expect(result.output).toContain('simulated network error');
  });

  test('isError=true from callTool produces { success: false }', async () => {
    reg = makeRegistryWithHttpServer(
      'srv',
      [{ name: 'fail_tool' }],
      { content: [{ type: 'text', text: 'something went wrong' }], isError: true },
    );
    await bootRegistry(reg, 'srv');

    const map = buildMcpToolHandlerMap(reg);
    const handler = map['mcp__srv__fail_tool'];
    expect(handler).toBeDefined();

    const ctx = { projectRoot: '/tmp', dangerouslyAllowAll: false };
    const result = await handler!.preview({}, ctx);

    expect(result.success).toBe(false);
    expect(result.output).toBe('something went wrong');
  });

  test('tools from errored servers are not exposed', async () => {
    // Build a registry where the server fails to connect.
    const fakeFetch = async (): Promise<Response> => {
      throw new Error('connection refused');
    };
    reg = new MCPRegistry({ fetchImpl: fakeFetch as unknown as typeof fetch });
    const cfg: McpServerConfig = { type: 'http', url: 'http://localhost:9999/mcp' };
    // start() catches the error — server ends up in errored state
    await reg.start({ errored_srv: cfg });

    const servers = reg.getServers();
    const srv = servers.find((s) => s.name === 'errored_srv');
    // Server is errored
    expect(srv?.state).toBe('errored');

    const map = buildMcpToolHandlerMap(reg);
    // No tools from errored servers
    expect(Object.keys(map)).toHaveLength(0);
  });

  test('MCP tool handler has only preview (no commit)', async () => {
    reg = makeRegistryWithHttpServer(
      'pure',
      [{ name: 'fetch' }],
      { content: [{ type: 'text', text: 'result' }] },
    );
    await bootRegistry(reg, 'pure');

    const map = buildMcpToolHandlerMap(reg);
    const handler = map['mcp__pure__fetch'];
    expect(handler).toBeDefined();
    expect(handler!.commit).toBeUndefined();
  });
});

describe('buildMcpToolSchema', () => {
  let reg: MCPRegistry;

  afterEach(async () => {
    await reg.dispose();
  });

  test('returns parallel entries with namespaced names', async () => {
    reg = makeRegistryWithHttpServer(
      'github',
      [
        {
          name: 'search_repos',
          description: 'Search GitHub repositories',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              limit: { type: 'number', description: 'Max results' },
            },
            required: ['query'],
          },
        },
      ],
      { content: [{ type: 'text', text: '' }] },
    );
    await bootRegistry(reg, 'github');

    const schemas = buildMcpToolSchema(reg);
    expect(schemas).toHaveLength(1);

    const schema = schemas[0];
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('function');
    expect(schema!.function.name).toBe('mcp__github__search_repos');
    expect(schema!.function.description).toBe('Search GitHub repositories');
    expect(schema!.function.parameters.type).toBe('object');
    expect(schema!.function.parameters.properties['query']).toBeDefined();
    expect(schema!.function.parameters.required).toContain('query');
  });

  test('falls back to a generated description when tool has none', async () => {
    reg = makeRegistryWithHttpServer(
      'srv',
      [{ name: 'no_desc' }],
      { content: [{ type: 'text', text: '' }] },
    );
    await bootRegistry(reg, 'srv');

    const schemas = buildMcpToolSchema(reg);
    expect(schemas[0]?.function.description).toBeTruthy();
  });

  test('tools from errored servers are not in schema', async () => {
    const fakeFetch = async (): Promise<Response> => {
      throw new Error('no connection');
    };
    reg = new MCPRegistry({ fetchImpl: fakeFetch as unknown as typeof fetch });
    await reg.start({ bad: { type: 'http', url: 'http://x' } });

    const schemas = buildMcpToolSchema(reg);
    expect(schemas).toHaveLength(0);
  });
});

describe('name collision policy', () => {
  test('MCP handler map key does not collide with built-in names', async () => {
    // Built-ins use plain underscores (e.g. read_file).
    // MCP names use mcp__<srv>__<tool> — structurally distinct.
    const reg = makeRegistryWithHttpServer(
      'myserver',
      [{ name: 'read_file' }], // same base name as built-in
      { content: [{ type: 'text', text: 'mcp result' }] },
    );
    await bootRegistry(reg, 'myserver');

    const map = buildMcpToolHandlerMap(reg);
    // The MCP key is namespaced, not 'read_file'
    expect(map['read_file']).toBeUndefined();
    expect(map['mcp__myserver__read_file']).toBeDefined();

    await reg.dispose();
  });
});
