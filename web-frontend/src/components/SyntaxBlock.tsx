/**
 * SyntaxBlock — fenced code rendering with the Nox syntax theme.
 *
 * Visual treatment per spec:
 *   - container `--bg-elevated`, radius 8px, padding `10px 16px`
 *   - mono 13px / 22px line
 *   - top-right: lang label 11px `--text-muted` + Copy icon button
 *
 * We render plain `<pre><code>` and apply Nox-flavoured token colours
 * via a tiny tokeniser keyed on the declared language. Shiki is the
 * preferred upgrade path; gating it behind a lazy import keeps the
 * baseline bundle small while leaving room for a richer highlighter
 * later. The set of supported languages mirrors the plan's list:
 * `typescript|tsx|javascript|jsx|python|bash|json|markdown|html|css`.
 *
 * The component never sets `dangerouslySetInnerHTML` — every span is a
 * React node, so the highlighter cannot be turned into an XSS vector.
 */

import { memo, useCallback, useMemo, useState, type JSX } from 'react';

import { Check, Copy } from '../icons';

import styles from './SyntaxBlock.module.css';

export interface SyntaxBlockProps {
  language: string | null;
  code: string;
}

type SupportedLang =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'bash'
  | 'json'
  | 'markdown'
  | 'html'
  | 'css';

const ALIASES: Record<string, SupportedLang> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  py: 'python',
  python: 'python',
  sh: 'bash',
  shell: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  css: 'css',
};

function normaliseLang(lang: string | null): SupportedLang | null {
  if (lang === null) return null;
  const key = lang.toLowerCase();
  return ALIASES[key] ?? null;
}

// ---------- Tokeniser (deliberately simple; covers the common 80%) ----------

export type Token = { cls: string; text: string };

const KEYWORDS_TS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import',
  'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'public',
  'private', 'protected', 'readonly', 'return', 'satisfies', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield',
]);

const KEYWORDS_PY = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'True', 'try', 'while', 'with', 'yield',
]);

const KEYWORDS_BASH = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'do',
  'done', 'in', 'function', 'return', 'export', 'local', 'readonly',
]);

/**
 * Coalesce adjacent tokens that share the same className into a single
 * token. The tokenisers above emit a token per identifier, operator and
 * even per single un-classified character — for typical TS code that is
 * 2x more spans than necessary. Folding adjacent same-class runs cuts
 * the React node count (and the resulting DOM) by ~50% on average,
 * which directly translates to faster reconciliation while streaming.
 */
export function coalesceTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last !== undefined && last.cls === t.cls) {
      out[out.length - 1] = { cls: last.cls, text: last.text + t.text };
    } else {
      out.push(t);
    }
  }
  return out;
}

function tokensFor(lang: SupportedLang | null, src: string): Token[] {
  if (lang === null) return [{ cls: '', text: src }];

  let raw: Token[];
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      raw = tokeniseCLike(src, KEYWORDS_TS, '//', '/*', '*/');
      break;
    case 'python':
      raw = tokeniseCLike(src, KEYWORDS_PY, '#', null, null);
      break;
    case 'bash':
      raw = tokeniseCLike(src, KEYWORDS_BASH, '#', null, null);
      break;
    case 'json':
      raw = tokeniseJson(src);
      break;
    case 'css':
      raw = tokeniseCss(src);
      break;
    case 'html':
      raw = tokeniseHtml(src);
      break;
    case 'markdown':
      raw = [{ cls: '', text: src }];
      break;
  }
  return coalesceTokens(raw);
}

