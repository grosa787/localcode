/**
 * TOOL-RENDERERS-SECTION — `file:line` / `file:line:column` parser.
 *
 * The model emits text like `src/foo.ts:42` or
 * `Edited src/bar.ts:120:5  — match`. We walk a string and return both
 * the plain-text spans and the structured `(path, line, column)` matches
 * so the renderer can wrap each match in a clickable `<FileRef>`.
 *
 * Conservative regex
 * ------------------
 * We anchor on file paths with a recognised extension OR paths that
 * begin with a `./` / `../` / `src/` / `tests/` / `docs/` prefix. The
 * extension whitelist keeps us from matching things that LOOK like
 * paths but are not (e.g. `localhost:5173` — wrong because no slash,
 * but also `Tools:5` from a tool log).
 *
 * The regex deliberately rejects:
 *   - bare hostnames (`localhost:8080`, `host.example.com:443`)
 *   - URLs (`http://x.com:80/`)
 *   - times (`14:30:00`)
 *   - bare numbers (`x:5`)
 *
 * It accepts:
 *   - `src/foo.ts:42`, `src/foo.tsx:1:10`
 *   - `./tests/bar.test.tsx:88`
 *   - `package.json:5`
 *   - `path/with/slashes/and.dots/file.go:99:1`
 *
 * Out-of-scope: globs, paths with spaces, Windows backslash separators
 * (LocalCode normalises to forward slashes everywhere). False positives
 * are still possible but the recogniser is strict enough that in
 * practice the failure mode is "no link" rather than "wrong link".
 */

/** Single parsed file:line reference. */
export interface ParsedFileRef {
  /** Raw substring, ready to be replaced in-place inside the text. */
  readonly raw: string;
  /** Resolved file path string as it appeared in the source. */
  readonly path: string;
  /** 1-based line number; always present (matches must have ":line"). */
  readonly line: number;
  /** 1-based column number, when the source supplied a `:line:col` form. */
  readonly column?: number;
  /** Inclusive start index in the source string. */
  readonly start: number;
  /** Exclusive end index in the source string. */
  readonly end: number;
}

/**
 * Whitelist of file extensions we accept. Keep this list tight — every
 * new entry is a potential source of false positives.
 *
 * The matcher allows a trailing letter after `.tsx` etc. so a path like
 * `.test.tsx` still works (the regex tracks the LAST extension; we
 * just need ONE recognised one anywhere in the trailing segment).
 */
const FILE_EXTENSIONS: readonly string[] = [
  // TypeScript / JavaScript
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  // Web
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  // Systems
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hpp',
  'hh',
  'rs',
  'go',
  'zig',
  // JVM
  'java',
  'kt',
  'kts',
  'scala',
  'groovy',
  // Dynamic
  'py',
  'pyi',
  'rb',
  'php',
  'pl',
  'lua',
  'r',
  // Mobile
  'swift',
  'm',
  'mm',
  // Data / config
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'csv',
  'tsv',
  'env',
  // Shell / build
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'mk',
  'cmake',
  'gradle',
  // Docs / misc
  'md',
  'mdx',
  'rst',
  'txt',
  'log',
  'sql',
  'graphql',
  'gql',
  'proto',
  // Notebooks
  'ipynb',
  // Locks/manifests (no dot — handled by the "well-known names" path)
];

/** Well-known filenames without an extension that we still accept. */
const WELL_KNOWN_NAMES: ReadonlySet<string> = new Set([
  'Dockerfile',
  'Makefile',
  'Rakefile',
  'Procfile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'AUTHORS',
  'CONTRIBUTING',
  'NOTICE',
  'CODEOWNERS',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'jsconfig.json',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  // case-sensitive matches above; for `.env` keep the bare-name slot too
]);

/**
 * Build the master regex once. Pattern breakdown:
 *   - `(?:[./~]\w[\w./\-+]*|\b[\w][\w./\-+]*)` — path body. Allow
 *     leading `.`, `/`, `~` for relative/abs paths; for bare segments
 *     anchor on `\b\w` to avoid matching mid-word.
 *   - `\.(<ext>)` — final extension from the whitelist.
 *   - `:(\d{1,7})` — required line number, 1..7 digits.
 *   - `(?::(\d{1,7}))?` — optional column.
 *
 * We compile a separate regex for "well-known names" since those have
 * no extension to anchor on.
 */
