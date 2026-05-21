/**
 * High-level MCP client.
 *
 * Wraps a `McpTransport` with:
 *   - JSON-RPC request/response correlation via a `Map<id, pending>`
 *   - `initialize` handshake (sends client info + capabilities, awaits
 *     `initialize` result, follows up with `notifications/initialized`)
 *   - thin wrappers for `tools/list` and `tools/call`
 *   - state machine: `idle → connecting → ready → errored | closed`
 *   - lightweight event emitter so the registry can subscribe to state
 *     changes and listChanged notifications.
 *
 * Reconnection is the caller's responsibility (the registry decides
 * whether to restart). The client signals `closed`; the registry rebuilds
 * a new transport + client around it.
 */

import {
  MCP_PROTOCOL_VERSION,
  McpCallResultSchema,
  McpInitializeResultSchema,
  McpListToolsResultSchema,
  isResponse,
  makeNotification,
  makeRequest,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type McpCallResult,
  type McpClientCapabilities,
  type McpClientInfo,
  type McpInitializeResult,
  type McpToolDef,
} from './types';
import type { McpTransport } from './transport-stdio';

export type McpClientState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'errored'
  | 'closed';

export type McpClientEvent =
  | 'state-change'
  | 'tool-list-changed'
  | 'error'
  | 'close';

export interface McpClientOpts {
  /** Human-readable server name — used for diagnostics + tool prefixes. */
  name: string;
  transport: McpTransport;
  clientInfo?: McpClientInfo;
  capabilities?: McpClientCapabilities;
  /**
   * Optional per-request timeout (ms). Default 30s. Used for every
   * outbound call (initialize, tools/list, tools/call).
   */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
}

/** Type guard — does a JSON-RPC response carry an error block? */
function isErrorResponse(
  msg: JsonRpcResponse,
): msg is JsonRpcResponse & { error: { code: number; message: string } } {
  return (msg as { error?: unknown }).error !== undefined;
}

export class MCPClient {
  private readonly opts: McpClientOpts;
  private readonly transport: McpTransport;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private _state: McpClientState = 'idle';
  private lastError: Error | null = null;
  private listeners = new Map<McpClientEvent, Array<(payload: unknown) => void>>();
  private unsubscribeMessage: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private unsubscribeClose: (() => void) | null = null;
  private serverInfo: McpInitializeResult | null = null;

  constructor(opts: McpClientOpts) {
    this.opts = opts;
    this.transport = opts.transport;
  }

  get name(): string {
    return this.opts.name;
  }

  get state(): McpClientState {
    return this._state;
  }

  get error(): Error | null {
    return this.lastError;
  }

  get serverDescription(): McpInitializeResult | null {
    return this.serverInfo;
  }

  /**
   * Spawn the transport, send `initialize`, then send the matching
   * `notifications/initialized`. Resolves with the server's response.
   */
  async start(): Promise<McpInitializeResult> {
    if (this._state === 'ready' && this.serverInfo !== null) return this.serverInfo;
    this.setState('connecting');
    this.wireTransport();
    try {
      await this.transport.start();
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      this.setError(err);
      throw err;
    }

    const clientInfo: McpClientInfo = this.opts.clientInfo ?? {
      name: 'localcode',
      version: '0.1.0',
    };
    const capabilities: McpClientCapabilities = this.opts.capabilities ?? {
      tools: {},
    };

    let initResult: McpInitializeResult;
    try {
      const raw = await this.callRaw('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities,
        clientInfo,
      });
      const parsed = McpInitializeResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `initialize: invalid server response: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      initResult = parsed.data;
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      this.setError(err);
      throw err;
    }
    this.serverInfo = initResult;
    // Follow up with the required `initialized` notification.
    try {
      await this.transport.send(makeNotification('notifications/initialized'));
    } catch {
      // Non-fatal — some servers tolerate missing notifications.
    }
    this.setState('ready');
    return initResult;
  }

  /** List tools. Returns the parsed array. */
  async listTools(): Promise<McpToolDef[]> {
    if (this._state !== 'ready') {
      throw new Error(`listTools: client not ready (state=${this._state})`);
    }
    const raw = await this.callRaw('tools/list', {});
    const parsed = McpListToolsResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `tools/list: invalid response: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    return [...parsed.data.tools];
  }

