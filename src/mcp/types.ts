/**
 * MCP (Model Context Protocol) wire types + Zod validators.
 *
 * MCP is JSON-RPC 2.0 over a transport (stdio is the most common; HTTP
 * Streamable is the alternative). v1 only consumes `initialize`,
 * `notifications/initialized`, `tools/list`, and `tools/call`.
 *
 * Shapes here mirror the public spec
 * (https://spec.modelcontextprotocol.io). We do NOT depend on the
 * official `@modelcontextprotocol/sdk` package — implementing the small
 * surface ourselves keeps LocalCode dependency-free and Bun-compatible.
 */

import { z } from 'zod';

// ---------- JSON-RPC primitives ----------

/** Protocol version we advertise on `initialize`. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Client info sent to the server during handshake. */
export interface McpClientInfo {
  name: string;
  version: string;
}

/** Server info returned during handshake. */
export interface McpServerInfo {
  name: string;
  version: string;
}

/** Capabilities advertised by the client. v1 only consumes tools. */
export interface McpClientCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

/** Capabilities advertised by the server. */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
}

// ---------- JSON-RPC envelope ----------

/**
 * A JSON-RPC 2.0 request. `id` is a string or number that the server
 * echoes back. We always use string ids so dispatch / dedup logic stays
 * simple (`Map<string, …>` lookups).
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

/** A JSON-RPC 2.0 notification (no id, no response expected). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown> | unknown[];
}

/** A JSON-RPC 2.0 successful response. */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

/** A JSON-RPC 2.0 error response. */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Discriminated union of every wire message we might receive. */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// ---------- Zod schemas for inbound validation ----------

export const JsonRpcResponseSchema = z.union([
  z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]),
    result: z.unknown(),
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    error: z.object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
  }),
]);

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
});

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  method: z.string(),
  params: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
});

// ---------- MCP-specific payloads ----------

/** Result returned by the server on `initialize`. */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: McpServerInfo;
  instructions?: string;
}

export const McpInitializeResultSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z
    .object({
      tools: z.object({ listChanged: z.boolean().optional() }).optional(),
      resources: z
        .object({
          listChanged: z.boolean().optional(),
          subscribe: z.boolean().optional(),
        })
        .optional(),
      prompts: z.object({ listChanged: z.boolean().optional() }).optional(),
      logging: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  serverInfo: z.object({
    name: z.string(),
    version: z.string(),
  }),
  instructions: z.string().optional(),
});

/**
 * Tool descriptor as returned by `tools/list`. `inputSchema` is a JSON
 * Schema fragment (typically `{ type: 'object', properties, required }`).
 */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export const McpToolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
});

export const McpListToolsResultSchema = z.object({
  tools: z.array(McpToolDefSchema),
  nextCursor: z.string().optional(),
});

/** One content block inside a `tools/call` result. */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: Record<string, unknown> };

export const McpContentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({ type: z.literal('resource'), resource: z.record(z.unknown()) }),
]);

/** Result of `tools/call`. */
export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

export const McpCallResultSchema = z.object({
  content: z.array(McpContentSchema),
  isError: z.boolean().optional(),
});

// ---------- Helpers ----------

/**
 * Build a JSON-RPC request with a monotonic id. Caller owns the id
 * generator so multiple in-flight calls don't collide.
 */
export function makeRequest(
  id: string,
  method: string,
  params?: Record<string, unknown> | unknown[],
): JsonRpcRequest {
  const out: JsonRpcRequest = { jsonrpc: '2.0', id, method };
  if (params !== undefined) out.params = params;
  return out;
}

export function makeNotification(
  method: string,
  params?: Record<string, unknown> | unknown[],
): JsonRpcNotification {
  const out: JsonRpcNotification = { jsonrpc: '2.0', method };
  if (params !== undefined) out.params = params;
  return out;
}

/**
 * Type guard — does the parsed envelope carry a `method` field? Then it's
 * either a request or a notification.
 */
export function isRequestOrNotification(
  msg: unknown,
): msg is JsonRpcRequest | JsonRpcNotification {
  return (
    msg !== null &&
    typeof msg === 'object' &&
    typeof (msg as { method?: unknown }).method === 'string'
  );
}

/** Type guard — response shape (has either `result` or `error`). */
export function isResponse(msg: unknown): msg is JsonRpcResponse {
  if (msg === null || typeof msg !== 'object') return false;
  const m = msg as { id?: unknown; result?: unknown; error?: unknown };
  if (m.id === undefined) return false;
  return m.result !== undefined || m.error !== undefined;
}

/**
 * Parse a single line as a JSON-RPC message. Returns `null` for unparseable
 * input — callers (transport readers) MUST treat null as a soft skip
 * (logged), not a fatal error, so a single bad line doesn't kill the
 * whole connection.
 */
export function tryParseMessage(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  if (isResponse(raw)) return raw as JsonRpcResponse;
  if (isRequestOrNotification(raw)) {
    // distinguish: request has id, notification doesn't.
    const r = raw as { id?: unknown };
    return r.id === undefined
      ? (raw as JsonRpcNotification)
      : (raw as JsonRpcRequest);
  }
  return null;
}
