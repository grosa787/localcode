/**
 * `web_search` tool — run a search query and return the top N results
 * (title + URL + snippet) so the model can pick which page to actually
 * fetch via `web_fetch`.
 *
 * Backend: DuckDuckGo Lite (`https://lite.duckduckgo.com/lite/`). The
 * `/lite/` endpoint accepts POST form-data and (unlike `/html/`) very
 * rarely returns the anomaly/captcha challenge. No API key required —
 * keeps LocalCode local-first.
 *
 * Output: stable JSON-stringified envelope in `ToolResult.output`:
 *   {
 *     query: string,
 *     results: Array<{ title: string; url: string; snippet: string }>
 *   }
 *
 * This tool is auto-approved — read-only GET/POST with no filesystem
 * side effects.
 */

import { z } from 'zod';

import type { ToolContext, ToolResult } from './types';

/** Default # results returned when caller omits `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
/** Absolute upper bound — DDG Lite returns ~30 per page, we cap below that. */
const HARD_MAX_RESULTS = 25;
/** Network timeout for the search request (ms). */
const FETCH_TIMEOUT_MS = 15_000;

/** Zod schema for `web_search` arguments. */
export const WebSearchArgsSchema = z.object({
  query: z
    .string()
    .min(1, 'query must be a non-empty string')
    .max(500, 'query must be 500 chars or fewer'),
  maxResults: z.number().int().positive().optional(),
});

export type WebSearchArgs = z.infer<typeof WebSearchArgsSchema>;

/** Internal options bag — exposed so tests can inject a fake fetch. */
export interface WebSearchOptions {
  /**
   * Override the URL used for the search request. Tests point this at a
   * mocked endpoint; production callers leave it undefined.
   */
  endpoint?: string;
}

/** One search hit. */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Output envelope for the success path. Serialised into `result.output`. */
export interface WebSearchEnvelope {
  query: string;
  results: readonly WebSearchHit[];
}

/** Failure helper — tools never throw; they return a structured result. */
function fail(message: string): ToolResult {
  return {
    success: false,
    output: '',
    error: message,
  };
}

/** Success helper — envelope is JSON-stringified into `output`. */
function succeed(env: WebSearchEnvelope): ToolResult {
  return {
    success: true,
    output: JSON.stringify(env),
  };
}

/**
 * Decode the common HTML named entities + numeric refs that DDG emits in
 * titles and snippets. We don't pull in a full HTML parser — the surface
 * is small and stable.
 */
