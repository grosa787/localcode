/**
 * MCP module barrel — types, transports, client, and registry.
 *
 * Importers should pull from `@/mcp` rather than the individual files
 * so internal refactors (e.g. splitting transports into transport/*.ts)
 * don't ripple through call sites.
 */

export {
  MCP_PROTOCOL_VERSION,
  McpInitializeResultSchema,
  McpListToolsResultSchema,
  McpCallResultSchema,
  McpToolDefSchema,
  McpContentSchema,
  JsonRpcResponseSchema,
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  isRequestOrNotification,
  isResponse,
  makeRequest,
  makeNotification,
  tryParseMessage,
} from './types';

export type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  McpClientCapabilities,
  McpClientInfo,
  McpServerCapabilities,
  McpServerInfo,
  McpInitializeResult,
  McpToolDef,
  McpCallResult,
  McpContent,
} from './types';

export {
  StdioTransport,
  drainLines,
} from './transport-stdio';

export type {
  McpTransport,
  SpawnedChild,
  SpawnFn,
  SpawnOpts,
  StdioTransportOpts,
  TransportState,
} from './transport-stdio';

export { HttpTransport } from './transport-http';
export type { HttpTransportOpts } from './transport-http';

export { MCPClient } from './client';
export type {
  McpClientEvent,
  McpClientOpts,
  McpClientState,
} from './client';

export {
  MCPRegistry,
  getProcessMcpRegistry,
  setProcessMcpRegistry,
} from './registry';
export type {
  McpRegistryOpts,
  McpRegistryServerView,
  McpRegistryTool,
  McpServerStatus,
} from './registry';
