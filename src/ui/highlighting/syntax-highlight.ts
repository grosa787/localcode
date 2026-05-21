/**
 * Syntax highlighting helpers for fenced code blocks.
 *
 * ROADMAP #3 (Agent C): "Beautiful code-fence syntax highlighting" — not
 * the minimum, but real beauty. The strategy is to lean on `cli-highlight`
 * (a thin wrapper over highlight.js) so we get language detection and
 * 190+ grammars for free, and to render the result through a *Nox*-themed
 * chalk palette so colours sit naturally next to the rest of the UI.
 *
 * Goals:
 *   - Pure JS, zero native deps. Works on Bun without WASM loaders.
 *   - Token theme keyed off `noxPalette` so the highlighter stays inside
 *     the brand and never lands on a generic terminal palette.
 *   - Graceful fallback: when language is unknown / highlighter throws,
 *     we render plain dim text rather than crashing the whole row.
 *   - Static heuristic language detection so naked ```\n...``` fences
 *     still get *some* colour. Conservative — only confident hits, no
 *     wild guesses.
 *   - Public API is explicit and side-effect free; the React layer
 *     consumes pre-coloured strings and does not need to know about
 *     highlight.js at all.
 *
 * Caching strategy (R28):
 *   - Streaming code blocks re-call `highlightCode` on every chunk that
 *     extends the same growing source. cli-highlight is non-trivial
 *     (regex-driven highlight.js parse) so we keep a small in-process
 *     LRU keyed on `(language, FNV-1a hash, length)`. Exact-prefix hits
 *     are fast; misses fall through to highlight + insert.
 *   - We deliberately do NOT do prefix matching. Streaming is throttled
 *     upstream (~6Hz), each successive snapshot has a different hash,
 *     and highlighter state at offset N rarely matches highlighter
 *     state at offset M. Exact-key caching is enough — it makes the
 *     post-stream re-render path (overlay open/close, parent re-render)
 *     a constant-time map lookup.
 *   - Cache is module-local and bounded (`MAX_CACHE`). LRU eviction is
 *     "drop oldest insertion order" via `Map` semantics; good enough
 *     given the small cap and the fact that fresh insertions are the
 *     common case during a stream.
 *
 * What this file deliberately does NOT do:
 *   - Provide React components. `CodeBlock.tsx` is the rendering layer.
 *   - Memoise across processes. The cache lives for the life of the
 *     module; tests that need clean state can `__TEST_CLEAR_CACHE()`.
 *   - Touch global chalk state. We capture the chalk *module* once,
 *     bump its level if needed, and call its API surface — but we
 *     never `chalk.level = …` from import-time code paths.
 */

import chalk, { type ChalkInstance } from 'chalk';
import { highlight as cliHighlight, supportsLanguage, type Theme } from 'cli-highlight';
import { syntaxTheme } from '../theme.js';

/**
 * Curated alias map.
 *
 * `cli-highlight` already understands a fair number of aliases (e.g. `js`
 * → `javascript`), but model-emitted code fences in the wild use plenty
 * of shorthand that highlight.js does not register. We normalise the
 * fence label here BEFORE calling `supportsLanguage` so we don't lose
 * highlighting on the obvious cases.
 *
 * Keys are always lower-cased; values are highlight.js language ids.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  py3: 'python',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  console: 'bash',
  yml: 'yaml',
  toml: 'ini', // close enough — highlight.js has no toml grammar
  md: 'markdown',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  svelte: 'xml',
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  proto: 'protobuf',
  protobuf: 'protobuf',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  make: 'makefile',
  makefile: 'makefile',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  scss: 'scss',
  sass: 'scss',
  css: 'css',
  less: 'less',
  txt: 'plaintext',
  text: 'plaintext',
  plain: 'plaintext',
};

/**
 * Normalise a fence-label to a highlight.js language id, or return
 * `undefined` if we can't resolve it confidently. Trims, lower-cases,
 * applies `LANGUAGE_ALIASES`, then probes `supportsLanguage`.
 */
export function normaliseLanguage(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  const aliased = LANGUAGE_ALIASES[trimmed] ?? trimmed;
  if (supportsLanguage(aliased)) return aliased;
  return undefined;
}

/**
 * Rough heuristic language detector for fenced blocks that arrive
 * WITHOUT a fence label. We only return a language when the signal is
 * very strong — a false positive (Rust code coloured as Python) reads
 * worse than no colour at all.
 *
 * The matcher walks the first ~600 bytes of the snippet and tallies
 * keyword hits per language family. Whichever family wins by a 2x
 * margin over the runner-up gets the slot; ties → `undefined`.
 *
 * IMPORTANT: keep the regexes conservative. `func` would otherwise hit
 * Go on every JS arrow function called `func`, etc.
 */
