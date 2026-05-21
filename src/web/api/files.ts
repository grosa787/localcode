/**
 * REST handlers for `/api/files/tree` and `/api/files/read`.
 *
 * Path-traversal hardening: every request resolves the user-supplied
 * relative path under the workspace root via `resolveSafePath`, which
 * rejects anything that escapes via `..`, symlink-style absolute
 * inputs, or empty segments. Symlinks themselves are followed by
 * `node:fs` natively — we do not re-resolve through `realpath` because
 * that would prevent a workspace from including symlinked source dirs;
 * the authority remains the workspace root prefix check.
 *
 * Read returns text by default; non-image binaries (NUL byte in the
 * first 1KB) are rejected with HTTP 415 per the wire contract.
 * Recognised image extensions are returned as base64 with
 * `encoding='image'` so the SPA can render an inline `<img>`.
 *
 * Tree supports two optional query params used by the SPA's
 * file-browser panel:
 *   - `depth=0` → return only the directory metadata (no entries)
 *   - `depth=1` (default) → immediate children, sorted dirs-first
 *   - `showHidden=1` → include dotfiles AND build directories
 *     (`node_modules`, `.git`, `dist`, …) that are normally pruned
 *     server-side. The SPA renders these in a collapsed state.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { resolveSafePathStrict } from '@/tools/path-safety';
import type {
  FileReadResponse,
  FileTreeEntry,
  FileTreeResponse,
} from '../protocol/rest-types.js';
import { jsonError, jsonOk } from './http.js';
import type { ApiDeps } from './types.js';

/**
 * Build/cache dirs we hide unless the caller explicitly opts in with
 * `showHidden=1`. Dotfiles are filtered separately so the SPA's
 * "show hidden" toggle can reveal them without bringing back
 * `node_modules`.
 */
const HIDDEN_BUILD_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
];

/** Always hidden — internal LocalCode state + macOS junk. */
const ALWAYS_HIDDEN: readonly string[] = ['.localcode', '.DS_Store'];

/** Hard cap on file-read size — protects the tab from crashing on huge files. */
const MAX_READ_BYTES = 1 * 1024 * 1024;

/** Image extensions we surface as inline previews (base64-encoded). */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
]);

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  return path.slice(dot + 1).toLowerCase();
}

function mimeForImage(ext: string): string {
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    case 'ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

/**
 * Stage 1 only — purely lexical containment. Exported so the existing
 * unit test suite can keep asserting the cheap-path behaviour.
 */
function resolveSafePathLexical(root: string, relative: string): string | null {
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, relative.length === 0 ? '.' : relative);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return null;
  }
  return candidate;
}

/**
 * Resolve a request path against the project root with full traversal
 * hardening (lexical + realpath). H6 — delegating to
 * `resolveSafePathStrict` closes the symlink-traversal hole where a
 * lexical-only check accepted `link/passwd` when `link → /etc`.
 *
 * Returns null on any failure (lexical traversal, symlink escape,
 * realpath error) — the HTTP layer renders the 403 in both cases.
 */
export function resolveSafePath(root: string, relative: string): string | null {
  // Cheap lexical pre-check keeps unit-test expectations stable for
  // pure `..` / absolute-path inputs (no FS lookup at all).
  if (resolveSafePathLexical(root, relative) === null) return null;
  return resolveSafePathStrict(root, relative.length === 0 ? '.' : relative);
}

function parseFlag(v: string | null): boolean {
  if (v === null) return false;
  const norm = v.toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes';
}

