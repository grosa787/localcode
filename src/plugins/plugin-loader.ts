/**
 * Plugin loader.
 *
 * Scans two locations for plugins:
 *   - global:  `~/.localcode/plugins/`
 *   - project: `<projectRoot>/.localcode/plugins/`
 *
 * A plugin is either:
 *   1. A directory containing a `localcode-plugin.json` manifest (the
 *      NEW SDK-based format — see `src/plugins/sdk/types.ts`). The
 *      manifest's `entry` field (default `index.ts` / `index.js`) is
 *      dynamic-imported and inspected for SDK handlers (`tools`,
 *      `commands`, `themes` named exports).
 *   2. A single `*.{js,mjs,cjs,ts}` file at the directory root — the
 *      LEGACY simple-export format. The module exports either a
 *      default `Plugin` value, a named `tool` export, or a named
 *      `plugin` export.
 *
 * Project plugins override global plugins with the same name.
 *
 * Errors during a single plugin load (parse error, missing exports,
 * malformed shape, wrong sdkVersion) are logged via `console.warn` and
 * the plugin is skipped — the loader never throws into the host.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PLUGIN_SDK_VERSION,
  parsePluginManifest,
  type PluginCommandDef,
  type PluginManifest,
  type PluginThemeDef,
  type PluginToolDef,
} from './sdk/types';
import type {
  CommandHandler,
  PluginCommandContext,
  PluginExecuteContext,
  PluginToolResult,
  ThemePalette,
  ToolHandler,
} from './sdk/api';
import type {
  LoadedPlugin,
  LoadedPluginRuntime,
  Plugin,
  PluginSource,
  PluginToolDefinition,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
]);

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const MANIFEST_FILE = 'localcode-plugin.json';
const DEFAULT_ENTRY_CANDIDATES: readonly string[] = [
  'index.ts',
  'index.tsx',
  'index.mjs',
  'index.js',
  'index.cjs',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadPluginsOptions {
  /**
   * Override for the global plugins directory. When omitted, defaults
   * to `~/.localcode/plugins/`. Pass `null` to disable global loading.
   */
  globalDir?: string | null;
  /**
   * Project root; when provided, the loader also scans
   * `<projectRoot>/.localcode/plugins/`. Project plugins override global
   * plugins of the same name.
   */
  projectRoot?: string;
  /**
   * Callback invoked for each error encountered while loading a plugin.
   * When omitted, errors are logged via `console.warn`.
   */
  onLoadError?: (filePath: string, error: Error) => void;
}

/**
 * Load all plugins from the configured directories. Always returns an
 * array (possibly empty); never throws.
 */
export async function loadPlugins(
  options: LoadPluginsOptions = {},
): Promise<Plugin[]> {
  const records = await loadPluginRecords(options);
  return records.map((r) => r.plugin);
}

/**
 * Lower-level variant that returns the full `LoadedPlugin` records
 * (including `source`, `filePath`, and the optional SDK manifest +
 * capabilities when present).
 */
export async function loadPluginRecords(
  options: LoadPluginsOptions = {},
): Promise<LoadedPlugin[]> {
  const onError = options.onLoadError ?? defaultErrorReporter;

  const globalDir =
    options.globalDir === null
      ? null
      : options.globalDir ?? defaultGlobalDir();
  const projectDir =
    typeof options.projectRoot === 'string' && options.projectRoot.length > 0
      ? path.join(options.projectRoot, '.localcode', 'plugins')
      : null;

  const collected = new Map<string, LoadedPlugin>();

  if (globalDir !== null) {
    for (const rec of await loadFromDir(globalDir, 'global', onError)) {
      collected.set(rec.plugin.name, rec);
    }
  }
  if (projectDir !== null) {
    for (const rec of await loadFromDir(projectDir, 'project', onError)) {
      collected.set(rec.plugin.name, rec);
    }
  }

  return [...collected.values()].sort((a, b) =>
    a.plugin.name.localeCompare(b.plugin.name),
  );
}

// ---------------------------------------------------------------------------
// SDK-only capability access
// ---------------------------------------------------------------------------

/**
 * Collect the SDK-style capabilities from a list of loaded records,
 * preserving last-wins order (project overrides global). Returns the
 * runtime handler maps the orchestrator wires into the command
 * registry / theme picker / statusline renderer.
 */
export interface LoadedCapabilities {
  commands: Map<string, CommandHandler>;
  themes: Map<string, ThemePalette>;
  statusline: Map<string, { templateId: string; render: string; pluginId: string }>;
}

