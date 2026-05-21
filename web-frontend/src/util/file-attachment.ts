/**
 * File-attachment classification helpers for Composer drag-drop.
 *
 * Three lanes:
 *   - `image` — base64-encode and attach as multimodal data URI.
 *   - `text`  — either reference as `@<relative path>` if the dropped
 *               file lives under `projectRoot`, or inline the content
 *               (size-capped) otherwise.
 *   - `unsupported` — reject with a friendly toast.
 *
 * The classification is mime-driven, with a small extension fallback for
 * common code/text files browsers misreport (e.g. `.ts`, `.toml`,
 * `.lock`). Binary types not in the image allow-list are rejected.
 *
 * Pure: no DOM dependencies, no React. Easy to unit-test under jsdom.
 */

/** Maximum bytes inlined when a dropped text file lives outside projectRoot. */
export const MAX_INLINE_TEXT_BYTES = 50 * 1024;

/** Image mime types we accept for multimodal attachment. */
export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

/**
 * File extensions browsers commonly report with an empty / generic mime
 * type but which we still want to treat as text. Anything under this
 * threshold and not in the image set lands in the `text` lane.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'md', 'mdx', 'markdown', 'rst', 'log', 'csv', 'tsv', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'js', 'mjs', 'cjs', 'jsx',
  'ts', 'mts', 'cts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'php', 'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'graphql', 'gql',
  'json', 'jsonc',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'vue', 'svelte', 'astro',
  'lock', 'gitignore', 'gitattributes', 'editorconfig', 'prettierrc',
  'eslintrc', 'dockerfile', 'dockerignore',
]);

/** Outcome tag for `classifyDroppedFile`. */
export type FileClassification =
  | { kind: 'image' }
  | { kind: 'text' }
  | { kind: 'unsupported'; reason: string };

/** Pull the lowercase extension (no leading dot) or empty string. */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i === -1 || i === name.length - 1) return '';
  // For dotfiles (`.eslintrc`), treat the base name as the extension.
  if (i === 0) return name.slice(1).toLowerCase();
  return name.slice(i + 1).toLowerCase();
}

/**
 * Classify a dropped file by its mime + extension. The mime check wins;
 * extension is the fallback for the depressingly common `mimeType === ''`
 * case (Safari, drag-from-finder, etc.).
 */
export function classifyDroppedFile(file: File): FileClassification {
  const mime = file.type;
  if (mime.length > 0 && IMAGE_MIME_TYPES.has(mime)) {
    return { kind: 'image' };
  }
  if (mime.startsWith('text/') || mime === 'application/json') {
    return { kind: 'text' };
  }
  // Some browsers report empty mime for code files. Fall back to ext.
  const ext = extensionOf(file.name);
  if (ext.length > 0 && TEXT_EXTENSIONS.has(ext)) {
    return { kind: 'text' };
  }
  // Generic application/* or octet-stream: reject explicitly so the user
  // knows we saw the drop but won't ingest it.
  return {
    kind: 'unsupported',
    reason: mime.length > 0 ? mime : 'application/octet-stream',
  };
}

/**
 * If `absolutePath` lives under `projectRoot`, return the relative path
 * (forward-slash separated, no leading slash). Otherwise null.
 *
 * Both paths must already be absolute. Trailing slashes on `projectRoot`
 * are tolerated. Comparison is purely string-based — symlink resolution
 * is the server's job; for the composer we just want a stable `@path`
 * reference the user can recognise.
 */
export function relativeToProject(
  absolutePath: string,
  projectRoot: string,
): string | null {
  if (absolutePath.length === 0 || projectRoot.length === 0) return null;
  // Normalise: drop any trailing slash on the root so we don't end up
  // with `//` after the join check.
  const root = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot;
  if (absolutePath === root) return '';
  const prefix = `${root}/`;
  if (!absolutePath.startsWith(prefix)) return null;
  return absolutePath.slice(prefix.length);
}

/**
 * Browser `File` may carry the `webkitRelativePath` field when dropped
 * from a directory picker, but for ordinary OS drops only `name` is
 * populated and we cannot recover the source path at all. We still
 * accept the `path` property which Electron / some custom hosts set.
 *
 * This helper returns the most reliable absolute-path candidate, or
 * null if nothing usable is on the File.
 */
export function readFilePath(file: File): string | null {
  // Electron's File extension — non-standard, optional.
  const maybePath = (file as File & { path?: unknown }).path;
  if (typeof maybePath === 'string' && maybePath.length > 0) {
    return maybePath;
  }
  return null;
}

/**
 * Read a Blob as UTF-8 text. Wraps the FileReader API in a Promise so
 * the caller can `await` it. Rejects on read error.
 */
export function readBlobAsText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected reader result'));
        return;
      }
      resolve(result);
    };
    reader.onerror = (): void => reject(reader.error ?? new Error('Read failed'));
    reader.readAsText(blob);
  });
}
