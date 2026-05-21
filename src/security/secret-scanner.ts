/**
 * Secret scanner — detects API keys, tokens, and other credentials in
 * text and git diffs. Used by the built-in PreToolUse hook to block
 * `git_commit` when staged additions contain unredacted secrets.
 *
 * Catalog covers the common cloud / OAuth / payment / private-key
 * formats plus a low-confidence entropy heuristic for free-form
 * `secret=...` lines. Every finding carries a `redactedMatch` field so
 * synthetic messages never echo the raw secret back into the chat log.
 *
 * The scanner is pure — no I/O, no logging, no thrown errors. Callers
 * decide whether to block / surface / persist findings.
 */

import { looksHighEntropy } from './entropy';

export type Severity = 'critical' | 'high' | 'medium';

export interface Finding {
  /** Stable identifier for the pattern category (e.g. `aws-access-key`). */
  kind: string;
  /** Suggested severity. Critical = certain & destructive; medium = heuristic. */
  severity: Severity;
  /**
   * Heuristic confidence 0..1. Pattern-matched keys are >=0.9;
   * entropy-only findings are 0.5..0.7.
   */
  confidence: number;
  /** Raw matched value (NEVER serialized to a user-facing surface). */
  match: string;
  /** Redacted form safe to print (`AKIA**********`). */
  redactedMatch: string;
  /** 1-based line number inside the scanned text. */
  line: number;
  /** Optional file path (only populated when caller knows it). */
  file?: string;
}

interface PatternEntry {
  kind: string;
  severity: Severity;
  confidence: number;
  /** Sticky-safe `RegExp` with the `g` flag set. */
  regex: RegExp;
  /**
   * Optional secondary validator: pattern says "this looks like a secret",
   * the validator says "but is it really" (e.g. entropy floor).
   */
  validator?: (match: string) => boolean;
}

/**
 * Pattern catalog. Order matters only for tie-breaking when multiple
 * patterns match the same substring — the first wins per character
 * range, but the scanner emits every distinct kind that hits.
 *
 * Each regex is anchored with a non-capturing left boundary (`\b` or
 * lookbehind for `:` / `=`) to keep false positives off identifier-like
 * substrings.
 */
const PATTERNS: readonly PatternEntry[] = [
  // AWS access key id — fixed 20-char prefix+suffix shape.
  {
    kind: 'aws-access-key',
    severity: 'critical',
    confidence: 0.98,
    regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  // AWS secret access key value (looser; only flags when context word
  // `aws_secret_access_key` appears on the same line).
  {
    kind: 'aws-secret-access-key',
    severity: 'critical',
    confidence: 0.9,
    regex: /aws[_-]?secret[_-]?access[_-]?key["'\s:=]+([A-Za-z0-9/+=]{40})\b/gi,
  },
  // GitHub PATs — ghp_, gho_, ghu_, ghs_, ghr_ followed by ~36 base62.
  {
    kind: 'github-pat',
    severity: 'critical',
    confidence: 0.99,
    regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  },
  // OpenAI project keys (newer shape).
  {
    kind: 'openai-project-key',
    severity: 'critical',
    confidence: 0.98,
    regex: /\bsk-proj-[A-Za-z0-9_-]{40,}\b/g,
  },
  // OpenAI legacy API keys. Loose pattern; validate length & entropy.
  {
    kind: 'openai-api-key',
    severity: 'critical',
    confidence: 0.9,
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    validator: (m): boolean => !m.startsWith('sk-ant-') && !m.startsWith('sk-proj-'),
  },
  // Anthropic Claude API key.
  {
    kind: 'anthropic-api-key',
    severity: 'critical',
    confidence: 0.99,
    regex: /\bsk-ant-api03-[A-Za-z0-9_-]{80,}\b/g,
  },
  // Google Cloud API key (browser / firebase / maps style).
  {
    kind: 'google-api-key',
    severity: 'critical',
    confidence: 0.97,
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  // Google service-account private key (PEM marker).
  {
    kind: 'google-service-account-key',
    severity: 'critical',
    confidence: 0.99,
    regex: /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----/g,
  },
  // Slack token (bot / user / app / refresh / config).
  {
    kind: 'slack-token',
    severity: 'high',
    confidence: 0.97,
    regex: /\bxox[bpoasr]-[0-9]+-[0-9]+-[0-9a-zA-Z-]+\b/g,
  },
  // Stripe live secret key.
  {
    kind: 'stripe-secret-key',
    severity: 'critical',
    confidence: 0.99,
    regex: /\bsk_live_[A-Za-z0-9]{24,}\b/g,
  },
  // Stripe live publishable (less critical but worth noting).
  {
    kind: 'stripe-publishable-key',
    severity: 'medium',
    confidence: 0.95,
    regex: /\bpk_live_[A-Za-z0-9]{24,}\b/g,
  },
  // Generic PEM private key markers.
  {
    kind: 'private-key',
    severity: 'critical',
    confidence: 0.99,
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
];

// JWT-style triple (header.payload.signature) — separate from the
// catalog so we can apply length + non-overlap rules cleanly. Lower
// confidence because base64 fragments concatenated with dots can occur
// in source maps and minified bundles.
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

// Entropy line heuristic — looks for `key=` / `secret:` / `token =` /
// `password =` assignments with a quoted or bareword value.
const ENTROPY_LINE_RE =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|secret|token|password|passwd|api_secret)\b\s*[:=]\s*["']?([^"'\s,;]{20,200})["']?/gi;

// Dictionary-ish placeholder values we shouldn't flag (template / docs).
const PLACEHOLDER_VALUES = new Set<string>([
  'changeme',
  'your-key-here',
  'your_api_key',
  'placeholder',
  'example',
  'redacted',
  'undefined',
  'null',
  'xxxxxxxxxxxxxxxx',
]);

/**
 * Replace the middle of a secret with `*`, keeping a 4-char prefix +
 * 2-char suffix so reviewers can sanity-check the source without
 * leaking the value. Strings shorter than 8 chars are fully redacted.
 */
export function redact(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  const head = value.slice(0, 4);
  const tail = value.slice(-2);
  const mid = '*'.repeat(Math.min(12, value.length - 6));
  return `${head}${mid}${tail}`;
}

/**
 * Scan a single line. Internal helper — `scanText` walks the file and
 * tags each finding with the line number.
 */
function scanLine(line: string): Array<Omit<Finding, 'line' | 'file'>> {
  const out: Array<Omit<Finding, 'line' | 'file'>> = [];
  const seenRanges = new Set<string>();

  for (const entry of PATTERNS) {
    entry.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entry.regex.exec(line)) !== null) {
      const matched = m[0];
      if (matched.length === 0) {
        entry.regex.lastIndex += 1;
        continue;
      }
      if (entry.validator !== undefined && !entry.validator(matched)) continue;
      const key = `${entry.kind}:${m.index}:${matched.length}`;
      if (seenRanges.has(key)) continue;
      seenRanges.add(key);
      out.push({
        kind: entry.kind,
        severity: entry.severity,
        confidence: entry.confidence,
        match: matched,
        redactedMatch: redact(matched),
      });
    }
  }

  // JWT triple.
  JWT_REGEX.lastIndex = 0;
  let jm: RegExpExecArray | null;
  while ((jm = JWT_REGEX.exec(line)) !== null) {
    const matched = jm[0];
    if (matched.length === 0) {
      JWT_REGEX.lastIndex += 1;
      continue;
    }
    // Skip if any high-confidence pattern already covers this exact text
    // (avoids double-counting when a JWT-shaped value is also matched by
    // an upstream pattern — unlikely but cheap to guard).
    if (out.some((f) => f.match === matched)) continue;
    out.push({
      kind: 'jwt',
      severity: 'medium',
      confidence: 0.6,
      match: matched,
      redactedMatch: redact(matched),
    });
  }

  // Entropy assignment heuristic — `secret = "..."` style. Skip if any
  // higher-confidence pattern already covered the value (e.g. a literal
  // OpenAI key after `api_key=`).
  ENTROPY_LINE_RE.lastIndex = 0;
  let em: RegExpExecArray | null;
  while ((em = ENTROPY_LINE_RE.exec(line)) !== null) {
    const value = em[2];
    if (value === undefined || value.length === 0) continue;
    if (PLACEHOLDER_VALUES.has(value.toLowerCase())) continue;
    // Skip if a pattern-based finding already covers this value.
    if (out.some((f) => f.match === value || value.includes(f.match))) continue;
    if (!looksHighEntropy(value, { minLength: 20, minEntropy: 4.0 })) continue;
    out.push({
      kind: 'high-entropy-assignment',
      severity: 'medium',
      confidence: 0.55,
      match: value,
      redactedMatch: redact(value),
    });
  }

  return out;
}

/**
 * Scan arbitrary text. Splits on `\n`, returns one `Finding` per match
 * with `line` set to the 1-based line number.
 */
export function scanText(text: string, file?: string): Finding[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined || raw.length === 0) continue;
    for (const f of scanLine(raw)) {
      const merged: Finding = {
        ...f,
        line: i + 1,
      };
      if (file !== undefined) merged.file = file;
      findings.push(merged);
    }
  }
  return findings;
}

