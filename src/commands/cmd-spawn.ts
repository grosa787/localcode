/**
 * /spawn — list the curated catalog of sub-agent templates, or launch
 * one against a concrete task.
 *
 *   /spawn                          — print every template (id + tagline)
 *   /spawn <id>                     — print one template's full description
 *   /spawn <id> <task description>  — launch a sub-agent
 *
 * Unlike the model-driven `spawn_agent` tool, `/spawn` is user-driven
 * and never blocks the LLM stream. The command resolves the template at
 * dispatch time and asks the orchestrator to spawn — surfacing the
 * resulting agentId in chat. The lead is then responsible for `agent_status`
 * / `await_agent` polls (or the operator can watch via the AgentTeamPanel).
 *
 * The slash command is intentionally a separate code path from the tool
 * so users can drive a spawn even when the model isn't aware of the
 * `template` parameter (e.g. older / smaller models).
 */

import { AGENT_TEMPLATES, findAgentTemplate } from '@/agents/catalog';
import type { AgentTemplate } from '@/agents/catalog';
import type { CommandContext, SlashCommand } from '@/types/global';

/**
 * Subset of `AgentOrchestrator` the command needs. Kept tight so the
 * wiring layer can inject either the real orchestrator or a test fake.
 *
 * The method returns the new agentId on success; the command surfaces
 * it in chat. On failure (unknown template, maxConcurrent exceeded,
 * etc.) it throws synchronously — the command catches and prints.
 */
export interface SpawnOrchestrator {
  spawnFromTemplate(
    parentSessionId: string,
    templateId: string,
    customPrompt: string,
    overrides?: {
      files?: readonly string[];
      model?: string;
      isolation?: 'worktree' | 'shared';
      timeout?: number;
    },
  ): Promise<{ agentId: string }>;
}

export interface SpawnDeps {
  /**
   * Returns the parent session id (the lead). May return `null` when
   * no session is active yet — the command refuses to spawn in that case.
   */
  getSessionId: () => string | null;
  orchestrator: SpawnOrchestrator | null;
}

export function createSpawnCommand(deps: SpawnDeps): SlashCommand {
  return {
    name: 'spawn',
    description:
      'Spawn a specialist sub-agent from the curated template catalog.',
    usage:
      '/spawn | /spawn <template-id> | /spawn <template-id> <task description>',
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();

      // No args -> list the catalog.
      if (trimmed.length === 0) {
        printCatalog(ctx);
        return;
      }

      const split = splitFirst(trimmed);
      const templateId = split.head;
      const taskBody = split.tail;
      const template = findAgentTemplate(templateId);
      if (template === undefined) {
        ctx.print(
          `Unknown template "${templateId}". Run /spawn (no args) to see the available templates.`,
        );
        return;
      }

      // Single arg -> show that template's detail page.
      if (taskBody.length === 0) {
        printTemplateDetail(ctx, template);
        return;
      }

      // Two args -> launch.
      if (deps.orchestrator === null) {
        ctx.print('Sub-agent orchestrator is not enabled in this session.');
        return;
      }
      const sessionId = deps.getSessionId();
      if (sessionId === null) {
        ctx.print('No active session — start chatting first, then /spawn.');
        return;
      }
      try {
        const { agentId } = await deps.orchestrator.spawnFromTemplate(
          sessionId,
          templateId,
          taskBody,
        );
        ctx.print(
          `Spawned ${template.name} agent (id=${agentId}). Use the team panel or agent_status to follow progress.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.print(`Spawn failed: ${msg}`);
      }
    },
  };
}

function printCatalog(ctx: CommandContext): void {
  ctx.print('Sub-agent catalog (use `/spawn <id> <task>` to launch):');
  ctx.print('');
  // Stable order: catalog declaration order.
  const widest = AGENT_TEMPLATES.reduce(
    (n, t) => Math.max(n, t.id.length),
    0,
  );
  for (const t of AGENT_TEMPLATES) {
    const pad = ' '.repeat(Math.max(0, widest - t.id.length));
    ctx.print(`  ${t.id}${pad}  ${t.tagline}`);
  }
}

function printTemplateDetail(
  ctx: CommandContext,
  template: AgentTemplate,
): void {
  ctx.print(`${template.name} (${template.id})`);
  ctx.print('');
  ctx.print(template.description);
  ctx.print('');
  ctx.print(`Approval profile: ${template.approvalProfile}`);
  const toolList =
    template.tools.length === 0 ? '(no restriction)' : template.tools.join(', ');
  ctx.print(`Tools allow-list: ${toolList}`);
  const model =
    template.recommendedModel.length === 0
      ? '(inherit worker model)'
      : template.recommendedModel;
  ctx.print(`Recommended model: ${model}`);
  ctx.print('');
  ctx.print(`To launch: /spawn ${template.id} <task description>`);
}

/**
 * Split on the first run of whitespace. Returns `{head, tail}` where
 * `head` is the first whitespace-delimited token and `tail` is the
 * remainder (trimmed).
 */
function splitFirst(s: string): { head: string; tail: string } {
  const match = /^(\S+)(\s+([\s\S]*))?$/.exec(s);
  if (match === null) return { head: '', tail: '' };
  const head = match[1] ?? '';
  const tail = (match[3] ?? '').trim();
  return { head, tail };
}
