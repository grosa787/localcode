/**
 * AutoFeedbackDetector unit tests.
 *
 * Covers:
 *   - Positive / negative / configuration pattern detection in English + Russian.
 *   - False-positive guards (code blocks, empty messages, first turn).
 *   - Confidence scoring + polarity precedence.
 *   - FeedbackStagingArea stage/consume/TTL semantics.
 */

import { describe, expect, test } from 'bun:test';

import {
  AutoFeedbackDetector,
  FeedbackStagingArea,
  dominantPolarity,
  scoreConfidence,
  stripCode,
  deriveSlug,
  type FeedbackSignal,
} from '@/memory/auto-feedback';

describe('AutoFeedbackDetector — English positive', () => {
  test('detects "perfect" after an assistant turn', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Perfect — that worked!', 'Here is the fix.');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('positive');
    expect(result.suggestedProposal?.suggestedEntry.type).toBe('feedback');
  });

  test('detects "love it"', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('I love it, thanks', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('positive');
  });

  test('detects "exactly"', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Exactly what I wanted', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
  });

  test('does not fire on bland acknowledgement', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Yes please continue with the next step', 'output');
    expect(result.suggestSavingFeedback).toBe(false);
  });
});

describe('AutoFeedbackDetector — English negative', () => {
  test('detects "don\'t" as negative', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe("Don't use semicolons — switch to commas", 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    // Has both `don't` and `do not` style negative.
    const polarity = result.suggestedProposal?.polarity;
    expect(polarity).toBeDefined();
    if (polarity !== undefined) {
      expect(['negative', 'configuration']).toContain(polarity);
    }
  });

  test('detects "stop doing"', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Please stop doing that', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('negative');
  });

  test('detects "wrong"', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('This is wrong, the indentation should be 2 spaces', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
  });
});

describe('AutoFeedbackDetector — English configuration', () => {
  test('detects "from now on" with high confidence', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('From now on, always use 4-space indentation', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('configuration');
    // Configuration patterns are strong → confidence should be high.
    expect(result.suggestedProposal?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test('"always" alone qualifies as configuration', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Always run lint before commit', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('configuration');
  });

  test('"never" alone qualifies as configuration', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Never write to /etc directly', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('configuration');
  });
});

describe('AutoFeedbackDetector — Russian patterns', () => {
  test('detects "отлично" (positive)', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Отлично, спасибо!', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('positive');
  });

  test('detects "идеально" (positive)', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Идеально, продолжай.', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
  });

  test('detects "не делай так" (negative)', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Не делай так больше, используй const', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('negative');
  });

  test('detects "не нужно" (negative)', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Не нужно добавлять комментарии', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('negative');
  });

  test('detects "всегда" (configuration)', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Всегда добавляй тесты для новых функций', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('configuration');
  });

  test('detects "с этого момента" (configuration)', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('С этого момента используй TypeScript strict', 'output');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.polarity).toBe('configuration');
  });
});

describe('AutoFeedbackDetector — false-positive guards', () => {
  test('does not fire on empty message', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('   ', 'output');
    expect(result.suggestSavingFeedback).toBe(false);
  });

  test('skips first-turn signal by default', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Perfect, start working', null);
    expect(result.suggestSavingFeedback).toBe(false);
  });

  test('first-turn signal allowed when allowFirstTurn is true', () => {
    const det = new AutoFeedbackDetector({ allowFirstTurn: true });
    const result = det.observe('From now on always use 2 spaces', null);
    expect(result.suggestSavingFeedback).toBe(true);
  });

  test('does NOT trigger on "don\'t" inside a fenced code block', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe(
      "Here is the file:\n```js\n// don't do this\nfunction foo() {}\n```",
      'output',
    );
    expect(result.suggestSavingFeedback).toBe(false);
  });

  test('does NOT trigger on inline code spans containing trigger words', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('Run `stop doing` — wait, that is a command name', 'output');
    // `wait, that is a command name` should not match any pattern;
    // `stop doing` was inside backticks.
    expect(result.suggestSavingFeedback).toBe(false);
  });
});

describe('stripCode', () => {
  test('removes fenced code blocks', () => {
    const stripped = stripCode('before\n```ts\nconst x = 1\n```\nafter');
    expect(stripped).not.toContain('const x = 1');
    expect(stripped).toContain('before');
    expect(stripped).toContain('after');
  });

  test('removes inline code spans', () => {
    const stripped = stripCode('this is `inline code` rest');
    expect(stripped).not.toContain('inline code');
  });

  test('preserves prose untouched', () => {
    const text = 'no code here at all';
    expect(stripCode(text)).toBe(text);
  });
});