  /** Invoke a tool. Returns the parsed `McpCallResult`. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    if (this._state !== 'ready') {
      throw new Error(`callTool: client not ready (state=${this._state})`);
    }
    const raw = await this.callRaw('tools/call', {
      name,
      arguments: args,
    });
    const parsed = McpCallResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `tools/call: invalid response: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    return parsed.data;
  }

  on(event: McpClientEvent, listener: (payload: unknown) => void): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return () => {
      const current = this.listeners.get(event);
      if (current === undefined) return;
      const next = current.filter((l) => l !== listener);
      if (next.length === 0) {
        this.listeners.delete(event);
      } else {
        this.listeners.set(event, next);
      }
    };
  }

  /**
   * Shut down the client. Rejects every in-flight request with a
   * `closed` error so callers don't hang forever.
   */
  async close(): Promise<void> {
    if (this._state === 'closed') return;
    this.setState('closed');
    for (const [, pending] of this.pending) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(new Error('MCPClient closed before response arrived'));
    }
    this.pending.clear();
    this.unsubscribeMessage?.();
    this.unsubscribeError?.();
    this.unsubscribeClose?.();
    this.unsubscribeMessage = null;
    this.unsubscribeError = null;
    this.unsubscribeClose = null;
    try {
      await this.transport.close();
    } catch {
      /* swallow — transport already torn down */
    }
  }

  // ---------- Internals ----------

  private wireTransport(): void {
    this.unsubscribeMessage = this.transport.onMessage((msg) => {
      this.onMessage(msg);
    });
    this.unsubscribeError = this.transport.onError((err) => {
      this.lastError = err;
      this.emit('error', err);
    });
    this.unsubscribeClose = this.transport.onClose((code, reason) => {
      // The server died. Reject every in-flight call.
      for (const [, pending] of this.pending) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(new Error(`transport closed: ${reason}`));
      }
      this.pending.clear();
      if (this._state !== 'closed') {
        this.setState(this.lastError !== null ? 'errored' : 'closed');
      }
      this.emit('close', { code, reason });
    });
  }

  private setState(next: McpClientState): void {
    if (this._state === next) return;
    this._state = next;
    this.emit('state-change', next);
  }

  private setError(err: Error): void {
    this.lastError = err;
    this.setState('errored');
    this.emit('error', err);
  }

  private emit(event: McpClientEvent, payload: unknown): void {
    const list = this.listeners.get(event);
    if (list === undefined) return;
    for (const h of list) {
      try {
        h(payload);
      } catch {
        /* swallow — listener bugs must not crash the client */
      }
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const id = msg.id;
      // Our outbound ids are always strings.
      const idStr = typeof id === 'string' ? id : String(id);
      const pending = this.pending.get(idStr);
      if (pending === undefined) return;
      this.pending.delete(idStr);
      if (pending.timer !== null) clearTimeout(pending.timer);
      if (isErrorResponse(msg)) {
        pending.reject(
          new Error(
            `${pending.method} failed: ${msg.error.code} ${msg.error.message}`,
          ),
        );
        return;
      }
      pending.resolve((msg as { result: unknown }).result);
      return;
    }
    // Notification or request from server.
    const m = msg as { method?: string };
    if (m.method === 'notifications/tools/list_changed') {
      this.emit('tool-list-changed', undefined);
    }
    // We don't implement reverse-direction requests in v1 — silently drop.
  }

  private async callRaw(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = String(this.nextId++);
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const req = makeRequest(id, method, params);
      this.transport.send(req).catch((cause) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
    });
  }
}
