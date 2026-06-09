/**
 * Wave 16B — inference-control types.
 *
 * The local-first moat: llama.cpp-class servers (LM Studio, Ollama,
 * llama-server, vLLM-with-grammar) expose constrained-decoding knobs
 * that cloud APIs (OpenAI / Anthropic) do NOT — GBNF grammar, raw
 * `logit_bias`, and llama.cpp's `cache_prompt`. Only an agent talking
 * raw OpenAI-compat to a local backend can use them.
 *
 * This module is dependency-free at runtime (no tokenizer bundled). The
 * adapter consumes it via the `// INFERENCE-CONTROL-SECTION` markers and
 * attaches the output to the PER-REQUEST body — never the byte-stable
 * system prompt (that would defeat the prefix cache).
 */

import type { Backend } from '@/types/global';

/**
 * What a given (backend, baseUrl, model) tuple actually honours, as
 * measured by {@link probeCapabilities}. Cloud backends short-circuit
 * to all-false without a network round-trip.
 *
 * `grammar`     — server accepts a GBNF `grammar` field (llama.cpp).
 * `jsonSchema`  — server accepts `response_format: { type: 'json_schema' }`.
 * `logitBias`   — server accepts a `logit_bias` token→bias map.
 * `cachePrompt` — server accepts llama.cpp's `cache_prompt: true`.
 * `probedAt`    — epoch ms the probe ran; drives the on-disk TTL.
 */
export interface CapabilityReport {
  grammar: boolean;
  jsonSchema: boolean;
  logitBias: boolean;
  cachePrompt: boolean;
  probedAt: number;
  backend: string;
  model: string;
}

/** A compiled GBNF grammar plus the metadata used to debug / cache it. */
export interface GrammarSpec {
  /** The GBNF source string, ready to hand to llama.cpp as `grammar`. */
  gbnf: string;
  /** Tool names the grammar admits (the enum root). */
  toolNames: readonly string[];
  /**
   * True when at least one per-tool arg constraint was derived from an
   * executor Zod validator rather than the looser wire schema. Purely
   * informational — surfaced in tests / diagnostics.
   */
  derivedFromExecutor: boolean;
}

/** Local backends that may honour constrained-decoding knobs. */
export const LOCAL_BACKENDS: readonly Backend[] = ['ollama', 'lmstudio', 'custom'];

/** Cloud backends that NEVER get probed (all capabilities false). */
export const CLOUD_BACKENDS: readonly Backend[] = [
  'openai',
  'openrouter',
  'google',
  'anthropic',
];

/**
 * True for backends that *may* support constrained decoding. `custom`
 * is treated as local because the common case is a self-hosted
 * llama.cpp / vLLM endpoint; the capability probe is the real gate, so
 * a `custom` backend that is actually a cloud proxy simply reports all
 * capabilities false and the adapter omits the knobs.
 */
export function isLocalInferenceBackend(backend: Backend | undefined): boolean {
  if (!backend) return false;
  return LOCAL_BACKENDS.includes(backend);
}

/** An all-false report for cloud backends / probe failures. */
export function disabledReport(backend: string, model: string): CapabilityReport {
  return {
    grammar: false,
    jsonSchema: false,
    logitBias: false,
    cachePrompt: false,
    probedAt: Date.now(),
    backend,
    model,
  };
}
