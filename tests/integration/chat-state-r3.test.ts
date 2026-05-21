/**
 * R3 additions to chat-state reducer:
 *   - `overlayKind` field on ChatState (`null` by default).
 *   - `SHOW_OVERLAY` action sets the active overlay kind and dismisses
 *     any open SkillInputOverlay so there's exactly one panel at a time.
 *   - `CLOSE_OVERLAY` clears `overlayKind`.
 *   - Other actions (ADD_MESSAGE, START_STREAM, APPEND_CHUNK, etc.) leave
 *     the overlay alone — chat activity must not dismiss a panel the user
 *     is interacting with.
 */
import { describe, test, expect } from 'bun:test';
import { chatReducer, initialChatState } from '@/integration/chat-state';
import type { Message } from '@/types/global';

function userMessage(content: string, id = 'm-id'): Message {
  return { id, role: 'user', content, createdAt: 0 };
}

describe('chatReducer — overlay actions', () => {
  test('initial state has overlayKind: null', () => {
    expect(initialChatState.overlayKind).toBeNull();
  });

  test('SHOW_OVERLAY sets overlayKind', () => {
    const next = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'permissions',
    });
    expect(next.overlayKind).toBe('permissions');
  });

  test('SHOW_OVERLAY accepts every documented kind', () => {
    const kinds = [
      'permissions',
      'context',
      'ctxsize',
      'resume',
      'model',
      'provider',
      'skills',
    ] as const;
    for (const kind of kinds) {
      const next = chatReducer(initialChatState, {
        type: 'SHOW_OVERLAY',
        kind,
      });
      expect(next.overlayKind).toBe(kind);
    }
  });

  test('SHOW_OVERLAY dismisses an open SkillInputOverlay', () => {
    const withSkill = chatReducer(initialChatState, {
      type: 'OPEN_SKILL_OVERLAY',
    });
    expect(withSkill.skillOverlay).toBe(true);

    const next = chatReducer(withSkill, {
      type: 'SHOW_OVERLAY',
      kind: 'permissions',
    });
    expect(next.overlayKind).toBe('permissions');
    expect(next.skillOverlay).toBe(false);
  });

  test('CLOSE_OVERLAY clears overlayKind', () => {
    const opened = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'context',
    });
    const closed = chatReducer(opened, { type: 'CLOSE_OVERLAY' });
    expect(closed.overlayKind).toBeNull();
  });

  test('CLOSE_OVERLAY is a no-op when no overlay is open', () => {
    const closed = chatReducer(initialChatState, { type: 'CLOSE_OVERLAY' });
    expect(closed.overlayKind).toBeNull();
  });

  test('SHOW_OVERLAY twice swaps the kind', () => {
    const a = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'permissions',
    });
    const b = chatReducer(a, { type: 'SHOW_OVERLAY', kind: 'ctxsize' });
    expect(b.overlayKind).toBe('ctxsize');
  });
});

describe('chatReducer — other actions preserve overlayKind', () => {
  function withOverlay(kind: 'permissions' | 'context' = 'permissions') {
    return chatReducer(initialChatState, { type: 'SHOW_OVERLAY', kind });
  }

  test('ADD_MESSAGE preserves overlayKind', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, {
      type: 'ADD_MESSAGE',
      message: userMessage('hi'),
    });
    expect(next.overlayKind).toBe('permissions');
    expect(next.messages.length).toBe(1);
  });

  test('REPLACE_MESSAGES preserves overlayKind', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, {
      type: 'REPLACE_MESSAGES',
      messages: [userMessage('hi', 'a')],
    });
    expect(next.overlayKind).toBe('permissions');
    expect(next.messages.length).toBe(1);
  });

  test('START_STREAM preserves overlayKind', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, { type: 'START_STREAM' });
    expect(next.overlayKind).toBe('permissions');
    expect(next.isStreaming).toBe(true);
  });

  test('APPEND_CHUNK preserves overlayKind', () => {
    const streaming = chatReducer(withOverlay(), { type: 'START_STREAM' });
    const next = chatReducer(streaming, {
      type: 'APPEND_CHUNK',
      text: 'hello',
    });
    expect(next.overlayKind).toBe('permissions');
    expect(next.currentOutput).toBe('hello');
  });

  test('END_STREAM preserves overlayKind', () => {
    const streaming = chatReducer(withOverlay(), { type: 'START_STREAM' });
    const next = chatReducer(streaming, { type: 'END_STREAM' });
    expect(next.overlayKind).toBe('permissions');
    expect(next.isStreaming).toBe(false);
  });

  test('SET_PENDING_APPROVAL preserves overlayKind', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, {
      type: 'SET_PENDING_APPROVAL',
      approval: null,
    });
    expect(next.overlayKind).toBe('permissions');
  });

  test('PUSH_HISTORY preserves overlayKind', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, { type: 'PUSH_HISTORY', text: 'hi' });
    expect(next.overlayKind).toBe('permissions');
    expect(next.inputHistory).toEqual(['hi']);
  });

  test('ENQUEUE_PENDING preserves overlayKind', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, { type: 'ENQUEUE_PENDING', text: 'queued' });
    expect(next.overlayKind).toBe('permissions');
    expect(next.pendingQueue).toEqual(['queued']);
  });

  test('ADD_OUTPUT_TOKENS preserves overlayKind', () => {
    const opened = withOverlay('context');
    const next = chatReducer(opened, {
      type: 'ADD_OUTPUT_TOKENS',
      tokens: 42,
    });
    expect(next.overlayKind).toBe('context');
    expect(next.sessionTotalOut).toBe(42);
  });

  test('UPSERT_TOOL_CALL_STATE preserves overlayKind', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, {
      type: 'UPSERT_TOOL_CALL_STATE',
      id: 't1',
      state: {
        toolName: 'read_file',
        args: {},
        status: 'pending',
      } as never, // we don't depend on the exact shape, just preserving overlayKind
    });
    expect(next.overlayKind).toBe('permissions');
  });

  test('CLEAR_TOOL_CALL_STATES preserves overlayKind', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, { type: 'CLEAR_TOOL_CALL_STATES' });
    expect(next.overlayKind).toBe('permissions');
  });

  test('OPEN_SKILL_OVERLAY does not clear overlayKind (independent panel)', () => {
    // The reducer's SHOW_OVERLAY closes skillOverlay; OPEN_SKILL_OVERLAY
    // is the inverse of CLOSE_SKILL_OVERLAY and shouldn't touch overlayKind.
    const opened = withOverlay();
    const next = chatReducer(opened, { type: 'OPEN_SKILL_OVERLAY' });
    expect(next.skillOverlay).toBe(true);
    expect(next.overlayKind).toBe('permissions');
  });

  test('CLOSE_SKILL_OVERLAY does not clear overlayKind', () => {
    const opened = withOverlay();
    const skillOpen = chatReducer(opened, { type: 'OPEN_SKILL_OVERLAY' });
    const next = chatReducer(skillOpen, { type: 'CLOSE_SKILL_OVERLAY' });
    expect(next.overlayKind).toBe('permissions');
    expect(next.skillOverlay).toBe(false);
  });

  test('RESET clears overlayKind (and everything else)', () => {
    const opened = withOverlay();
    const next = chatReducer(opened, { type: 'RESET' });
    expect(next.overlayKind).toBeNull();
    // Generation increments, the rest is reset.
    expect(next.generation).toBe(opened.generation + 1);
  });
});

