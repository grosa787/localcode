/**
 * TOOL-RENDERERS-SECTION — shared types for the per-tool rich-renderer
 * registry under `src/ui/tool-renderers/`.
 *
 * Each renderer exports a `renderToolResult(args, result, ctx)` that
 * returns a `ReactElement` to render BELOW the tool-call header (the
 * `└─ OK: <preview>` line) in `<ToolCallBlock>`. Returning `null` means
 * "no rich render available for this shape" and the caller falls back
 * to the existing raw-output preview.
 *
 * Renderers are pure functions of (args, result, ctx). They never read
 * or write the filesystem and never spawn workers — they only build
 * JSX out of strings.
 */

import type React from 'react';

/**
 * Minimal context passed to renderers. We don't share the full
 * `ToolContext` from `src/tools/types.ts` because that includes
 * `sessionId` and other run-only fields renderers don't need. Keeping
 * the context lean means renderers can be invoked from anywhere in the
 * UI (tests, future overlays) without dragging in tool-execution
 * machinery.
 */
export interface ToolRendererContext {
  /** Absolute project root. Used to anchor relative paths in file refs. */
  readonly projectRoot: string;
}

/** Renderer status — matches `<ToolCallBlock>`'s exposed status shape. */
export type ToolRendererStatus = 'pending' | 'running' | 'done' | 'error';

/** Result shape consumed by renderers (a subset of `ToolResult`). */
export interface ToolRendererResult {
  readonly status: ToolRendererStatus;
  /** Stringified tool output (raw text the tool emitted on success). */
  readonly output?: string;
  /** Error message from the tool, when `status === 'error'`. */
  readonly error?: string;
}

/**
 * Per-tool renderer signature. Each tool's file exports a `render`
 * function matching this signature; the registry barrel maps tool name
 * → render.
 *
 * Renderers receive the structured args dictionary from the assistant
 * (already validated against the tool's Zod schema by the executor)
 * plus the result. They return a `ReactElement` to display, or `null`
 * if they decide not to render rich output for this particular
 * argument/result combo (the caller then falls back to raw preview).
 */
export type RenderToolResult = (
  args: Record<string, unknown>,
  result: ToolRendererResult,
  ctx: ToolRendererContext,
) => React.ReactElement | null;
