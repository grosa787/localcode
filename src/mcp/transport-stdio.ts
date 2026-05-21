/**
 * JSON-RPC over stdio transport for MCP.
 *
 * Most MCP servers run as child processes that:
 *   - read newline-delimited JSON-RPC from stdin
 *   - write newline-delimited JSON-RPC to stdout
 *   - log diagnostics on stderr
 *
 * This module spawns the server via `Bun.spawn`, drains stdout through a
 * newline parser, dispatches each parsed message to subscribed handlers,
 * and pipes stderr to a diagnostics listener (caller-supplied).
 *
 * Failures (spawn error, EOF, write error) are surfaced via the `onClose`
 * / `onError` listeners. The transport never throws asynchronously after
 * `start()` resolves — callers attach listeners and react.
 */

import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
} from './types';
import { tryParseMessage } from './types';

/**
 * Lifecycle states. Mirrors WebSocket-style semantics so consumers can
 * reason about the connection without peeking at internals.
 */
export type TransportState = 'starting' | 'open' | 'closed' | 'errored';

/** Shared transport interface. Both stdio and HTTP transports satisfy this. */
export interface McpTransport {
  start(): Promise<void>;
  send(payload: JsonRpcRequest | JsonRpcNotification): Promise<void>;
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void;
  onError(handler: (err: Error) => void): () => void;
  onClose(handler: (code: number, reason: string) => void): () => void;
  close(): Promise<void>;
  readonly state: TransportState;
}

/** Minimal abstraction for a child process so tests can inject a fake. */
export interface SpawnedChild {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  stdin: WritableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal?: number | string) => void;
  pid: number;
}

/** Argv-only spawn options the transport feeds to its `SpawnFn`. */
export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Pluggable spawn signature. Production callers leave it unset to use
 * the real `Bun.spawn`. Tests pass a fake that scripts I/O.
 */
export type SpawnFn = (cmd: readonly string[], opts: SpawnOpts) => SpawnedChild;

/** Options for `StdioTransport`. */
export interface StdioTransportOpts {
  /** Argv. `command` is `argv[0]` plus `args`. */
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Optional stderr sink. Receives every line written by the child to
   * stderr (newlines stripped). Default: drop.
   */
  onStderr?: (line: string) => void;
  /** Test injection point. Falls back to a real `Bun.spawn`. */
  spawn?: SpawnFn;
}

/** Real `Bun.spawn` wrapper. Throws when Bun isn't present (tests). */
function defaultSpawn(cmd: readonly string[], opts: SpawnOpts): SpawnedChild {
  const bun = (globalThis as unknown as {
    Bun?: {
      spawn: (
        c: readonly string[],
        o?: Record<string, unknown>,
      ) => SpawnedChild;
    };
  }).Bun;
  if (bun === undefined || typeof bun.spawn !== 'function') {
    throw new Error('Bun.spawn is unavailable — stdio transport requires Bun');
  }
  const bag: Record<string, unknown> = {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  };
  if (opts.cwd !== undefined) bag['cwd'] = opts.cwd;
  if (opts.env !== undefined) {
    // Filter out undefined values — Bun.spawn rejects them.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    bag['env'] = env;
  }
  return bun.spawn(cmd as string[], bag);
}

/**
 * Drain a `ReadableStream<Uint8Array>` of UTF-8 bytes, emitting one
 * callback per complete line (newline-stripped). Buffers partial lines
 * until the next read returns the rest.
 *
 * Exit conditions:
 *   - stream EOFs cleanly → flush trailing buffer (if non-empty) as a
 *     final line, then resolve.
 *   - reader rejects → emit `onError` and resolve (we don't propagate;
 *     the caller's onClose will fire when `exited` settles).
 */
