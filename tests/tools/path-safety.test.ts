/**
 * H6 — Symlink-traversal containment.
 *
 * Every filesystem-facing tool (`read_file`, `write_file`, `edit_file`)
 * must reject a path whose lexical form is in-tree but whose realpath
 * escapes the project root via a symlink.
 *
 * Layout per test:
 *
 *   tmpRoot/
 *     ok.txt           ← legitimate in-tree file
 *     link → /etc      ← symlink to an outside dir
 *
 * Then we probe `link/passwd` (read), `link/new-file` (write), and
 * `link/ok.txt` (edit). All must fail with a traversal-shaped error.
 *
 * macOS note: /tmp is itself a symlink to /private/tmp. The realpath
 * helper canonicalises the project root once and uses that as the
 * containment prefix, so tests do NOT need to special-case macOS.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readFile } from '@/tools/read-file';
import { writeFile as writeFileTool, commitWrite } from '@/tools/write-file';
import { editFile, commitEdit } from '@/tools/edit-file';
import { resolveSafePathStrict } from '@/tools/path-safety';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-pathsafe-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('resolveSafePathStrict', () => {
  test('rejects lexical traversal (..)', () => {
    expect(resolveSafePathStrict(tmpRoot, '../etc/passwd')).toBeNull();
  });

  test('rejects absolute paths outside the root', () => {
    expect(resolveSafePathStrict(tmpRoot, '/etc/passwd')).toBeNull();
  });

  test('accepts in-tree paths', async () => {
    await writeFile(path.join(tmpRoot, 'hi.txt'), 'hello', 'utf8');
    const r = resolveSafePathStrict(tmpRoot, 'hi.txt');
    expect(r).not.toBeNull();
    expect(r).toContain('hi.txt');
  });

  test('rejects symlink escape — link → /etc, probe link/passwd', async () => {
    // Build a relative symlink whose target is /etc (an existing dir
    // outside the project root). The lexical check passes — `link` is
    // a single in-tree segment — but realpath canonicalises to /etc.
    await symlink('/etc', path.join(tmpRoot, 'link'));
    expect(resolveSafePathStrict(tmpRoot, 'link/passwd')).toBeNull();
    // The link itself also escapes.
    expect(resolveSafePathStrict(tmpRoot, 'link')).toBeNull();
  });

  test('accepts new file under existing in-tree parent (ENOENT path)', async () => {
    await mkdir(path.join(tmpRoot, 'sub'));
    // Target does not exist — helper realpaths the nearest existing
    // ancestor (`sub`) and checks containment. Must succeed.
    const r = resolveSafePathStrict(tmpRoot, 'sub/new.txt');
    expect(r).not.toBeNull();
  });

  test('rejects new file whose parent is a symlink escaping the root', async () => {
    await symlink('/etc', path.join(tmpRoot, 'escape'));
    // Even though `escape/new.txt` doesn't exist, the parent realpaths
    // to /etc — so the candidate is blocked at creation time too.
    expect(resolveSafePathStrict(tmpRoot, 'escape/new.txt')).toBeNull();
  });
});

describe('read_file symlink containment', () => {
  test('blocks reading through a symlink to /etc', async () => {
    await symlink('/etc', path.join(tmpRoot, 'link'));
    const r = await readFile(
      { path: 'link/passwd' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(r.success).toBe(false);
    expect(r.error ?? '').toMatch(/traversal/i);
  });

  test('reads a legitimate in-tree symlink target inside the root', async () => {
    // Create a target file and a symlink to it, both inside the root.
    // Realpath stays inside — read must succeed.
    await writeFile(path.join(tmpRoot, 'real.txt'), 'real-data', 'utf8');
    await symlink('real.txt', path.join(tmpRoot, 'inside-link'));
    const r = await readFile(
      { path: 'inside-link' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(r.success).toBe(true);
    expect(r.output).toBe('real-data');
  });
});

describe('write_file symlink containment', () => {
  test('preview rejects write through a symlink escape', async () => {
    await symlink('/etc', path.join(tmpRoot, 'link'));
    const r = await writeFileTool(
      { path: 'link/new.txt', content: 'malicious' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(r.success).toBe(false);
    expect(r.error ?? '').toMatch(/traversal/i);
  });

  test('commit rejects write through a symlink escape', async () => {
    await symlink('/etc', path.join(tmpRoot, 'link'));
    const r = await commitWrite(
      { path: 'link/new.txt', content: 'malicious' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(r.success).toBe(false);
    expect(r.error ?? '').toMatch(/traversal/i);
  });
});

describe('edit_file symlink containment', () => {
  test('preview rejects editing a path that escapes via symlink', async () => {
    await symlink('/etc', path.join(tmpRoot, 'link'));
    const r = await editFile(
      {
        path: 'link/hosts',
        find_text: '127.0.0.1',
        replace_text: '0.0.0.0',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(r.success).toBe(false);
    expect(r.error ?? '').toMatch(/traversal/i);
  });

  test('commit rejects editing a path that escapes via symlink', async () => {
    await symlink('/etc', path.join(tmpRoot, 'link'));
    const r = await commitEdit(
      {
        path: 'link/hosts',
        find_text: '127.0.0.1',
        replace_text: '0.0.0.0',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(r.success).toBe(false);
    expect(r.error ?? '').toMatch(/traversal/i);
  });
});
