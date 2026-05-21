/**
 * MCP tool adapter.
 *
 * Converts the flat `McpRegistryTool[]` catalogue produced by
 * `MCPRegistry.getAllTools()` into:
 *
 *   1. A `Record<string, ToolHandler>` keyed by namespaced tool name
 *      (`mcp__<serverName>__<toolName>`) — merged into the executor's
 *      handler map so the LLM can invoke MCP tools like built-ins.
 *
 *   2. A `readonly ToolSchema[]` array — appended to `TOOLS_SCHEMA` at
 *      call time so the model sees every MCP tool in its tools list.
 *
 * MCP tools are single-phase (read + side-effects happen atomically on
 * the server); they implement only `preview` with no `commit`.  The
 * executor treats tools without `commit` as auto-completing after
 * `preview` returns.
 *
 * Naming convention: `mcp__<serverName>__<toolName>` (double-underscore
 * separators).  The double underscore avoids collision with built-in
 * names (which use single underscores) and matches the pattern the
 * CLAUDE.md spec describes.
 *
 * Error contract: a thrown error from `registry.callTool` is always
 * caught here and returned as `{ success: false, output: <message> }`.
 * The executor never sees an unhandled rejection from an MCP tool.
 *
 * Only tools from servers in `ready` state are exposed.  Tools from
 * `errored` / `connecting` / `closed` servers are omitted — the model
 * should not be offered tools it cannot call.
 */

import type { MCPRegistry, McpRegistryTool } from '@/mcp/registry';
import type { ToolHandler } from '@/tools/index';
import type { ToolResult } from '@/types/global';
import type { ToolSchema, JSONSchemaProperty } from '@/types/message';
import type { McpContent } from '@/mcp/types';

// ---------- Naming ----------

/** Convert a server name + tool name into the namespaced handler key. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

// ---------- Schema conversion ----------

const VALID_TYPES = new Set<string>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
]);

/**
 * Coerce an unknown value from MCP's `inputSchema.properties` into a
 * `JSONSchemaProperty`.  We can't trust the MCP server to emit exactly
 * the right shape, so we narrow defensively and fall back to `'string'`
 * for any unrecognised type.  The alternative — using `as any` — is
 * banned by the CI lint gate.
 */
function coerceProperty(raw: unknown): JSONSchemaProperty {
  if (raw === null || typeof raw !== 'object') {
    return { type: 'string' };
  }
  const obj = raw as Record<string, unknown>;

  const rawType = obj['type'];
  const type: JSONSchemaProperty['type'] =
    typeof rawType === 'string' && VALID_TYPES.has(rawType)
      ? (rawType as JSONSchemaProperty['type'])
      : 'string';

  const prop: JSONSchemaProperty = { type };

  const desc = obj['description'];
  if (typeof desc === 'string') prop.description = desc;

  const rawEnum = obj['enum'];
  if (Array.isArray(rawEnum) && rawEnum.every((e): e is string => typeof e === 'string')) {
    prop.enum = rawEnum;
  }

  if (type === 'array') {
    const rawItems = obj['items'];
    if (rawItems !== null && rawItems !== undefined) {
      prop.items = coerceProperty(rawItems);
    }
  }

  if (type === 'object') {
    const rawProps = obj['properties'];
    if (rawProps !== null && rawProps !== undefined && typeof rawProps === 'object') {
      const subProps: Record<string, JSONSchemaProperty> = {};
      for (const [k, v] of Object.entries(rawProps as Record<string, unknown>)) {
        subProps[k] = coerceProperty(v);
      }
      prop.properties = subProps;
    }
  }

  return prop;
}

/**
 * Build the `parameters` block for a `ToolSchema` from an MCP
 * `inputSchema`.  MCP's `inputSchema` is already JSON Schema; we
 * extract the subset that `ToolFunctionSchema.parameters` can represent.
 */
function buildParameters(
  inputSchema: Record<string, unknown> | undefined,
): ToolSchema['function']['parameters'] {
  const properties: Record<string, JSONSchemaProperty> = {};
  const required: string[] = [];
  let additionalProperties: boolean | undefined;

  if (inputSchema !== undefined) {
    const rawProps = inputSchema['properties'];
    if (rawProps !== null && rawProps !== undefined && typeof rawProps === 'object') {
      for (const [k, v] of Object.entries(rawProps as Record<string, unknown>)) {
        properties[k] = coerceProperty(v);
      }
    }

    const rawRequired = inputSchema['required'];
    if (Array.isArray(rawRequired)) {
      for (const r of rawRequired) {
        if (typeof r === 'string') required.push(r);
      }
    }

    const rawAdditional = inputSchema['additionalProperties'];
    if (typeof rawAdditional === 'boolean') {
      additionalProperties = rawAdditional;
    }
  }

  const params: ToolSchema['function']['parameters'] = {
    type: 'object',
    properties,
  };
  if (required.length > 0) params.required = required;
  if (additionalProperties !== undefined) params.additionalProperties = additionalProperties;
  return params;
}

// ---------- Content conversion ----------

/** Flatten `McpContent[]` into a plain string for `ToolResult.output`. */
function contentToString(content: McpContent[]): string {
  return content
    .map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return `[image: ${c.mimeType}]`;
      return '[resource]';
    })
    .join('\n');
}

// ---------- Public API ----------

/**
 * Build a handler map from every *ready* MCP server tool in the registry.
 *
 * Keys are `mcp__<serverName>__<toolName>`.  Each handler implements only
 * `preview` (no `commit`) — MCP tools execute atomically.
 *
 * Merged AFTER plugin tools so that an MCP-side name collision shadows a
 * plugin tool (which itself shadows a built-in).
 */
export function buildMcpToolHandlerMap(
  registry: MCPRegistry,
): Record<string, ToolHandler> {
  const map: Record<string, ToolHandler> = {};

  const servers = registry.getServers();
  const readyServers = new Set(
    servers.filter((s) => s.state === 'ready').map((s) => s.name),
  );

  for (const { serverName, tool } of registry.getAllTools()) {
    // Skip tools from servers that aren't currently ready.
    if (!readyServers.has(serverName)) continue;

    const exposedName = mcpToolName(serverName, tool.name);

    map[exposedName] = {
      preview: async (args: unknown): Promise<ToolResult> => {
        // Normalise args — the executor passes `Record<string, unknown>`.
        const callArgs: Record<string, unknown> =
          args !== null && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        try {
          const result = await registry.callTool(serverName, tool.name, callArgs);
          const output = contentToString(result.content);
          if (result.isError === true) {
            return { success: false, output };
          }
          return { success: true, output };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            output: `MCP tool error (${serverName}/${tool.name}): ${message}`,
          };
        }
      },
    };
  }

  return map;
}

/**
 * Build the model-facing `ToolSchema[]` for every ready MCP tool.
 * Namespacing mirrors `buildMcpToolHandlerMap`.
 */
export function buildMcpToolSchema(
  registry: MCPRegistry,
): readonly ToolSchema[] {
  const servers = registry.getServers();
  const readyServers = new Set(
    servers.filter((s) => s.state === 'ready').map((s) => s.name),
  );

  const schemas: ToolSchema[] = [];

  const tools: McpRegistryTool[] = registry.getAllTools();
  for (const { serverName, tool } of tools) {
    if (!readyServers.has(serverName)) continue;

    schemas.push({
      type: 'function',
      function: {
        name: mcpToolName(serverName, tool.name),
        description: tool.description ?? `MCP tool ${tool.name} from server ${serverName}.`,
        parameters: buildParameters(tool.inputSchema),
      },
    });
  }

  return schemas;
}
