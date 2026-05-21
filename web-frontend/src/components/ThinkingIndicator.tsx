/**
 * ThinkingIndicator — web mirror of the TUI's <ThinkingSpinner>.
 *
 * Renders a 28px row with:
 *   - a pulsing dot (accent colour)
 *   - a rotating phrase (rainbow-gradient text, animated)
 *   - elapsed time (e.g. "12.3s") in a mono/faint style
 *
 * Phrases cycle every 3 s (12 s under prefers-reduced-motion). The
 * elapsed counter ticks at 200 ms for a smooth seconds readout. All
 * timers are cleaned up on unmount — the parent should unmount this
 * component to stop the indicator (do NOT toggle visibility via CSS).
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { useStore } from '../state/store';
import { pickPhrasesForLocale, shufflePhrases } from '../util/thinking-phrases';

import styles from './ThinkingIndicator.module.css';

export interface ThinkingIndicatorProps {
  /** Unix ms — when the request was kicked off. */
  readonly startedAt: number;
}

const PHRASE_ROTATE_MS = 3_000;
const PHRASE_ROTATE_REDUCED_MS = 12_000;
const TICK_MS = 200;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function formatElapsed(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = safe / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

export function ThinkingIndicator(props: ThinkingIndicatorProps): JSX.Element {
  const { startedAt } = props;
  const locale = useStore((s) => s.locale);

  // Re-shuffle phrase order whenever the locale changes (and once on mount).
  const phrases = useMemo<readonly string[]>(() => {
    const bank = pickPhrasesForLocale(locale);
    const shuffled = shufflePhrases(bank);
    return shuffled.length > 0 ? shuffled : bank;
  }, [locale]);

  const reducedMotionRef = useRef<boolean>(prefersReducedMotion());
  const [phraseIndex, setPhraseIndex] = useState<number>(0);
  const [elapsedMs, setElapsedMs] = useState<number>(() =>
    Math.max(0, Date.now() - startedAt),
  );

  // Phrase rotation.
  useEffect(() => {
    const interval = reducedMotionRef.current
      ? PHRASE_ROTATE_REDUCED_MS
      : PHRASE_ROTATE_MS;
    const handle = window.setInterval(() => {
      setPhraseIndex((i) => i + 1);
    }, interval);
    return () => {
      window.clearInterval(handle);
    };
  }, []);

  // Elapsed-time ticker.
  useEffect(() => {
    setElapsedMs(Math.max(0, Date.now() - startedAt));
    const handle = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAt));
    }, TICK_MS);
    return () => {
      window.clearInterval(handle);
    };
  }, [startedAt]);

  const phrase = useMemo<string>(() => {
    if (phrases.length === 0) return 'Thinking';
    const i = ((phraseIndex % phrases.length) + phrases.length) % phrases.length;
    return phrases[i] ?? 'Thinking';
  }, [phrases, phraseIndex]);

  return (
    <div className={styles.root} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.phrase}>{phrase}</span>
      <span className={styles.elapsed}>{formatElapsed(elapsedMs)}</span>
    </div>
  );
}

export default ThinkingIndicator;