export function collectCapabilities(
  records: readonly LoadedPlugin[],
): LoadedCapabilities {
  const commands = new Map<string, CommandHandler>();
  const themes = new Map<string, ThemePalette>();
  const statusline = new Map<
    string,
    { templateId: string; render: string; pluginId: string }
  >();

  for (const rec of records) {
    if (!rec.manifest || !rec.runtime) continue;
    for (const cmd of rec.runtime.commands) {
      commands.set(cmd.def.name, cmd);
    }
    for (const theme of rec.runtime.themes) {
      themes.set(theme.def.id, theme);
    }
    if (rec.runtime.statusline) {
      statusline.set(rec.runtime.statusline.templateId, {
        templateId: rec.runtime.statusline.templateId,
        render: rec.runtime.statusline.render,
        pluginId: rec.manifest.id,
      });
    }
  }

  return { commands, themes, statusline };
}

// ---------------------------------------------------------------------------
// Internal: directory-level loading
// ---------------------------------------------------------------------------

async function loadFromDir(
  dir: string,
  source: PluginSource,
  onError: (filePath: string, error: Error) => void,
): Promise<LoadedPlugin[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Missing dir → no plugins. Not an error.
    return [];
  }

  const out: LoadedPlugin[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const result = await loadOneDir(abs, source);
      if (result.kind === 'ok') {
        out.push(result.record);
      } else if (result.kind === 'error') {
        onError(abs, result.error);
      } else {
        // 'skip' means no manifest found — silently ignore.
      }
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!PLUGIN_EXTENSIONS.has(ext)) continue;

    const result = await loadOneFile(abs, source);
    if (result.kind === 'ok') {
      out.push(result.record);
    } else {
      onError(abs, result.error);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal: directory-style (manifest) plugin load
// ---------------------------------------------------------------------------

type LoadOneFileResult =
  | { kind: 'ok'; record: LoadedPlugin }
  | { kind: 'error'; error: Error };

type LoadOneDirResult = LoadOneFileResult | { kind: 'skip' };

async function loadOneDir(
  dir: string,
  source: PluginSource,
): Promise<LoadOneDirResult> {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  let manifestText: string;
  try {
    manifestText = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return { kind: 'skip' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (cause) {
    return {
      kind: 'error',
      error: new Error(
        `Failed to parse ${manifestPath}: ${describe(cause)}`,
      ),
    };
  }

  // Reject incompatible SDK versions with an actionable message BEFORE
  // running schema validation so authors see the version error first.
  if (isObject(raw)) {
    const sdkRaw = (raw as { sdkVersion?: unknown }).sdkVersion;
    if (sdkRaw !== undefined && sdkRaw !== PLUGIN_SDK_VERSION) {
      return {
        kind: 'error',
        error: new Error(
          `Plugin ${dir}: incompatible sdkVersion ${describe(sdkRaw)} — this LocalCode build supports sdkVersion ${PLUGIN_SDK_VERSION}. Upgrade the plugin (or LocalCode) to match.`,
        ),
      };
    }
  }

  const parsed = parsePluginManifest(raw);
  if (!parsed.ok) {
    return {
      kind: 'error',
      error: new Error(`Plugin ${dir}: invalid manifest — ${parsed.error}`),
    };
  }
  const manifest = parsed.manifest;

  // Find + import entry (optional — manifests can declare capabilities
  // with only static tool metadata if no runtime is needed).
  const runtime = await loadRuntimeForManifest(dir, manifest);
  if ('error' in runtime) {
    return { kind: 'error', error: runtime.error };
  }

  // Build the legacy `Plugin` view so the existing tool wiring keeps
  // working unchanged. Tools defined in capabilities map straight in.
  const legacyPlugin = buildLegacyPlugin(manifest, runtime.value.tools);

  const record: LoadedPlugin = {
    plugin: legacyPlugin,
    source,
    filePath: manifestPath,
    manifest,
    runtime: runtime.value,
  };
  return { kind: 'ok', record };
}

type RuntimeBundle = LoadedPluginRuntime;

async function loadRuntimeForManifest(
  dir: string,
  manifest: PluginManifest,
): Promise<{ value: RuntimeBundle } | { error: Error }> {
  const declaredTools = manifest.capabilities?.tools ?? [];
  const declaredCommands = manifest.capabilities?.commands ?? [];
  const declaredThemes = manifest.capabilities?.themes ?? [];
  const declaredStatusline = manifest.capabilities?.statusline ?? null;

  // Resolve an entry file. The author may set `entry` explicitly, or
  // we probe a small list of conventional names.
  const entryPath = await resolveEntryPath(dir, manifest.entry);

  // No entry, and no runtime is required — pure-metadata plugins (e.g.
  // theme-only) are still valid. Tools without an executor are rejected
  // separately below.
  if (entryPath === null) {
    if (declaredTools.length > 0) {
      return {
        error: new Error(
          `Plugin ${manifest.id}: tools declared in manifest but no entry module found. Add an "entry" field to the manifest or an index.ts file.`,
        ),
      };
    }
    if (declaredCommands.length > 0) {
      return {
        error: new Error(
          `Plugin ${manifest.id}: commands declared in manifest but no entry module found.`,
        ),
      };
    }
    // Static-only bundle (themes / statusline). Build empty runtime.
    return {
      value: {
        tools: [],
        commands: [],
        themes: declaredThemes.map((d) => ({ def: d })),
        statusline: declaredStatusline
          ? { templateId: declaredStatusline.templateId, render: declaredStatusline.render }
          : null,
      },
    };
  }

  let mod: unknown;
  try {
    mod = await import(pathToFileURL(entryPath).href);
  } catch (cause) {
    return {
      error: new Error(
        `Plugin ${manifest.id}: failed to import ${entryPath}: ${describe(cause)}`,
      ),
    };
  }

  const exportedTools = readArrayExport(mod, 'tools');
  const exportedCommands = readArrayExport(mod, 'commands');
  const exportedThemes = readArrayExport(mod, 'themes');

  // Sanity-check that every declared tool has a matching runtime
  // handler. Missing handlers are fatal — the LLM would otherwise see a
  // tool it cannot invoke.
  const toolHandlers = pickToolHandlers(declaredTools, exportedTools, manifest.id);
  if ('error' in toolHandlers) return { error: toolHandlers.error };

  const commandHandlers = pickCommandHandlers(
    declaredCommands,
    exportedCommands,
    manifest.id,
  );
  if ('error' in commandHandlers) return { error: commandHandlers.error };

  const themeHandlers = pickThemeHandlers(declaredThemes, exportedThemes);

  return {
    value: {
      tools: toolHandlers.value,
      commands: commandHandlers.value,
      themes: themeHandlers,
      statusline: declaredStatusline
        ? { templateId: declaredStatusline.templateId, render: declaredStatusline.render }
        : null,
    },
  };
}

function buildLegacyPlugin(
  manifest: PluginManifest,
  toolHandlers: readonly ToolHandler[],
): Plugin {
  const tools: PluginToolDefinition[] = toolHandlers.map((handler) => ({
    name: handler.def.name,
    description: handler.def.description,
    parameters: handler.def.parameters as Record<string, unknown>,
    execute: wrapExecute(manifest.id, handler),
  }));
  return {
    name: manifest.id,
    version: manifest.version,
    tools,
  };
}

function wrapExecute(
  pluginId: string,
  handler: ToolHandler,
): (args: unknown, ctx: PluginExecuteContext) => Promise<PluginToolResult> {
  return async (args, ctx) => {
    try {
      return await handler.execute(args, ctx);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return {
        success: false,
        output: '',
        error: `Plugin "${pluginId}" tool "${handler.def.name}" threw: ${msg}`,
      };
    }
  };
}

async function resolveEntryPath(
  dir: string,
  explicit: string | undefined,
): Promise<string | null> {
  if (typeof explicit === 'string' && explicit.length > 0) {
    const abs = path.isAbsolute(explicit) ? explicit : path.join(dir, explicit);
    try {
      const st = await fs.stat(abs);
      return st.isFile() ? abs : null;
    } catch {
      return null;
    }
  }
  for (const candidate of DEFAULT_ENTRY_CANDIDATES) {
    const abs = path.join(dir, candidate);
    try {
      const st = await fs.stat(abs);
      if (st.isFile()) return abs;
    } catch {
      // try next
    }
  }
  return null;
}

function readArrayExport(mod: unknown, name: string): unknown[] {
  if (mod === null || typeof mod !== 'object') return [];
  const direct = (mod as Record<string, unknown>)[name];
  if (Array.isArray(direct)) return direct;
  // ESM-default-wrapped CJS — check `mod.default.<name>`.
  const def = (mod as Record<string, unknown>)['default'];
  if (def !== null && typeof def === 'object') {
    const nested = (def as Record<string, unknown>)[name];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function pickToolHandlers(
  declared: readonly PluginToolDef[],
  exported: readonly unknown[],
  pluginId: string,
): { value: ToolHandler[] } | { error: Error } {
  const exportedByName = new Map<string, unknown>();
  for (const item of exported) {
    if (isToolHandler(item)) exportedByName.set(item.def.name, item);
  }
  const out: ToolHandler[] = [];
  for (const decl of declared) {
    const handler = exportedByName.get(decl.name);
    if (handler === undefined) {
      return {
        error: new Error(
          `Plugin ${pluginId}: tool "${decl.name}" declared in manifest but no matching handler exported. Use defineTool({ name: "${decl.name}", ... }) and export it in the "tools" array.`,
        ),
      };
    }
    if (!isToolHandler(handler)) {
      return {
        error: new Error(
          `Plugin ${pluginId}: handler for tool "${decl.name}" is not a valid ToolHandler.`,
        ),
      };
    }
    out.push(handler);
  }
  return { value: out };
}

function pickCommandHandlers(
  declared: readonly PluginCommandDef[],
  exported: readonly unknown[],
  pluginId: string,
): { value: CommandHandler[] } | { error: Error } {
  const exportedByName = new Map<string, unknown>();
  for (const item of exported) {
    if (isCommandHandler(item)) exportedByName.set(item.def.name, item);
  }
  const out: CommandHandler[] = [];
  for (const decl of declared) {
    const handler = exportedByName.get(decl.name);
    if (handler === undefined) {
      return {
        error: new Error(
          `Plugin ${pluginId}: command "${decl.name}" declared in manifest but no matching handler exported. Use defineCommand({ name: "${decl.name}", ... }) and export it in the "commands" array.`,
        ),
      };
    }
    if (!isCommandHandler(handler)) {
      return {
        error: new Error(
          `Plugin ${pluginId}: handler for command "${decl.name}" is not a valid CommandHandler.`,
        ),
      };
    }
    out.push(handler);
  }
  return { value: out };
}

function pickThemeHandlers(
  declared: readonly PluginThemeDef[],
  exported: readonly unknown[],
): ThemePalette[] {
  const out: ThemePalette[] = [];
  const exportedById = new Map<string, ThemePalette>();
  for (const item of exported) {
    if (isThemePalette(item)) exportedById.set(item.def.id, item);
  }
  for (const decl of declared) {
    const handler = exportedById.get(decl.id);
    out.push(handler ?? { def: decl });
  }
  return out;
}

function isToolHandler(value: unknown): value is ToolHandler {
  if (!isObject(value)) return false;
  const v = value as { def?: unknown; execute?: unknown };
  return (
    isObject(v.def) &&
    typeof (v.def as { name?: unknown }).name === 'string' &&
    typeof v.execute === 'function'
  );
}

function isCommandHandler(value: unknown): value is CommandHandler {
  if (!isObject(value)) return false;
  const v = value as { def?: unknown; execute?: unknown };
  return (
    isObject(v.def) &&
    typeof (v.def as { name?: unknown }).name === 'string' &&
    typeof v.execute === 'function'
  );
}

function isThemePalette(value: unknown): value is ThemePalette {
  if (!isObject(value)) return false;
  const v = value as { def?: unknown };
  return (
    isObject(v.def) &&
    typeof (v.def as { id?: unknown }).id === 'string'
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Internal: single-file legacy load
// ---------------------------------------------------------------------------

async function loadOneFile(
  filePath: string,
  source: PluginSource,
): Promise<LoadOneFileResult> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(filePath).href);
  } catch (cause) {
    return {
      kind: 'error',
      error: new Error(
        `Failed to import plugin file ${filePath}: ${describe(cause)}`,
      ),
    };
  }

  const plugin = extractPlugin(mod, filePath);
  if ('error' in plugin) {
    return { kind: 'error', error: plugin.error };
  }

  const validation = validatePlugin(plugin.value);
  if (validation !== null) {
    return {
      kind: 'error',
      error: new Error(`Plugin ${filePath} failed validation: ${validation}`),
    };
  }

  return {
    kind: 'ok',
    record: { plugin: plugin.value, source, filePath },
  };
}

interface ExtractedOk {
  value: Plugin;
}
interface ExtractedErr {
  error: Error;
}

function extractPlugin(
  mod: unknown,
  filePath: string,
): ExtractedOk | ExtractedErr {
  if (mod === null || typeof mod !== 'object') {
    return {
      error: new Error(
        `Plugin module ${filePath} did not export an object (got ${typeof mod})`,
      ),
    };
  }

  const m = mod as Record<string, unknown>;
  const fallbackName = inferNameFromPath(filePath);

  const defaultExport = unwrapDefault(m['default']);
  if (defaultExport !== undefined) {
    if (looksLikePlugin(defaultExport)) {
      return { value: ensureName(defaultExport, fallbackName) };
    }
    if (looksLikeTool(defaultExport)) {
      return {
        value: {
          name: fallbackName,
          tools: [defaultExport as PluginToolDefinition],
        },
      };
    }
  }

  const namedTool = m['tool'];
  if (namedTool !== undefined && looksLikeTool(namedTool)) {
    return {
      value: {
        name: fallbackName,
        tools: [namedTool as PluginToolDefinition],
      },
    };
  }

  const namedPlugin = m['plugin'];
  if (namedPlugin !== undefined && looksLikePlugin(namedPlugin)) {
    return { value: ensureName(namedPlugin, fallbackName) };
  }

  return {
    error: new Error(
      `Plugin module ${filePath} must export a default Plugin, a default PluginToolDefinition, or a named "tool" / "plugin" export.`,
    ),
  };
}

function unwrapDefault(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const inner = (value as { default?: unknown }).default;
  if (inner !== undefined && (looksLikePlugin(inner) || looksLikeTool(inner))) {
    return inner;
  }
  return value;
}

function ensureName(plugin: Plugin, fallback: string): Plugin {
  if (typeof plugin.name === 'string' && plugin.name.length > 0) return plugin;
  return { ...plugin, name: fallback };
}

function looksLikePlugin(value: unknown): value is Plugin {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { tools?: unknown };
  if (!Array.isArray(v.tools)) return false;
  for (const t of v.tools) {
    if (!looksLikeTool(t)) return false;
  }
  return true;
}

function looksLikeTool(value: unknown): value is PluginToolDefinition {
  if (value === null || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  if (typeof t['name'] !== 'string') return false;
  if (typeof t['description'] !== 'string') return false;
  if (t['parameters'] === null || typeof t['parameters'] !== 'object') return false;
  if (typeof t['execute'] !== 'function') return false;
  return true;
}

function validatePlugin(plugin: Plugin): string | null {
  if (typeof plugin.name !== 'string' || plugin.name.length === 0) {
    return 'plugin.name is required';
  }
  if (!NAME_RE.test(plugin.name)) {
    return `plugin.name must match ${NAME_RE} (got "${plugin.name}")`;
  }
  if (!Array.isArray(plugin.tools) || plugin.tools.length === 0) {
    return 'plugin.tools must be a non-empty array';
  }
  const seenToolNames = new Set<string>();
  for (const tool of plugin.tools) {
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      return 'tool.name is required';
    }
    if (!TOOL_NAME_RE.test(tool.name)) {
      return `tool.name must match ${TOOL_NAME_RE} (got "${tool.name}")`;
    }
    if (seenToolNames.has(tool.name)) {
      return `duplicate tool name within plugin: "${tool.name}"`;
    }
    seenToolNames.add(tool.name);
    if (typeof tool.description !== 'string' || tool.description.length === 0) {
      return `tool "${tool.name}" is missing a description`;
    }
    if (
      tool.parameters === null ||
      typeof tool.parameters !== 'object' ||
      Array.isArray(tool.parameters)
    ) {
      return `tool "${tool.name}" must have a JSON-Schema parameters object`;
    }
    if (typeof tool.execute !== 'function') {
      return `tool "${tool.name}" must have an execute() function`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultGlobalDir(): string {
  return path.join(homedir(), '.localcode', 'plugins');
}

function defaultErrorReporter(filePath: string, error: Error): void {
  // eslint-disable-next-line no-console
  console.warn(`[plugin-loader] ${filePath}: ${error.message}`);
}

function inferNameFromPath(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length === 0 ? 'plugin' : cleaned;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

// `toError` kept for symmetry with prior version (unused after dirent
// refactor but exported for back-compat with any direct importers).
export function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new Error(describe(cause));
}

export type { CommandHandler, ThemePalette, ToolHandler, PluginCommandContext };
