/**
 * slash-executor — execute web slash commands.
 *
 * The Composer parses `/<name> <args>` and (when the name matches a
 * known command) calls `executeSlashCommand(line, ctx)`. Each command
 * is handled inline (REST call, overlay open, store mutation) and
 * NEVER forwarded to the LLM. This mirrors the TUI's `SlashRegistry`
 * dispatch — commands are interactive UI actions, not chat output.
 *
 * Each result is one of:
 *   - `inline-system-message`  → caller renders `text` as a system
 *                                bubble in the chat surface.
 *   - `overlay-opened`         → an overlay was opened; no chat entry.
 *   - `config-changed`         → REST mutation succeeded; optional
 *                                `text` shown as toast.
 *   - `error`                  → operation failed; `text` carries the
 *                                error message.
 *
 * The executor is intentionally framework-agnostic: tests pass typed
 * fakes for `rest` + `store`.
 */

import type {
  Backend,
  CommandSummary,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  PermissionProfile,
  SetModelRequest,
  SetModelResponse,
  SetOutputStyleRequest,
  SetOutputStyleResponse,
  SetProfileRequest,
  SetProfileResponse,
  SetProviderRequest,
  SetProviderResponse,
} from '../../../src/web/protocol/rest-types.js';

export type SlashExecResultKind =
  | 'inline-system-message'
  | 'overlay-opened'
  | 'config-changed'
  | 'error';

export interface SlashExecResult {
  kind: SlashExecResultKind;
  /** Human-readable text. Caller decides how to surface it. */
  text?: string;
}

/**
 * Minimal REST surface the executor needs. Mirrors the methods on
 * `RestClient` so the real client can be passed directly and tests can
 * implement a minimal fake.
 */
export interface SlashRestSurface {
  setModel(req: SetModelRequest): Promise<SetModelResponse>;
  setProvider(req: SetProviderRequest): Promise<SetProviderResponse>;
  setProfile(req: SetProfileRequest): Promise<SetProfileResponse>;
  setOutputStyle(req: SetOutputStyleRequest): Promise<SetOutputStyleResponse>;
  deleteSession(sessionId: string): Promise<DeleteSessionResponse>;
  createSession(req: CreateSessionRequest): Promise<CreateSessionResponse>;
}

/**
 * Discriminated union of overlay kinds the executor can request. Kept
 * narrow so the test fake doesn't have to mirror the full `OpenOverlay`
 * union from the zustand store.
 */
export type SlashOverlayRequest =
  | { kind: 'settings' }
  | { kind: 'memory' }
  | { kind: 'hooks' }
  | { kind: 'usage' }
  | { kind: 'agents-config' }
  | { kind: 'skills' }
  | { kind: 'slash-commands' }
  | { kind: 'session-search' };

/**
 * Store actions the executor needs. Same shape as the zustand store but
 * narrowed to the slice we actually call.
 */
export interface SlashStoreSurface {
  openOverlay: (next: SlashOverlayRequest) => void;
  openWhiteboard?: () => void;
  setActiveSession: (id: string | null) => void;
  clearSessionMessages: (sessionId: string) => void;
  pushToast: (toast: {
    level: 'info' | 'success' | 'warning' | 'error';
    message: string;
  }) => void;
}

export interface SlashExecCtx {
  rest: SlashRestSurface;
  store: SlashStoreSurface;
  /** Active session id. Required for `/clear`. */
  sessionId: string | null;
  /** Active project id. Required for `/clear`. */
  projectId: string | null;
  /** Active backend. Captured for diagnostics; not currently sent on create. */
  backend: Backend | null;
  /** Active model. Required for `/clear` so the replacement session keeps it. */
  model: string | null;
  /** Full known-command list — used by `/help`. */
  commands: ReadonlyArray<CommandSummary>;
}

/**
 * Render a Markdown-ish help table from the command list. Kept inline
 * so callers can render it as a system message.
 */
function renderHelpText(commands: ReadonlyArray<CommandSummary>): string {
  if (commands.length === 0) {
    return 'No slash commands available.';
  }
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = ['**Available slash commands**', ''];
  for (const c of sorted) {
    const usage =
      c.usage !== undefined && c.usage.length > 0 ? ` — \`${c.usage}\`` : '';
    lines.push(`- \`/${c.name}\`${usage} — ${c.description}`);
  }
  return lines.join('\n');
}

/**
 * Names recognised by the executor — every known slash command this
 * module can dispatch. Composer consults this set to decide whether to
 * intercept the input or fall back to its existing unknown-command path.
 */
export const KNOWN_EXEC_COMMANDS: ReadonlySet<string> = new Set([
  'help',
  'clear',
  'model',
  'provider',
  'profile',
  'style',
  'memory',
  'hooks',
  'settings',
  'usage',
  'cost',
  'agents',
  'diff',
  'whiteboard',
  'skills',
  'resume',
]);

