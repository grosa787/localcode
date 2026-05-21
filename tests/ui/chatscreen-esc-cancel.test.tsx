/**
 * Source-shape invariants for the Esc-cancels-streaming binding in
 * `ChatScreen.tsx`. Like the other source-shape tests in this folder
 * we grep the compiled source rather than mount the screen — ChatScreen
 * has ~40 required props that touch heavyweight subsystems, so a render
 * test would be brittle and expensive. The pattern checks here are
 * cheap, deterministic, and reliably catch regressions where someone
 * deletes the Esc → onCancel wire-up or moves it outside the marked
 * section.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'screens',
  'ChatScreen.tsx',
);

describe('ChatScreen — ESC-CANCEL-SECTION', () => {
  const src = readFileSync(SCREEN, 'utf8');

  test('section markers are present (start + end)', () => {
    expect(src).toMatch(/\/\/ ESC-CANCEL-SECTION — start/);
    expect(src).toMatch(/\/\/ ESC-CANCEL-SECTION — end/);
  });

  test('an `input`-mode handler keyed on key.escape lives inside the section', () => {
    const startIdx = src.indexOf('// ESC-CANCEL-SECTION — start');
    const endIdx = src.indexOf('// ESC-CANCEL-SECTION — end');
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = src.slice(startIdx, endIdx);
    expect(block).toMatch(/useInputModeHandler\(\s*['"]input['"]/);
    expect(block).toMatch(/key\.escape/);
  });

  test('the section calls `onCancel()` guarded by `isStreaming`', () => {
    const startIdx = src.indexOf('// ESC-CANCEL-SECTION — start');
    const endIdx = src.indexOf('// ESC-CANCEL-SECTION — end');
    const block = src.slice(startIdx, endIdx);
    // Allow whitespace between `if (isStreaming) onCancel();`.
    expect(block).toMatch(/if\s*\(\s*isStreaming\s*\)\s*onCancel\(\)/);
  });

  test('the cancel branch returns a consumed marker so the keystroke does not leak', () => {
    const startIdx = src.indexOf('// ESC-CANCEL-SECTION — start');
    const endIdx = src.indexOf('// ESC-CANCEL-SECTION — end');
    const block = src.slice(startIdx, endIdx);
    expect(block).toMatch(/return\s+true;/);
  });
});