/**
 * Scan a unified-diff string (`git diff --cached --no-color` output).
 * Only `+` additions are scanned — removals and context are ignored.
 * The file path is tracked across `+++ b/<path>` headers so each
 * finding can attribute back to its source file.
 */
export function scanCommitDiff(diff: string): Finding[] {
  if (diff.length === 0) return [];
  const lines = diff.split(/\r?\n/);
  const findings: Finding[] = [];
  let currentFile: string | undefined;
  // Diff line numbers don't correspond to file line numbers without
  // hunk parsing; we keep a simple post-`@@` counter so users get a
  // useful approximation.
  let newLineNumber = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (raw.startsWith('+++ ')) {
      // `+++ b/path/to/file` → strip the `b/` prefix when present.
      const tail = raw.slice(4).trim();
      currentFile = tail.startsWith('b/') ? tail.slice(2) : tail;
      newLineNumber = 0;
      continue;
    }
    if (raw.startsWith('--- ')) {
      // Skip the old-file header.
      continue;
    }
    if (raw.startsWith('@@')) {
      // Parse `@@ -A,B +C,D @@` for the new-file starting line.
      const m = raw.match(/\+(\d+)/);
      if (m !== null && m[1] !== undefined) {
        const parsed = Number.parseInt(m[1], 10);
        newLineNumber = Number.isFinite(parsed) ? parsed : 0;
      }
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const content = raw.slice(1);
      const lineFindings = scanLine(content);
      for (const f of lineFindings) {
        const merged: Finding = {
          ...f,
          line: newLineNumber > 0 ? newLineNumber : i + 1,
        };
        if (currentFile !== undefined && currentFile !== '/dev/null') {
          merged.file = currentFile;
        }
        findings.push(merged);
      }
      newLineNumber += 1;
    } else if (!raw.startsWith('-')) {
      // Context lines advance the new-line counter too.
      newLineNumber += 1;
    }
  }
  return findings;
}

/**
 * Format a finding as a single line suitable for synthetic hook
 * messages. Always uses the redacted form — never the raw secret.
 */
export function formatFinding(f: Finding): string {
  const loc = f.file !== undefined ? `${f.file}:${f.line}` : `line ${f.line}`;
  return `${f.kind} at ${loc} ("${f.redactedMatch}")`;
}