export async function executeSlashCommand(
  line: string,
  ctx: SlashExecCtx,
): Promise<SlashExecResult> {
  if (line.length === 0 || line.charAt(0) !== '/') {
    return { kind: 'error', text: 'Not a slash command' };
  }
  const trimmed = line.slice(1).trim();
  const firstSpace = trimmed.indexOf(' ');
  const name = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace))
    .toLowerCase();
  const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  if (name.length === 0) {
    return { kind: 'error', text: 'Empty command' };
  }

  // ----- Overlay openers (pure UI). -----
  if (name === 'settings') {
    ctx.store.openOverlay({ kind: 'settings' });
    return { kind: 'overlay-opened' };
  }
  if (name === 'memory') {
    ctx.store.openOverlay({ kind: 'memory' });
    return { kind: 'overlay-opened' };
  }
  if (name === 'hooks') {
    ctx.store.openOverlay({ kind: 'hooks' });
    return { kind: 'overlay-opened' };
  }
  if (name === 'usage' || name === 'cost') {
    // No dedicated cost overlay yet — the usage dashboard's "today" tab
    // is the per-session cost rollup, so both names route there.
    ctx.store.openOverlay({ kind: 'usage' });
    return { kind: 'overlay-opened' };
  }
  if (name === 'agents') {
    ctx.store.openOverlay({ kind: 'agents-config' });
    return { kind: 'overlay-opened' };
  }
  if (name === 'skills') {
    ctx.store.openOverlay({ kind: 'skills' });
    return { kind: 'overlay-opened' };
  }
  if (name === 'resume') {
    // Resume == cross-session search overlay (FTS). The user picks the
    // session to jump back to.
    ctx.store.openOverlay({ kind: 'session-search' });
    return { kind: 'overlay-opened' };
  }
  if (name === 'whiteboard') {
    if (ctx.store.openWhiteboard !== undefined) {
      ctx.store.openWhiteboard();
      return { kind: 'overlay-opened' };
    }
    return { kind: 'error', text: 'Whiteboard not available' };
  }
  if (name === 'diff') {
    // No standalone diff overlay in the web UI yet; surface the slash
    // commands overlay so the user can see the related entries.
    ctx.store.openOverlay({ kind: 'slash-commands' });
    return {
      kind: 'inline-system-message',
      text: 'Diff viewer is not yet available in the web UI. Use the TUI for now.',
    };
  }

  // ----- Help. -----
  if (name === 'help') {
    return {
      kind: 'inline-system-message',
      text: renderHelpText(ctx.commands),
    };
  }

  // ----- REST-backed commands. -----
  if (name === 'clear') {
    if (ctx.sessionId === null) {
      return { kind: 'error', text: 'No active session to clear' };
    }
    if (ctx.projectId === null) {
      return {
        kind: 'error',
        text: 'Cannot create a replacement session without an active project',
      };
    }
    try {
      const oldId = ctx.sessionId;
      await ctx.rest.deleteSession(oldId);
      ctx.store.clearSessionMessages(oldId);
      const req: CreateSessionRequest = { projectId: ctx.projectId };
      if (ctx.model !== null) req.model = ctx.model;
      const created = await ctx.rest.createSession(req);
      ctx.store.setActiveSession(created.session.id);
      return {
        kind: 'config-changed',
        text: 'Conversation cleared. Started a new session.',
      };
    } catch (err) {
      return {
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to clear session',
      };
    }
  }

  if (name === 'model') {
    if (args.length === 0) {
      return { kind: 'error', text: 'Usage: /model <model-name>' };
    }
    try {
      await ctx.rest.setModel({ model: args });
      return { kind: 'config-changed', text: `Model switched to ${args}` };
    } catch (err) {
      return {
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to switch model',
      };
    }
  }

  if (name === 'provider') {
    if (args.length === 0) {
      return {
        kind: 'error',
        text: 'Usage: /provider <ollama|lmstudio|openai|anthropic|openrouter|google|custom>',
      };
    }
    const head = args.split(/\s+/u)[0] ?? '';
    const backend = parseBackend(head);
    if (backend === null) {
      return { kind: 'error', text: `Unknown provider: ${head}` };
    }
    try {
      await ctx.rest.setProvider({ type: backend });
      return { kind: 'config-changed', text: `Provider switched to ${backend}` };
    } catch (err) {
      return {
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to switch provider',
      };
    }
  }

  if (name === 'profile') {
    if (args.length === 0) {
      return {
        kind: 'error',
        text: 'Usage: /profile <default|acceptEdits|plan|dontAsk|bypassPermissions>',
      };
    }
    const head = args.split(/\s+/u)[0] ?? '';
    const profile = parseProfile(head);
    if (profile === null) {
      return { kind: 'error', text: `Unknown profile: ${head}` };
    }
    try {
      await ctx.rest.setProfile({ profile });
      return { kind: 'config-changed', text: `Profile switched to ${profile}` };
    } catch (err) {
      return {
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to switch profile',
      };
    }
  }

  if (name === 'style') {
    if (args.length === 0) {
      return {
        kind: 'error',
        text: 'Usage: /style <concise|explanatory|verbose>',
      };
    }
    const head = args.split(/\s+/u)[0] ?? '';
    if (head !== 'concise' && head !== 'explanatory' && head !== 'verbose') {
      return { kind: 'error', text: `Unknown output style: ${head}` };
    }
    try {
      await ctx.rest.setOutputStyle({ outputStyle: head });
      return { kind: 'config-changed', text: `Output style switched to ${head}` };
    } catch (err) {
      return {
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to switch output style',
      };
    }
  }

  return {
    kind: 'error',
    text: `Unknown command: /${name}. Type /help for the full list.`,
  };
}

/**
 * Narrow a freeform argument to a known `Backend` literal. Accepts the
 * common `lm-studio` alias and normalises it to `lmstudio`.
 */
function parseBackend(raw: string): Backend | null {
  const v = raw.toLowerCase();
  if (
    v === 'ollama' ||
    v === 'lmstudio' ||
    v === 'openai' ||
    v === 'anthropic' ||
    v === 'openrouter' ||
    v === 'google' ||
    v === 'custom'
  ) {
    return v;
  }
  if (v === 'lm-studio') return 'lmstudio';
  return null;
}

function parseProfile(raw: string): PermissionProfile | null {
  if (
    raw === 'default' ||
    raw === 'acceptEdits' ||
    raw === 'plan' ||
    raw === 'dontAsk' ||
    raw === 'bypassPermissions'
  ) {
    return raw;
  }
  return null;
}
