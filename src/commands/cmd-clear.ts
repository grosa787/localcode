/**
 * /clear — wipe the current in-memory context and start a fresh session.
 *
 * The previous SQLite session is left intact; we just create a new one
 * and rewire `contextManager` to be empty. Active skills and LOCALCODE.md
 * are untouched.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type { ContextManager } from '@/llm/context-manager';

export interface ClearDeps {
  contextManager: ContextManager;
  /**
   * Creates a new SQLite session row and returns its id. Implemented by
   * Agent 8's wiring layer — typically a thin wrapper around
   * `SessionManager.createSession(...)` that also updates any
   * higher-level app state.
   */
  onNewSession: () => string;
}

const CLEAR_NAME = 'clear';
const CLEAR_DESCRIPTION = 'Clear the current context and start a new session';
const CLEAR_USAGE = '/clear';
const ID_PREFIX_LEN = 8;

export function createClearCommand(deps: ClearDeps): SlashCommand {
  const { contextManager, onNewSession } = deps;

  return {
    name: CLEAR_NAME,
    description: CLEAR_DESCRIPTION,
    usage: CLEAR_USAGE,
    execute: (_args: string, ctx: CommandContext): void => {
      try {
        contextManager.clear();
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to clear context: ${msg}`);
        return;
      }

      let newId: string;
      try {
        newId = onNewSession();
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Context cleared but failed to create new session: ${msg}`);
        return;
      }

      if (!newId || newId.length === 0) {
        ctx.print('Context cleared. (No new session id returned.)');
        return;
      }

      ctx.print(`✓ Context cleared. New session: ${newId.slice(0, ID_PREFIX_LEN)}`);
    },
  };
}
