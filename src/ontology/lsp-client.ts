/**
 * Minimal LSP JSON-RPC client for the ontology indexer.
 *
 * The Language Server Protocol uses JSON-RPC 2.0 framed with HTTP-style
 * `Content-Length: N\r\n\r\n` headers on stdio. We spawn
 * `typescript-language-server --stdio` (via `bunx`) and speak just
 * enough of the protocol to drive the indexer:
 *   - `initialize` / `initialized` handshake
 *   - `textDocument/didOpen` (so the server has the buffer)
 *   - `textDocument/documentSymbol` (declarations in a file)
 *   - `textDocument/references` (call sites of a symbol)
 *   - `textDocument/definition` (resolve a symbol)
 *   - `textDocument/prepareCallHierarchy` + `callHierarchy/incomingCalls`
 *     + `callHierarchy/outgoingCalls` (call graph)
 *
 * Tests inject a fake child via the `spawn` option — production callers
 * leave it unset to use `Bun.spawn`. Every request/response is correlated
 * by integer id through a `Map<id, pending>`. Server-initiated requests
 * (window/showMessageRequest, etc) are dropped because none of them are
 * fatal for indexing.
 */

import { z } from 'zod';

import type { SpawnedChild, SpawnOpts } from '@/mcp/transport-stdio';

/**
 * Pluggable spawn signature — narrower than the MCP one (LSP only needs
 * to read stdin/stdout/stderr; no env injection requirement).
 */
export type LspSpawnFn = (
  cmd: readonly string[],
  opts: SpawnOpts,
) => SpawnedChild;

/** Constructor options for {@link LspClient}. */
export interface LspClientOpts {
  /** Argv. `command` is `argv[0]` followed by `args`. */
  command: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * Test injection point. Falls back to `Bun.spawn` when unset.
   */
  spawn?: LspSpawnFn;
  /** Optional diagnostics sink. Receives every stderr line. */
  onStderr?: (line: string) => void;
  /** Per-request timeout, ms. Default 30_000. */
  requestTimeoutMs?: number;
}

/** A pending JSON-RPC call awaiting its response. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
}

/**
 * Default spawn implementation — same shape as `mcp/transport-stdio`
 * but kept private so the ontology module owns its dependency.
 */
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
    throw new Error('Bun.spawn is unavailable — LSP client requires Bun');
  }
  const bag: Record<string, unknown> = {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  };
  if (opts.cwd !== undefined) bag['cwd'] = opts.cwd;
  return bun.spawn(cmd as string[], bag);
}

// ---------- LSP wire shapes (just enough for the indexer) ----------

export type LspSymbolKind =
  | 1 // File
  | 2 // Module
  | 3 // Namespace
  | 4 // Package
  | 5 // Class
  | 6 // Method
  | 7 // Property
  | 8 // Field
  | 9 // Constructor
  | 10 // Enum
  | 11 // Interface
  | 12 // Function
  | 13 // Variable
  | 14 // Constant
  | 15 // String
  | 16 // Number
  | 17 // Boolean
  | 18 // Array
  | 19 // Object
  | 20 // Key
  | 21 // Null
  | 22 // EnumMember
  | 23 // Struct
  | 24 // Event
  | 25 // Operator
  | 26; // TypeParameter

const PositionSchema = z.object({
  line: z.number().int().min(0),
  character: z.number().int().min(0),
});

const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});

const LocationSchema = z.object({
  uri: z.string(),
  range: RangeSchema,
});

export type LspPosition = z.infer<typeof PositionSchema>;
export type LspRange = z.infer<typeof RangeSchema>;
export type LspLocation = z.infer<typeof LocationSchema>;

const DocumentSymbolBase = z.object({
  name: z.string(),
  detail: z.string().optional(),
  kind: z.number().int().min(1).max(26),
  range: RangeSchema,
  selectionRange: RangeSchema,
});

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: LspSymbolKind;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

const DocumentSymbolSchema: z.ZodType<LspDocumentSymbol> = DocumentSymbolBase.extend({
  children: z.array(z.lazy((): z.ZodType<LspDocumentSymbol> => DocumentSymbolSchema)).optional(),
}) as z.ZodType<LspDocumentSymbol>;

const DocumentSymbolResultSchema = z.array(DocumentSymbolSchema);

const CallHierarchyItemSchema = z.object({
  name: z.string(),
  kind: z.number().int().min(1).max(26),
  uri: z.string(),
  range: RangeSchema,
  selectionRange: RangeSchema,
  detail: z.string().optional(),
});
export type LspCallHierarchyItem = z.infer<typeof CallHierarchyItemSchema>;

const IncomingCallSchema = z.object({
  from: CallHierarchyItemSchema,
  fromRanges: z.array(RangeSchema),
});
const OutgoingCallSchema = z.object({
  to: CallHierarchyItemSchema,
  fromRanges: z.array(RangeSchema),
});
export type LspIncomingCall = z.infer<typeof IncomingCallSchema>;
export type LspOutgoingCall = z.infer<typeof OutgoingCallSchema>;

