/**
 * Minimal Streamable HTTP transport for MCP.
 *
 * v1 scope: each request goes out as a POST with `Content-Type:
 * application/json`. The response is JSON (single message) or
 * `text/event-stream` (SSE) where each `data:` line is a JSON-RPC
 * message. We surface every parsed message via `onMessage` exactly like
 * the stdio transport.
 *
 * This implementation is intentionally limited — most real-world MCP
 * deployments use stdio. We ship HTTP best-effort so the registry has
 * a working code path when a user configures `type = "http"`.
 */

import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
} from './types';
import { tryParseMessage } from './types';
import type { McpTransport, TransportState } from './transport-stdio';

export interface HttpTransportOpts {
  /** Endpoint URL — e.g. `http://localhost:9876/mcp`. */
  url: string;
  /** Optional extra headers (auth, etc.) sent with every request. */
  headers?: Record<string, string>;
  /**
   * Pluggable `fetch`. Defaults to `globalThis.fetch`. Tests inject
   * a stub here.
   */
  fetchImpl?: typeof fetch;
}

/**
 * HTTP transport. Round-trip semantics: `send` POSTs the payload and
 * dispatches each parsed JSON-RPC message (single JSON body or SSE
 * stream) via `onMessage`.
 */
export class HttpTransport implements McpTransport {
  private readonly opts: HttpTransportOpts;
  private messageHandlers: Array<(msg: JsonRpcMessage) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];
  private closeHandlers: Array<(code: number, reason: string) => void> = [];
  private _state: TransportState = 'starting';

  constructor(opts: HttpTransportOpts) {
    this.opts = opts;
  }

  get state(): TransportState {
    return this._state;
  }

  async start(): Promise<void> {
    this._state = 'open';
  }

  async send(payload: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (this._state !== 'open') {
      throw new Error(`HttpTransport.send: not open (state=${this._state})`);
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.opts.headers ?? {}),
    };
    let response: Response;
    try {
      response = await fetchImpl(this.opts.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      this.emitError(err);
      throw err;
    }
    if (!response.ok) {
      // Notifications have no `id`; we surface the failure via the error
      // channel so callers see the upstream problem.
      const err = new Error(`HTTP ${response.status} ${response.statusText}`);
      this.emitError(err);
      // Don't throw — the client's request layer will still time out
      // waiting for the response, but a bad notification shouldn't
      // tear the transport down.
      if ((payload as JsonRpcRequest).id !== undefined) throw err;
      return;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/event-stream')) {
      await this.consumeSse(response);
      return;
    }
    // Treat anything else as a single JSON message.
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      this.emitError(err);
      throw err;
    }
    if (text.length === 0) return;
    const msg = tryParseMessage(text);
    if (msg !== null) this.dispatch(msg);
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.push(handler);
    return () => {
      this.errorHandlers = this.errorHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: (code: number, reason: string) => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }

  async close(): Promise<void> {
    if (this._state === 'closed') return;
    this._state = 'closed';
    for (const h of this.closeHandlers) {
      try {
        h(0, 'closed by client');
      } catch {
        /* swallow */
      }
    }
  }

  // ---------- internals ----------

  private dispatch(msg: JsonRpcMessage): void {
    for (const h of this.messageHandlers) {
      try {
        h(msg);
      } catch (cause) {
        this.emitError(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
      }
    }
  }

  private emitError(err: Error): void {
    for (const h of this.errorHandlers) {
      try {
        h(err);
      } catch {
        /* swallow */
      }
    }
  }

  private async consumeSse(response: Response): Promise<void> {
    const body = response.body;
    if (body === null) return;
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        buf += decoder.decode(value, { stream: true });
        // SSE events are separated by blank line; each event carries one
        // or more `data:` lines we concat then JSON.parse.
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const event = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          this.parseSseEvent(event);
          sep = buf.indexOf('\n\n');
        }
      }
      // Flush trailing event if any.
      if (buf.trim().length > 0) this.parseSseEvent(buf);
    } catch (cause) {
      this.emitError(
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* swallow */
      }
    }
  }

  private parseSseEvent(event: string): void {
    const lines = event.split('\n');
    const dataLines: string[] = [];
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith('data:')) {
        // Strip "data:" and one optional leading space.
        const rest = line.slice(5);
        dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest);
      }
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    const msg = tryParseMessage(payload);
    if (msg !== null) this.dispatch(msg);
  }
}
