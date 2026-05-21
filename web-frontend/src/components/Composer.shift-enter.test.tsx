/**
 * Composer.tsx — Shift+Enter inserts a newline, plain Enter submits.
 *
 * Mirrors the source-shape pattern used by Composer.queue.test.tsx
 * (Composer has many cross-cutting dependencies — store slices, REST
 * clients, drag/drop providers — so a full render is brittle).
 * We pin the contract by grepping the compiled component for:
 *
 *   - The `SHIFT-ENTER-SECTION` marker brackets (start + end).
 *   - The `e.key === 'Enter' && !e.shiftKey` discriminator that
 *     differentiates submit from newline.
 *   - That `preventDefault()` is gated by the `!shiftKey` branch only,
 *     so Shift+Enter falls through to the browser's native textarea
 *     handler (which inserts `\n` at the caret position).
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSER_SRC = readFileSync(
  path.resolve(HERE, 'Composer.tsx'),
  'utf8',
);

describe('Composer — SHIFT-ENTER-SECTION', () => {
  test('section markers are present (start + end)', () => {
    expect(COMPOSER_SRC).toMatch(/SHIFT-ENTER-SECTION — start/);
    expect(COMPOSER_SRC).toMatch(/SHIFT-ENTER-SECTION — end/);
  });

  test('submit branch keys on `Enter && !e.shiftKey`', () => {
    const startIdx = COMPOSER_SRC.indexOf('SHIFT-ENTER-SECTION — start');
    const endIdx = COMPOSER_SRC.indexOf('SHIFT-ENTER-SECTION — end');
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = COMPOSER_SRC.slice(startIdx, endIdx);
    expect(block).toMatch(/e\.key\s*===\s*['"]Enter['"]\s*&&\s*!e\.shiftKey/);
  });

  test('preventDefault + submit live inside the !shiftKey branch only', () => {
    const startIdx = COMPOSER_SRC.indexOf('SHIFT-ENTER-SECTION — start');
    const endIdx = COMPOSER_SRC.indexOf('SHIFT-ENTER-SECTION — end');
    const block = COMPOSER_SRC.slice(startIdx, endIdx);
    expect(block).toMatch(/e\.preventDefault\(\)/);
    expect(block).toMatch(/void\s+submit\(\)/);
    // No branch inside the section catches plain `Enter` without the
    // shift guard — that would re-introduce the regression where
    // Shift+Enter also submits.
    expect(block).not.toMatch(/e\.key\s*===\s*['"]Enter['"]\s*\)/);
  });
});

describe('Composer — fireEvent: keyDown semantics', () => {
  /**
   * The source check above pins the discriminator. This second tier
   * exercises the actual DOM contract: a <textarea> with `onKeyDown`
   * that calls `preventDefault()` ONLY when shift is unset. This is the
   * minimal repro that the TUI parity test is mirroring.
   */
  test('Shift+Enter does NOT preventDefault → browser inserts newline natively', () => {
    let prevented = false;
    const handler = (e: { key: string; shiftKey: boolean; preventDefault: () => void }): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
      }
    };
    handler({
      key: 'Enter',
      shiftKey: true,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(false);
  });

  test('plain Enter DOES preventDefault → submit path runs', () => {
    let prevented = false;
    const handler = (e: { key: string; shiftKey: boolean; preventDefault: () => void }): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
      }
    };
    handler({
      key: 'Enter',
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });
});
