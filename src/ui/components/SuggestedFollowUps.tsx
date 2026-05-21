/**
 * SuggestedFollowUps — composer power feature #3.
 *
 * After every assistant message commits, three ghost-button rows
 * appear below the dynamic area with proposed next-questions. The user
 * picks one via Alt+1 / Alt+2 / Alt+3 and the host inserts it into the
 * composer (or sends immediately — host's call). Suggestions are
 * generated cheaply on the client from the last assistant message — no
 * extra LLM round-trip.
 *
 * Heuristics (in priority order, capped at 3):
 *   1. Code references the model just emitted — fenced code blocks +
 *      `name()` / `name(` patterns yield `Explain <name>`, `Test
 *      <name>`, `Refactor <name>`. We dedupe so the same identifier
 *      doesn't fill the entire list.
 *   2. TODO / FIXME comments visible in any fenced code block surface
 *      as `Fix the TODO: <preview>`.
 *   3. Two always-on fallbacks fill any remaining slots: `Continue`
 *      and `Show me the affected files`.
 *
 * The generator is a pure function — easy to unit-test, and easy to
 * call from non-TUI surfaces (the web frontend can render the same
 * suggestions even though the keystroke wiring lives in ChatScreen).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { textMuted } from '../theme.js';

export interface FollowUpSuggestion {
  /** Display label shown next to the hint key. */
  readonly label: string;
  /**
   * Text inserted into the composer (or submitted, host's choice) when
   * the user picks this row. Often identical to `label` but kept as a
   * separate field so labels can stay short while payloads can carry
   * verbose context (`Fix the TODO: …` → `Please fix the TODO …`).
   */
  readonly payload: string;
}

const MAX_SUGGESTIONS = 3;
/**
 * The TUI uses Alt+1/2/3 (ink reports `key.meta === true` plus the
 * digit in `input`). The label in the rendered row is `Alt+N` so the
 * user sees the documented contract; we expose this as a constant so
 * the keymap and the rendering stay in lockstep.
 *
 * NOTE on hotkey choice: Alt is reliable in most modern terminals,
 * but iTerm2's default keymap maps Option to "Esc+<key>" instead of
 * "Meta-<key>" — users running stock iTerm2 may need to switch
 * "Left/Right Option key acts as: Esc+ → Meta" or fall back to typing
 * `Alt+N` manually. Documented in the README. We deliberately do NOT
 * also bind Ctrl+1/2/3 because Ctrl+digit is reserved by ink/tmux for
 * pane navigation and stealing it would break user workflows.
 */
export const FOLLOW_UP_HINT_KEYS: readonly string[] = ['Alt+1', 'Alt+2', 'Alt+3'];

/**
 * Captures `name(` and `name()` patterns the model is likely to be
 * talking about. Conservative: skips numeric leading characters, single
 * letter names, and JS/TS keywords that look like calls (`if`, `for`,
 * …). Captures BOTH definition-style (`function foo(`, `def foo(`) and
 * call-style (`foo(arg)`) so the same identifier surfaces regardless of
 * which the model emitted.
 */
const IDENT_CALL_RE = /\b([a-zA-Z_][a-zA-Z0-9_]{1,63})\s*\(/g;
const KEYWORD_SKIP = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'def',
  'class',
  'new',
  'await',
  'async',
  'yield',
  'throw',
  'super',
  'this',
  'typeof',
  'instanceof',
  'void',
  'do',
  'else',
  'try',
  'finally',
  'with',
  'import',
  'from',
  'export',
  'const',
  'let',
  'var',
  'in',
  'of',
  'as',
  'is',
  'not',
  'and',
  'or',
  'true',
  'false',
  'null',
  'undefined',
  'None',
  'True',
  'False',
  'print',
  'log',
  'console',
]);

/**
 * Extract fenced code blocks (```...```) and inline code (`…`).
 * Returns the concatenated body so downstream patterns can search a
 * single buffer instead of repeatedly walking the message.
 */
function extractCodeFragments(message: string): string {
  const fragments: string[] = [];
  // Fenced blocks first — multiline so we don't try the inline regex on
  // them and double-capture.
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = fenceRe.exec(message);
  let consumed = '';
  while (m !== null) {
    fragments.push(m[1] ?? '');
    consumed += message.slice(m.index, m.index + m[0].length);
    m = fenceRe.exec(message);
  }
  // Strip fenced regions before the inline pass to avoid duplicates.
  const stripped = consumed.length > 0 ? message.replace(/```[^\n]*\n[\s\S]*?```/g, ' ') : message;
  const inlineRe = /`([^`\n]+)`/g;
  let inl: RegExpExecArray | null = inlineRe.exec(stripped);
  while (inl !== null) {
    fragments.push(inl[1] ?? '');
    inl = inlineRe.exec(stripped);
  }
  return fragments.join('\n');
}

function uniqueIdentifiers(codeText: string, limit: number): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  IDENT_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null = IDENT_CALL_RE.exec(codeText);
  while (m !== null) {
    const name = m[1];
    if (name !== undefined && name.length >= 2 && !KEYWORD_SKIP.has(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
      if (out.length >= limit) break;
    }
    m = IDENT_CALL_RE.exec(codeText);
  }
  return out;
}

/**
 * Locate TODO / FIXME comments in a code body. Returns up to `limit`
 * one-line previews, oldest-first. Tolerates both line (`// TODO`,
 * `# FIXME`) and block (`/* TODO …`) comment styles.
 */
