/**
 * REST handler for `GET /api/commands` — read-only metadata listing of
 * the built-in slash commands the TUI registers.
 *
 * Source of truth is the `name`/`description`/`usage` constants declared
 * at the top of each `src/commands/cmd-*.ts` factory module. Those
 * constants are statically known at module load — no `CommandContext` is
 * required to read them — so we mirror the static metadata here rather
 * than constructing every factory with stub deps. The web UI consumes
 * the result without hardcoding the list.
 *
 * Sorted alphabetically by name; this matches `SlashRegistry.getAll()`.
 */

import type { CommandSummary, ListCommandsResponse } from '../protocol/rest-types.js';
import { jsonError, jsonOk } from './http.js';

/**
 * Static metadata for every built-in command exposed by
 * `BuiltinCommandFactories` in `src/commands/index.ts`. Each entry must
 * stay in sync with the matching `cmd-<name>.ts` factory's exported
 * SlashCommand fields.
 */
const BUILTIN_COMMAND_METADATA: readonly CommandSummary[] = [
  {
    name: 'agent',
    description:
      'Agentic loop — run the model autonomously until the task is complete or a safety limit is hit.',
    usage:
      '/agent <task> | /agent execute | /agent resume | /agent cancel | /agent --auto <task>',
  },
  {
    name: 'clear',
    description: 'Clear the current context and start a new session',
    usage: '/clear',
  },
  {
    name: 'compress',
    description:
      'Summarize the entire chat context into a compact summary, freeing up context space while preserving project memory.',
    usage: '/compress [--keep-last N]',
  },
  {
    name: 'context',
    description:
      'Show current context usage, active skills, and system prompt preview',
    usage: '/context',
  },
  {
    name: 'ctxsize',
    description:
      'Show or change the model context window (num_ctx) and keep-alive',
    usage: '/ctxsize [N | keepalive <seconds>]',
  },
  {
    name: 'diff',
    description:
      'Show git diff for current changes (working tree vs HEAD by default; pass a ref to compare).',
    usage: '/diff [git-args...]',
  },
  {
    name: 'init',
    description: 'Scan this project and generate (or update) .localcode/LOCALCODE.md',
    usage: '/init',
  },
  {
    name: 'model',
    description: 'List, switch, or refresh the active model',
    usage: '/model [name|refresh]',
  },
  {
    name: 'new-skill',
    description: 'Open an overlay to paste text or provide a file path for a new skill',
    usage: '/new-skill',
  },
  {
    name: 'permissions',
    description: 'List, grant, or revoke auto-approval for tools',
    usage: '/permissions [add|remove <toolName> | clear]',
  },
  {
    name: 'plan',
    description:
      'Two-phase generation: ask the model to produce a concrete plan before writing any code.',
    usage: '/plan <task description>',
  },
  {
    name: 'provider',
    description: 'Switch between Ollama, LM Studio, or a custom backend URL.',
    usage: '/provider [show | ollama | lmstudio | custom <url>]',
  },
  {
    name: 'resume',
    description: 'List recent sessions, or resume one by ID prefix',
    usage: '/resume [list | <idPrefix>]',
  },
  {
    name: 'review',
    description:
      'Code review by the model: a single file, a git range, or the whole project.',
    usage: '/review [path | git-range | empty for whole project]',
  },
  {
    name: 'settings',
    description:
      'View or edit generation parameters (temperature, top_p, repeat_penalty, max_tokens). Project settings override global.',
    usage: '/settings [show | source | reset-project]',
  },
  {
    name: 'statusline',
    description:
      'View or edit the assistant footer template (placeholders: {model}, {tokens}, {pct}, etc).',
    usage: '/statusline [set <template> | enable | disable | reset]',
  },
  {
    name: 'style',
    description:
      'Switch the active output style (concise / explanatory / verbose).',
    usage: '/style [name]',
  },
  {
    name: 'wakeups',
    description:
      'List or cancel pending in-session wakeups scheduled via schedule_wakeup.',
    usage: '/wakeups [cancel <id|all>]',
  },
  // WHITEBOARD-CMD-SECTION
  {
    name: 'whiteboard',
    description:
      'Open the web whiteboard for sketching diagrams / UI mockups (web UI only).',
    usage: '/whiteboard',
  },
  // WHITEBOARD-CMD-SECTION-END
];

export async function handleCommands(
  req: Request,
  _url: URL,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const sorted = [...BUILTIN_COMMAND_METADATA].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const body: ListCommandsResponse = { commands: sorted };
  return jsonOk(body);
}
