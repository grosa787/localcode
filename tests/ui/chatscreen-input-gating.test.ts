/**
 * Source-shape invariants for the input-routing fixes in `ChatScreen.tsx`.
 *
 * H1 / M7 / C1 / H2 / M2 / M4 / M9 / L3 / L5: this file pins the
 * load-bearing pieces that prevent keystroke leaks, stale static rows,
 * and animation-lifecycle bugs. Source-shape rather than render-shape
 * for the same reason `chatscreen-tamagotchi-hoist.test.ts` is —
 * ChatScreen takes ~40 required props that touch heavyweight
 * subsystems, and a regression here is much cheaper to detect via grep
 * on the compiled source than via a full mount.
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
const INPUT_BAR = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'components',
  'InputBar.tsx',
);
const APPROVAL = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'components',
  'ApprovalPrompt.tsx',
);
const DIFFVIEW = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'components',
  'DiffView.tsx',
);
const THINKING = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'components',
  'ThinkingBlock.tsx',
);
const NOX = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'components',
  'Nox.tsx',
);

describe('H1 — centralized InputDispatcher routes keystrokes by mode', () => {
  // After the dispatcher refactor, no component (besides the dispatcher
  // itself) calls ink's `useInput` directly. Instead each consumer
  // subscribes via `useInputModeHandler(mode, handler)`. The dispatcher
  // owns mode resolution based on app state (approval / overlay / input)
  // so cross-handler keystroke leaks are architecturally impossible.

  const screen = readFileSync(SRC, 'utf8');
  const bar = readFileSync(INPUT_BAR, 'utf8');
  const approval = readFileSync(APPROVAL, 'utf8');
  const diffview = readFileSync(DIFFVIEW, 'utf8');

  test('InputBar receives `disabled={pendingApproval !== null}`', () => {
    expect(screen).toMatch(/disabled=\{\s*pendingApproval\s*!==\s*null\s*\}/);
  });

  test('InputBar subscribes via useInputModeHandler (no direct useInput)', () => {
    expect(bar).toMatch(/useInputModeHandler\(/);
    // It MUST NOT import ink's useInput anymore.
    expect(bar).not.toMatch(/from\s+['"]ink['"][^;]*useInput/);
  });

  test('ChatScreen mounts InputDispatcherProvider + uses dispatcher hooks', () => {
    expect(screen).toMatch(/InputDispatcherProvider/);
    expect(screen).toMatch(/useInputModeHandler\(\s*['"]input['"]/);
  });

  test('ChatScreen no longer imports ink useInput directly', () => {
    // Comments may still mention `useInput` historically; the IMPORT
    // statement must be free of it. Anchored to the actual import line.
    expect(screen).not.toMatch(/from\s+['"]ink['"][^;]*\buseInput\b/);
  });

  test('ApprovalPrompt subscribes via useInputModeHandler(\'approval\')', () => {
    expect(approval).toMatch(/useInputModeHandler\(\s*['"]approval['"]/);
    expect(approval).not.toMatch(/from\s+['"]ink['"][^;]*useInput/);
  });

  test('DiffView subscribes via useInputModeHandler (approval-or-diff mode)', () => {
    expect(diffview).toMatch(/useInputModeHandler\(/);
    expect(diffview).not.toMatch(/from\s+['"]ink['"][^;]*useInput/);
  });
});

describe('C1 / H3 — Static items must be FINAL before commit', () => {
  const screen = readFileSync(SRC, 'utf8');

  test('isMessageFinal predicate exists and gates static commit', () => {
    expect(screen).toContain('isMessageFinal');
    // Pending or running tool calls must drop the row to the dynamic
    // tail (otherwise pending status freezes in scrollback).
    expect(screen).toMatch(/status\s*===\s*'pending'\s*\|\|\s*status\s*===\s*'running'/);
  });

  test('Split index walks from the tail; static is a strict prefix', () => {
    expect(screen).toContain('splitIndex');
    expect(screen).toContain('staticMessages');
    expect(screen).toContain('pendingMessages');
  });

  test('Static receives staticMessages, NOT a spread of narrowedMessages', () => {
    // C2 — items should NOT be a fresh spread.
    expect(screen).not.toMatch(/items=\{\[\.\.\.\s*narrowedMessages\s*\]\}/);
    // The cast is allowed and documents the readonly→mutable conversion.
    expect(screen).toMatch(/items=\{\s*staticMessages\s+as\s+MessageWithThinking\[\]\s*\}/);
  });

  test('renderStaticItem deps no longer include toolCallStates or sessionTotalOut', () => {
    // The callback identity must not flip on tool-call advances /
    // session-token bumps — those refresh the static frame for no
    // visible benefit. Inspect the deps list at the renderStaticItem
    // declaration site.
    const idx = screen.indexOf('const renderStaticItem');
    expect(idx).toBeGreaterThan(-1);
    // Slice the surrounding useCallback body + deps array.
    const tail = screen.slice(idx, idx + 1400);
    // The deps array sits at the end of the useCallback expression.
    // Verify staticMessages + effectiveModelName are present, and
    // toolCallStates / sessionTotalOut are absent.
    const depsMatch = /\[\s*staticMessages,\s*effectiveModelName\s*\]/.exec(tail);
    expect(depsMatch).not.toBeNull();
  });
});

describe('H2 — ThinkingBlock mounts only on real thinking content', () => {
  const screen = readFileSync(SRC, 'utf8');

  test('mount condition drops the `isStreaming ||` clause', () => {
    // The old condition mounted the block for every streaming turn,
    // including from non-thinking models, painting a phantom header.
    expect(screen).not.toMatch(
      /\{\s*\(\s*isStreaming\s*\|\|\s*\(\s*currentThinking\s*!==\s*undefined/,
    );
    // The replacement must check for non-empty thinking buffer first.
    expect(screen).toMatch(
      /currentThinking\s*!==\s*undefined\s*&&\s*currentThinking\.length\s*>\s*0/,
    );
  });
});

describe('M2 — inputKey churn replaced with resetTrigger', () => {
  const screen = readFileSync(SRC, 'utf8');
  const bar = readFileSync(INPUT_BAR, 'utf8');

  test('ChatScreen exposes a `resetTrigger` state + bumper', () => {
    expect(screen).toMatch(/const\s*\[\s*resetTrigger,\s*setResetTrigger\s*\]/);
    expect(screen).toContain('bumpResetTrigger');
  });

  test('inputKey is bumped only in the overlay-close effect', () => {
    // Counts: declaration + exactly one setInputKey call.
    const matches = screen.match(/setInputKey\(/g);
    expect(matches).not.toBeNull();
    expect(matches?.length ?? 0).toBe(1);
    // The single remaining bump must live next to the overlay-close
    // comment, so locate the call and check the preceding context.
    const idx = screen.indexOf('setInputKey((k) => k + 1)');
    expect(idx).toBeGreaterThan(-1);
    const before = screen.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain('overlayActive');
  });

  test('InputBar accepts a resetTrigger prop and watches it via effect', () => {
    expect(bar).toMatch(/readonly\s+resetTrigger\?:\s*number/);
    expect(bar).toMatch(/lastResetTriggerRef/);
  });
});

describe('M4 — history is a single state slice, no parallel ref', () => {
  const screen = readFileSync(SRC, 'utf8');

  test('historyRef is gone; functional setHistory is the only writer', () => {
    // The actual ref declaration must be absent. We allow a casual
    // mention inside the M4 comment that documents the migration.
    expect(screen).not.toMatch(/const\s+historyRef\s*=\s*useRef/);
    expect(screen).not.toMatch(/historyRef\.current\s*=/);
    // Confirm at least one functional updater exists.
    expect(screen).toMatch(/setHistory\(\(prev\)\s*=>\s*\[\.\.\.prev,/);
  });
});

describe('M9 — queue toast timer guards against unmount', () => {
  const screen = readFileSync(SRC, 'utf8');

  test('isMountedRef is wired and the timer short-circuits when false', () => {
    expect(screen).toContain('isMountedRef');
    // Cleanup path nullifies the mount flag.
    expect(screen).toMatch(/isMountedRef\.current\s*=\s*false/);
    // Timer callback bails when the screen is gone.
    expect(screen).toMatch(/if\s*\(!isMountedRef\.current\)\s*return/);
  });
});

describe('L3 / L5 / L6 / L9 — memoised auxiliary components', () => {
  const screen = readFileSync(SRC, 'utf8');
  const diffview = readFileSync(DIFFVIEW, 'utf8');
  const inline = readFileSync(
    path.resolve(
      HERE,
      '..',
      '..',
      'src',
      'ui',
      'components',
      'InlineDiffView.tsx',
    ),
    'utf8',
  );

  test('Separator wrapped in React.memo', () => {
    expect(screen).toMatch(/Separator\s*=\s*React\.memo/);
  });

  test('StreamTimer wrapped in React.memo', () => {
    expect(screen).toMatch(/StreamTimer\s*=\s*React\.memo\(StreamTimerImpl\)/);
  });

  test('DiffView wrapped in React.memo', () => {
    expect(diffview).toMatch(/DiffView\s*=\s*React\.memo\(DiffViewImpl\)/);
  });

  test('InlineDiffView wrapped in React.memo with prop comparator', () => {
    expect(inline).toMatch(/InlineDiffView\s*=\s*React\.memo\(InlineDiffViewImpl,\s*arePropsEqual\)/);
  });
});

describe('H5 — NoxBig reacts to terminal resize', () => {
  const nox = readFileSync(NOX, 'utf8');

  test('NoxBig listens to stdout resize via ink useStdout', () => {
    expect(nox).toContain('useStdout');
    expect(nox).toMatch(/stdout\.on\(\s*['"]resize['"]/);
    expect(nox).toMatch(/stdout\.off\(\s*['"]resize['"]/);
  });
});

describe('M11 — ThinkingBlock memoises line split', () => {
  const t = readFileSync(THINKING, 'utf8');

  test('lines computed via useMemo([text])', () => {
    expect(t).toMatch(/useMemo\(\s*\n?\s*\(\)\s*=>\s*text\.split/);
  });
});