export async function drainLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
  onError?: (err: Error) => void,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      buf += decoder.decode(value, { stream: true });
      let newlineIdx = buf.indexOf('\n');
      while (newlineIdx >= 0) {
        const line = buf.slice(0, newlineIdx);
        buf = buf.slice(newlineIdx + 1);
        // Strip trailing CR for cross-platform safety.
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (clean.length > 0) onLine(clean);
        newlineIdx = buf.indexOf('\n');
      }
    }
    // Flush any trailing partial line.
    const tail = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
    if (tail.length > 0) onLine(tail);
  } catch (cause) {
    if (onError !== undefined) {
      onError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Stdio transport. Encapsulates the child-process lifecycle and the
 * newline-delimited JSON-RPC framing.
 */
export class StdioTransport implements McpTransport {
  private readonly opts: StdioTransportOpts;
  private child: SpawnedChild | null = null;
  private encoder = new TextEncoder();
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private messageHandlers: Array<(msg: JsonRpcMessage) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];
  private closeHandlers: Array<(code: number, reason: string) => void> = [];
  private _state: TransportState = 'starting';
  private closeReason: { code: number; reason: string } | null = null;

  constructor(opts: StdioTransportOpts) {
    this.opts = opts;
  }

  get state(): TransportState {
    return this._state;
  }

  async start(): Promise<void> {
    if (this.child !== null) return;
    const spawn = this.opts.spawn ?? defaultSpawn;
    let child: SpawnedChild;
    try {
      const spawnOpts: SpawnOpts = {};
      if (this.opts.cwd !== undefined) spawnOpts.cwd = this.opts.cwd;
      if (this.opts.env !== undefined) spawnOpts.env = this.opts.env;
      child = spawn([this.opts.command, ...(this.opts.args ?? [])], spawnOpts);
    } catch (cause) {
      this._state = 'errored';
      const err = cause instanceof Error ? cause : new Error(String(cause));
      this.emitError(err);
      this.emitClose(-1, err.message);
      throw err;
    }
    this.child = child;
    this._state = 'open';

    // stdin writer: lazily acquired so write() can serialise concurrent
    // sends through a single Writer (Bun's WritableStream only allows one
    // outstanding writer at a time).
    if (child.stdin !== null) {
      this.stdinWriter = child.stdin.getWriter();
    }

    // Wire stdout → onMessage dispatch.
    void drainLines(
      child.stdout,
      (line) => {
        const msg = tryParseMessage(line);
        if (msg === null) return;
        for (const h of this.messageHandlers) {
          try {
            h(msg);
          } catch (cause) {
            // A subscriber blowing up shouldn't crash the transport.
            // Log to the error channel; subscribers can decide what to do.
            this.emitError(
              cause instanceof Error ? cause : new Error(String(cause)),
            );
          }
        }
      },
      (err) => {
        this.emitError(err);
      },
    );

    // Wire stderr → onStderr (optional).
    const onStderr = this.opts.onStderr;
    if (onStderr !== undefined) {
      void drainLines(child.stderr, (line) => {
        try {
          onStderr(line);
        } catch {
          /* swallow — diagnostics callback must not crash transport */
        }
      });
    } else {
      // Drain anyway so the child's stderr pipe doesn't block.
      void drainLines(child.stderr, () => {
        /* drop */
      });
    }

    // Watch for exit → emit close.
    void child.exited.then((code) => {
      this._state = 'closed';
      const reason = this.closeReason?.reason ?? `exit ${code}`;
      this.emitClose(code, reason);
    });
  }

  async send(payload: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (this._state !== 'open' || this.stdinWriter === null) {
      throw new Error(
        `StdioTransport.send: not open (state=${this._state})`,
      );
    }
    const serialized = `${JSON.stringify(payload)}\n`;
    try {
      await this.stdinWriter.write(this.encoder.encode(serialized));
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      this._state = 'errored';
      this.emitError(err);
      throw err;
    }
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
    // If we've already closed, fire immediately so late subscribers don't
    // miss the signal.
    if (this._state === 'closed' && this.closeReason !== null) {
      try {
        handler(this.closeReason.code, this.closeReason.reason);
      } catch {
        /* swallow */
      }
    }
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }

  async close(): Promise<void> {
    if (this._state === 'closed') return;
    this.closeReason = { code: 0, reason: 'closed by client' };
    try {
      if (this.stdinWriter !== null) {
        try {
          await this.stdinWriter.close();
        } catch {
          /* best-effort */
        }
        this.stdinWriter = null;
      }
    } catch {
      /* swallow */
    }
    try {
      this.child?.kill();
    } catch {
      /* swallow */
    }
  }

  // ---------- internals ----------

  private emitError(err: Error): void {
    for (const h of this.errorHandlers) {
      try {
        h(err);
      } catch {
        /* swallow */
      }
    }
  }

  private emitClose(code: number, reason: string): void {
    this.closeReason = { code, reason };
    for (const h of this.closeHandlers) {
      try {
        h(code, reason);
      } catch {
        /* swallow */
      }
    }
  }
}