function decodeEntities(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => {
      const code = parseInt(n, 16);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Strip any HTML tags from a fragment (DDG wraps the matched query terms
 * in `<b>...</b>`). We keep this minimal — same surface as `htmlToMarkdown`
 * but lossy: only the text content survives.
 */
function stripTags(raw: string): string {
  return raw.replace(/<[^>]+>/g, '');
}

/** Normalise whitespace and decode entities — applied to titles + snippets. */
function cleanText(raw: string): string {
  return decodeEntities(stripTags(raw)).replace(/\s+/g, ' ').trim();
}

/**
 * Reject the ad links DDG slips into Lite results. They look like
 * `https://duckduckgo.com/y.js?ad_domain=...&u3=<destination>`. Returning
 * the wrapper URL would force the model to fetch a redirector instead of
 * the real page; better to drop them entirely.
 */
function isAdLink(url: string): boolean {
  return (
    url.startsWith('https://duckduckgo.com/y.js') ||
    url.startsWith('http://duckduckgo.com/y.js') ||
    url.startsWith('//duckduckgo.com/y.js')
  );
}

/**
 * Parse the DDG Lite HTML into search hits. The format is stable enough
 * that a focused regex is more robust than ad-hoc DOM walking — each
 * result is a `<a ... class='result-link' href="..."}>title</a>` followed
 * (somewhere downstream in the document) by the matching
 * `<td class='result-snippet'>snippet</td>` cell.
 *
 * We walk the document position-by-position: when we hit a result-link
 * anchor we keep it, then peek forward for the next `result-snippet`
 * cell after the anchor's end. This keeps anchor/snippet pairing
 * correct even when some anchors get filtered out (ads, "more info").
 *
 * The "more info" rows DDG injects under sponsored results also carry
 * `class='result-link'`. We filter them by exact text match.
 */
export function parseDuckDuckGoLite(html: string): WebSearchHit[] {
  const hits: WebSearchHit[] = [];

  // Build an ordered list of snippet cell positions so we can find the
  // snippet that follows each accepted anchor.
  const snippetRe = /<td\b[^>]*\bclass=['"][^'"]*\bresult-snippet\b[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi;
  const snippetSlots: Array<{ start: number; text: string }> = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRe.exec(html)) !== null) {
    snippetSlots.push({
      start: snippetMatch.index,
      text: cleanText(snippetMatch[1] ?? ''),
    });
  }

  // Find every <a ... class='result-link' ...> anchor regardless of attribute
  // order (DDG Lite emits `href` before `class`).
  const anchorRe = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  const hrefRe = /\bhref\s*=\s*['"]([^'"]+)['"]/i;
  const classRe = /\bclass\s*=\s*['"]([^'"]*)['"]/i;

  // Track the highest snippet index we've consumed so two anchors in a
  // row don't reuse the same snippet.
  let nextSnippetIdx = 0;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRe.exec(html)) !== null) {
    const attrs = anchorMatch[1] ?? '';
    const inner = anchorMatch[2] ?? '';
    const classMatch = classRe.exec(attrs);
    const classVal = classMatch?.[1] ?? '';
    if (!/\bresult-link\b/.test(classVal)) continue;
    const hrefMatch = hrefRe.exec(attrs);
    const rawUrl = hrefMatch?.[1] ?? '';
    const title = cleanText(inner);
    if (!rawUrl) continue;
    // Skip "more info" links and ad wrappers.
    if (title.toLowerCase() === 'more info') continue;
    if (isAdLink(rawUrl)) continue;
    const url = decodeEntities(rawUrl);
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      continue;
    }
    if (!title) continue;
    // Advance past any snippets that occur before this anchor so the next
    // available snippet is the one that follows it in the document.
    const anchorEnd = anchorMatch.index + anchorMatch[0].length;
    while (
      nextSnippetIdx < snippetSlots.length &&
      (snippetSlots[nextSnippetIdx]?.start ?? 0) < anchorEnd
    ) {
      nextSnippetIdx += 1;
    }
    const snippet = snippetSlots[nextSnippetIdx]?.text ?? '';
    if (nextSnippetIdx < snippetSlots.length) nextSnippetIdx += 1;
    hits.push({ title, url, snippet });
  }

  return hits;
}

/**
 * Execute the search. See module doc for the format contract.
 */
export async function webSearch(
  args: WebSearchArgs,
  _ctx: ToolContext,
  options?: WebSearchOptions,
): Promise<ToolResult> {
  const parsed = WebSearchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return fail(
      `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const maxResults = Math.min(
    parsed.data.maxResults ?? DEFAULT_MAX_RESULTS,
    HARD_MAX_RESULTS,
  );
  const endpoint = options?.endpoint ?? 'https://lite.duckduckgo.com/lite/';
  const body = new URLSearchParams({ q: parsed.data.query }).toString();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // DDG Lite serves a plain mobile page when given a regular UA; the
        // anomaly challenge is far less aggressive than the /html/ path.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return fail(`web_search timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Network error during web_search: ${msg}`);
  }

  if (!response.ok) {
    return fail(
      `web_search failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  let html: string;
  try {
    html = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`web_search could not read response body: ${msg}`);
  }

  // DDG sometimes returns an HTTP-200 anomaly page instead of results.
  // Detect it cheaply so the model gets a clear error rather than zero
  // results with no explanation.
  if (/anomaly-modal|anomaly\.js/i.test(html) && !/result-link/i.test(html)) {
    return fail(
      'web_search blocked by DuckDuckGo anti-bot challenge — try again later or use web_fetch on a specific URL.',
    );
  }

  const hits = parseDuckDuckGoLite(html).slice(0, maxResults);
  return succeed({ query: parsed.data.query, results: hits });
}
