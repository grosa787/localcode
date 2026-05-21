/**
 * AutoFeedbackDetector — passive observer that scans user messages for
 * positive / negative / configuration feedback signals immediately after
 * the model produced an assistant turn.
 *
 * Wave 6 — self-evolution memory.
 *
 * Detection is PURE: the detector never writes to disk and never spawns
 * the LLM. When it finds a signal it returns a `FeedbackProposal` and
 * the host surfaces a synthetic system note (`💾 Save this as feedback
 * memory? /memory save <id>`). The user opts in explicitly via the
 * slash command — we do NOT auto-persist on signal.
 *
 * Pattern policy:
 *   - English + Russian bilingual coverage (both surface in the LocalCode
 *     user base; Russian is the project owner's primary language).
 *   - Case-insensitive whole-word matching where possible. Word
 *     boundaries are enforced for English (`\b`) and Cyrillic gets a
 *     custom boundary that excludes letters/digits but tolerates
 *     punctuation/whitespace.
 *   - Code-block content is stripped BEFORE pattern matching so a `// don't`
 *     comment inside a fenced block cannot trigger a negative signal.
 *
 * Confidence model: each match contributes additively; multiple signals
 * push confidence up, configuration patterns (`from now on`, `always`,
 * `never`) carry the highest weight because they are the strongest user
 * intent to persist.
 */

import { randomUUID } from 'node:crypto';

import type { MemoryEntry } from './types';

// ---------- Types ----------

/** Feedback polarity. */
export type FeedbackPolarity = 'positive' | 'negative' | 'configuration';

/**
 * Signal observed in a user message. Surfaced for diagnostics + tests;
 * the detector also exposes which patterns matched so the proposal can
 * carry that context.
 */
export interface FeedbackSignal {
  /** Verbatim phrase that matched (lowercased). */
  readonly phrase: string;
  readonly polarity: FeedbackPolarity;
  /** Weight contribution to the proposal's confidence score. */
  readonly weight: number;
}

/**
 * Output of `observe()` when a signal is detected. The host renders
 * `💾 Save this as feedback memory? /memory save <id>` and stages the
 * `suggestedEntry` keyed by `id` so the slash command can resolve it.
 */
export interface FeedbackProposal {
  /** Random unique id used as the staging key. */
  readonly id: string;
  /** Combined confidence ∈ [0, 1]. */
  readonly confidence: number;
  /** Strongest polarity (configuration > negative > positive). */
  readonly polarity: FeedbackPolarity;
  /** All signals that contributed. */
  readonly signals: readonly FeedbackSignal[];
  /** Ready-to-persist MemoryEntry — type is always `'feedback'`. */
  readonly suggestedEntry: MemoryEntry;
}

/** Return shape exposed to the runtime. */
export interface ObserveResult {
  readonly suggestSavingFeedback: boolean;
  readonly suggestedProposal?: FeedbackProposal;
}

// ---------- Pattern tables ----------

interface PatternEntry {
  readonly re: RegExp;
  readonly polarity: FeedbackPolarity;
  readonly weight: number;
}

/**
 * English positive patterns.
 *
 * Each regex uses `\b` word boundaries and `i` flag for case-insensitivity.
 * Weight tuning: short single-word signals (perfect, great) carry less
 * weight than multi-word phrases (`exactly what I wanted`) because the
 * latter is a stronger commitment.
 */
const PATTERNS_EN_POSITIVE: readonly PatternEntry[] = [
  { re: /\bperfect\b/i, polarity: 'positive', weight: 0.3 },
  { re: /\bgreat\b/i, polarity: 'positive', weight: 0.25 },
  { re: /\bexactly\b/i, polarity: 'positive', weight: 0.35 },
  { re: /\blove it\b/i, polarity: 'positive', weight: 0.4 },
  { re: /\blooks good\b/i, polarity: 'positive', weight: 0.3 },
  { re: /\bthat works\b/i, polarity: 'positive', weight: 0.3 },
  { re: /\bnice\b/i, polarity: 'positive', weight: 0.2 },
];

/**
 * English negative patterns.
 *
 * The `don't` pattern is the trickiest — bare "don't" in the middle of a
 * sentence is usually negative ("don't do that") but inside code or
 * comments is often informational. Code-block stripping in `observe()`
 * handles the worst false-positive class; we keep the pattern simple
 * here so the test suite stays auditable.
 */
