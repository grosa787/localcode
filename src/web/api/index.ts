/**
 * Barrel for the REST API. `createApiHandler` returns the function
 * Agent A's router calls for every `/api/*` request — returning `null`
 * lets the router fall through to the next handler (e.g. static).
 */

import { handleAgentsConfig } from './agents-config.js';
import { handleCommands } from './commands.js';
import { handleHooks } from './hooks.js';
import { handleMcp } from './mcp.js';
import { handlePlugins } from './plugins.js';
import { handleSkills, handleSkillToggle, handleSkillDelete } from './skills.js';
import {
  handleConfig,
  handleConfigGeneration,
  handleConfigModel,
  handleConfigOutputStyle,
  handleConfigProfile,
  handleConfigProvider,
  handleConfigProviders,
} from './config.js';
import { handleFilesRead, handleFilesTree } from './files.js';
import { handleModelsRefresh } from './models.js';
import { handlePickFolder, handleProjectById, handleProjects } from './projects.js';
import { handleSearch } from './search.js';
import { handleSessionById, handleSessions } from './sessions.js';
import { handleUsage } from './usage.js';
import { handleMemory, handleMemoryDelete } from './memory.js';
import type { ApiDeps } from './types.js';

export type { ApiDeps, AdapterFactory, ProviderAdapter } from './types.js';
export { resolveSafePath } from './files.js';

export type ApiHandler = (req: Request, url: URL) => Promise<Response | null>;

export function createApiHandler(deps: ApiDeps): ApiHandler {
  return async (req, url) => {
    const path = url.pathname;
    if (!path.startsWith('/api/')) return null;

    if (path === '/api/projects') return handleProjects(req, url, deps);
    if (path.startsWith('/api/projects/')) return handleProjectById(req, url, deps);

    if (path === '/api/pick-folder') return handlePickFolder(req, url, deps);

    if (path === '/api/sessions') return handleSessions(req, url, deps);
    if (path.startsWith('/api/sessions/')) return handleSessionById(req, url, deps);

    if (path === '/api/files/tree') return handleFilesTree(req, url, deps);
    if (path === '/api/files/read') return handleFilesRead(req, url, deps);

    if (path === '/api/config') return handleConfig(req, url, deps);
    if (path === '/api/config/model') return handleConfigModel(req, url, deps);
    if (path === '/api/config/provider') return handleConfigProvider(req, url, deps);
    if (path === '/api/config/providers') return handleConfigProviders(req, url, deps);
    if (path === '/api/config/generation') return handleConfigGeneration(req, url, deps);
    if (path === '/api/config/profile') return handleConfigProfile(req, url, deps);
    if (path === '/api/config/output-style') return handleConfigOutputStyle(req, url, deps);
    if (path === '/api/config/agents') return handleAgentsConfig(req, url, deps);

    if (path === '/api/models/refresh') return handleModelsRefresh(req, url, deps);

    if (path === '/api/commands') return handleCommands(req, url);

    if (path === '/api/hooks') return handleHooks(req, url, deps);

    if (path === '/api/mcp') return handleMcp(req, url);

    // MEMORY-SKILL-WRITE-ROUTES-SECTION
    if (path === '/api/skills') return handleSkills(req, url, deps);
    if (path.startsWith('/api/skills/')) {
      // `…/toggle` → toggle handler, otherwise treat the trailing
      // segment as a bare id and route DELETE to the delete handler.
      if (path.endsWith('/toggle')) return handleSkillToggle(req, url, deps);
      if (req.method === 'DELETE') return handleSkillDelete(req, url, deps);
      return handleSkillToggle(req, url, deps);
    }
    // MEMORY-SKILL-WRITE-ROUTES-SECTION-END

    if (path === '/api/plugins') return handlePlugins(req, url, deps);

    if (path === '/api/search') return handleSearch(req, url, deps);

    if (path === '/api/usage') return handleUsage(req, url, deps);

    if (path === '/api/memory') return handleMemory(req, url, deps);
    if (path.startsWith('/api/memory/')) return handleMemoryDelete(req, url, deps);

    return null;
  };
}
