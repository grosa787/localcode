/**
 * Regression tests for the Agent 8 R4 slash-routing fix.
 *
 * Background:
 *   - `ChatScreen.submit()` intercepts every single-`/` line and routes
 *     it through the SlashRegistry. Unknown `/foo` does NOT fall
 *     through to the LLM (would have leaked otherwise).
 *   - `//literal` is the escape — strips the leading `/` and sends the
 *     rest as a normal user message.
 *   - Lookup is case-insensitive: `/Permissions` matches a registered
 *     `permissions` command.
 *
 * The submit() helper is a private method on the ink-rendered
 * ChatScreen; unit-testing it requires `ink-testing-library`. The
 * regression-relevant logic actually lives in the SlashRegistry — it
 * is the SlashRegistry that performs the case-insensitive lookup the
 * fix relies on. We assert the SlashRegistry contract here.
 *
 * The `//literal` escape behaviour lives entirely inside ChatScreen
 * and is not exercised here — Agent 8 R4 documented a manual smoke
 * harness as the regression evidence for that path.
 */
import { describe, test, expect } from 'bun:test';
import {
  SlashRegistry,
  SlashRegistryError,
} from '@/commands/slash-registry';
import type { SlashCommand } from '@/types/global';

function cmd(name: string, description = ''): SlashCommand {
  return {
    name,
    description,
    execute: () => {
      /* no-op */
    },
  };
}

describe('SlashRegistry — case-insensitive lookup (regression for #34/#35 routing)', () => {
  test('mixed-case lookup of `/Permissions` matches registered `permissions`', () => {
    const r = new SlashRegistry();
    r.register(cmd('permissions'));
    expect(r.get('/Permissions')?.name).toBe('permissions');
    expect(r.get('Permissions')?.name).toBe('permissions');
    expect(r.get('PERMISSIONS')?.name).toBe('permissions');
    expect(r.get('/permissions')?.name).toBe('permissions');
  });

  test('mixed-case lookup of /Compress and /Settings (R5 commands) succeeds', () => {
    const r = new SlashRegistry();
    r.register(cmd('compress'));
    r.register(cmd('settings'));
    expect(r.get('/Compress')?.name).toBe('compress');
    expect(r.get('/SETTINGS')?.name).toBe('settings');
    expect(r.get('Compress')?.name).toBe('compress');
  });

  test('registering the same name twice throws (case-insensitive duplicate)', () => {
    const r = new SlashRegistry();
    r.register(cmd('permissions'));
    expect(() => r.register(cmd('permissions'))).toThrow(SlashRegistryError);
    // Different case, same logical name → also rejected.
    expect(() => r.register(cmd('Permissions'))).toThrow(SlashRegistryError);
    expect(() => r.register(cmd('PERMISSIONS'))).toThrow(SlashRegistryError);
  });

  test('search prefix-matches case-insensitively', () => {
    const r = new SlashRegistry();
    r.registerAll([cmd('compress'), cmd('settings'), cmd('permissions')]);
    const matches = r.search('/COM');
    expect(matches.map((c) => c.name)).toEqual(['compress']);
  });

  test('unknown command lookup returns null (registry never throws)', () => {
    const r = new SlashRegistry();
    r.register(cmd('compress'));
    expect(r.get('/totally-unknown')).toBeNull();
    expect(r.get('Unknown')).toBeNull();
  });
});

describe('SlashRegistry — name validation', () => {
  test('register rejects names that themselves start with /', () => {
    const r = new SlashRegistry();
    expect(() => r.register(cmd('/leading'))).toThrow(SlashRegistryError);
  });

  test('register rejects empty names', () => {
    const r = new SlashRegistry();
    expect(() => r.register(cmd(''))).toThrow(SlashRegistryError);
  });
});
