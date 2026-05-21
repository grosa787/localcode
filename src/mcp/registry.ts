/**
 * Process-wide MCP registry.
 *
 * Owns a `Map<serverName, ServerSlot>` and handles:
 *   - boot: read `cfg.mcpServers`, spawn each entry, run `initialize` +
 *     `tools/list`.
 *   - tool catalogue: aggregate every server's tools into a flat list of
 *     `McpRegistryTool` entries that the host can turn into LocalCode
 *     `ToolHandler`s via `src/tools/mcp-tool.ts`.
 *   - lifecycle controls: `restart(name)`, `dispose()`.
 *
 * Servers that fail to start (or to list tools) are recorded with their
 * error message; the registry doesn't throw — the host displays the
 * failure via the REST endpoint.
 */

import { MCPClient, type McpClientState } from './client';
import { StdioTransport, type SpawnFn } from './transport-stdio';
import { HttpTransport } from './transport-http';
import type { McpServerConfig } from '@/types/global';
import type { McpToolDef, McpCallResult, McpServerInfo } from './types';

export type McpServerStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'errored'
  | 'closed';

export interface McpRegistryServerView {
  name: string;
  type: 'stdio' | 'http';
  state: McpServerStatus;
  toolCount: number;
  tools: string[];
  serverInfo: McpServerInfo | null;
  error: string | null;
}

export interface McpRegistryTool {
  serverName: string;
  tool: McpToolDef;
}

interface ServerSlot {
  name: string;
  config: McpServerConfig;
  client: MCPClient | null;
  tools: McpToolDef[];
  status: McpServerStatus;
  error: string | null;
  serverInfo: McpServerInfo | null;
}

export interface McpRegistryOpts {
  /** Test-only spawn injection. Forwarded to every stdio transport. */
  spawn?: SpawnFn;
  /** Test-only fetch injection. Forwarded to every http transport. */
  fetchImpl?: typeof fetch;
  /**
   * Optional callback invoked when any server's status changes — used
   * by the host to re-render the status panel.
   */
  onChange?: (servers: ReadonlyArray<McpRegistryServerView>) => void;
  /** Optional callback when a server publishes a new tool catalogue. */
  onToolsChanged?: (servers: ReadonlyArray<McpRegistryServerView>) => void;
  /** Optional diagnostics sink for transport stderr. */
  onLog?: (entry: { server: string; level: 'info' | 'error'; message: string }) => void;
}

function buildClient(
  name: string,
  config: McpServerConfig,
  opts: McpRegistryOpts,
): MCPClient {
  if (config.type === 'stdio') {
    if (typeof config.command !== 'string' || config.command.length === 0) {
      throw new Error(`MCP server "${name}": stdio transport requires "command"`);
    }
    const transport = new StdioTransport({
      command: config.command,
      args: config.args ?? [],
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.env !== undefined ? { env: config.env } : {}),
      onStderr: (line) => {
        opts.onLog?.({ server: name, level: 'info', message: line });
      },
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    });
    return new MCPClient({ name, transport });
  }
  // HTTP transport.
  if (typeof config.url !== 'string' || config.url.length === 0) {
    throw new Error(`MCP server "${name}": http transport requires "url"`);
  }
  const transport = new HttpTransport({
    url: config.url,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return new MCPClient({ name, transport });
}

function clientStateToStatus(s: McpClientState): McpServerStatus {
  switch (s) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return 'connecting';
    case 'ready':
      return 'ready';
    case 'errored':
      return 'errored';
    case 'closed':
      return 'closed';
    default:
      return 'idle';
  }
}

function isStdio(cfg: McpServerConfig): cfg is McpServerConfig & {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
} {
  return cfg.type === 'stdio';
}

export class MCPRegistry {
  private slots = new Map<string, ServerSlot>();
  private readonly opts: McpRegistryOpts;
  private disposed = false;

  constructor(opts: McpRegistryOpts = {}) {
    this.opts = opts;
  }

  /**
   * Load every server in `mcpServers` (key = server name). Returns when
   * each server has either reached `ready` or `errored`. Safe to call
   * with an empty map — does nothing and returns immediately.
   */
  async start(mcpServers: Record<string, McpServerConfig>): Promise<void> {
    if (this.disposed) {
      throw new Error('MCPRegistry: already disposed');
    }
    const names = Object.keys(mcpServers);
    if (names.length === 0) return;
    await Promise.all(
      names.map(async (name) => {
        const cfg = mcpServers[name];
        if (cfg === undefined) return;
        await this.startSlot(name, cfg);
      }),
    );
  }

