/**
 * Plugin system types (ROADMAP — Tier 3 plugin support).
 *
 * Plugins extend LocalCode with custom tools the model can call. Each
 * plugin lives as a single JS/TS module under either:
 *   - `~/.localcode/plugins/`             (global, applies everywhere)
 *   - `<projectRoot>/.localcode/plugins/` (project-local, overrides global by name)
 *
 * Each plugin module exports either:
 *   - a default export of type `Plugin`, OR
 *   - a named `tool` export of type `PluginToolDefinition` (the loader
 *     wraps this into a single-tool Plugin record automatically).
 *
 * The loader validates each plugin shape at load time. Invalid plugins
 * are logged and skipped — they never crash the host.
 *
 * Tool execution flows through `Plugin.tools[*].execute`, which receives
 * the raw arguments dictionary and a small context object (currently just
 * `projectRoot`). The return value mirrors the existing `ToolResult`
 * contract used by the rest of the codebase.
 */

/**
 * Result returned by a plugin tool's `execute` function. Mirrors the
 * core `ToolResult` shape but is redeclared here to keep `src/plugins/`
 * free of cross-package imports — plugin authors writing JS files in
 * their `.localcode/plugins/` folder shouldn't need to know about
 * internal project paths.
 */
export interface PluginToolResult {
  success: boolean;
  output: string;
  error?: string;
  /**
   * When `true`, the host's tool-executor must run the standard
   * approval flow before invoking this tool. Plugins are encouraged
   * to set this for any side-effecting operation.
   */
  requiresApproval?: boolean;
}

/**
 * Execution context handed to a plugin tool's `execute` function.
 * Deliberately small to keep the surface stable — additional fields
 * may be added in the future without breaking existing plugins.
 */
export interface PluginExecuteContext {
  projectRoot: string;
}

/**
 * One tool a plugin contributes. Multiple tools may be packaged in a
 * single plugin (use the `Plugin.tools` array).
 */
export interface PluginToolDefinition {
  /**
   * Tool name. Must be unique across all loaded plugins. The loader
   * validates that the name matches `^[a-z][a-z0-9_-]*$` to avoid
   * collisions with built-in tool names and to keep IDs URL/file-safe.
   * Convention: snake_case or kebab-case, lowercase ASCII.
   */
  name: string;
  /** Human-readable description, embedded in the model's tool catalogue. */
  description: string;
  /**
   * JSON Schema describing the `args` payload the tool expects. Stored
   * as an opaque object so plugin authors can use whatever JSON-Schema
   * shape they prefer — the host forwards it verbatim to the LLM
   * adapter's tool catalogue.
   */
  parameters: Record<string, unknown>;
  /**
   * Tool implementation. Receives the raw args dictionary as `unknown`
   * (the plugin is responsible for narrowing / validating its own
   * parameters) and returns a structured result.
   */
  execute: (
    args: unknown,
    ctx: PluginExecuteContext,
  ) => Promise<PluginToolResult>;
}

/**
 * One loaded plugin. The loader fills `name` from the source filename
 * (without extension) when the module doesn't supply one explicitly.
 */
export interface Plugin {
  /** Unique plugin name (alphanumeric + hyphens; the loader enforces this). */
  name: string;
  /** Optional semantic version string. Free-form; not validated. */
  version?: string;
  /** One or more tools contributed by this plugin. */
  tools: PluginToolDefinition[];
}

/**
 * Where a plugin was loaded from. `'project'` plugins shadow `'global'`
 * plugins with the same name.
 */
export type PluginSource = 'project' | 'global';

/**
 * Internal record produced by the loader. Plugin authors do not need to
 * import this — it is exported only for tests and the plugin index helper.
 *
 * When the plugin uses the SDK manifest format (`localcode-plugin.json`),
 * `manifest` and `runtime` carry the typed metadata + runtime handler
 * bundle. Legacy single-file plugins leave both undefined.
 *
 * Imports from `./sdk/*` here are TYPE-ONLY so there is no runtime
 * cycle (types.ts and sdk/types.ts compile independently).
 */
import type { PluginManifest } from './sdk/types';
import type { CommandHandler, ThemePalette, ToolHandler } from './sdk/api';

export interface LoadedPluginRuntime {
  tools: readonly ToolHandler[];
  commands: readonly CommandHandler[];
  themes: readonly ThemePalette[];
  statusline: { templateId: string; render: string } | null;
}

export interface LoadedPlugin {
  plugin: Plugin;
  source: PluginSource;
  /** Absolute path of the source file (for diagnostics). */
  filePath: string;
  /** SDK manifest when the plugin used the manifest format. */
  manifest?: PluginManifest;
  /** Runtime handler bundle for manifest plugins. */
  runtime?: LoadedPluginRuntime;
}
