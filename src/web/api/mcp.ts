/**
 * REST handler for `GET /api/mcp`.
 *
 * Returns the current snapshot of every MCP server the process-wide
 * registry knows about. Read-only — no CSRF required. Returns 405 on
 * non-GET.
 *
 * The registry is lazily constructed by `getProcessMcpRegistry()`. If
 * `start()` has not been called yet the snapshot will be empty (`[]`).
 */

import { getProcessMcpRegistry } from '@/mcp';
import type { McpRegistryServerView } from '@/mcp';

import { jsonError, jsonOk } from './http.js';

export interface McpStatusResponse {
  servers: McpRegistryServerView[];
}

export async function handleMcp(
  req: Request,
  _url: URL,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  try {
    const registry = getProcessMcpRegistry();
    const body: McpStatusResponse = { servers: registry.getServers() };
    return jsonOk(body);
  } catch (err) {
    return jsonError(
      'mcp_error',
      err instanceof Error ? err.message : 'Failed to read MCP registry',
      500,
    );
  }
}
