/**
 * End-to-end boot smoke for `startWebApp`.
 *
 * Spins the server up on a fixed high port, hits a handful of HTTP
 * endpoints, asserts CSRF gating + path-traversal hardening, then stops
 * cleanly. No real LLM, no real network beyond loopback.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startWebApp, type RunningWebApp } from '@/web';

let app: RunningWebApp;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'lc-web-it-'));
  app = await startWebApp({
    projectRoot: tmpRoot,
    host: '127.0.0.1',
    port: 47700,
    openInBrowser: false,
  });
});

afterAll(async () => {
  if (app !== undefined) await app.stop();
  if (tmpRoot !== undefined) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('startWebApp returns a CSRF token + bound port', () => {
  expect(typeof app.csrfToken).toBe('string');
  expect(app.csrfToken.length).toBeGreaterThanOrEqual(32);
  expect(app.port).toBeGreaterThan(0);
});

test('GET / returns the embedded SPA index', async () => {
  const res = await fetch(`http://127.0.0.1:${app.port}/`);
  expect(res.status).toBe(200);
  const text = await res.text();
  // Either the real SPA index or the stub — both contain a root mount node.
  expect(
    text.includes('<div id="root"') || text.includes('id="root"'),
  ).toBe(true);
});

test('GET /api/projects requires no CSRF (read-only)', async () => {
  // Note: GET /api/projects filters tmpdir-rooted entries as junk
  // (see isJunkProjectPath). The test's `tmpRoot` is created under
  // os.tmpdir() so it is intentionally absent from the response.
  const res = await fetch(`http://127.0.0.1:${app.port}/api/projects`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    projects: Array<{ id: string; root: string }>;
  };
  expect(Array.isArray(body.projects)).toBe(true);
  expect(body.projects.some((p) => p.root === tmpRoot)).toBe(false);
});

test('POST /api/projects rejects without CSRF', async () => {
  const res = await fetch(`http://127.0.0.1:${app.port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: tmpRoot }),
  });
  expect(res.status).toBe(403);
});

test('POST /api/projects with valid CSRF accepts', async () => {
  const newProjectRoot = mkdtempSync(join(tmpdir(), 'lc-web-it-extra-'));
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LocalCode-CSRF': app.csrfToken,
      },
      body: JSON.stringify({ root: newProjectRoot }),
    });
    expect([200, 201]).toContain(res.status);
  } finally {
    rmSync(newProjectRoot, { recursive: true, force: true });
  }
});

test('GET /api/files/tree rejects path traversal', async () => {
  // Register a project so we have a valid id regardless of what real
  // workspaces exist on the host. GET /api/projects filters tmpdir-rooted
  // entries as junk (so a fresh CI host lists none), but POST still returns
  // the created record — the id resolves for /api/files/tree even though
  // it's hidden from the list. Self-contained so the test is host-independent.
  const travRoot = mkdtempSync(join(tmpdir(), 'lc-web-it-trav-'));
  try {
    const created = await fetch(`http://127.0.0.1:${app.port}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LocalCode-CSRF': app.csrfToken,
      },
      body: JSON.stringify({ root: travRoot }),
    });
    expect([200, 201]).toContain(created.status);
    const body = (await created.json()) as { project: { id: string } };
    const projectId = body.project.id;
    expect(projectId).not.toBe('');
    const url = new URL(`http://127.0.0.1:${app.port}/api/files/tree`);
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('path', '../../../../../etc');
    const res = await fetch(url);
    expect([400, 403, 404]).toContain(res.status);
  } finally {
    rmSync(travRoot, { recursive: true, force: true });
  }
});

test('unknown /api/* path returns 404', async () => {
  const res = await fetch(`http://127.0.0.1:${app.port}/api/does-not-exist`);
  expect(res.status).toBe(404);
});

test('app.stop is idempotent', async () => {
  // Calling stop twice (once here, once in afterAll) must not throw.
  await app.stop();
  await app.stop();
});
