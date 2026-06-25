import { test, expect } from 'bun:test';
import type { SlashCommand } from '@/types/global';
import { SlashRegistry, SlashRegistryError } from '@/commands/slash-registry';
import { registerBuiltinCommands } from '@/commands';

function stub(name: string): SlashCommand {
  return {
    name,
    description: name,
    usage: `/${name}`,
    execute: (): void => {},
  };
}

/**
 * Regression guard for the v0.24.1 startup brick: the marketplace
 * `/skills browse` command and the `/skills` screen command both named
 * themselves 'skills', and the duplicate registration threw inside a
 * passive-mount effect, crashing the whole TUI ("SlashCommand already
 * registered: /skills"). registerBuiltinCommands must now tolerate a
 * duplicate — log + skip — so one bad command never bricks startup.
 */

test('SlashRegistry.register still throws on a true duplicate (dev contract)', () => {
  const reg = new SlashRegistry();
  reg.register(stub('a'));
  expect(() => reg.register(stub('a'))).toThrow(SlashRegistryError);
});

test('registerBuiltinCommands does NOT throw when a factory name collides', () => {
  const reg = new SlashRegistry();
  // Two factories share the 'skills' name (the exact collision shape).
  expect(() =>
    registerBuiltinCommands(reg, {
      skillsBrowse: stub('skills'),
      // A second distinct command must still register.
      mcpBrowse: stub('mcp'),
    }),
  ).not.toThrow();
});

test('registerBuiltinCommands keeps the first of a colliding pair + the rest', () => {
  const reg = new SlashRegistry();
  // Pre-register a 'skills' screen-style command, then feed a colliding
  // browse factory + an unrelated one. The pre-existing must survive and
  // the unrelated one must still land.
  const screen = stub('skills');
  reg.register(screen);
  registerBuiltinCommands(reg, {
    skillsBrowse: stub('skills'), // collides — skipped
    mcpBrowse: stub('mcp'), // unrelated — registered
  });
  const names = reg.getAll().map((c) => c.name);
  expect(names.filter((n) => n === 'skills')).toHaveLength(1);
  expect(names).toContain('mcp');
});
