/**
 * Sub-agent template catalog — public re-exports.
 *
 * Consumers:
 *   - `src/commands/cmd-spawn.ts`  — `/spawn` slash command.
 *   - `src/llm/tools-schema.ts`    — exposes `template` on `spawn_agent`.
 *   - `src/agents/orchestrator.ts` — `spawnFromTemplate(id, customPrompt)`.
 *   - `web-frontend/src/components/AgentCatalogPicker.tsx` — picker UI.
 */

export type {
  AgentApprovalProfile,
  AgentTemplate,
} from './types';

export {
  AGENT_TEMPLATES,
  AGENT_TEMPLATES_BY_ID,
  AGENT_TEMPLATE_IDS,
  findAgentTemplate,
} from './templates';
