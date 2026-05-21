/**
 * Wave 5A (TA team) — CommandPalette overlay.
 *
 * The palette is mounted in app.tsx as a takeover screen (mirrors
 * ProviderOverlay / SettingsOverlay). Triggered via Ctrl+K at the
 * app-root useInput pump, or via `/` from an empty composer (future
 * trigger). Selection types are flat: command | file | session | tool.
 *
 * Tests verify:
 *   - `buildRankedRows` (the pure ranker) produces sensible output
 *     for empty and non-empty queries.
 *   - `app.tsx` actually mounts the CommandPalette inside the
 *     CMD-PALETTE-MOUNT-SECTION markers and wires the Ctrl+K trigger.
 *
 * The component itself is interactive — we trust the ranker tests +
 * source-shape mount-site checks rather than driving ink keystrokes
 * (the existing ChatScreen tests follow the same pattern).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRankedRows,
  PALETTE_MAX_ROWS,
  type PaletteCommand,
  type PaletteFile,
  type PaletteSession,
  type PaletteTool,
} from '@/ui/overlays/CommandPalette';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_TSX = path.resolve(HERE, '..', '..', 'src', 'app.tsx');

const COMMANDS: readonly PaletteCommand[] = [
  { name: 'permissions', description: 'Manage auto-approve list' },
  { name: 'provider', description: 'Switch backend / model URL' },
  { name: 'context', description: 'Inspect context manager' },
  { name: 'ctxsize', description: 'Resize the rolling window' },
  { name: 'model', description: 'Pick a model from the catalog' },
];
const FILES: readonly PaletteFile[] = [
  { path: 'src/app.tsx' },
  { path: 'src/ui/screens/ChatScreen.tsx' },
  { path: 'src/llm/tool-executor.ts' },
];
const SESSIONS: readonly PaletteSession[] = [
  { id: 's1', title: 'Fix OpenRouter 429 handler', updatedAt: Date.now() },
  { id: 's2', title: 'Hookup browser tools', updatedAt: Date.now() - 60_000 },
];
const TOOLS: readonly PaletteTool[] = [
  { name: 'read_file', description: 'Read a file from the project root' },
  { name: 'write_file', description: 'Write content to a project file' },
  { name: 'run_command', description: 'Execute a shell command' },
];

describe('CommandPalette — buildRankedRows (pure ranker)', () => {
  test('empty query returns the first PALETTE_MAX_ROWS rows across all categories', () => {
    const rows = buildRankedRows('', COMMANDS, FILES, SESSIONS, TOOLS);
    // All four categories are present (the fixture has fewer than 30
    // total rows so the empty-query branch returns everything).
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(PALETTE_MAX_ROWS);
    const cats = new Set(rows.map((r) => r.category));
    expect(cats.has('command')).toBe(true);
    expect(cats.has('file')).toBe(true);
    expect(cats.has('session')).toBe(true);
    expect(cats.has('tool')).toBe(true);
  });

  test('typed query filters + ranks across categories', () => {
    const rows = buildRankedRows('perm', COMMANDS, FILES, SESSIONS, TOOLS);
    expect(rows.length).toBeGreaterThan(0);
    // The command row /permissions should appear in the result set
    // because the ranker scored its label highly.
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('/permissions');
  });

  test('typed query that matches nothing returns zero rows', () => {
    const rows = buildRankedRows('xyzqq', COMMANDS, FILES, SESSIONS, TOOLS);
    expect(rows).toHaveLength(0);
  });

  test('rows carry the selection payload the parent will consume', () => {
    const rows = buildRankedRows('chat', COMMANDS, FILES, SESSIONS, TOOLS);
    // ChatScreen.tsx is the most prominent "chat" candidate.
    const fileRow = rows.find((r) => r.category === 'file');
    expect(fileRow).toBeDefined();
    if (fileRow !== undefined) {
      expect(fileRow.selection.kind).toBe('file');
      if (fileRow.selection.kind === 'file') {
        expect(fileRow.selection.path).toContain('.tsx');
      }
    }
  });

  test('caps result list at PALETTE_MAX_ROWS', () => {
    const manyCommands: PaletteCommand[] = Array.from({ length: 50 }, (_, i) => ({
      name: `cmd-${i}-perm`,
      description: `perm ${i}`,
    }));
    const rows = buildRankedRows('perm', manyCommands, [], [], []);
    expect(rows.length).toBeLessThanOrEqual(PALETTE_MAX_ROWS);
  });

  test('rows return command selection.kind === "command" with the slash-stripped name', () => {
    const rows = buildRankedRows('provider', COMMANDS, FILES, SESSIONS, TOOLS);
    const cmd = rows.find((r) => r.category === 'command');
    expect(cmd).toBeDefined();
    if (cmd !== undefined && cmd.selection.kind === 'command') {
      expect(cmd.selection.name).toBe('provider');
    }
  });
});

describe('CommandPalette — mount-site invariants in app.tsx', () => {
  const appSrc = readFileSync(APP_TSX, 'utf8');

  test('app.tsx imports CommandPalette + type exports', () => {
    expect(appSrc).toContain("from '@/ui/overlays/CommandPalette'");
    expect(appSrc).toContain('type PaletteSelection');
  });

  test('app.tsx contains the CMD-PALETTE-MOUNT-SECTION markers', () => {
    expect(appSrc).toContain('CMD-PALETTE-MOUNT-SECTION');
    expect(appSrc).toContain('CMD-PALETTE-MOUNT-SECTION-END');
  });

  test('Ctrl+K toggles the palette in the app-root useInput handler', () => {
    // The key handler lives next to the existing Ctrl+C exit handler
    // to guarantee it sits inside the top-level useInput pump.
    expect(appSrc).toMatch(
      /key\.ctrl[\s\S]{0,40}\(input === 'k'[\s\S]{0,40}setPaletteOpen/,
    );
  });

  test('palette is mounted as a takeover branch above the ChatScreen render', () => {
    expect(appSrc).toContain('<CommandPalette');
    // The flag-gated branch returns the palette before reaching the
    // ChatScreen render, mirroring ProviderOverlay.
    const paletteIdx = appSrc.indexOf('<CommandPalette');
    const chatIdx = appSrc.indexOf('<ChatScreen');
    expect(paletteIdx).toBeGreaterThan(-1);
    expect(chatIdx).toBeGreaterThan(-1);
    expect(paletteIdx).toBeLessThan(chatIdx);
  });

  test('onPaletteSelect handler dispatches on the four selection kinds', () => {
    // The switch covers `command | file | session | tool` (the
    // PaletteSelection union). Future renames must keep this branch
    // exhaustive or TypeScript will flag the _exhaustive guard.
    expect(appSrc).toContain('onPaletteSelect');
    expect(appSrc).toMatch(/case 'command'/);
    expect(appSrc).toMatch(/case 'file'/);
    expect(appSrc).toMatch(/case 'session'/);
    expect(appSrc).toMatch(/case 'tool'/);
  });
});
