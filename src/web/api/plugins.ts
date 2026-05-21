/**
 * REST handler for `/api/plugins` — read-only listing of installed
 * plugins. Honors `?projectId=…` to also include project-local plugins.
 *
 * Failed loads are surfaced via a single aggregate `failed` count so the
 * UI can display "N plugins failed" without exposing absolute filesystem
 * paths to the browser.
 */

import { loadPluginRecords } from '@/plugins/plugin-loader';

import type {
  ListPluginsResponse,
  PluginSummary,
} from '../protocol/rest-types.js';

import { jsonError, jsonOk } from './http.js';
import type { ApiDeps } from './types.js';

export async function handlePlugins(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError(
      'method_not_allowed',
      `Method ${req.method} not allowed`,
      405,
    );
  }

  const projectId = url.searchParams.get('projectId');
  let projectRoot: string | undefined;
  if (projectId !== null && projectId.length > 0) {
    const ws = deps.workspaceRegistry.get(projectId);
    if (ws !== null) projectRoot = ws.root;
  }

  const failed: string[] = [];
  try {
    const records = await loadPluginRecords({
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      onLoadError: (filePath, error) => {
        failed.push(`${filePath.split('/').pop() ?? 'plugin'}: ${error.message}`);
      },
    });

    const plugins: PluginSummary[] = records.map((r) => {
      const summary: PluginSummary = {
        id: r.plugin.name,
        name: r.plugin.name,
        status: 'loaded',
        source: r.source,
        toolCount: r.plugin.tools.length,
      };
      if (r.plugin.version !== undefined) summary.version = r.plugin.version;
      return summary;
    });

    // Append failed loads as red rows so the UI can show them.
    for (const message of failed) {
      plugins.push({
        id: `failed:${message}`,
        name: message,
        status: 'failed',
        source: 'global',
        toolCount: 0,
      });
    }

    const body: ListPluginsResponse = { plugins };
    return jsonOk(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError('plugins_failed', msg, 500);
  }
}
