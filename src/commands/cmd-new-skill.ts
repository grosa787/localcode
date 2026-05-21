/**
 * /new-skill — open the skill-input overlay so the user can paste / type
 * text or provide a file path for a new skill.
 *
 * The heavy lifting (reading lines, submitting text/file content,
 * showing a confirmation) happens in Agent 4's `SkillInputOverlay` UI.
 * This command is a thin glue layer: it tells the app to open the
 * overlay and nothing else. Agent 8 wires the overlay's submit callback
 * to `skillsManager.addFromText(...)` / `skillsManager.add(...)`.
 *
 * Keeping the command side-effect-free w/r/t the LLM is intentional:
 * slash commands MUST NOT hit the model. See app.tsx `onSlashExecute`
 * for the confirming dispatch path.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type { SkillsManager } from '@/skills/skills-manager';

export interface NewSkillDeps {
  /**
   * SkillsManager is accepted for future extensibility (e.g. printing
   * the target write dir) and to keep the factory signature symmetric
   * with the other skill-related commands. The actual save happens via
   * the overlay's submit callback in app.tsx.
   */
  skillsManager: SkillsManager;
  /**
   * Open the skill-input overlay. Implemented by Agent 8 — typically a
   * `setScreen('skillInput')` or equivalent in-place overlay state.
   */
  openSkillOverlay: () => void;
}

const NEW_SKILL_NAME = 'new-skill';
const NEW_SKILL_DESCRIPTION =
  'Open an overlay to paste text or provide a file path for a new skill';
const NEW_SKILL_USAGE = '/new-skill';

export function createNewSkillCommand(deps: NewSkillDeps): SlashCommand {
  const { skillsManager, openSkillOverlay } = deps;

  return {
    name: NEW_SKILL_NAME,
    description: NEW_SKILL_DESCRIPTION,
    usage: NEW_SKILL_USAGE,
    execute: (_args: string, ctx: CommandContext): void => {
      try {
        openSkillOverlay();
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to open skill overlay: ${msg}`);
        return;
      }

      // Let the user know where the skill will be saved by default
      // (project-local if configured, else global).
      const target =
        skillsManager.projectDirectory ?? skillsManager.globalDirectory;
      ctx.print(`Opening new-skill overlay. Default save location: ${target}`);
    },
  };
}