/**
 * R13 (Agent 8) — `SHOW_OVERLAY` carries an optional `data.filter`
 * payload that pre-seeds `modelOverlayFilter` for the model overlay.
 * Used by `/model <query>` to land the user on a narrowed list.
 */
describe('chatReducer — SHOW_OVERLAY data payload (R13)', () => {
  test('initial state has modelOverlayFilter: null', () => {
    expect(initialChatState.modelOverlayFilter).toBeNull();
  });

  test('SHOW_OVERLAY model with data.filter sets modelOverlayFilter', () => {
    const next = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'model',
      data: { filter: 'claude' },
    });
    expect(next.overlayKind).toBe('model');
    expect(next.modelOverlayFilter).toBe('claude');
  });

  test('SHOW_OVERLAY model without data leaves modelOverlayFilter null', () => {
    const next = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'model',
    });
    expect(next.overlayKind).toBe('model');
    expect(next.modelOverlayFilter).toBeNull();
  });

  test('SHOW_OVERLAY model with empty/whitespace filter normalises to null', () => {
    const a = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'model',
      data: { filter: '' },
    });
    expect(a.modelOverlayFilter).toBeNull();
    const b = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'model',
      data: { filter: '   ' },
    });
    expect(b.modelOverlayFilter).toBeNull();
  });

  test('SHOW_OVERLAY for non-model kind ignores data.filter', () => {
    const next = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'permissions',
      data: { filter: 'should-not-stick' },
    });
    expect(next.overlayKind).toBe('permissions');
    expect(next.modelOverlayFilter).toBeNull();
  });

  test('SHOW_OVERLAY model resets a stale filter when no new one is supplied', () => {
    // First open with a filter…
    const a = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'model',
      data: { filter: 'claude' },
    });
    expect(a.modelOverlayFilter).toBe('claude');
    // …then the next open without one must wipe the carry-over.
    const b = chatReducer(a, { type: 'SHOW_OVERLAY', kind: 'model' });
    expect(b.modelOverlayFilter).toBeNull();
  });

  test('CLOSE_OVERLAY clears modelOverlayFilter alongside overlayKind', () => {
    const opened = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'model',
      data: { filter: 'claude' },
    });
    expect(opened.modelOverlayFilter).toBe('claude');
    const closed = chatReducer(opened, { type: 'CLOSE_OVERLAY' });
    expect(closed.overlayKind).toBeNull();
    expect(closed.modelOverlayFilter).toBeNull();
  });

  test('Switching from a non-model overlay to model with filter still applies it', () => {
    const perm = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'permissions',
    });
    const model = chatReducer(perm, {
      type: 'SHOW_OVERLAY',
      kind: 'model',
      data: { filter: 'claude' },
    });
    expect(model.overlayKind).toBe('model');
    expect(model.modelOverlayFilter).toBe('claude');
  });

  test('RESET clears modelOverlayFilter', () => {
    const opened = chatReducer(initialChatState, {
      type: 'SHOW_OVERLAY',
      kind: 'model',
      data: { filter: 'claude' },
    });
    const next = chatReducer(opened, { type: 'RESET' });
    expect(next.modelOverlayFilter).toBeNull();
  });
});