  /** Restart a single server by name. Idempotent. */
  async restart(name: string): Promise<void> {
    const slot = this.slots.get(name);
    if (slot === undefined) {
      throw new Error(`MCP server "${name}" is not registered`);
    }
    if (slot.client !== null) {
      try {
        await slot.client.close();
      } catch {
        /* swallow */
      }
    }
    slot.client = null;
    slot.tools = [];
    slot.error = null;
    slot.serverInfo = null;
    slot.status = 'idle';
    await this.startSlot(name, slot.config);
  }

  /** Shut down every server. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const closes = Array.from(this.slots.values()).map(async (slot) => {
      if (slot.client !== null) {
        try {
          await slot.client.close();
        } catch {
          /* swallow */
        }
      }
      slot.status = 'closed';
    });
    await Promise.all(closes);
    this.slots.clear();
  }

  /** Snapshot of every server's current state — used by REST + UI. */
  getServers(): McpRegistryServerView[] {
    return Array.from(this.slots.values())
      .map<McpRegistryServerView>((slot) => ({
        name: slot.name,
        type: slot.config.type,
        state: slot.status,
        toolCount: slot.tools.length,
        tools: slot.tools.map((t) => t.name),
        serverInfo: slot.serverInfo,
        error: slot.error,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Flat list of every (server, tool) pair across the registry. */
  getAllTools(): McpRegistryTool[] {
    const out: McpRegistryTool[] = [];
    for (const slot of this.slots.values()) {
      for (const tool of slot.tools) {
        out.push({ serverName: slot.name, tool });
      }
    }
    return out;
  }

  /**
   * Invoke a tool on a named server. The mcp-tool adapter calls this.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const slot = this.slots.get(serverName);
    if (slot === undefined) {
      throw new Error(`MCP server "${serverName}" is not registered`);
    }
    if (slot.client === null || slot.status !== 'ready') {
      throw new Error(
        `MCP server "${serverName}" is not ready (status=${slot.status})`,
      );
    }
    return slot.client.callTool(toolName, args);
  }

  // ---------- internals ----------

  private async startSlot(name: string, config: McpServerConfig): Promise<void> {
    const slot: ServerSlot = this.slots.get(name) ?? {
      name,
      config,
      client: null,
      tools: [],
      status: 'idle',
      error: null,
      serverInfo: null,
    };
    slot.config = config;
    slot.status = 'connecting';
    slot.error = null;
    this.slots.set(name, slot);
    this.notify();

    const client = buildClient(name, config, this.opts);
    slot.client = client;

    // Track state via the client's events so a transport-level drop
    // updates the registry view without polling.
    client.on('state-change', (s) => {
      const newStatus = clientStateToStatus(s as McpClientState);
      slot.status = newStatus;
      if (newStatus === 'errored' || newStatus === 'closed') {
        slot.tools = [];
      }
      this.notify();
    });
    client.on('error', (err) => {
      const e = err as Error;
      slot.error = e instanceof Error ? e.message : String(e);
      this.notify();
    });
    client.on('tool-list-changed', () => {
      void this.refreshTools(slot);
    });

    try {
      const initResult = await client.start();
      slot.serverInfo = initResult.serverInfo;
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      slot.error = err.message;
      slot.status = 'errored';
      this.notify();
      return;
    }

    await this.refreshTools(slot);
  }

  private async refreshTools(slot: ServerSlot): Promise<void> {
    if (slot.client === null) return;
    try {
      const tools = await slot.client.listTools();
      slot.tools = tools;
      slot.status = 'ready';
      slot.error = null;
      this.notify(true);
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      slot.error = `tools/list failed: ${err.message}`;
      slot.status = 'errored';
      this.notify();
    }
  }

  private notify(toolsChanged = false): void {
    const view = this.getServers();
    try {
      this.opts.onChange?.(view);
    } catch {
      /* swallow */
    }
    if (toolsChanged) {
      try {
        this.opts.onToolsChanged?.(view);
      } catch {
        /* swallow */
      }
    }
  }
}

// ---------- Process-wide singleton ----------

let processWide: MCPRegistry | null = null;

/**
 * Lazily-constructed process-wide registry. The host (app.tsx + web
 * runtime) bootstraps the singleton on first config read.
 *
 * Tests should NOT call this — they construct a fresh `new MCPRegistry`
 * to avoid leaking state across test files.
 */
export function getProcessMcpRegistry(): MCPRegistry {
  if (processWide === null) processWide = new MCPRegistry();
  return processWide;
}

/** Replace the process-wide singleton (host bootstrap; test teardown). */
export function setProcessMcpRegistry(reg: MCPRegistry | null): void {
  processWide = reg;
}
