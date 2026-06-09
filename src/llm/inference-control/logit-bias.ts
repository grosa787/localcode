/**
 * Wave 16B — logit-bias construction (conservative v1).
 *
 * The moat: llama.cpp / LM Studio honour a raw `logit_bias` map
 * (token-id → additive bias) that cloud APIs gate or omit. We use it to
 * gently STEER the model toward symbols that are actually in scope /
 * imported in a TypeScript repo, and optionally to BAN a small set of
 * known-deprecated identifiers.
 *
 * Hard rules:
 *   - NEVER aggressive. We bias a bounded set of symbol tokens; we never
 *     touch the bulk of the vocabulary. An over-broad ban would brick
 *     generation, so `BAN_BIAS` is the only large-magnitude value and it
 *     applies only to an explicit, small `banned` list.
 *   - TYPESCRIPT-ONLY. The symbol set comes from the ontology indexer,
 *     which is TS/TSX-only (typescript-language-server). For any other
 *     language we return `{}` (no-op) and surface a one-time note so the
 *     caller can explain the graceful degradation.
 *   - NO bundled tokenizer. The caller injects a `tokenize` fn backed by
 *     the server's `/tokenize` endpoint (llama.cpp / LM Studio expose
 *     one). We never guess token ids.
 */

/** Additive bias applied to a boosted (in-scope) symbol's tokens. */
export const BOOST_BIAS = 1.5;

/**
 * Additive bias applied to a banned symbol's tokens. llama.cpp treats
 * any bias <= -100 as an effective ban. We use exactly that — applied
 * ONLY to the explicit `banned` list, never broadly.
 */
export const BAN_BIAS = -100;

/** How many distinct symbols we are willing to boost in one request. */
export const MAX_BOOST_SYMBOLS = 256;

export type LogitBiasMode = 'boost' | 'boost+ban';

export interface BuildSymbolLogitBiasParams {
  /** In-scope / imported symbol names (from the TS ontology indexer). */
  symbols: readonly string[];
  /**
   * Tokenize a piece of text into the server's token ids. Backed by the
   * llama.cpp / LM Studio `/tokenize` endpoint — injected, never bundled.
   * May be sync or async; we call it once per symbol and merge.
   */
  tokenize: (text: string) => readonly number[];
  /** boost only, or boost + ban the `banned` list. Default 'boost'. */
  mode?: LogitBiasMode;
  /** Known-deprecated identifiers to ban. Only used when mode includes ban. */
  banned?: readonly string[];
  /**
   * Language of the active repo. Only `'typescript'` / `'typescriptreact'`
   * (TS/TSX) produce a non-empty map — everything else returns `{}`.
   * Defaults to `'typescript'` so TS callers don't have to pass it.
   */
  language?: string;
}

export interface SymbolLogitBiasResult {
  /** token-id → additive bias. Empty for non-TS or empty input. */
  bias: Record<number, number>;
  /**
   * Present (once) when the map is empty because the repo isn't TS. The
   * caller logs this a single time to explain the no-op.
   */
  note?: string;
}

const TS_LANGUAGES = new Set(['typescript', 'typescriptreact', 'ts', 'tsx']);

/**
 * Build a conservative `logit_bias` map from a set of in-scope symbols.
 *
 * Returns `{ bias: {} }` (plus a `note`) when the repo isn't TypeScript —
 * the ontology indexer only understands TS/TSX, so we have no trustworthy
 * symbol set for other languages and must not bias blindly.
 */
export function buildSymbolLogitBias(
  params: BuildSymbolLogitBiasParams,
): SymbolLogitBiasResult {
  const language = params.language ?? 'typescript';
  if (!TS_LANGUAGES.has(language)) {
    return {
      bias: {},
      note:
        `logit-banlist: no-op for non-TypeScript repo (language="${language}"). ` +
        `The symbol index is TypeScript-only; biasing is skipped.`,
    };
  }

  const mode: LogitBiasMode = params.mode ?? 'boost';
  const bias: Record<number, number> = {};

  // Boost in-scope symbols — bounded set, gentle magnitude.
  const boostList = dedupe(params.symbols).slice(0, MAX_BOOST_SYMBOLS);
  for (const sym of boostList) {
    applyBias(bias, params.tokenize, sym, BOOST_BIAS);
  }

  // Ban known-deprecated names — explicit small list only.
  if (mode === 'boost+ban' && params.banned && params.banned.length > 0) {
    for (const sym of dedupe(params.banned)) {
      // A ban must win even if the symbol also appears in `symbols`.
      applyBias(bias, params.tokenize, sym, BAN_BIAS, /*overwrite*/ true);
    }
  }

  return { bias };
}

/** Tokenize a symbol and merge each token's bias into the map. */
function applyBias(
  bias: Record<number, number>,
  tokenize: (text: string) => readonly number[],
  symbol: string,
  value: number,
  overwrite = false,
): void {
  if (symbol.length === 0) return;
  let tokens: readonly number[];
  try {
    tokens = tokenize(symbol);
  } catch {
    // A tokenizer hiccup must never break generation — skip the symbol.
    return;
  }
  for (const tok of tokens) {
    if (!Number.isInteger(tok) || tok < 0) continue;
    if (overwrite) {
      bias[tok] = value;
    } else if (bias[tok] === undefined || Math.abs(value) > Math.abs(bias[tok])) {
      // Keep the larger-magnitude bias when a token is shared across
      // symbols, so a ban is never silently downgraded by a boost.
      bias[tok] = value;
    }
  }
}

function dedupe(xs: readonly string[]): string[] {
  return Array.from(new Set(xs.filter((x) => typeof x === 'string' && x.length > 0)));
}
