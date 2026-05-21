/**
 * Regression guard for the two TUI fixes in `ChatScreen.tsx`:
 *
 *  1. `<NoxTamagotchi>` must be rendered OUTSIDE the
 *     `overlayActive ? <Overlay /> : <chat tree />` ternary so it stays
 *     visible during overlays, streaming, and approval prompts.
 *
 *  2. The input row must be edge-to-edge — `<NoxMini>` and the
 *     `<Box width={1} />` left spacer that previously sat between
 *     NoxMini and the InputBar must be gone, so the InputBar starts at
 *     terminal column 0.
 *
 * We assert these as source-shape invariants instead of mounting the
 * full ChatScreen (the component takes ~40 required props that touch
 * SessionManager, SkillsManager, ToolExecutor… not worth the surface
 * area for a layout regression). If a future refactor moves things
 * around it MUST keep these invariants true or update this test
 * deliberately.
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

describe('ChatScreen layout invariants', () => {
  const source = readFileSync(SRC, 'utf8');

  test('NoxMini is no longer rendered in the input row (Bug #2)', () => {
    // The left-side NoxMini block was the source of the visible
    // left padding the user complained about. It must be removed
    // from the chat-tree render path.
    expect(source).not.toContain('{noxMiniElement}');
    // The compact mini variant is also no longer imported.
    expect(source).not.toMatch(/import\s*\{[^}]*\bNoxMini\b[^}]*\}/);
  });

  test('Tamagotchi is hoisted outside the overlay short-circuit (Bug #1)', () => {
    // Both halves of the ternary must come BEFORE the final tamagotchi
    // render. We locate the closing `)}` of the ternary and ensure the
    // {noxTamagotchiElement} usage appears AFTER it in the file.
    const tamagotchiIdx = source.indexOf('{noxTamagotchiElement}');
    expect(tamagotchiIdx).toBeGreaterThan(-1);

    // The overlay branch is gated by `overlayActive ?`. Find that token
    // and the closing of the corresponding ternary's else-branch
    // fragment (`</>\n      )}`). The tamagotchi must live AFTER it.
    const ternaryStart = source.indexOf('overlayActive ? (');
    expect(ternaryStart).toBeGreaterThan(-1);
    expect(ternaryStart).toBeLessThan(tamagotchiIdx);

    // The else-branch fragment closes with `</>\n      )}`. The
    // tamagotchi render must be past that closing as a sibling.
    const elseClose = source.indexOf('</>\n      )}', ternaryStart);
    expect(elseClose).toBeGreaterThan(-1);
    expect(tamagotchiIdx).toBeGreaterThan(elseClose);
  });
});
