/**
 * Plugins barrel — re-exports the loader, types, and a helper for
 * turning a list of `Plugin` records into a tool-handler map shaped like
 * the one Agent 2's `ToolExecutor` consumes (see `src/tools/index.ts`).
 *
 * Wiring (Agent F territory):
 *   1. Call `loadPlugins({ projectRoot })` at startup.
 *   2. Pass the result through `buildPluginHandlerMap(plugins, ctx)` to
 *      get a `Record<string, { preview, commit? }>` shape.
 *   3. Merge the resulting map into the built-in tool handler map and
 *      hand the combined map to `ToolExecutor` along with extended
 *      `KNOWN_TOOL_NAMES` / `TOOLS_SCHEMA` entries (those live in
 *      `@/types/message` and `@/llm/tools-schema` and are out of this
 *      module's scope — Agent F handles the wire-up).
 */

import type { ToolResult } from '@/types/global';
import type {
  Plugin,
  PluginExecuteContext,
  PluginToolDefinition,
  PluginToolResult,
} from '@/plugins/types';

export type {
  LoadedPlugin,
  LoadedPluginRuntime,
  Plugin,
  PluginExecuteContext,
  PluginSource,
  PluginToolDefinition,
  PluginToolResult,
} from '@/plugins/types';

export {
  loadPlugins,
  loadPluginRecords,
  collectCapabilities,
  type LoadPluginsOptions,
  type LoadedCapabilities,
} from '@/plugins/plugin-loader';

// SDK public surface — plugin authors and CLI subcommands import these.
export {
  PLUGIN_SDK_VERSION,
  PLUGIN_ID_REGEX,
  PluginManifestSchema,
  PluginCapabilitiesSchema,
  PluginToolDefSchema,
  PluginCommandDefSchema,
  PluginStatuslineDefSchema,
  PluginThemeDefSchema,
  parsePluginManifest,
  defineTool,
  defineCommand,
  defineTheme,
} from '@/plugins/sdk';
export type {
  PluginManifest,
  PluginCapabilities,
  PluginToolDef,
  PluginCommandDef,
  PluginStatuslineDef,
  PluginThemeDef,
  ToolHandler,
  CommandHandler,
  ThemePalette,
  PluginCommandContext,
} from '@/plugins/sdk';

export {
  PluginRegistry,
  PluginRegistryError,
} from '@/plugins/registry';
export type {
  PluginRegistryEntry,
  PluginRegistryFile,
  PluginRegistryOptions,
  PluginScope,
} from '@/plugins/registry';

/**
 * Shape of a single tool-handler entry expected by Agent 2's
 * `ToolExecutor`. Mirrors the shape produced by `createToolHandlerMap`
 * in `src/tools/index.ts` — read-only tools only need `preview`,
 * mutating tools also expose `commit`.
 *
 * Plugin tools always populate just `preview` because the plugin contract
 * does not split previews from commits — the `execute` function does the
 * work directly. Plugins that need approval should set
 * `requiresApproval: true` on the returned `PluginToolResult` and the
 * host's executor will route through the standard approval flow.
 */
export interface PluginHandler {
  preview: (
    args: unknown,
    ctx: PluginExecuteContext,
  ) => Promise<ToolResult>;
}

export type PluginHandlerMap = Record<string, PluginHandler>;

/**
 * Build a tool-handler map from a list of plugins. The resulting map
 * keys are the tool names (NOT plugin names) — Agent F merges this map
 * with the built-in handler map and then registers the merged map with
 * `ToolExecutor`.
 *
 * Conflict resolution: if two plugins contribute a tool with the same
 * name, the LAST one wins (project plugins are loaded after global, and
 * within each scope plugins are processed alphabetically — so the
 * effective behaviour is "project overrides global"). The loader
 * already enforces "project overrides global" at the plugin level; this
 * helper only deduplicates within a flattened plugin list, so callers
 * are advised to keep their tool names unique.
 *
 * Errors thrown by a plugin's `execute` are caught and surfaced as a
 * `ToolResult` with `success: false`. Plugins never crash the host.
 */
export function buildPluginHandlerMap(
  plugins: readonly Plugin[],
): PluginHandlerMap {
  const map: PluginHandlerMap = {};
  for (const plugin of plugins) {
    for (const tool of plugin.tools) {
      map[tool.name] = makeHandler(plugin.name, tool);
    }
  }
  return map;
}

/**
 * Convenience: collapse the plugin list into a flat `name → tool`
 * mapping for callers that need to look up the original tool definition
 * (e.g. when building the model-facing `TOOLS_SCHEMA` entry).
 */
export function buildPluginToolIndex(
  plugins: readonly Plugin[],
): Map<string, { plugin: Plugin; tool: PluginToolDefinition }> {
  const out = new Map<string, { plugin: Plugin; tool: PluginToolDefinition }>();
  for (const plugin of plugins) {
    for (const tool of plugin.tools) {
      out.set(tool.name, { plugin, tool });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function makeHandler(
  pluginName: string,
  tool: PluginToolDefinition,
): PluginHandler {
  return {
    preview: async (args, ctx) => {
      try {
        const raw = await tool.execute(args, ctx);
        return normaliseResult(pluginName, tool.name, raw);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        return {
          success: false,
          output: '',
          error: `Plugin "${pluginName}" tool "${tool.name}" threw: ${msg}`,
        };
      }
    },
  };
}

/**
 * Coerce whatever the plugin returned into a `ToolResult`. Plugins that
 * forget required fields get a sensible default + a warning baked into
 * the output string (helpful for debugging during development).
 */
function normaliseResult(
  pluginName: string,
  toolName: string,
  raw: unknown,
): ToolResult {
  if (raw === null || typeof raw !== 'object') {
    return {
      success: false,
      output: '',
      error: `Plugin "${pluginName}" tool "${toolName}" returned a non-object value (${describe(raw)}). Expected { success, output, error?, requiresApproval? }.`,
    };
  }
  const r = raw as Partial<PluginToolResult>;
  const success = typeof r.success === 'boolean' ? r.success : false;
  const output = typeof r.output === 'string' ? r.output : '';
  const error = typeof r.error === 'string' ? r.error : undefined;
  const requiresApproval =
    typeof r.requiresApproval === 'boolean' ? r.requiresApproval : undefined;
  const result: ToolResult = { success, output };
  if (error !== undefined) result.error = error;
  if (requiresApproval !== undefined) result.requiresApproval = requiresApproval;
  return result;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
