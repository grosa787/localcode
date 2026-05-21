/**
 * Plugin SDK types — public surface for third-party plugin authors.
 *
 * Plugins ship a `localcode-plugin.json` manifest describing their
 * identity and the capabilities they contribute (tools, slash commands,
 * statusline template, themes). The loader (`src/plugins/plugin-loader.ts`)
 * validates the manifest via Zod, then dynamic-imports the entry module
 * to wire up handlers.
 *
 * Stability contract:
 *   - `sdkVersion: 1` is the current major version. Plugins targeting a
 *     newer SDK get a clear error message on load rather than silently
 *     failing later.
 *   - Adding new optional fields to a capability is a minor change.
 *     Removing fields / renaming fields is a major change (bumps
 *     `sdkVersion`).
 *
 * This module is intentionally free of runtime imports beyond Zod so it
 * can be vendored into a plugin author's own toolchain without dragging
 * the rest of LocalCode along.
 */

import { z } from 'zod';

/**
 * Current plugin SDK API version. Plugins must declare the same number
 * in their manifest's `sdkVersion` field. The loader rejects mismatches
 * with a friendly error suggesting an upgrade path.
 */
export const PLUGIN_SDK_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Capability schemas
// ---------------------------------------------------------------------------

/**
 * One tool a plugin contributes. Mirrors `PluginToolDefinition` from
 * `src/plugins/types.ts` but with a Zod schema so manifests can be
 * validated at load time before the entry module is imported.
 *
 * The `execute` function itself is NOT part of the manifest — it lives
 * on the entry module's runtime export (see `api.ts → defineTool`).
 */
export const PluginToolDefSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_-]*$/, {
        message: 'tool name must match /^[a-z][a-z0-9_-]*$/',
      }),
    description: z.string().min(1),
    parameters: z.record(z.unknown()).default({}),
  })
  .strict();

export type PluginToolDef = z.infer<typeof PluginToolDefSchema>;

/**
 * One slash command a plugin contributes. Like tools, only the metadata
 * is stored in the manifest — the handler lives on the entry module.
 *
 * `name` excludes the leading `/`. `args` is an optional free-form usage
 * hint shown in `/plugin info` and the slash-menu autocomplete.
 */
export const PluginCommandDefSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_-]*$/, {
        message: 'command name must match /^[a-z][a-z0-9_-]*$/',
      }),
    description: z.string().min(1),
    args: z.string().optional(),
  })
  .strict();

export type PluginCommandDef = z.infer<typeof PluginCommandDefSchema>;

/**
 * Statusline template contribution. `templateId` is a stable identifier
 * (kebab-case) the user can reference via `config.statusline.template`
 * indirection in the future; `render` is the raw template string with
 * the standard `{placeholder}` substitutions documented in
 * `src/ui/statusline-template.ts`.
 *
 * Note: the brief mandates the render field is a TEMPLATE STRING, not a
 * function — this keeps statusline contributions safe to evaluate
 * without invoking plugin code on every render tick.
 */
export const PluginStatuslineDefSchema = z
  .object({
    templateId: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, {
        message: 'templateId must be kebab-case',
      }),
    render: z.string().min(1),
  })
  .strict();

export type PluginStatuslineDef = z.infer<typeof PluginStatuslineDefSchema>;

/**
 * A theme palette contribution. Keys are theme tokens (e.g. `primary`,
 * `accent`) and values are hex colours like `#a855f7`. The host
 * validates each value is a 3- or 6-digit hex string; non-matching
 * entries are silently dropped by the loader (with a warning) rather
 * than failing the whole plugin.
 */
export const PluginThemeDefSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, {
        message: 'theme id must be kebab-case',
      }),
    name: z.string().min(1),
    palette: z.record(z.string()),
  })
  .strict();

export type PluginThemeDef = z.infer<typeof PluginThemeDefSchema>;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Kebab-case plugin id pattern. Mirrors the existing loader's
 * plugin-name pattern so a manifest-based plugin and a simple-export
 * plugin can never collide on shape.
 */
export const PLUGIN_ID_REGEX = /^[a-z][a-z0-9-]*$/;

const SemverLooseRegex = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

export const PluginCapabilitiesSchema = z
  .object({
    tools: z.array(PluginToolDefSchema).optional(),
    commands: z.array(PluginCommandDefSchema).optional(),
    statusline: PluginStatuslineDefSchema.optional(),
    themes: z.array(PluginThemeDefSchema).optional(),
  })
  .strict();

export type PluginCapabilities = z.infer<typeof PluginCapabilitiesSchema>;

export const PluginManifestSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID_REGEX, {
      message: 'plugin id must be kebab-case (e.g. "my-plugin")',
    }),
    name: z.string().min(1),
    version: z.string().regex(SemverLooseRegex, {
      message: 'version must look like semver (e.g. "1.2.3")',
    }),
    description: z.string().min(1),
    author: z.string().optional(),
    license: z.string().optional(),
    homepage: z.string().optional(),
    sdkVersion: z.literal(PLUGIN_SDK_VERSION),
    entry: z.string().min(1).optional(),
    capabilities: PluginCapabilitiesSchema.optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Parse a raw manifest object. Returns a discriminated result rather
 * than throwing so callers can decide whether to surface the error or
 * skip the plugin.
 */
export function parsePluginManifest(
  raw: unknown,
):
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string } {
  const parsed = PluginManifestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const issue = parsed.error.issues[0];
  const message = issue
    ? `${issue.path.join('.') || '<root>'}: ${issue.message}`
    : 'invalid manifest';
  return { ok: false, error: message };
}