export async function handleFilesTree(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const projectId = url.searchParams.get('projectId');
  if (projectId === null || projectId.length === 0) {
    return jsonError('invalid_query', 'projectId is required', 400);
  }
  const project = deps.workspaceRegistry.get(projectId);
  if (project === null) {
    return jsonError('not_found', `Project ${projectId} not found`, 404);
  }
  // Accept both `path` (legacy) and `subpath` (new) — SPA standardised
  // on `subpath` after the file-browser rewrite; keep `path` working so
  // older clients and tests don't break.
  const relative =
    url.searchParams.get('subpath') ?? url.searchParams.get('path') ?? '';
  const showHidden = parseFlag(url.searchParams.get('showHidden'));
  const depthRaw = url.searchParams.get('depth');
  const depth = depthRaw === null ? 1 : Math.max(0, Math.min(1, Number(depthRaw)));

  const abs = resolveSafePath(project.root, relative);
  if (abs === null) {
    return jsonError('forbidden', 'Path escapes the project root', 403);
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return jsonError('not_found', `Path not found: ${relative || '.'}`, 404);
  }
  if (!stat.isDirectory()) {
    return jsonError('invalid_kind', 'Path is not a directory', 400);
  }

  const rootResolved = resolve(project.root);
  const relPath = abs === rootResolved ? '' : abs.slice(rootResolved.length + 1);

  if (depth === 0) {
    const body: FileTreeResponse = { path: relPath, entries: [] };
    return jsonOk(body);
  }

  let dirents;
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    return jsonError(
      'read_failed',
      err instanceof Error ? err.message : 'Failed to read directory',
      500,
    );
  }

  const entries: FileTreeEntry[] = [];
  for (const d of dirents) {
    if (ALWAYS_HIDDEN.includes(d.name)) continue;
    if (!showHidden) {
      if (d.name.startsWith('.')) continue;
      if (HIDDEN_BUILD_DIRS.includes(d.name)) continue;
    }
    const isDir = d.isDirectory();
    const isFile = d.isFile();
    if (!isDir && !isFile) continue; // skip sockets, fifos, etc.
    const childAbs = resolve(abs, d.name);
    const childRel = childAbs.slice(resolve(project.root).length + 1);
    const entry: FileTreeEntry = {
      name: d.name,
      path: childRel,
      kind: isDir ? 'dir' : 'file',
    };
    if (isFile) {
      try {
        const fileStat = statSync(childAbs);
        entry.size = fileStat.size;
        entry.mtime = fileStat.mtimeMs;
      } catch {
        // missing-by-the-time-we-stat — skip telemetry, keep entry
      }
    }
    entries.push(entry);
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const body: FileTreeResponse = { path: relPath, entries };
  return jsonOk(body);
}

export async function handleFilesRead(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const projectId = url.searchParams.get('projectId');
  if (projectId === null || projectId.length === 0) {
    return jsonError('invalid_query', 'projectId is required', 400);
  }
  const project = deps.workspaceRegistry.get(projectId);
  if (project === null) {
    return jsonError('not_found', `Project ${projectId} not found`, 404);
  }
  const relative = url.searchParams.get('path');
  if (relative === null || relative.length === 0) {
    return jsonError('invalid_query', 'path is required', 400);
  }
  const abs = resolveSafePath(project.root, relative);
  if (abs === null) {
    return jsonError('forbidden', 'Path escapes the project root', 403);
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return jsonError('not_found', `File not found: ${relative}`, 404);
  }
  if (!stat.isFile()) {
    return jsonError('invalid_kind', 'Path is not a regular file', 400);
  }
  if (stat.size > MAX_READ_BYTES) {
    return jsonError('too_large', `File exceeds ${MAX_READ_BYTES} byte cap`, 413);
  }
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    return jsonError(
      'read_failed',
      err instanceof Error ? err.message : 'Failed to read file',
      500,
    );
  }
  const rootResolved = resolve(project.root);
  const relPath = abs.slice(rootResolved.length + 1);
  const ext = extOf(relPath);
  const isImage = IMAGE_EXTENSIONS.has(ext);

  if (isImage) {
    // SVG is text, but the SPA renders it through an <img src="data:…">
    // for parity with other image formats. Base64 keeps the JSON shape
    // simple and avoids escaping XML inside JSON.
    const body: FileReadResponse = {
      path: relPath,
      content: buf.toString('base64'),
      size: stat.size,
      mtime: stat.mtimeMs,
      encoding: 'image',
      mimeType: mimeForImage(ext),
    };
    return jsonOk(body);
  }

  if (looksBinary(buf)) {
    // Keep the legacy 415 status for non-image binaries — existing
    // clients (and tests) rely on this contract. The SPA surfaces a
    // "Binary file — N KB" placeholder when it sees a 415 here.
    return jsonError('binary', 'Binary files are not supported', 415);
  }
  const body: FileReadResponse = {
    path: relPath,
    content: buf.toString('utf-8'),
    size: stat.size,
    mtime: stat.mtimeMs,
    encoding: 'utf-8',
  };
  return jsonOk(body);
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 1024));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}
