/**
 * Plugin SDK — public barrel for third-party plugin authors.
 *
 * Plugin entry modules import from `localcode/plugin-sdk` (or, when
 * developing inside this repo, `@/plugins/sdk`). The SDK is the only
 * stable contract — anything else in `src/plugins/` is an
 * implementation detail.
 */

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
} from './types';

export type {
  PluginManifest,
  PluginCapabilities,
  PluginToolDef,
  PluginCommandDef,
  PluginStatuslineDef,
  PluginThemeDef,
} from './types';

export {
  defineTool,
  defineCommand,
  defineTheme,
} from './api';

export type {
  ToolHandler,
  CommandHandler,
  ThemePalette,
  PluginToolResult,
  PluginExecuteContext,
  PluginCommandContext,
} from './api';
