/**
 * Shannon entropy helper for the secret scanner.
 *
 * Used as a heuristic gate for "looks-like-secret" detection on lines
 * that mention `api_key` / `token` / `secret` / `password`: real secrets
 * tend to have high per-character entropy (>4 bits over ≥20 chars) while
 * dictionary words / paths / sentences stay well below that.
 *
 * Pure function, no dependencies — safe to import from anywhere.
 */

/**
 * Shannon entropy in bits per character. Returns 0 for the empty
 * string. Higher values = more random-looking.
 *
 * Typical values:
 *   - "password123"            → ~3.3
 *   - "hello world"            → ~2.8
 *   - "AKIAIOSFODNN7EXAMPLE"   → ~3.9
 *   - random 32-char base64    → ~5.5+
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts: Record<string, number> = {};
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const len = value.length;
  let entropy = 0;
  for (const k of Object.keys(counts)) {
    const c = counts[k] ?? 0;
    if (c === 0) continue;
    const p = c / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * `true` when `value` looks high-entropy enough to be a secret. Combines
 * a minimum-length floor (avoids flagging 4-char hex codes) with a
 * Shannon-entropy bar. Defaults: 20 chars / 4.0 bits — matches the spec.
 */
export function looksHighEntropy(
  value: string,
  opts: { minLength?: number; minEntropy?: number } = {},
): boolean {
  const minLength = opts.minLength ?? 20;
  const minEntropy = opts.minEntropy ?? 4.0;
  if (value.length < minLength) return false;
  return shannonEntropy(value) >= minEntropy;
}
