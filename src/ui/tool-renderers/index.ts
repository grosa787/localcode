/**
 * TOOL-RENDERERS-SECTION — registry barrel.
 *
 * Maps a tool name (`read_file`, `list_dir`, …) to its
 * `RenderToolResult` function. Callers use `pickRenderer(name)` and get
 * back either a renderer function or `undefined` when the tool has no
 * rich override.
 *
 * Adding a new renderer:
 *   1. Create `src/ui/tool-renderers/<name>.tsx` exporting `render`.
 *   2. Add an entry below mapping the canonical tool name (and any
 *      aliases) to the imported `render`.
 *   3. Add a focused test under `tests/ui/tool-renderers/`.
 */

import type { RenderToolResult } from './types.js';

import { render as renderReadFile } from './read-file.js';
import { render as renderListDir } from './list-dir.js';
import { render as renderRunCommand } from './run-command.js';
import { render as renderGrepSearch } from './grep-search.js';
import { render as renderWebFetch } from './web-fetch.js';
import { render as renderWebSearch } from './web-search.js';
import { render as renderEditFile } from './edit-file.js';
// INLINE-IMAGE-SECTION — Wave 16C: render fetched images inline.
import { render as renderFetchImage } from './fetch-image.js';

/**
 * Frozen lookup table. Key is the canonical tool name as the executor
 * surfaces it to the UI. We deliberately use a plain object (not a Map)
 * so consumers can introspect the keys cheaply for diagnostics.
 */
export const TOOL_RENDERERS: Readonly<Record<string, RenderToolResult>> = Object.freeze({
  read_file: renderReadFile,
  list_dir: renderListDir,
  run_command: renderRunCommand,
  // Search-shape family — same renderer is happy with any
  // `file:line[:col] — preview` stream OR a bare path-per-line list.
  glob_search: renderGrepSearch,
  find_symbol: renderGrepSearch,
  grep_search: renderGrepSearch,
  web_fetch: renderWebFetch,
  web_search: renderWebSearch,
  edit_file: renderEditFile,
  multi_edit: renderEditFile,
  write_file: renderEditFile,
  // INLINE-IMAGE-SECTION — fetch_image draws its result inline via the
  // terminal graphics protocol (or a clean text fallback).
  fetch_image: renderFetchImage,
});

/** Return the renderer for `name`, or `undefined` when none is registered. */
export function pickRenderer(name: string): RenderToolResult | undefined {
  return TOOL_RENDERERS[name];
}

export type { RenderToolResult, ToolRendererContext, ToolRendererResult, ToolRendererStatus } from './types.js';
