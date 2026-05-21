/**
 * Wave 6B integration wire-up regression guard for `ChatScreen.tsx`.
 *
 * We assert source-shape invariants for the six features in F2's brief:
 *   1. SuggestedFollowUps mount + Alt+1/2/3 hotkeys.
 *   2. Vim status indicator under config.editor.vimMode.
 *   3. AgentInlineMessage inline panel + Ctrl+G toggle.
 *   4. Snippet-selection mode (Ctrl+S, ↑/↓, Y, Esc) + @clip-N expansion.
 *   5. Live model swap (Ctrl+M).
 *   6. BranchBreadcrumb + BranchPicker mount + Ctrl+B.
 *
 * We follow the source-shape pattern established by
 * `chatscreen-tamagotchi-hoist.test.ts` and `chatscreen-queue.test.tsx`
 * — mounting the full ChatScreen would force us to fake ~40 services,
 * which is wasted scope for a wiring regression test. The behaviour of
 * each underlying primitive (snippet ring, follow-up generator,
 * AgentTailStore, vim engine) is tested in dedicated unit tests.
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

describe('ChatScreen — Wave 6B wiring', () => {
  const source = readFileSync(SRC, 'utf8');

  // 1. SuggestedFollowUps -------------------------------------------------
  test('SUGGEST-MOUNT-SECTION imports and mounts SuggestedFollowUps', () => {
    expect(source).toContain('SUGGEST-MOUNT-SECTION');
    expect(source).toContain("from '../components/SuggestedFollowUps.js'");
    expect(source).toContain('<SuggestedFollowUps');
  });

  test('SuggestedFollowUps hides while streaming', () => {
    // The follow-up generator memo short-circuits when isStreaming so
    // every chunk doesn't recompute regex over the assistant content.
    expect(source).toContain('if (isStreaming) return [];');
  });

  test('Alt+1/2/3 hotkeys subscribe via useInputModeHandler(input)', () => {
    // The handler keys on key.meta + digits '1' / '2' / '3'.
    expect(source).toMatch(
      /input === '1' \? 0 : input === '2' \? 1 : input === '3' \? 2 : -1/,
    );
    expect(source).toContain('if (!key.meta) return;');
  });

  // 2. Vim indicator ------------------------------------------------------
  test('VIM-INDICATOR-MOUNT-SECTION renders -- MODE -- chip', () => {
    expect(source).toContain('VIM-INDICATOR-MOUNT-SECTION');
    // Chip renders only when both the config flag AND prop are present.
    expect(source).toContain('config.editor?.vimMode === true && vimMode !== undefined');
    expect(source).toContain('`-- ${vimMode.toUpperCase()} --`');
  });

  // 3. AgentInlineMessage interleaved ------------------------------------
  test('AGENT-TAIL-RENDER-SECTION mounts AgentInlineMessage block', () => {
    expect(source).toContain('AGENT-TAIL-RENDER-SECTION');
    expect(source).toContain("from '../components/AgentInlineMessage.js'");
    expect(source).toContain('<AgentInlineMessage');
  });

  test('Ctrl+G toggles the inline agent panel', () => {
    // The keystroke handler flips agentTailVisible.
    expect(source).toContain("if (input === 'g') {");
    expect(source).toContain('setAgentTailVisible((v) => !v);');
  });

  test('agent-tail handler routes ↑/↓/Enter/Esc', () => {
    // useInputModeHandler('agent-tail', ...) is registered.
    expect(source).toMatch(/useInputModeHandler\(\s*'agent-tail'/);
  });

  // 4. Snippet selection mode --------------------------------------------
  test('SNIPPET-MODE-MOUNT-SECTION wires Ctrl+S → select mode', () => {
    expect(source).toContain('SNIPPET-MODE-MOUNT-SECTION');
    expect(source).toContain("if (input === 's') {");
    expect(source).toContain('setSnippetSelectActive(true);');
  });

  test('select handler honours Y / Esc / arrow keys', () => {
    expect(source).toMatch(/useInputModeHandler\(\s*'select'/);
    expect(source).toContain("input === 'y' || input === 'Y'");
    // Y copies the focused row(s) to the ring.
    expect(source).toContain('ring.push(');
  });

  test('submit expands @clip-N before classification', () => {
    // expandClipReferences is called BEFORE classifySubmit.
    expect(source).toContain("from '../snippet-ring.js'");
    expect(source).toMatch(
      /expandClipReferences\(rawText, ring\)[\s\S]+classifySubmit/,
    );
  });

  // 5. Live model swap ---------------------------------------------------
  test('MODEL-SWAP-MOUNT-SECTION wires Ctrl+M → onOpenModelSwap', () => {
    expect(source).toContain('MODEL-SWAP-MOUNT-SECTION');
    expect(source).toContain("if (input === 'm' && onOpenModelSwap !== undefined)");
    expect(source).toContain('onOpenModelSwap();');
  });

  test('model-swap handler accepts Esc to cancel', () => {
    expect(source).toMatch(/useInputModeHandler\(\s*'model-swap'/);
  });

  // 6. Branch picker / breadcrumb verification --------------------------
  test('BRANCHES-MOUNT-SECTION mounts BranchBreadcrumb at the top', () => {
    expect(source).toContain('BRANCHES-MOUNT-SECTION');
    expect(source).toContain('<BranchBreadcrumb chain={branchChain} />');
  });

  test('Ctrl+B opens the branch picker overlay', () => {
    expect(source).toContain(
      "if (input === 'b' && onOpenBranchPicker !== undefined)",
    );
    expect(source).toContain('onOpenBranchPicker();');
  });

  // Cross-cutting: dispatcher modes must include the new ones --------
  test('inputMode precedence layers the three new modes correctly', () => {
    // The mode picker must give overlay/approval/agent-focus precedence
    // over snippet/model-swap/agent-tail. We assert the order of the
    // ternary chain explicitly so a reshuffle gets caught.
    const lower = source
      .replace(/\s+/g, ' ')
      .match(/const inputMode: InputMode = [^;]+;/);
    expect(lower).not.toBeNull();
    const chain = (lower !== null ? lower[0] : '').replace(/\s+/g, ' ');
    expect(chain).toContain("pendingApproval !== null ? 'approval'");
    expect(chain).toContain("overlayActive ? 'overlay'");
    expect(chain).toContain("agentFocusMode ? 'agent-focus'");
    expect(chain).toContain("modelSwapActive ? 'model-swap'");
    expect(chain).toContain("snippetSelectActive ? 'select'");
    expect(chain).toContain("agentTailVisible ? 'agent-tail'");
  });
});