describe('scoreConfidence', () => {
  test('returns 0 when no signals', () => {
    expect(scoreConfidence([])).toBe(0);
  });

  test('sums single signal directly', () => {
    const sig: FeedbackSignal = { phrase: 'perfect', polarity: 'positive', weight: 0.3 };
    expect(scoreConfidence([sig])).toBeCloseTo(0.3, 5);
  });

  test('caps at 1.0', () => {
    const sigs: FeedbackSignal[] = Array.from({ length: 10 }, () => ({
      phrase: 'always',
      polarity: 'configuration',
      weight: 0.5,
    }));
    expect(scoreConfidence(sigs)).toBeLessThanOrEqual(1);
  });

  test('applies diminishing returns for repeat polarity', () => {
    const sigs: FeedbackSignal[] = [
      { phrase: 'perfect', polarity: 'positive', weight: 0.3 },
      { phrase: 'great', polarity: 'positive', weight: 0.3 },
    ];
    // 0.3 + 0.6 * 0.3 = 0.48
    expect(scoreConfidence(sigs)).toBeCloseTo(0.48, 5);
  });
});

describe('dominantPolarity', () => {
  test('configuration > negative > positive', () => {
    const sigs: FeedbackSignal[] = [
      { phrase: 'perfect', polarity: 'positive', weight: 0.3 },
      { phrase: 'wrong', polarity: 'negative', weight: 0.3 },
      { phrase: 'always', polarity: 'configuration', weight: 0.5 },
    ];
    expect(dominantPolarity(sigs)).toBe('configuration');
  });

  test('negative > positive when no configuration', () => {
    const sigs: FeedbackSignal[] = [
      { phrase: 'great', polarity: 'positive', weight: 0.25 },
      { phrase: 'wrong', polarity: 'negative', weight: 0.3 },
    ];
    expect(dominantPolarity(sigs)).toBe('negative');
  });

  test('positive only', () => {
    const sigs: FeedbackSignal[] = [
      { phrase: 'great', polarity: 'positive', weight: 0.25 },
    ];
    expect(dominantPolarity(sigs)).toBe('positive');
  });
});

describe('deriveSlug', () => {
  test('produces prefix matching polarity', () => {
    expect(deriveSlug('always use semicolons', 'configuration').startsWith('rule-')).toBe(true);
    expect(deriveSlug('do not use semicolons', 'negative').startsWith('avoid-')).toBe(true);
    expect(deriveSlug('perfect work', 'positive').startsWith('pref-')).toBe(true);
  });

  test('truncates long messages and falls back when empty', () => {
    const slug = deriveSlug('', 'positive');
    expect(slug.length).toBeGreaterThan(0);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  test('all chars are slug-safe', () => {
    const slug = deriveSlug('Привет!!! Hello @world #2024', 'positive');
    expect(slug).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });
});

describe('FeedbackStagingArea', () => {
  test('stage + consume', () => {
    const area = new FeedbackStagingArea();
    const det = new AutoFeedbackDetector();
    const res = det.observe('Perfect, that works', 'output');
    expect(res.suggestSavingFeedback).toBe(true);
    const proposal = res.suggestedProposal;
    expect(proposal).toBeDefined();
    if (proposal === undefined) return;
    area.stage(proposal);
    expect(area.size()).toBe(1);
    const consumed = area.consume(proposal.id);
    expect(consumed?.id).toBe(proposal.id);
    expect(area.size()).toBe(0);
  });

  test('consume returns null for unknown id', () => {
    const area = new FeedbackStagingArea();
    expect(area.consume('nonexistent')).toBeNull();
  });

  test('expires after TTL', () => {
    let now = 1_000_000;
    const area = new FeedbackStagingArea({ ttlMs: 100, nowFn: () => now });
    const det = new AutoFeedbackDetector();
    const res = det.observe('great', 'output');
    const proposal = res.suggestedProposal;
    if (proposal === undefined) throw new Error('expected proposal');
    area.stage(proposal);
    expect(area.size()).toBe(1);
    now += 200;
    expect(area.consume(proposal.id)).toBeNull();
    expect(area.size()).toBe(0);
  });

  test('clear empties the staging area', () => {
    const area = new FeedbackStagingArea();
    const det = new AutoFeedbackDetector();
    const res1 = det.observe('perfect', 'a');
    const res2 = det.observe('great work', 'a');
    if (res1.suggestedProposal !== undefined) area.stage(res1.suggestedProposal);
    if (res2.suggestedProposal !== undefined) area.stage(res2.suggestedProposal);
    area.clear();
    expect(area.size()).toBe(0);
  });
});

describe('AutoFeedbackDetector — proposal shape', () => {
  test('suggestedEntry is a valid MemoryEntry', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('From now on, never use any', 'use any here');
    expect(result.suggestSavingFeedback).toBe(true);
    const entry = result.suggestedProposal?.suggestedEntry;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.type).toBe('feedback');
    expect(entry.name).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    expect(entry.description.length).toBeGreaterThan(0);
    expect(entry.body.length).toBeGreaterThan(0);
    // Body must contain the user message text in some form.
    expect(entry.body).toContain('never use any');
  });

  test('confidence reaches minimum threshold', () => {
    const det = new AutoFeedbackDetector();
    const result = det.observe('From now on use 2-space indentation always', 'context');
    expect(result.suggestSavingFeedback).toBe(true);
    expect(result.suggestedProposal?.confidence).toBeGreaterThanOrEqual(0.4);
  });
});