const EXTENSION_GROUP = FILE_EXTENSIONS.map((e) =>
  e.replace(/[.+]/g, '\\$&'),
).join('|');

const FILE_LINE_REGEX = new RegExp(
  // Path body: optional leading `.`, `/`, `~` (one or more), then one or
  // more "segment" characters. Segments may themselves contain `.`,
  // `/`, `\-`, `+`, and word chars. We anchor with `(?<!\w)` so the
  // path doesn't start mid-identifier (no `Foosrc/x.ts:1` matches).
  `(?<!\\w)((?:[./~]+)?[\\w][\\w./\\-+]*\\.(?:${EXTENSION_GROUP}))` +
    `:(\\d{1,7})(?::(\\d{1,7}))?(?!\\w)`,
  'g',
);

const WELL_KNOWN_REGEX = new RegExp(
  `(?<!\\w)((?:(?:[./~]+)?[\\w./\\-+]*)(?:${[...WELL_KNOWN_NAMES]
    .map((n) => n.replace(/[.+]/g, '\\$&'))
    .join('|')}))` +
    `:(\\d{1,7})(?::(\\d{1,7}))?(?!\\w)`,
  'g',
);

/**
 * Walk `text` and return every `path:line[:column]` reference we
 * recognise. Matches are sorted by `start` so callers can splice in
 * order. Overlapping matches (same start position from two regexes)
 * are de-duped — the extension regex wins because it's the stricter
 * recogniser.
 */
export function parseFileRefs(text: string): readonly ParsedFileRef[] {
  if (text.length === 0) return [];

  const found = new Map<number, ParsedFileRef>();

  const addMatch = (
    m: RegExpExecArray,
    pathGroup: number,
    lineGroup: number,
    columnGroup: number,
  ): void => {
    const start = m.index;
    if (found.has(start)) return;
    const raw = m[0];
    const path = m[pathGroup];
    const lineStr = m[lineGroup];
    const colStr = m[columnGroup];
    if (path === undefined || lineStr === undefined) return;
    const line = Number.parseInt(lineStr, 10);
    if (!Number.isFinite(line) || line < 1) return;
    const column =
      colStr !== undefined && colStr.length > 0
        ? Number.parseInt(colStr, 10)
        : undefined;
    if (column !== undefined && (!Number.isFinite(column) || column < 1)) return;
    found.set(start, {
      raw,
      path,
      line,
      column,
      start,
      end: start + raw.length,
    });
  };

  // Clone the regexes so we don't share `lastIndex` across calls (the
  // module-level singletons would carry state from a previous call).
  const extRe = new RegExp(FILE_LINE_REGEX.source, FILE_LINE_REGEX.flags);
  const wellKnownRe = new RegExp(
    WELL_KNOWN_REGEX.source,
    WELL_KNOWN_REGEX.flags,
  );

  let match: RegExpExecArray | null;
  while ((match = extRe.exec(text)) !== null) {
    addMatch(match, 1, 2, 3);
  }
  while ((match = wellKnownRe.exec(text)) !== null) {
    addMatch(match, 1, 2, 3);
  }

  const sorted = [...found.values()].sort((a, b) => a.start - b.start);
  return sorted;
}

/**
 * Slice a string into alternating text and ref pieces — convenience for
 * the renderer that wants to walk linearly and build JSX. The output is
 * always non-empty: even when no refs are found we return a single text
 * piece carrying the entire input.
 */
export type FileRefPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'ref'; readonly ref: ParsedFileRef };

export function splitTextByRefs(text: string): readonly FileRefPiece[] {
  const refs = parseFileRefs(text);
  if (refs.length === 0) {
    return [{ kind: 'text', text }];
  }
  const out: FileRefPiece[] = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) {
      out.push({ kind: 'text', text: text.slice(cursor, ref.start) });
    }
    out.push({ kind: 'ref', ref });
    cursor = ref.end;
  }
  if (cursor < text.length) {
    out.push({ kind: 'text', text: text.slice(cursor) });
  }
  return out;
}