function extractTodos(codeText: string, limit: number): readonly string[] {
  const out: string[] = [];
  const re = /(?:\/\/|#|\*|--)\s*(TODO|FIXME)[: ]\s*([^\n]{2,80})/gi;
  let m: RegExpExecArray | null = re.exec(codeText);
  while (m !== null) {
    const note = (m[2] ?? '').trim();
    if (note.length > 0) {
      out.push(note);
      if (out.length >= limit) break;
    }
    m = re.exec(codeText);
  }
  return out;
}

/**
 * Generate up to three follow-up suggestions for the last assistant
 * message. Heuristics layer in priority order; if a layer has no
 * candidates the next layer's items take the empty slot. The final
 * always-on fallback (`Continue`) is appended last so users always have
 * at least one row.
 *
 * Pure function — no side effects, no IO. Trivial to test.
 */
export function generateFollowUps(lastAssistantMessage: string): readonly FollowUpSuggestion[] {
  if (lastAssistantMessage.trim().length === 0) return [];

  const suggestions: FollowUpSuggestion[] = [];
  const code = extractCodeFragments(lastAssistantMessage);

  // 1. Code-reference heuristics.
  const idents = uniqueIdentifiers(code, MAX_SUGGESTIONS);
  if (idents.length > 0) {
    const first = idents[0];
    if (first !== undefined) {
      suggestions.push({
        label: `Explain ${first}()`,
        payload: `Explain ${first}() in detail — what it does, who calls it, edge cases.`,
      });
    }
    if (idents.length > 1) {
      const second = idents[1];
      if (second !== undefined) {
        suggestions.push({
          label: `Test ${second}()`,
          payload: `Write thorough unit tests for ${second}() covering happy paths and edge cases.`,
        });
      }
    } else if (first !== undefined && suggestions.length < MAX_SUGGESTIONS) {
      suggestions.push({
        label: `Test the edge cases of ${first}()`,
        payload: `Write unit tests for ${first}() that focus on edge cases (empty input, large input, error paths).`,
      });
    }
    if (suggestions.length < MAX_SUGGESTIONS) {
      const target = idents[2] ?? idents[0];
      if (target !== undefined) {
        suggestions.push({
          label: `Refactor ${target}()`,
          payload: `Refactor ${target}() for clarity and maintainability — keep the public signature stable.`,
        });
      }
    }
  }

  // 2. TODO heuristics — append until we hit the cap.
  if (suggestions.length < MAX_SUGGESTIONS) {
    const todos = extractTodos(code, MAX_SUGGESTIONS - suggestions.length);
    for (const todo of todos) {
      if (suggestions.length >= MAX_SUGGESTIONS) break;
      const preview = todo.length > 50 ? `${todo.slice(0, 47)}…` : todo;
      suggestions.push({
        label: `Fix the TODO: ${preview}`,
        payload: `Fix the TODO/FIXME: ${todo}`,
      });
    }
  }

  // 3. Always-on fallbacks. Order: `Continue` first (most useful when
  // the model truncated mid-thought), `Show me the affected files`
  // second (orientates the user when the model just edited code).
  if (suggestions.length < MAX_SUGGESTIONS) {
    suggestions.push({
      label: 'Continue',
      payload: 'Continue.',
    });
  }
  if (suggestions.length < MAX_SUGGESTIONS) {
    suggestions.push({
      label: 'Show me the affected files',
      payload: 'List the files you touched in this turn with a one-line summary of the change to each.',
    });
  }

  return suggestions.slice(0, MAX_SUGGESTIONS);
}

export interface SuggestedFollowUpsProps {
  readonly suggestions: readonly FollowUpSuggestion[];
  /**
   * Toggleable via `/suggest off`. When false, render `null` so the
   * component contributes zero vertical space.
   */
  readonly visible: boolean;
}

/**
 * Render up to three ghost rows. Pure presentation; hotkey dispatch
 * happens upstream in ChatScreen so the component itself stays
 * un-coupled to the InputDispatcher. Each row is dimmed with the
 * project's `textMuted` token to match the existing `[Paste #N]` /
 * footer aesthetics.
 */
function SuggestedFollowUpsImpl({
  suggestions,
  visible,
}: SuggestedFollowUpsProps): React.JSX.Element | null {
  if (!visible) return null;
  if (suggestions.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {suggestions.slice(0, MAX_SUGGESTIONS).map((s, i) => {
        const key = FOLLOW_UP_HINT_KEYS[i] ?? `Alt+${i + 1}`;
        return (
          <Text key={i} color={textMuted} dimColor italic>
            {`💡 ${key}: ${s.label}`}
          </Text>
        );
      })}
    </Box>
  );
}

export const SuggestedFollowUps = React.memo(SuggestedFollowUpsImpl);
export default SuggestedFollowUps;
