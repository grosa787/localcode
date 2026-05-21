/**
 * R26 (ROADMAP #14) — model-specific prompt presets.
 * R27 (Agent A) — token-trimmed bodies.
 *
 * Different open-weights model families respond best to different
 * prompt styles. The preset tweaks ONLY the `## Identity` body — the
 * surrounding sections (Language, Operating rules, Self-configuration,
 * etc.) stay identical across presets so cache prefix and tests are
 * stable.
 *
 * Detection priority is contains-match against the lowercased model
 * name; first hit wins. Mistral and CodeLlama deliberately route to
 * `generic` (their tuning is close to OpenAI defaults).
 *
 * The `default` preset is the baseline — it carries the senior persona
 * + tools reminder. Family-specific presets diverge from there.
 */

/**
 * Canonical preset identifier. Stable across releases — used in
 * AGENTS_LOG entries and (potentially) telemetry to track which preset
 * a session ran under.
 */
export type ModelPresetName =
  | 'qwen'
  | 'gemma'
  | 'llama'
  | 'deepseek'
  | 'generic'
  | 'default';

/**
 * Match the model name (case-folded, trimmed) against the known
 * families. Substring matching gives high recall without false
 * positives — model identifiers in LM Studio / Ollama tend to embed
 * the family name in the path.
 *
 * Order matters: `codellama` must be caught BEFORE `llama` so it
 * routes to `generic` per spec. Empty / non-string returns `default`.
 */
export function detectModelPreset(modelName: string): ModelPresetName {
  if (typeof modelName !== 'string') return 'default';
  const name = modelName.toLowerCase().trim();
  if (name.length === 0) return 'default';
  if (name.includes('qwen')) return 'qwen';
  if (name.includes('gemma')) return 'gemma';
  if (name.includes('deepseek')) return 'deepseek';
  if (name.includes('codellama')) return 'generic';
  if (name.includes('llama')) return 'llama';
  if (name.includes('mistral')) return 'generic';
  return 'default';
}

// ---------- Preset bodies (R27 trimmed) ----------

/**
 * DEFAULT — senior persona + tools reminder. Tests require mention of
 * TypeScript, write_file, edit_file. ~40 tokens.
 */
const IDENTITY_DEFAULT =
  'Senior engineer pair-programming with the user. TypeScript/Python/Go/Rust, mature libs, correctness > cleverness. Deliver code via write_file / edit_file — never paste in chat.';

/**
 * QWEN — formal tone, explicit examples. Test asserts `worked example`.
 * ~35 tokens.
 */
const IDENTITY_QWEN =
  'Senior engineer (Qwen). State the trade-off before coding.\n\nWorked example: USER: "add caching" → YOU: "Per-request memo (fast, no reuse) vs module LRU (better hit, invalidation pain). Picking LRU because resolver is pure-of-side-effects."\n\nDeliver code via write_file / edit_file.';

/**
 * GEMMA — structured `## Step N` headers. Tests assert `## Step 1` AND
 * `## Step 5`. ~40 tokens.
 */
const IDENTITY_GEMMA = [
  '## Step 1: Who',
  'Senior engineer pair-programming with user.',
  '## Step 2: Stack',
  'TypeScript, Python, Go, Rust.',
  '## Step 3: Optimise for',
  'Correctness, readability, maintainability.',
  '## Step 4: Communicate',
  'State trade-offs first. Push back on bad ideas.',
  '## Step 5: Deliver',
  'Code via write_file / edit_file. Never in chat.',
].join('\n');

/**
 * LLAMA — conversational prose. Test asserts `you're a senior software
 * engineer` (case-insensitive) and NO `## Step 1`. ~35 tokens.
 */
const IDENTITY_LLAMA =
  "You're a senior software engineer pair-programming with the user. Think out loud about trade-offs as you work; push back when a request is misguided. Deliver code via write_file / edit_file, not in chat.";

/**
 * DEEPSEEK — spec-first. Tests assert `IDENTITY SPEC` and `expertise:`.
 * ~40 tokens.
 */
const IDENTITY_DEEPSEEK = [
  'IDENTITY SPEC',
  '  role: senior_software_engineer',
  '  expertise: [TypeScript, Python, Go, Rust]',
  '  optimises_for: [correctness, maintainability]',
  'CONTRACT: state trade-offs before coding; push back on bad ideas; deliver via write_file / edit_file.',
].join('\n');

/**
 * GENERIC — Mistral / CodeLlama. Test asserts strictly longer than
 * default AND contains `senior, opinionated`. Composed = default body
 * + tone hint, so the inequality holds. ~45 tokens.
 */
const IDENTITY_GENERIC = [
  IDENTITY_DEFAULT,
  'Tone: senior, opinionated, pragmatic. Skip "Sure!" / "Of course!" preambles.',
].join('\n');

// ---------- Public builder ----------

/**
 * Return the IDENTITY paragraph (without the leading `## Identity`
 * header) for the given preset. The header is added by the caller in
 * `ContextManager.buildSystemPrompt` so presets compose cleanly.
 *
 * Default behaviour for unknown preset names is `'default'` — never
 * throws on a missing preset.
 */
export function buildPersonaForPreset(name: ModelPresetName): string {
  switch (name) {
    case 'qwen':
      return IDENTITY_QWEN;
    case 'gemma':
      return IDENTITY_GEMMA;
    case 'llama':
      return IDENTITY_LLAMA;
    case 'deepseek':
      return IDENTITY_DEEPSEEK;
    case 'generic':
      return IDENTITY_GENERIC;
    case 'default':
    default:
      return IDENTITY_DEFAULT;
  }
}
