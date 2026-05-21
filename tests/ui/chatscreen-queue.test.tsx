/**
 * Interaction smoke test for the type-ahead-while-busy queue in
 * `ChatScreen.tsx`.
 *
 * The component takes ~40 required props that touch heavyweight
 * subsystems (SessionManager, SkillsManager, ToolExecutor, …). Mounting
 * the whole tree to drive a key flow would be brittle and slow, and the
 * existing `chatscreen-tamagotchi-hoist.test.ts` already established the
 * source-shape invariant pattern for this file. We follow that pattern
 * here: assert the load-bearing pieces of the queue wiring exist in the
 * compiled-source shape so a future refactor can't accidentally regress
 * the contract.
 *
 * The reducer-level concat/clear/double-flush behaviour is exercised in
 * `tests/integration/chat-state-typeahead.test.ts`. This file is the
 * complement: it checks the call-site invariants in ChatScreen.tsx that
 * tie the reducer slice to the user-visible UI.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'screens',
  'ChatScreen.tsx',
);

describe('ChatScreen — type-ahead-while-busy queue invariants', () => {
  const source = readFileSync(SRC, 'utf8');

  test('flush concatenates the queue with \\n\\n', () => {
    // The flush effect must call `pendingQueue.join('\n\n')` so each
    // queued submission reads as a separate paragraph to the model.
    expect(source).toContain("pendingQueue.join('\\n\\n')");
  });

  test('flush is guarded by a re-entrancy ref to prevent double-fire', () => {
    expect(source).toContain('flushedRef');
    // Re-arm on a fresh stream start.
    expect(source).toMatch(/if\s*\(\s*isStreaming\s*\)\s*\{\s*flushedRef\.current\s*=\s*false/);
    // Block on a still-flushed gate.
    expect(source).toMatch(/if\s*\(\s*flushedRef\.current\s*\)\s*return/);
  });

  test('pendingApproval blocks enqueue with a toast', () => {
    // The submit handler must short-circuit during approval.
    expect(source).toContain('Answer the approval prompt first');
  });

  test('streaming submissions are enqueued + show a toast', () => {
    expect(source).toContain('Queued — will send after current turn');
    // Single source of truth: ChatScreen dispatches up via
    // `onEnqueuePending(payload)` instead of mirroring a local
    // useState slice. The host translates this into a
    // `chatDispatch({ type: 'ENQUEUE_PENDING', text: payload })`.
    expect(source).toMatch(/onEnqueuePending\s*\(\s*payload\s*\)/);
  });

  test('whitespace-only payloads are NOT enqueued during streaming', () => {
    // We mirror the reducer guard at the submit site so the toast
    // doesn't promise queueing for an input that won't be queued.
    expect(source).toMatch(/payload\.trim\(\)\.length\s*===\s*0/);
  });

  test('queue indicator follows the spec format', () => {
    expect(source).toContain('queued (will send after this turn)');
  });

  test('double-Esc clears the queue', () => {
    expect(source).toContain('ESC_DOUBLE_PRESS_MS');
    expect(source).toContain('Cleared queued messages');
    // Single Esc still cancels the active stream.
    expect(source).toMatch(/if\s*\(\s*isStreaming\s*\)\s*onCancel\(\s*\)/);
  });

  test('flush effect is gated by lastTurnError (Fix 2)', () => {
    // Source-shape: the flush effect must early-return when
    // `lastTurnError` is non-null. This stops a transient upstream
    // failure during one turn from spamming an error toast for each
    // queued type-ahead message.
    expect(source).toContain('lastTurnError');
    // The gate is the explicit !== null check inside the flush effect.
    expect(source).toMatch(/lastTurnError\s*!==\s*null/);
    // LOCALE-APPLY-SECTION — the literal English banner copy moved
    // into `src/i18n/strings/en.ts`. ChatScreen renders it via
    // `t('chat.queuePausedBanner')` so the user-visible signal survives
    // the migration; we assert on the key invocation, the i18n unit
    // tests cover the actual copy.
    expect(source).toContain("t('chat.queuePausedBanner')");
    // LOCALE-APPLY-SECTION-END
  });

  test('Esc cancel does NOT clear the queue on first press', () => {
    // Sanity: the lone-Esc path must not dispatch `onClearPending()`.
    // The clear call lives only inside the double-press branch.
    const escHandlerStart = source.indexOf('lastEscAtRef.current');
    expect(escHandlerStart).toBeGreaterThan(-1);
    // Locate the double-press branch and ensure the clear lives inside
    // it — i.e. the `onClearPending` call sits AFTER the
    // `if (isDoublePress &&` guard in the Esc handler region.
    const doublePressIdx = source.indexOf('isDoublePress &&', escHandlerStart);
    expect(doublePressIdx).toBeGreaterThan(-1);
    const clearIdx = source.indexOf('onClearPending()', doublePressIdx);
    expect(clearIdx).toBeGreaterThan(doublePressIdx);
  });

  test('reducer pendingQueue is the single source of truth', () => {
    // Source-shape guard: ChatScreen MUST NOT hold a local useState
    // slice for the pending queue. The queue arrives via props
    // (`pendingQueueProp` → `pendingQueue`) and clear/enqueue dispatch
    // through `onClearPending` / `onEnqueuePending` callbacks. If a
    // future refactor accidentally reintroduces `useState<readonly
    // string[]>` for the queue, this test breaks first.
    expect(source).not.toMatch(/useState<\s*readonly\s+string\[\]\s*>\s*\(\s*\[\s*\]\s*\)\s*;[\s\S]{0,40}pendingQueue/);
    expect(source).not.toMatch(/\[\s*pendingQueue\s*,\s*setPendingQueue\s*\]/);
    expect(source).not.toContain('setPendingQueue');
    // The prop wiring is the only path; assert the destructured names
    // are present in the component signature.
    expect(source).toContain('pendingQueue: pendingQueueProp');
    expect(source).toContain('onEnqueuePending');
    expect(source).toContain('onClearPending');
  });

  test('flush effect dispatches onClearPending BEFORE re-submission', () => {
    // The flush concat+submit must clear the reducer-owned queue
    // synchronously before calling `onSubmit`, otherwise the next
    // render observes a stale slice and the re-entrancy guard alone
    // would be load-bearing. We pin source-shape: in the flush effect
    // body, the `onClearPending()` call precedes `onSubmit(concatenated)`.
    const flushIdx = source.indexOf("pendingQueue.join('\\n\\n')");
    expect(flushIdx).toBeGreaterThan(-1);
    const clearIdx = source.indexOf('onClearPending', flushIdx);
    const submitIdx = source.indexOf('onSubmit(concatenated)', flushIdx);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(submitIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(submitIdx);
  });
});