function tokeniseCLike(
  src: string,
  keywords: ReadonlySet<string>,
  lineComment: string,
  blockOpen: string | null,
  blockClose: string | null,
): Token[] {
  const out: Token[] = [];
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i] ?? '';

    // Block comment.
    if (
      blockOpen !== null &&
      blockClose !== null &&
      src.startsWith(blockOpen, i)
    ) {
      const end = src.indexOf(blockClose, i + blockOpen.length);
      const stop = end === -1 ? len : end + blockClose.length;
      out.push({ cls: styles.comment ?? '', text: src.slice(i, stop) });
      i = stop;
      continue;
    }

    // Line comment.
    if (src.startsWith(lineComment, i)) {
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? len : nl;
      out.push({ cls: styles.comment ?? '', text: src.slice(i, stop) });
      i = stop;
      continue;
    }

    // Strings — single/double/backtick.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        const c = src[j] ?? '';
        if (c === '\\') { j += 2; continue; }
        if (c === quote) { j++; break; }
        j++;
      }
      out.push({ cls: styles.string ?? '', text: src.slice(i, j) });
      i = j;
      continue;
    }

    // Numbers.
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < len) {
        const c = src[j] ?? '';
        if ((c >= '0' && c <= '9') || c === '.' || c === 'x' || c === 'e' ||
            (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
          j++;
        } else {
          break;
        }
      }
      out.push({ cls: styles.number ?? '', text: src.slice(i, j) });
      i = j;
      continue;
    }

    // Identifiers / keywords.
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      let j = i + 1;
      while (j < len) {
        const c = src[j] ?? '';
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c === '_' || c === '$') {
          j++;
        } else {
          break;
        }
      }
      const word = src.slice(i, j);
      if (keywords.has(word)) {
        out.push({ cls: styles.keyword ?? '', text: word });
      } else if (
        // Function-call or definition heuristic: identifier followed by `(`.
        j < len && src[j] === '('
      ) {
        out.push({ cls: styles.function ?? '', text: word });
      } else {
        out.push({ cls: '', text: word });
      }
      i = j;
      continue;
    }

    // Default — advance one character.
    out.push({ cls: '', text: ch });
    i++;
  }

  return out;
}

function tokeniseJson(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i] ?? '';
    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        const c = src[j] ?? '';
        if (c === '\\') { j += 2; continue; }
        if (c === '"') { j++; break; }
        j++;
      }
      // Detect key (followed by colon ignoring whitespace).
      let k = j;
      while (k < len && (src[k] === ' ' || src[k] === '\t')) k++;
      const isKey = src[k] === ':';
      out.push({
        cls: isKey ? styles.type ?? '' : styles.string ?? '',
        text: src.slice(i, j),
      });
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < len) {
        const c = src[j] ?? '';
        if ((c >= '0' && c <= '9') || c === '.' || c === 'e' || c === '-' || c === '+') {
          j++;
        } else { break; }
      }
      out.push({ cls: styles.number ?? '', text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === 't' || ch === 'f' || ch === 'n') {
      const rest = src.slice(i, i + 5);
      if (rest.startsWith('true')) {
        out.push({ cls: styles.keyword ?? '', text: 'true' });
        i += 4;
        continue;
      }
      if (rest.startsWith('false')) {
        out.push({ cls: styles.keyword ?? '', text: 'false' });
        i += 5;
        continue;
      }
      if (rest.startsWith('null')) {
        out.push({ cls: styles.keyword ?? '', text: 'null' });
        i += 4;
        continue;
      }
    }
    out.push({ cls: '', text: ch });
    i++;
  }
  return out;
}

function tokeniseCss(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i] ?? '';
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? len : end + 2;
      out.push({ cls: styles.comment ?? '', text: src.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        const c = src[j] ?? '';
        if (c === '\\') { j += 2; continue; }
        if (c === quote) { j++; break; }
        j++;
      }
      out.push({ cls: styles.string ?? '', text: src.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ cls: '', text: ch });
    i++;
  }
  return out;
}

function tokeniseHtml(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i] ?? '';
    if (ch === '<') {
      const end = src.indexOf('>', i);
      const stop = end === -1 ? len : end + 1;
      out.push({ cls: styles.keyword ?? '', text: src.slice(i, stop) });
      i = stop;
      continue;
    }
    out.push({ cls: '', text: ch });
    i++;
  }
  return out;
}

function SyntaxBlockImpl({ language, code }: SyntaxBlockProps): JSX.Element {
  const lang = normaliseLang(language);
  const tokens = useMemo(() => tokensFor(lang, code), [lang, code]);

  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      return;
    }
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {
        // Silent failure — clipboard rejection is usually a permissions
        // issue and surfacing it as a toast would be too chatty.
      },
    );
  }, [code]);

  const label = language !== null && language.length > 0 ? language : 'text';

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.lang}>{label}</span>
        <button
          type="button"
          className={styles.copyBtn}
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy'}
        >
          {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
        </button>
      </div>
      <pre className={styles.pre}>
        <code className={styles.code}>
          {tokens.map((t, idx) =>
            t.cls.length > 0 ? (
              <span key={idx} className={t.cls}>{t.text}</span>
            ) : (
              <span key={idx}>{t.text}</span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

/**
 * Memoised at the component boundary: re-tokenising on every parent
 * keystroke is wasted work since the highlight only depends on
 * (language, code). Combined with the inner `useMemo([lang, code])`
 * the highlight result is reused both within a single render
 * lifecycle and across parent re-renders that don't touch our props.
 */
export const SyntaxBlock = memo(SyntaxBlockImpl);
