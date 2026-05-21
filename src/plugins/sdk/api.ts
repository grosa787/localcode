/**
 * Plugin SDK runtime API.
 *
 * Plugin entry modules use these helpers to define tools, slash
 * commands, and themes with full type-checking. Each helper is a
 * tiny Zod-validated builder that returns a frozen handler the host
 * loader can register.
 *
 * Plugin authors typically do:
 *
 *     import { defineTool, defineCommand } from 'localcode/plugin-sdk';
 *
 *     export const tools = [
 *       defineTool({
 *         name: 'hello',
 *         description: 'Say hello',
 *         parameters: { type: 'object', properties: {} },
 *         async execute() { return { success: true, output: 'hi' }; },
 *       }),
 *     ];
 *
 * The host imports the entry module and looks for these named exports.
 */

import { z } from 'zod';

import type {
  PluginCommandDef,
  PluginThemeDef,
  PluginToolDef,
} from './types';
import { PluginCommandDefSchema, PluginThemeDefSchema, PluginToolDefSchema } from './types';

// ---------------------------------------------------------------------------
// Shared runtime types — re-exported through the SDK barrel so plugin
// authors don't import deep paths.
// ---------------------------------------------------------------------------

export interface PluginToolResult {
  success: boolean;
  output: string;
  error?: string;
  requiresApproval?: boolean;
}

export interface PluginExecuteContext {
  projectRoot: string;
}

export interface PluginCommandContext {
  projectRoot: string;
  sessionId: string | null;
  print: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Tool / command / theme handlers (host-facing)
// ---------------------------------------------------------------------------

export interface ToolHandler {
  /** Static metadata (validated). */
  readonly def: PluginToolDef;
  /**
   * Runtime callback. Args are forwarded verbatim from the LLM tool
   * call — the plugin is responsible for narrowing them against its
   * own JSON Schema.
   */
  execute(args: unknown, ctx: PluginExecuteContext): Promise<PluginToolResult>;
}

export interface CommandHandler {
  /** Static metadata (validated). */
  readonly def: PluginCommandDef;
  /**
   * Runtime callback. `args` is the raw slash-command tail (everything
   * after `/<name> `).
   */
  execute(args: string, ctx: PluginCommandContext): Promise<void> | void;
}

export interface ThemePalette {
  /** Static metadata (validated). */
  readonly def: PluginThemeDef;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const ToolBuilderSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.unknown()).optional(),
    execute: z.unknown(),
  })
  .passthrough();

/**
 * Define a tool. The builder validates the manifest-shape portion via
 * Zod and verifies `execute` is a function. Returns a frozen handler.
 */
export function defineTool(input: {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute: (
    args: unknown,
    ctx: PluginExecuteContext,
  ) => Promise<PluginToolResult>;
}): ToolHandler {
  const parsedShape = ToolBuilderSchema.safeParse(input);
  if (!parsedShape.success) {
    const issue = parsedShape.error.issues[0];
    const path = issue?.path.join('.') || '<root>';
    throw new Error(
      `defineTool: invalid input at ${path}: ${issue?.message ?? 'unknown error'}`,
    );
  }
  if (typeof input.execute !== 'function') {
    throw new Error('defineTool: execute must be a function');
  }

  const defResult = PluginToolDefSchema.safeParse({
    name: input.name,
    description: input.description,
    parameters: input.parameters ?? {},
  });
  if (!defResult.success) {
    const issue = defResult.error.issues[0];
    throw new Error(
      `defineTool: invalid metadata: ${issue?.path.join('.') ?? '<root>'}: ${issue?.message ?? 'invalid'}`,
    );
  }

  const handler: ToolHandler = {
    def: defResult.data,
    execute: input.execute,
  };
  return Object.freeze(handler);
}

/**
 * Define a slash command contributed by a plugin.
 */
export function defineCommand(input: {
  name: string;
  description: string;
  args?: string;
  execute: (args: string, ctx: PluginCommandContext) => Promise<void> | void;
}): CommandHandler {
  if (typeof input.execute !== 'function') {
    throw new Error('defineCommand: execute must be a function');
  }
  const defResult = PluginCommandDefSchema.safeParse({
    name: input.name,
    description: input.description,
    ...(input.args !== undefined ? { args: input.args } : {}),
  });
  if (!defResult.success) {
    const issue = defResult.error.issues[0];
    throw new Error(
      `defineCommand: invalid metadata: ${issue?.path.join('.') ?? '<root>'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const handler: CommandHandler = {
    def: defResult.data,
    execute: input.execute,
  };
  return Object.freeze(handler);
}

/**
 * Define a theme palette. Theme palettes are pure metadata — no
 * runtime callback. The host wires them into the theme registry.
 */
export function defineTheme(input: {
  id: string;
  name: string;
  palette: Record<string, string>;
}): ThemePalette {
  const defResult = PluginThemeDefSchema.safeParse(input);
  if (!defResult.success) {
    const issue = defResult.error.issues[0];
    throw new Error(
      `defineTheme: invalid metadata: ${issue?.path.join('.') ?? '<root>'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const handler: ThemePalette = { def: defResult.data };
  return Object.freeze(handler);
}
