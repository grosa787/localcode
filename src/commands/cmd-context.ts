/**
 * /context — print a human-readable snapshot of the current context.
 *
 * Reports:
 *   - Token usage vs. max (tokens + percent bar preview)
 *   - Message count in the context window
 *   - Active skill names
 *   - LOCALCODE.md presence + path
 *   - First ~200 chars of the computed system prompt
 *
 * This command is read-only and never mutates state.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type { ContextManager } from '@/llm/context-manager';
import type { SkillsManager } from '@/skills/skills-manager';

export interface LocalcodeMdStatus {
  exists: boolean;
  path: string;
}

export interface ContextDeps {
  contextManager: ContextManager;
  skillsManager: SkillsManager;
  localcodeMdStatus: () => LocalcodeMdStatus;
  maxTokens: number;
}

const CONTEXT_NAME = 'context';
const CONTEXT_DESCRIPTION = 'Show current context usage, active skills, and system prompt preview';
const CONTEXT_USAGE = '/context';
const SYS_PROMPT_PREVIEW_CHARS = 200;

export function createContextCommand(deps: ContextDeps): SlashCommand {
  const { contextManager, skillsManager, localcodeMdStatus, maxTokens } = deps;

  return {
    name: CONTEXT_NAME,
    description: CONTEXT_DESCRIPTION,
    usage: CONTEXT_USAGE,
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      // FIX #32 — `/context` opens the ContextOverlay when available;
      // text snapshot remains for callers without overlay dispatch.
      if (ctx.showOverlay !== undefined) {
        ctx.showOverlay('context');
        return;
      }

      const tokens = contextManager.getTokenCount();
      const percent = maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;
      const messageCount = contextManager.getMessages().length;

      ctx.print(
        `Context: ${tokens} / ${maxTokens} tokens (${percent.toFixed(1)}%)`,
      );
      ctx.print(`Messages: ${messageCount}`);

      let activeSkillNames: string[] = [];
      let localcodeMdContent: string | null = null;

      try {
        const active = await skillsManager.getActiveSkills();
        activeSkillNames = active.map((s) => s.name);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Active skills: (failed to load: ${msg})`);
      }

      if (activeSkillNames.length === 0) {
        ctx.print('Active skills: (none)');
      } else {
        ctx.print(`Active skills: ${activeSkillNames.join(', ')}`);
      }

      let mdStatus: LocalcodeMdStatus;
      try {
        mdStatus = localcodeMdStatus();
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`LOCALCODE.md: (status check failed: ${msg})`);
        mdStatus = { exists: false, path: '(unknown)' };
      }
      ctx.print(
        `LOCALCODE.md: ${mdStatus.exists ? 'present' : 'missing'} at ${mdStatus.path}`,
      );

      // We don't actually need the full md content for the preview — the
      // context manager builds the system prompt from whatever it has.
      // But to represent what WILL be sent, feed through the currently
      // active skills + project context (unread here to avoid disk hits).
      let activeSkillsForPrompt: Awaited<ReturnType<SkillsManager['getActiveSkills']>> = [];
      try {
        activeSkillsForPrompt = await skillsManager.getActiveSkills();
      } catch {
        activeSkillsForPrompt = [];
      }
      const systemPrompt = contextManager.buildSystemPrompt(
        localcodeMdContent,
        activeSkillsForPrompt,
      );
      const preview = systemPrompt.slice(0, SYS_PROMPT_PREVIEW_CHARS);
      const suffix = systemPrompt.length > SYS_PROMPT_PREVIEW_CHARS ? '...' : '';
      ctx.print(`System prompt preview: ${preview}${suffix}`);
    },
  };
}
