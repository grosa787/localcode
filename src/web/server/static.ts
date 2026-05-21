/**
 * Static-asset handler for the `--web` SPA.
 *
 * Two modes:
 *
 *   - **Production** (default): assets are read from `EMBEDDED_ASSETS`,
 *     the base64 map produced by `scripts/embed-web.ts`. This is what
 *     ships in the single-binary `dist/cli.js`.
 *
 *   - **Dev** (when `LOCALCODE_WEB_DEV=1`): assets are read from
 *     `<repo>/dist-web/` at runtime. Agent D / F keep `dist-web/` fresh
 *     by running `vite build --watch` (or the dev server proxies to the
 *     Vite dev server, but that is a Phase 2 concern). This mode lets
 *     server agents iterate without re-running the embed step.
 *
 * Path traversal is blocked: requested paths are joined onto the dev
 * root and verified to still be a descendant via prefix check on the
 * resolved absolute path.
 *
 * MIME types are inferred from the request extension only — there is no
 * sniffing. The set of extensions covers everything Vite emits for our
 * build target plus woff/woff2 for `@fontsource/*` and svg/png/ico for
 * the Nox mascot.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { EMBEDDED_ASSETS } from '../bundle/embedded-assets';

/** Set once at module load. Switching modes requires a server restart. */
const DEV = process.env['LOCALCODE_WEB_DEV'] === '1';

/**
 * Absolute path to `<repo>/dist-web/`. Computed from `import.meta.dir` so
 * it works regardless of the user's CWD. `import.meta.dir` is Bun-specific
 * and always points at the directory of THIS source file
 * (`src/web/server/`), so three `..` segments hop back to the repo root.
 */
const DEV_ROOT = resolve(import.meta.dir, '../../../dist-web');

/** Trailing-slash form used for the descendant prefix check. */
const DEV_ROOT_PREFIX = DEV_ROOT.endsWith('/') ? DEV_ROOT : `${DEV_ROOT}/`;

/**
 * Try to serve `pathname` as a static asset.
 *
 * Returns:
 *   - a `Response` when the asset is found,
 *   - `null` when the asset is unknown — the caller (router) should then
 *     return its own 404. Returning `null` (not a 404 Response) keeps the
 *     handler composable and lets the SPA index-fallback strategy live in
 *     the router rather than here.
 */
export function serveStatic(pathname: string): Response | null {
  const path = pathname === '/' ? '/index.html' : pathname;

  if (DEV) {
    return serveFromDisk(path);
  }
  return serveFromBundle(path);
}

function serveFromDisk(path: string): Response | null {
  const filePath = resolve(join(DEV_ROOT, path));
  // Traversal guard: filePath must be DEV_ROOT itself or a descendant.
  if (filePath !== DEV_ROOT && !filePath.startsWith(DEV_ROOT_PREFIX)) {
    return null;
  }
  if (!existsSync(filePath)) return null;

  const body = readFileSync(filePath);
  return new Response(body, {
    headers: {
      'Content-Type': inferMime(path),
      'Cache-Control': 'no-store',
    },
  });
}

function serveFromBundle(path: string): Response | null {
  const asset = EMBEDDED_ASSETS[path];
  if (asset === undefined) return null;
  const buf = Buffer.from(asset.bytes, 'base64');
  return new Response(buf, {
    headers: {
      'Content-Type': asset.mime,
      // Hashed filenames from Vite are immutable. `index.html` is served
      // fresh; everything else can be cached by the browser indefinitely.
      'Cache-Control':
        path === '/index.html'
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
    },
  });
}

function inferMime(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs'))
    return 'application/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.ttf')) return 'font/ttf';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.ico')) return 'image/x-icon';
  if (path.endsWith('.map')) return 'application/json; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