const ReferencesResultSchema = z.array(LocationSchema);
const DefinitionResultSchema = z.union([
  LocationSchema,
  z.array(LocationSchema),
  z.null(),
]);
const PrepareCallHierarchyResultSchema = z.union([
  z.array(CallHierarchyItemSchema),
  z.null(),
]);
const IncomingCallsResultSchema = z.union([
  z.array(IncomingCallSchema),
  z.null(),
]);
const OutgoingCallsResultSchema = z.union([
  z.array(OutgoingCallSchema),
  z.null(),
]);

// ---------- Client ----------

const HEADER_TERMINATOR = '\r\n\r\n';

/**
 * Minimal LSP client. After `start()` resolves, callers may invoke any
 * of the request methods until `close()` is called (or the child exits).
 */
export class LspClient {
  private readonly opts: LspClientOpts;
  private child: SpawnedChild | null = null;
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private encoder = new TextEncoder();
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buf = new Uint8Array(0);
  private contentLength = -1;
  private started = false;
  private closed = false;
  private initializeResult: unknown = null;

  constructor(opts: LspClientOpts) {
    this.opts = opts;
  }

  /**
   * Spawn the child process and run the `initialize` / `initialized`
   * handshake. Resolves when the server is ready to receive requests.
   * Throws on spawn failure or on a malformed initialize response.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const spawn = this.opts.spawn ?? defaultSpawn;
    const spawnOpts: SpawnOpts = {};
    if (this.opts.cwd !== undefined) spawnOpts.cwd = this.opts.cwd;
    const child = spawn(
      [this.opts.command, ...(this.opts.args ?? [])],
      spawnOpts,
    );
    this.child = child;
    if (child.stdin !== null) {
      this.stdinWriter = child.stdin.getWriter();
    }
    void this.drainStdout(child.stdout);
    if (child.stderr !== null) {
      void this.drainStderr(child.stderr);
    }
    void child.exited.then(() => {
      // Reject any in-flight requests so callers don't hang forever.
      this.closed = true;
      for (const [, pending] of this.pending) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(new Error('LSP server exited before response'));
      }
      this.pending.clear();
    });

    const initParams: Record<string, unknown> = {
      processId: typeof process !== 'undefined' ? process.pid : null,
      clientInfo: { name: 'localcode-ontology', version: '0.1.0' },
      rootUri: this.opts.cwd !== undefined ? pathToUri(this.opts.cwd) : null,
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          references: {},
          definition: {},
          callHierarchy: { dynamicRegistration: false },
        },
        workspace: {},
      },
      trace: 'off',
    };
    this.initializeResult = await this.request('initialize', initParams);
    await this.notify('initialized', {});
  }

  /** Tell the server about a buffer so subsequent document requests work. */
  async didOpen(
    uri: string,
    text: string,
    languageId: string,
  ): Promise<void> {
    await this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });
  }

  async didClose(uri: string): Promise<void> {
    await this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /** Document symbols (hierarchical when the server supports it). */
  async documentSymbol(uri: string): Promise<LspDocumentSymbol[]> {
    const raw = await this.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    if (raw === null || raw === undefined) return [];
    const parsed = DocumentSymbolResultSchema.safeParse(raw);
    if (!parsed.success) return [];
    return parsed.data;
  }

  /** Reference locations for the symbol at the given position. */
  async references(
    uri: string,
    position: LspPosition,
    includeDeclaration = false,
  ): Promise<LspLocation[]> {
    const raw = await this.request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
    if (raw === null || raw === undefined) return [];
    const parsed = ReferencesResultSchema.safeParse(raw);
    if (!parsed.success) return [];
    return parsed.data;
  }

  /** Definition for the symbol at the given position. */
  async definition(
    uri: string,
    position: LspPosition,
  ): Promise<LspLocation[]> {
    const raw = await this.request('textDocument/definition', {
      textDocument: { uri },
      position,
    });
    const parsed = DefinitionResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data === null) return [];
    return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  }

  /** Prepare a call-hierarchy item at the given position. */
  async prepareCallHierarchy(
    uri: string,
    position: LspPosition,
  ): Promise<LspCallHierarchyItem[]> {
    const raw = await this.request('textDocument/prepareCallHierarchy', {
      textDocument: { uri },
      position,
    });
    const parsed = PrepareCallHierarchyResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data === null) return [];
    return parsed.data;
  }

  async incomingCalls(
    item: LspCallHierarchyItem,
  ): Promise<LspIncomingCall[]> {
    const raw = await this.request('callHierarchy/incomingCalls', { item });
    const parsed = IncomingCallsResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data === null) return [];
    return parsed.data;
  }

  async outgoingCalls(
    item: LspCallHierarchyItem,
  ): Promise<LspOutgoingCall[]> {
    const raw = await this.request('callHierarchy/outgoingCalls', { item });
    const parsed = OutgoingCallsResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data === null) return [];
    return parsed.data;
  }

  /** Read-only accessor — exposed for tests + diagnostics. */
  get rawInitializeResult(): unknown {
    return this.initializeResult;
  }

  /** Send a JSON-RPC request and await its response. */
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error('LSP client is closed');
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      void this.writeFramed(payload).catch((err) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Fire-and-forget JSON-RPC notification. */
  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    await this.writeFramed(payload);
  }

  /** Shut down the client and the spawned child. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // Best-effort `shutdown` + `exit`; we ignore failures since the
      // child may already be on its way out.
      try {
        await this.writeFramed(
          JSON.stringify({ jsonrpc: '2.0', id: -1, method: 'shutdown' }),
        );
        await this.writeFramed(
          JSON.stringify({ jsonrpc: '2.0', method: 'exit' }),
        );
      } catch {
        /* swallow */
      }
      if (this.stdinWriter !== null) {
        try {
          await this.stdinWriter.close();
        } catch {
          /* swallow */
        }
        this.stdinWriter = null;
      }
    } finally {
      try {
        this.child?.kill();
      } catch {
        /* swallow */
      }
      for (const [, pending] of this.pending) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(new Error('LSP client closed'));
      }
      this.pending.clear();
    }
  }

  // ---------- Internals ----------

  private async writeFramed(json: string): Promise<void> {
    if (this.stdinWriter === null) {
      throw new Error('LSP client has no stdin writer');
    }
    const body = this.encoder.encode(json);
    const header = this.encoder.encode(
      `Content-Length: ${body.byteLength}${HEADER_TERMINATOR}`,
    );
    const framed = new Uint8Array(header.byteLength + body.byteLength);
    framed.set(header, 0);
    framed.set(body, header.byteLength);
    await this.stdinWriter.write(framed);
  }

  private async drainStdout(
    stream: ReadableStream<Uint8Array> | null,
  ): Promise<void> {
    if (stream === null) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        this.appendBytes(value);
        this.drainFrames();
      }
    } catch {
      /* swallow — child exit handler will reject pending */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* swallow */
      }
    }
  }

  private async drainStderr(
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            try {
              this.opts.onStderr?.(line);
            } catch {
              /* swallow */
            }
          }
          nl = buf.indexOf('\n');
        }
      }
    } catch {
      /* swallow */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* swallow */
      }
    }
  }

  private appendBytes(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.byteLength);
    this.buf = merged;
  }

  /**
   * Consume as many complete LSP frames as the buffer currently holds.
   * Each frame is `Content-Length: N\r\n\r\n` followed by exactly N
   * bytes of JSON-RPC payload.
   */
  private drainFrames(): void {
    for (;;) {
      if (this.contentLength < 0) {
        const headerEnd = findHeaderTerminator(this.buf);
        if (headerEnd === -1) return; // wait for more bytes
        const headerStr = new TextDecoder().decode(this.buf.subarray(0, headerEnd));
        const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
        if (match === null || match[1] === undefined) {
          // Malformed header — drop until next \r\n\r\n and retry.
          this.buf = this.buf.subarray(headerEnd + 4);
          continue;
        }
        this.contentLength = Number.parseInt(match[1], 10);
        this.buf = this.buf.subarray(headerEnd + 4);
      }
      if (this.buf.byteLength < this.contentLength) return;
      const body = this.buf.subarray(0, this.contentLength);
      this.buf = this.buf.subarray(this.contentLength);
      this.contentLength = -1;
      try {
        const json = new TextDecoder('utf-8').decode(body);
        const parsed = JSON.parse(json) as unknown;
        this.dispatch(parsed);
      } catch {
        // Bad frame — skip and keep going.
      }
    }
  }

  private dispatch(msg: unknown): void {
    if (msg === null || typeof msg !== 'object') return;
    const m = msg as {
      id?: number | string | null;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
    };
    if (typeof m.id === 'number' && (m.result !== undefined || m.error !== undefined)) {
      const pending = this.pending.get(m.id);
      if (pending === undefined) return;
      this.pending.delete(m.id);
      if (pending.timer !== null) clearTimeout(pending.timer);
      if (m.error !== undefined) {
        pending.reject(
          new Error(
            `${pending.method} failed: ${m.error.code} ${m.error.message}`,
          ),
        );
        return;
      }
      pending.resolve(m.result);
      return;
    }
    // Server-initiated request or notification — silently drop. None of
    // them are required for our indexing pipeline.
  }
}

// ---------- URI helpers (file:// only) ----------

/** Convert a filesystem path to a `file://` URI. */
export function pathToUri(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }
  return `file:///${encodeURI(normalized)}`;
}

/** Convert a `file://` URI back into a filesystem path. */
export function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return decodeURI(uri.slice('file://'.length));
  }
  return decodeURI(uri);
}

/** Find the first `\r\n\r\n` sequence; returns its starting index or -1. */
function findHeaderTerminator(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.byteLength; i += 1) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}
