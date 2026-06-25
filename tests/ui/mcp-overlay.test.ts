/**
 * Unit tests for the `/mcp` add-server overlay's pure helper
 * `buildMcpServerFromForm` (validation + auth → headers + URL
 * normalisation) and a regression guard that only ONE `/mcp` command
 * registers (no startup-bricking collision between the screen/overlay
 * command and the marketplace browse command — both name themselves
 * 'mcp').
 */

import { test, expect } from 'bun:test';
import type { McpServerConfig, SlashCommand } from '@/types/global';
import { SlashRegistry } from '@/commands/slash-registry';
import { registerBuiltinCommands } from '@/commands';
import {
  buildMcpServerFromForm,
  normalizeMcpUrl,
  type McpServerForm,
} from '@/ui/components/McpOverlay';

function form(over: Partial<McpServerForm>): McpServerForm {
  return {
    name: 'srv',
    url: 'http://localhost:8080/mcp',
    auth: 'none',
    token: '',
    login: '',
    password: '',
    ...over,
  };
}

function expectOk(
  result: ReturnType<typeof buildMcpServerFromForm>,
): { name: string; server: McpServerConfig } {
  if ('error' in result) {
    throw new Error(`expected ok, got error: ${result.error}`);
  }
  return result;
}

// ---------- auth → headers ----------

test('Bearer auth → { Authorization: "Bearer <token>" }, type http, url normalized', () => {
  const out = expectOk(
    buildMcpServerFromForm(
      form({ auth: 'bearer', token: 'abc', url: 'http://1.2.3.4:9/mcp' }),
    ),
  );
  expect(out.name).toBe('srv');
  expect(out.server.type).toBe('http');
  expect(out.server.url).toBe('http://1.2.3.4:9/mcp');
  expect(out.server.headers).toEqual({ Authorization: 'Bearer abc' });
});

test('Basic auth → { Authorization: "Basic " + base64("user:pass") }', () => {
  const out = expectOk(
    buildMcpServerFromForm(
      form({ auth: 'basic', login: 'user', password: 'pass' }),
    ),
  );
  const expected = `Basic ${btoa('user:pass')}`;
  expect(out.server.headers).toEqual({ Authorization: expected });
});

test('Basic auth base64 round-trips for non-ASCII credentials', () => {
  const login = 'ünïcödé';
  const password = 'pä$$wörd';
  const out = expectOk(
    buildMcpServerFromForm(form({ auth: 'basic', login, password })),
  );
  const header = out.server.headers?.Authorization ?? '';
  const b64 = header.replace(/^Basic /, '');
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
  );
  expect(decoded).toBe(`${login}:${password}`);
});

test('None auth → no Authorization header at all', () => {
  const out = expectOk(buildMcpServerFromForm(form({ auth: 'none' })));
  expect(out.server.headers).toBeUndefined();
});

// ---------- URL normalisation ----------

test('bare host:port gets http:// prepended', () => {
  const out = expectOk(
    buildMcpServerFromForm(form({ url: '192.168.1.10:8080' })),
  );
  expect(out.server.url).toBe('http://192.168.1.10:8080');
});

test('https:// scheme is preserved (no double prefix)', () => {
  const out = expectOk(
    buildMcpServerFromForm(form({ url: 'https://api.example.com/mcp' })),
  );
  expect(out.server.url).toBe('https://api.example.com/mcp');
});

test('normalizeMcpUrl leaves already-schemed URLs untouched and prefixes bare', () => {
  expect(normalizeMcpUrl('http://x:1')).toBe('http://x:1');
  expect(normalizeMcpUrl('https://x:1')).toBe('https://x:1');
  expect(normalizeMcpUrl('x:1')).toBe('http://x:1');
  expect(normalizeMcpUrl('  10.0.0.1:80  ')).toBe('http://10.0.0.1:80');
});

// ---------- validation errors ----------

test('empty name → nameRequired', () => {
  const r = buildMcpServerFromForm(form({ name: '   ' }));
  expect(r).toEqual({ error: 'nameRequired' });
});

test('name with spaces → nameInvalid', () => {
  const r = buildMcpServerFromForm(form({ name: 'my server' }));
  expect(r).toEqual({ error: 'nameInvalid' });
});

test('valid name characters (letters, digits, . _ -) accepted', () => {
  const out = expectOk(buildMcpServerFromForm(form({ name: 'My.Srv_01-x' })));
  expect(out.name).toBe('My.Srv_01-x');
});

test('duplicate name → nameDuplicate', () => {
  const r = buildMcpServerFromForm(
    form({ name: 'dup', existingNames: ['dup', 'other'] }),
  );
  expect(r).toEqual({ error: 'nameDuplicate' });
});

test('empty url → urlRequired', () => {
  const r = buildMcpServerFromForm(form({ url: '   ' }));
  expect(r).toEqual({ error: 'urlRequired' });
});

test('garbage url → urlInvalid', () => {
  // Already-schemed but unparseable host — normalizeMcpUrl leaves the
  // scheme in place and `new URL` throws.
  const r = buildMcpServerFromForm(form({ url: 'http://:::' }));
  expect(r).toEqual({ error: 'urlInvalid' });
});

test('non-http scheme (ftp) → urlInvalid', () => {
  const r = buildMcpServerFromForm(form({ url: 'ftp://host:21' }));
  expect(r).toEqual({ error: 'urlInvalid' });
});

test('Bearer with empty token → tokenRequired', () => {
  const r = buildMcpServerFromForm(form({ auth: 'bearer', token: '  ' }));
  expect(r).toEqual({ error: 'tokenRequired' });
});

test('Basic with empty login → loginRequired', () => {
  const r = buildMcpServerFromForm(
    form({ auth: 'basic', login: '', password: 'p' }),
  );
  expect(r).toEqual({ error: 'loginRequired' });
});

test('Basic with empty password → passwordRequired', () => {
  const r = buildMcpServerFromForm(
    form({ auth: 'basic', login: 'u', password: '' }),
  );
  expect(r).toEqual({ error: 'passwordRequired' });
});

// ---------- single /mcp registration (no collision) ----------

/**
 * Mirrors the real app.tsx wiring: the marketplace `mcpBrowse` factory is
 * NOT passed to registerBuiltinCommands (it would name itself 'mcp' and
 * collide), and the single `/mcp` overlay command is registered directly.
 * Exactly one `/mcp` must exist — the collision is what previously bricked
 * startup.
 */
function stub(name: string): SlashCommand {
  return { name, description: name, usage: `/${name}`, execute: (): void => {} };
}

test('only ONE /mcp command registers (mcpBrowse not in builtin bag)', () => {
  const reg = new SlashRegistry();
  // Builtin bag WITHOUT mcpBrowse (matching the fixed wiring).
  registerBuiltinCommands(reg, { model: stub('model') });
  // The dedicated /mcp overlay command registers directly.
  reg.register({
    name: 'mcp',
    description: 'Add an MCP server',
    usage: '/mcp [add | browse [query]]',
    execute: (): void => {},
  });
  const names = reg.getAll().map((c) => c.name);
  expect(names.filter((n) => n === 'mcp')).toHaveLength(1);
});