const PATTERNS_EN_NEGATIVE: readonly PatternEntry[] = [
  { re: /\bdon't\b/i, polarity: 'negative', weight: 0.3 },
  { re: /\bdo not\b/i, polarity: 'negative', weight: 0.3 },
  { re: /\bstop doing\b/i, polarity: 'negative', weight: 0.45 },
  { re: /\bwrong\b/i, polarity: 'negative', weight: 0.3 },
  { re: /\bno[\s,—-]+instead\b/i, polarity: 'negative', weight: 0.5 },
  { re: /\bnot what i\b/i, polarity: 'negative', weight: 0.45 },
  { re: /\bdidn't want\b/i, polarity: 'negative', weight: 0.45 },
];

/**
 * English configuration patterns — strongest signal because the user is
 * explicitly setting a rule that should persist across turns.
 */
const PATTERNS_EN_CONFIG: readonly PatternEntry[] = [
  { re: /\bfrom now on\b/i, polarity: 'configuration', weight: 0.7 },
  { re: /\balways\b/i, polarity: 'configuration', weight: 0.5 },
  { re: /\bnever\b/i, polarity: 'configuration', weight: 0.5 },
  { re: /\bgoing forward\b/i, polarity: 'configuration', weight: 0.65 },
];

/**
 * Russian positive patterns. Cyrillic does not work with `\b` reliably
 * in JS RegExp, so we use lookahead/lookbehind on non-letter chars to
 * approximate word boundaries.
 */
const CYR_BEFORE = '(?:^|[^\\p{L}\\p{N}])';
const CYR_AFTER = '(?:[^\\p{L}\\p{N}]|$)';
function cyr(body: string): RegExp {
  return new RegExp(`${CYR_BEFORE}${body}${CYR_AFTER}`, 'iu');
}

const PATTERNS_RU_POSITIVE: readonly PatternEntry[] = [
  { re: cyr('отлично'), polarity: 'positive', weight: 0.3 },
  { re: cyr('идеально'), polarity: 'positive', weight: 0.35 },
  { re: cyr('согласен'), polarity: 'positive', weight: 0.3 },
  { re: cyr('супер'), polarity: 'positive', weight: 0.25 },
  { re: cyr('круто'), polarity: 'positive', weight: 0.25 },
];

const PATTERNS_RU_NEGATIVE: readonly PatternEntry[] = [
  { re: cyr('не делай так'), polarity: 'negative', weight: 0.5 },
  { re: cyr('не нужно'), polarity: 'negative', weight: 0.4 },
  { re: cyr('неправильно'), polarity: 'negative', weight: 0.35 },
  { re: cyr('не так'), polarity: 'negative', weight: 0.35 },
];

const PATTERNS_RU_CONFIG: readonly PatternEntry[] = [
  { re: cyr('с этого момента'), polarity: 'configuration', weight: 0.7 },
  { re: cyr('всегда'), polarity: 'configuration', weight: 0.5 },
  { re: cyr('никогда'), polarity: 'configuration', weight: 0.5 },
];

const ALL_PATTERNS: readonly PatternEntry[] = [
  ...PATTERNS_EN_POSITIVE,
  ...PATTERNS_EN_NEGATIVE,
  ...PATTERNS_EN_CONFIG,
  ...PATTERNS_RU_POSITIVE,
  ...PATTERNS_RU_NEGATIVE,
  ...PATTERNS_RU_CONFIG,
];

// ---------- Helpers ----------

/**
 * Strip fenced code blocks (```...```) and inline code spans (`...`)
 * from a message body. We deliberately keep the count of stripped
 * regions so callers can decide whether to surface a hint that the
 * entire message was code.
 *
 * Exported for tests so the code-block guard contract is auditable.
 */
export function stripCode(message: string): string {
  const fenceRe = /```[^\n]*\n[\s\S]*?```/g;
  const inlineRe = /`[^`\n]+`/g;
  return message.replace(fenceRe, ' ').replace(inlineRe, ' ');
}

/**
 * Confidence rule:
 *   - Sum signal weights.
 *   - Cap at 1.0.
 *   - When the same polarity fires more than once, apply a slight
 *     diminishing-returns factor so spammy keywords don't artificially
 *     spike confidence.
 *
 * Pure — exported for tests.
 */
export function scoreConfidence(signals: readonly FeedbackSignal[]): number {
  if (signals.length === 0) return 0;
  let total = 0;
  const seenPolarities = new Map<FeedbackPolarity, number>();
  for (const sig of signals) {
    const repeat = seenPolarities.get(sig.polarity) ?? 0;
    // Diminishing return: 1.0, 0.6, 0.4, 0.3, …
    const factor = repeat === 0 ? 1 : repeat === 1 ? 0.6 : repeat === 2 ? 0.4 : 0.3;
    total += sig.weight * factor;
    seenPolarities.set(sig.polarity, repeat + 1);
  }
  return Math.min(1, total);
}

/**
 * Polarity precedence: configuration > negative > positive.
 *
 * Configuration patterns ("from now on", "always", "never") represent
 * the strongest user intent — they describe a rule the model should
 * apply across turns. Negative is next (the user wants something to
 * stop), and positive is the weakest (acknowledgement, not change).
 */
export function dominantPolarity(
  signals: readonly FeedbackSignal[],
): FeedbackPolarity {
  let hasConfig = false;
  let hasNeg = false;
  for (const s of signals) {
    if (s.polarity === 'configuration') hasConfig = true;
    if (s.polarity === 'negative') hasNeg = true;
  }
  if (hasConfig) return 'configuration';
  if (hasNeg) return 'negative';
  return 'positive';
}

/**
 * Produce a kebab-case slug suitable for use as a MemoryEntry.name.
 * Falls back to a uuid suffix when the message is empty / pure
 * punctuation so we always return a valid slug.
 */
export function deriveSlug(userMessage: string, polarity: FeedbackPolarity): string {
  const cleaned = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter((w) => w.length >= 2).slice(0, 4);
  const base = words.length > 0 ? words.join('-').slice(0, 40) : 'note';
  const prefix = polarity === 'configuration' ? 'rule' : polarity === 'negative' ? 'avoid' : 'pref';
  // Stable random suffix avoids collisions on retries.
  const suffix = randomUUID().slice(0, 8);
  return `${prefix}-${base}-${suffix}`.replace(/-+/g, '-').slice(0, 60);
}

/**
 * Truncate text to a soft cap. Used so memory entries don't carry the
 * entire model output verbatim.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

// ---------- Detector ----------

export interface AutoFeedbackDetectorOptions {
  /** Minimum confidence required to surface a proposal. Default 0.4. */
  readonly minConfidence?: number;
  /**
   * When true, ignore the `lastAssistantMsg` requirement — a feedback
   * signal can fire on the very first user turn. Defaults to false so
   * "Hey, looks good — let's start" on the empty splash doesn't
   * generate noise.
   */
  readonly allowFirstTurn?: boolean;
}

// Feedback detection is intentionally more permissive than proactive
// suggestions: a single moderately-strong signal (e.g. "perfect",
// "отлично") should surface a save proposal so the user has an easy
// path to record a one-word acknowledgement. The strict ≥0.6 gate
// from the proactive-suggestions panel does NOT apply here.
const DEFAULT_MIN_CONFIDENCE = 0.2;

export class AutoFeedbackDetector {
  private readonly minConfidence: number;
  private readonly allowFirstTurn: boolean;

  constructor(opts: AutoFeedbackDetectorOptions = {}) {
    this.minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.allowFirstTurn = opts.allowFirstTurn ?? false;
  }

  /**
   * Inspect a user message in the context of the prior assistant turn.
   * Returns an `ObserveResult` indicating whether a feedback proposal
   * should be surfaced and the staged entry if so.
   *
   * Contract:
   *   - PURE — no IO, no LLM call, no mutation of input.
   *   - Code blocks are stripped before matching to suppress false
   *     positives from snippets the user pastes.
   *   - When `lastAssistantMsg` is missing (first turn) and
   *     `allowFirstTurn` is false, returns no suggestion regardless of
   *     content.
   */
  observe(
    userMsg: string,
    lastAssistantMsg: string | null,
  ): ObserveResult {
    const trimmed = userMsg.trim();
    if (trimmed.length === 0) {
      return { suggestSavingFeedback: false };
    }
    if (lastAssistantMsg === null && !this.allowFirstTurn) {
      return { suggestSavingFeedback: false };
    }

    const haystack = stripCode(trimmed);
    const signals = this.findSignals(haystack);
    if (signals.length === 0) {
      return { suggestSavingFeedback: false };
    }

    const confidence = scoreConfidence(signals);
    if (confidence < this.minConfidence) {
      return { suggestSavingFeedback: false };
    }

    const polarity = dominantPolarity(signals);
    const proposal = this.buildProposal(
      polarity,
      signals,
      confidence,
      userMsg,
      lastAssistantMsg,
    );

    return {
      suggestSavingFeedback: true,
      suggestedProposal: proposal,
    };
  }

  /** Expose pattern scanning for direct testability. */
  findSignals(text: string): readonly FeedbackSignal[] {
    const out: FeedbackSignal[] = [];
    for (const p of ALL_PATTERNS) {
      const match = p.re.exec(text);
      if (match !== null) {
        out.push({
          phrase: match[0].toLowerCase().trim(),
          polarity: p.polarity,
          weight: p.weight,
        });
      }
    }
    return out;
  }

  private buildProposal(
    polarity: FeedbackPolarity,
    signals: readonly FeedbackSignal[],
    confidence: number,
    userMsg: string,
    lastAssistantMsg: string | null,
  ): FeedbackProposal {
    const id = randomUUID();
    const name = deriveSlug(userMsg, polarity);

    const phrases = signals.map((s) => s.phrase).join(', ');
    const description =
      polarity === 'configuration'
        ? `User rule: ${truncate(userMsg, 80)}`
        : polarity === 'negative'
          ? `Avoid: ${truncate(userMsg, 80)}`
          : `Preference: ${truncate(userMsg, 80)}`;

    const bodyLines: string[] = [];
    bodyLines.push(`Detected ${polarity} feedback (signals: ${phrases}).`);
    bodyLines.push('');
    bodyLines.push('## User said');
    bodyLines.push('');
    bodyLines.push(truncate(userMsg, 1000));
    if (lastAssistantMsg !== null && lastAssistantMsg.length > 0) {
      bodyLines.push('');
      bodyLines.push('## In response to');
      bodyLines.push('');
      bodyLines.push(truncate(lastAssistantMsg, 1000));
    }

    const entry: MemoryEntry = {
      name,
      description,
      type: 'feedback',
      body: bodyLines.join('\n'),
      path: '',
    };

    return {
      id,
      confidence,
      polarity,
      signals,
      suggestedEntry: entry,
    };
  }
}

// ---------- In-memory staging registry ----------

/**
 * Process-wide singleton that pairs proposal ids with their staged
 * entries. The TUI host stashes a proposal here when it surfaces the
 * `💾 Save this as feedback memory? /memory save <id>` system note;
 * `/memory save <id>` consumes the entry and writes it to disk.
 *
 * Kept small and explicit (Map + ttl-on-write) so we don't accumulate
 * proposals forever — old ones expire after 30 minutes.
 */
const STAGING_TTL_MS = 30 * 60 * 1000;

interface StagedProposal {
  readonly proposal: FeedbackProposal;
  readonly expiresAt: number;
}

export class FeedbackStagingArea {
  private readonly store = new Map<string, StagedProposal>();
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

  constructor(opts: { readonly ttlMs?: number; readonly nowFn?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? STAGING_TTL_MS;
    this.nowFn = opts.nowFn ?? (() => Date.now());
  }

  stage(proposal: FeedbackProposal): void {
    this.store.set(proposal.id, {
      proposal,
      expiresAt: this.nowFn() + this.ttlMs,
    });
    this.gc();
  }

  consume(id: string): FeedbackProposal | null {
    this.gc();
    const staged = this.store.get(id);
    if (staged === undefined) return null;
    this.store.delete(id);
    return staged.proposal;
  }

  size(): number {
    this.gc();
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  private gc(): void {
    const now = this.nowFn();
    for (const [key, value] of this.store) {
      if (value.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}

let processStagingArea: FeedbackStagingArea | null = null;

/** Return the process-wide staging area. Lazily allocated. */
export function getProcessFeedbackStagingArea(): FeedbackStagingArea {
  if (processStagingArea === null) {
    processStagingArea = new FeedbackStagingArea();
  }
  return processStagingArea;
}

/** Reset hook for tests so they don't poison the singleton across files. */
export function __resetProcessFeedbackStagingAreaForTests(): void {
  processStagingArea = null;
}