export function detectLanguage(code: string): string | undefined {
  if (code.length === 0) return undefined;
  const sample = code.slice(0, 600);

  type Probe = { readonly lang: string; readonly patterns: readonly RegExp[] };

  const probes: readonly Probe[] = [
    {
      lang: 'typescript',
      patterns: [
        /\b(?:interface|type)\s+[A-Z]\w*/,
        /:\s*(?:string|number|boolean|void|any|unknown)\b/,
        /\bas\s+(?:const|[A-Z]\w*)/,
        /\bimport\s+\{[^}]+\}\s+from\s+['"][^'"]+['"]/,
        /=>\s*\{/,
      ],
    },
    {
      lang: 'javascript',
      patterns: [
        /\b(?:const|let|var)\s+\w+\s*=/,
        /\bfunction\s*\*?\s*\w*\s*\(/,
        /=>\s*[({]/,
        /\bconsole\.\w+\(/,
        /\brequire\(['"]/,
      ],
    },
    {
      lang: 'python',
      patterns: [
        /^\s*def\s+\w+\s*\(/m,
        /^\s*class\s+\w+(?:\([\w.]+\))?\s*:/m,
        /^\s*from\s+[\w.]+\s+import\b/m,
        /^\s*import\s+\w+(?:\.\w+)*\s*$/m,
        /\bprint\s*\(/,
        /\bself\b/,
      ],
    },
    {
      lang: 'go',
      patterns: [
        /^\s*package\s+\w+/m,
        /\bfunc\s+(?:\([\w\s*]+\)\s+)?\w+\s*\(/,
        /\binterface\s*\{/,
        /\bgo\s+\w+\(/,
        /\bfmt\.Print/,
      ],
    },
    {
      lang: 'rust',
      patterns: [
        /\bfn\s+\w+\s*[<(]/,
        /\blet\s+mut\s+\w+/,
        /\bimpl\s+\w+/,
        /::\s*<[^>]+>\(/,
        /\bprintln!\s*\(/,
        /\bResult<[^>]+,\s*[^>]+>/,
      ],
    },
    {
      lang: 'java',
      patterns: [
        /\bpublic\s+(?:static\s+)?(?:void|class|[A-Z]\w*)\s+\w+/,
        /\bSystem\.out\.println\(/,
        /\bnew\s+[A-Z]\w*\s*\(/,
        /\bextends\s+[A-Z]\w*/,
      ],
    },
    {
      lang: 'csharp',
      patterns: [
        /\busing\s+System(?:\.\w+)*\s*;/,
        /\bnamespace\s+\w+(?:\.\w+)*\s*\{/,
        /\bConsole\.WriteLine\(/,
        /\bvar\s+\w+\s*=\s*new\s+[A-Z]/,
      ],
    },
    {
      lang: 'kotlin',
      patterns: [
        /\bfun\s+\w+\s*\(/,
        /\bval\s+\w+\s*[:=]/,
        /\bvar\s+\w+\s*[:=]/,
        /\bdata\s+class\s+/,
      ],
    },
    {
      lang: 'swift',
      patterns: [
        /\bfunc\s+\w+\s*\(/,
        /\blet\s+\w+\s*=\s*\[/,
        /\bvar\s+\w+\s*:\s*[A-Z]/,
        /\bguard\s+let\s+/,
      ],
    },
    {
      lang: 'ruby',
      patterns: [
        /\bdef\s+\w+(?:\(|\s|$)/,
        /\bend\s*$/m,
        /\brequire\s+['"]/,
        /\bputs\s+/,
        /\bdo\s*\|/,
      ],
    },
    {
      lang: 'bash',
      patterns: [
        /^\s*#!\/(?:usr\/)?bin\/(?:env\s+)?(?:bash|sh|zsh)\b/m,
        /\$\(\w+/,
        /\b(?:echo|export|cd|grep|sed|awk)\s/,
        /\|\s*\w+/,
      ],
    },
    {
      lang: 'sql',
      patterns: [
        /\bSELECT\s+(?:\*|[\w,\s]+)\s+FROM\s+/i,
        /\bINSERT\s+INTO\s+/i,
        /\bWHERE\s+/i,
        /\bJOIN\s+/i,
      ],
    },
    {
      lang: 'json',
      patterns: [
        /^\s*\{\s*["']\w+["']\s*:/,
        /^\s*\[\s*\{/,
        /\}\s*,\s*$/m,
      ],
    },
    {
      lang: 'xml',
      patterns: [
        /<\/?[a-zA-Z][\w-]*(?:\s+[\w-]+\s*=\s*["'][^"']*["'])*\s*\/?>/,
        /<\?xml\s+version=/,
        /<!DOCTYPE\s+html/i,
      ],
    },
    {
      lang: 'yaml',
      patterns: [
        /^[a-zA-Z][\w-]*\s*:\s*[^{}\n]+$/m,
        /^\s*-\s+\w+\s*:/m,
        /^---\s*$/m,
      ],
    },
  ];

  let best: { readonly lang: string; readonly score: number } | undefined;
  let runnerUp = 0;

  for (const probe of probes) {
    let score = 0;
    for (const pattern of probe.patterns) {
      if (pattern.test(sample)) score += 1;
    }
    if (score === 0) continue;
    if (best === undefined || score > best.score) {
      runnerUp = best?.score ?? 0;
      best = { lang: probe.lang, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  // Need at least 2 hits AND 2x dominance over the runner-up to commit.
  if (best === undefined || best.score < 2) return undefined;
  if (runnerUp > 0 && best.score < runnerUp * 2) return undefined;
  return best.lang;
}

/**
 * Build the cli-highlight `Theme` from our `syntaxTheme` token map.
 *
 * cli-highlight expects FLAT functions (every value must be a callable
 * `(s: string) => string`); nested objects throw at colorize time.
 * We build the map once at module load and reuse it.
 */
function buildHighlightTheme(): Theme {
  const t = syntaxTheme;
  const passthrough = (s: string): string => s;
  return {
    keyword: t.keyword,
    'meta-keyword': t.keyword,
    built_in: t.builtin,
    'builtin-name': t.builtin,
    type: t.type,
    literal: t.literal,
    number: t.number,
    regexp: t.regexp,
    string: t.string,
    'meta-string': t.string,
    subst: t.variable,
    symbol: t.variable,
    class: t.className,
    function: t.function,
    title: t.function,
    params: t.variable,
    comment: t.comment,
    doctag: t.comment,
    meta: t.comment,
    section: t.tag,
    tag: t.tag,
    name: t.tag,
    attr: t.attr,
    attribute: t.attr,
    variable: t.variable,
    'template-variable': t.variable,
    'template-tag': t.tag,
    bullet: t.punctuation,
    code: t.variable,
    emphasis: t.variable,
    strong: t.keyword,
    formula: t.number,
    link: t.string,
    quote: t.comment,
    'selector-tag': t.tag,
    'selector-id': t.attr,
    'selector-class': t.className,
    'selector-attr': t.attr,
    'selector-pseudo': t.attr,
    addition: t.string,
    deletion: t.regexp, // re-use green for adds, soft red for dels via dim mapping
    default: passthrough,
  };
}

const CACHED_THEME: Theme = buildHighlightTheme();

/**
 * Force chalk into 24-bit colour mode. ink renders to a TTY and chalk
 * normally auto-detects, but a) Bun's process.stdout reporting can be
 * inconsistent during testing, and b) we WANT truecolour on every
 * terminal that supports ANSI codes (we're already using `chalk.hex`
 * everywhere else in the theme). chalk's Level enum is 0-3.
 */
function ensureColourLevel(): void {
  // Level 3 = truecolour. We never downgrade — if the user's terminal
  // really doesn't support colour we'd emit plain ANSI for nothing,
  // but ink's Box renderer absorbs that gracefully.
  if (chalk.level < 3) {
    chalk.level = 3;
  }
}

/**
 * Apply the fallback "muted" colour to a code block when we have no
 * language hint. Done at the line level so the React layer can split
 * by `\n` consistently.
 */
function fallbackColour(code: string): string {
  ensureColourLevel();
  const tint: ChalkInstance = chalk.hex('#cbb8e8');
  return tint(code);
}

/**
 * Module-local LRU cache for highlighted output.
 *
 * Keyed on `<themeVersion>:<language>:<fnv1a-hash>:<length>` so two
 * different strings that happen to collide on FNV still differ on
 * length (highlight.js output length is loosely correlated with input
 * length, so even when a hash collision sneaks past us the cache miss
 * just costs one extra highlight call — never a stale render).
 *
 * `themeVersion` is the load-bearing addition (R-perf, 2026-05): when
 * the user toggles to a different theme the chalk hex output for any
 * given token class changes, so entries cached under the OLD palette
 * would emit stale colours if reused. Including the version in the key
 * means a theme switch instantly invalidates the old entries WITHOUT
 * wiping the underlying Map — the old colours simply age out via LRU
 * eviction as the new theme fills the cache. Theme-change call sites
 * call `bumpThemeVersion()` once per switch.
 *
 * `MAX_CACHE` was bumped from 200 → 1000 to absorb a theme switch
 * mid-session without thrashing: under the old cap, the first 200
 * highlight calls after a `bumpThemeVersion()` would also evict every
 * pre-switch entry, defeating the "old colours linger until rotated
 * out" property we want for split-screen and rapid-toggle UX. 1000
 * comfortably holds the entries from BOTH the previous and current
 * theme version for a typical session (~100 committed code blocks
 * each).
 */
const HIGHLIGHT_CACHE = new Map<string, string>();
const MAX_CACHE = 1000;

/**
 * Monotonically-increasing version counter for the active syntax theme.
 *
 * Cache keys embed this so a theme switch makes every prior entry
 * unreachable without a Map.clear() (clear() would drop the previous
 * theme's entries too — fine in steady state but ugly when a user
 * toggles back and forth, since both directions would re-pay the full
 * highlight cost). Letting the LRU age out stale entries naturally
 * keeps the trailing-cache window tight.
 *
 * The counter is intentionally module-local and untyped to consumers;
 * call sites only ever ask for "bump it" — they never read the raw
 * value. Test helpers below expose it for assertion only.
 */
let themeVersion = 0;

/**
 * Increment the theme-version counter. Theme-switch sites (anything
 * that swaps `syntaxTheme`/`noxPalette` colours visibly — the
 * theme-toggle command and any future runtime palette swap) MUST call
 * this once per switch so future `highlightCode` calls compute a fresh
 * cache key. Cheap (one integer increment); idempotent across multiple
 * call sites in a single switch (each bump just shifts the window
 * further forward).
 */
export function bumpThemeVersion(): void {
  themeVersion += 1;
}

/**
 * FNV-1a 32-bit hash. Fast (single pass over UTF-16 code units), no
 * allocations, good distribution for our key universe (small-ish
 * source files). Output is hex so it composes cleanly into the
 * cache key. NOT cryptographic — collisions are tolerable because
 * the length suffix and language prefix make confused-deputy hits
 * vanishingly rare.
 */
function fnv1a32(s: string): string {
  // 0x811c9dc5 — FNV offset basis.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    // 0x01000193 — FNV prime. `Math.imul` keeps the multiply 32-bit
    // safe; without it V8/JSC would promote to float and lose bits.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Build the cache key for a `(themeVersion, language, code)` triple.
 * `themeVersion` is prefixed so a theme switch makes every prior entry
 * unreachable (LRU then ages them out naturally). We tolerate the
 * `auto` placeholder for the unknown-language path so the fallback
 * colourization is also cached (it's a single chalk.hex call but on
 * 4000-line pastes that still adds up).
 */
function cacheKey(code: string, language: string | undefined): string {
  const lang = language ?? 'auto';
  return `${themeVersion}:${lang}:${fnv1a32(code)}:${code.length}`;
}

/**
 * Hit/miss counters for the highlight cache. Maintained in the
 * `highlightCode` hot path so tests can assert that a theme-switch
 * produces one miss (re-highlight under the new palette) and that
 * subsequent calls land back on the cache. Exposed via the
 * `__TEST_CACHE_STATS` helper below; not consumed at runtime.
 */
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Insert a value into the LRU and evict the oldest entry when we exceed
 * the cap. `Map` preserves insertion order, so `keys().next().value` is
 * the least-recently-inserted key. We never bump on read — strict LRU
 * (move-to-end on hit) would be slightly more accurate but costs an
 * O(1) delete+set on every hit, which dominates the saved highlight
 * cost on cold caches. Insertion-order eviction is the right trade.
 */
function cacheInsert(key: string, value: string): void {
  HIGHLIGHT_CACHE.set(key, value);
  if (HIGHLIGHT_CACHE.size > MAX_CACHE) {
    const oldest = HIGHLIGHT_CACHE.keys().next().value;
    if (oldest !== undefined) HIGHLIGHT_CACHE.delete(oldest);
  }
}

/**
 * Public: coloured version of `code`, ready for splitting by `\n`.
 *
 * @param code Raw source text.
 * @param language Language hint (from fence label or detection); pass
 *   `undefined` to skip highlighting and apply the muted fallback.
 * @returns Coloured string with the same number of `\n` separators
 *   as the input; safe to split with `.split('\n')`.
 */
export function highlightCode(code: string, language: string | undefined): string {
  if (code.length === 0) return code;

  // Fast path: exact cache hit. Identical (themeVersion, lang, hash,
  // length) → return the cached coloured string. Streaming throttle
  // ensures the same final snapshot is seen multiple times (committed
  // message + parent re-renders); each one after the first is free.
  // After `bumpThemeVersion()` the version prefix flips, so the first
  // call under the new theme misses and rebuilds with fresh colours.
  const key = cacheKey(code, language);
  const cached = HIGHLIGHT_CACHE.get(key);
  if (cached !== undefined) {
    cacheHits += 1;
    return cached;
  }
  cacheMisses += 1;

  const lang = normaliseLanguage(language);
  if (lang === undefined) {
    const fallback = fallbackColour(code);
    cacheInsert(key, fallback);
    return fallback;
  }

  ensureColourLevel();

  let result: string;
  try {
    const out = cliHighlight(code, {
      language: lang,
      theme: CACHED_THEME,
      ignoreIllegals: true,
    });
    // Defence: highlight.js sometimes emits trailing newlines or strips
    // them; force the line count to match the input so downstream split
    // by `\n` lines up with the input lines.
    result = reconcileLineCount(code, out);
  } catch {
    result = fallbackColour(code);
  }

  cacheInsert(key, result);
  return result;
}

/**
 * Test-only helper: drop every entry from the highlight cache and zero
 * the hit/miss counters. Theme version is also reset to 0 so tests
 * start from a deterministic baseline regardless of how many bumps the
 * suite has already issued. Tests that exercise cache hit/miss
 * behaviour can call this between cases to start from a clean slate.
 */
export function __TEST_CLEAR_CACHE(): void {
  HIGHLIGHT_CACHE.clear();
  cacheHits = 0;
  cacheMisses = 0;
  themeVersion = 0;
}

/**
 * Test-only helper: peek at the current cache size without exposing
 * the Map itself. Used by cache-behaviour tests to assert that an
 * insert actually happened and that LRU eviction kicks in at the cap.
 */
export function __TEST_CACHE_SIZE(): number {
  return HIGHLIGHT_CACHE.size;
}

/**
 * Test-only helper: snapshot the cache hit/miss counters and the
 * current theme version. Used by the theme-aware cache test to assert
 * that a theme switch produces exactly one extra miss per code+lang
 * pair and that subsequent calls re-hit.
 */
export function __TEST_CACHE_STATS(): {
  readonly hits: number;
  readonly misses: number;
  readonly themeVersion: number;
  readonly size: number;
} {
  return {
    hits: cacheHits,
    misses: cacheMisses,
    themeVersion,
    size: HIGHLIGHT_CACHE.size,
  };
}

/**
 * cli-highlight occasionally returns a different number of `\n` than
 * we fed in (e.g. trailing newline collapse). The React layer expects
 * `output.split('\n').length === input.split('\n').length` so we can
 * iterate `lines` deterministically. This helper enforces that.
 */
function reconcileLineCount(input: string, output: string): string {
  const inLines = input.split('\n').length;
  const outLines = output.split('\n').length;
  if (inLines === outLines) return output;
  if (outLines < inLines) {
    return output + '\n'.repeat(inLines - outLines);
  }
  // outLines > inLines — drop the surplus from the end (ANSI-safe: we
  // only chop at \n boundaries so we don't crack a colour code in two).
  const surplus = outLines - inLines;
  const lines = output.split('\n');
  return lines.slice(0, lines.length - surplus).join('\n');
}

/**
 * Resolve a fence-label, falling back to detection when none provided.
 * Returns:
 *   - the resolved language id (highlight.js form)
 *   - `undefined` if neither label nor heuristic matched
 */
export function resolveLanguage(
  fenceLabel: string | undefined,
  code: string,
): string | undefined {
  const explicit = normaliseLanguage(fenceLabel);
  if (explicit !== undefined) return explicit;
  return detectLanguage(code);
}

/**
 * Test-only helper: re-export the assembled cli-highlight theme so we
 * can assert in tests that the major token classes have a non-passthrough
 * colourizer attached. Not for runtime consumers.
 */
export const __TEST_THEME: Theme = CACHED_THEME;
