/**
 * Tiny HTML → Markdown converter used by the `web_fetch` tool.
 *
 * Deliberately regex-based and dependency-free. The goal is not pixel-perfect
 * fidelity but a useful plain-text representation of arbitrary HTML pages so
 * the LLM can read them as context. Five passes:
 *   1. Strip `<script>`, `<style>`, `<noscript>`, `<svg>`, `<head>`, comments.
 *   2. Convert structural tags (h1-h6, p, br, hr, ul/ol/li, pre/code, a, img,
 *      blockquote, strong/em, table cells) to Markdown equivalents.
 *   3. Drop every remaining tag.
 *   4. Decode the most common HTML entities (numeric + named).
 *   5. Collapse runs of whitespace / blank lines.
 *
 * The implementation tolerates malformed HTML — every regex is non-greedy
 * with the `s` flag and we never throw on bad input. The worst-case output
 * for input we don't understand is "stripped tags + decoded entities" which
 * is still strictly better than the raw markup.
 */

/** Hand-picked subset of HTML entities. Covers ~99% of real-world pages. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  Agrave: 'À',
  Eacute: 'É',
  iexcl: '¡',
  iquest: '¿',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, dec: string): string => {
      const code = Number(dec);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string): string => {
      const code = parseInt(hex, 16);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string): string => {
      const replacement = NAMED_ENTITIES[name];
      return replacement !== undefined ? replacement : whole;
    });
}

/** Strip a set of "dangerous" or noisy blocks before any tag conversion. */
function stripBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '');
}

/** Pull a single attribute value out of a tag's attribute string. */
function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = re.exec(attrs);
  if (!match) return null;
  return (match[2] ?? match[3] ?? match[4] ?? '').trim();
}

/**
 * Convert known structural tags into Markdown equivalents. Tags we don't
 * recognise are left in place for the final tag-strip pass to remove.
 */
function transformTags(html: string): string {
  let out = html;

  // Headings — emit `# `..`###### ` plus the inner text, blank line after.
  for (let level = 1; level <= 6; level += 1) {
    const re = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}\\s*>`, 'gi');
    const prefix = '#'.repeat(level);
    out = out.replace(re, (_, inner: string): string => `\n\n${prefix} ${inner.trim()}\n\n`);
  }

  // Block-level breaks.
  out = out.replace(/<br\s*\/?\s*>/gi, '\n');
  out = out.replace(/<hr\s*\/?\s*>/gi, '\n\n---\n\n');

  // Paragraphs.
  out = out.replace(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi, (_, inner: string): string => {
    return `\n\n${inner.trim()}\n\n`;
  });

  // Blockquotes — prefix every line with `> `.
  out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_, inner: string): string => {
    const trimmed = inner.trim();
    if (!trimmed) return '';
    const quoted = trimmed
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `\n\n${quoted}\n\n`;
  });

  // Pre+code blocks — fenced.
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner: string): string => {
    // Inner may itself be `<code>...</code>` — strip those for the fence.
    const body = inner.replace(/<\/?code\b[^>]*>/gi, '');
    return `\n\n\`\`\`\n${body.trim()}\n\`\`\`\n\n`;
  });

  // Inline code.
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner: string): string => {
    return `\`${inner.trim()}\``;
  });

  // Strong / b / em / i.
  out = out.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, (_, inner: string): string => {
    return `**${inner.trim()}**`;
  });
  out = out.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, (_, inner: string): string => {
    return `*${inner.trim()}*`;
  });

  // Links — preserve href.
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string): string => {
    const href = attr(attrs, 'href');
    const text = inner.trim();
    if (href && text) return `[${text}](${href})`;
    if (text) return text;
    return '';
  });

  // Images — emit `![alt](src)`.
  out = out.replace(/<img\b([^>]*)\/?>/gi, (_, attrs: string): string => {
    const src = attr(attrs, 'src');
    const alt = attr(attrs, 'alt') ?? '';
    if (!src) return '';
    return `![${alt}](${src})`;
  });

  // Unordered list items.
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner: string): string => {
    return `\n- ${inner.trim()}`;
  });

  // Drop the list wrappers (they only add noise once items are line-prefixed).
  out = out.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n');

  // Tables — flatten cells to `| col1 | col2 |` per row.
  out = out.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi, (_, inner: string): string => {
    const cells: string[] = [];
    const cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = cellRe.exec(inner)) !== null) {
      const cellText = (match[1] ?? '').replace(/\s+/g, ' ').trim();
      cells.push(cellText);
    }
    if (cells.length === 0) return '';
    return `\n| ${cells.join(' | ')} |`;
  });

  // Generic block tags we want to KEEP separated by blank lines but whose
  // content shouldn't get any markdown decoration.
  out = out.replace(/<(?:div|section|article|header|footer|main|aside|nav)\b[^>]*>/gi, '\n');
  out = out.replace(/<\/(?:div|section|article|header|footer|main|aside|nav)\s*>/gi, '\n');

  return out;
}

/** Drop any remaining tags after structural conversion. */
function dropTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** Collapse runs of spaces/tabs and ≥3 newlines down to a maximum of 2. */
function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert an arbitrary HTML string to a Markdown approximation. Pure
 * function; never throws on malformed input.
 */
export function htmlToMarkdown(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  const stripped = stripBlocks(html);
  const transformed = transformTags(stripped);
  const tagless = dropTags(transformed);
  const decoded = decodeEntities(tagless);
  return collapseWhitespace(decoded);
}
