import { describe, test, expect, beforeEach } from 'bun:test';
import { SlashRegistry, SlashRegistryError } from '@/commands/slash-registry';
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

let r: SlashRegistry;

beforeEach(() => {
  r = new SlashRegistry();
});

describe('SlashRegistry.register / get', () => {
  test('registers and retrieves by name', () => {
    r.register(cmd('init', 'description'));
    expect(r.get('init')?.name).toBe('init');
    expect(r.get('/init')?.name).toBe('init');
    expect(r.get('INIT')?.name).toBe('init');
  });

  test('get returns null for missing command', () => {
    expect(r.get('ghost')).toBeNull();
  });

  test('register refuses empty name', () => {
    expect(() => r.register(cmd(''))).toThrow(SlashRegistryError);
  });

  test('register refuses names starting with /', () => {
    expect(() => r.register(cmd('/slashy'))).toThrow(SlashRegistryError);
  });

  test('duplicate registration throws', () => {
    r.register(cmd('dup'));
    expect(() => r.register(cmd('dup'))).toThrow(SlashRegistryError);
  });
});

describe('SlashRegistry.search', () => {
  beforeEach(() => {
    r.registerAll([cmd('init'), cmd('model'), cmd('resume'), cmd('context')]);
  });

  test('prefix match on non-empty query', () => {
    const matches = r.search('i');
    expect(matches.map((c) => c.name)).toEqual(['init']);
  });

  test('empty query returns all sorted', () => {
    const all = r.search('');
    expect(all.map((c) => c.name)).toEqual(['context', 'init', 'model', 'resume']);
  });

  test('accepts leading slash', () => {
    const matches = r.search('/m');
    expect(matches.map((c) => c.name)).toEqual(['model']);
  });

  test('case-insensitive matching', () => {
    const matches = r.search('MOD');
    expect(matches.map((c) => c.name)).toEqual(['model']);
  });
});

describe('SlashRegistry.getAll / clear / size', () => {
  test('getAll returns commands sorted by name', () => {
    r.register(cmd('b'));
    r.register(cmd('a'));
    r.register(cmd('c'));
    expect(r.getAll().map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  test('clear empties registry', () => {
    r.register(cmd('x'));
    r.clear();
    expect(r.size).toBe(0);
  });

  test('size reflects count', () => {
    expect(r.size).toBe(0);
    r.register(cmd('one'));
    r.register(cmd('two'));
    expect(r.size).toBe(2);
  });
});
