/**
 * Composer — queue-while-streaming routing.
 *
 * The full Composer mount depends on the ApiClients context (REST + WS
 * clients), which is intentionally NOT exported (mirrors
 * `Composer.dragdrop.test.tsx` and `App.test.tsx` which solve the same
 * problem via static source inspection). Here we lock the QUEUE-NEXT
 * contract by asserting the source contains the exact streaming-branch
 * routing — submit while `props.streaming === true` MUST call
 * `props.onQueue(text)` and MUST NOT call `props.onSend`.
 *
 * Also covers the i18n + handler types that depend on the new store
 * action shape: ChatView's `onQueueMessage` must invoke
 * `enqueueMessage` (not the legacy `enqueuePending`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const composerSource = readFileSync(
  resolve(__dirname, 'Composer.tsx'),
  'utf8',
);

const chatViewSource = readFileSync(
  resolve(__dirname, 'ChatView.tsx'),
  'utf8',
);

describe('Composer — queue-next routing (QUEUE-NEXT-SECTION)', () => {
  test('source contains the QUEUE-NEXT-SECTION marker (start + end)', () => {
    expect(composerSource).toMatch(/QUEUE-NEXT-SECTION — start/);
    expect(composerSource).toMatch(/QUEUE-NEXT-SECTION — end/);
  });

  test('streaming branch routes to props.onQueue and returns before onSend', () => {
    // The exact branch from the production source: when props.streaming
    // is true the handler must call onQueue(text) and early-return so
    // onSend(...) is never invoked for the same submission.
    expect(composerSource).toMatch(/if\s*\(\s*props\.streaming\s*\)/);
    expect(composerSource).toMatch(/props\.onQueue\(text\)/);
    // The early-return immediately after onQueue is the safety guard.
    expect(composerSource).toMatch(
      /props\.onQueue\(text\)\s*;\s*\n\s*return\s*;/,
    );
  });

  test('canSend gate does not require streaming === false', () => {
    // The composer keeps accepting input while streaming — only
    // `disabled` (no session) and `sending` (in-flight WS ack) block
    // submission. Regression guard for the "always-on input" requirement.
    expect(composerSource).toMatch(
      /const canSend\s*=\s*\n?\s*!props\.disabled\s*&&\s*\n?\s*!props\.sending/,
    );
    // Explicit: `streaming` must NOT appear in the canSend predicate.
    const canSendBlock = composerSource.match(
      /const canSend\s*=[\s\S]*?;\s*\n/u,
    );
    expect(canSendBlock).not.toBeNull();
    if (canSendBlock !== null) {
      expect(canSendBlock[0]).not.toMatch(/!props\.streaming/);
    }
  });
});

describe('ChatView — onQueueMessage wires to enqueueMessage', () => {
  test('imports the renamed enqueueMessage action (not the legacy enqueuePending)', () => {
    expect(chatViewSource).toMatch(/s\.enqueueMessage/);
    expect(chatViewSource).not.toMatch(/s\.enqueuePending/);
  });

  test('drains via drainPendingQueue and joins items with double newline', () => {
    expect(chatViewSource).toMatch(/drainPendingQueue\(\)/);
    expect(chatViewSource).toMatch(/\.map\(\(it\)\s*=>\s*it\.content\)\.join\('\\n\\n'\)/);
  });

  test('session switch clears the pending queue', () => {
    expect(chatViewSource).toMatch(/clearPendingQueue\(\)/);
  });
});
