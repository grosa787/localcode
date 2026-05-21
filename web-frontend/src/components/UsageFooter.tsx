/**
 * UsageFooter — thin token-usage caption strip rendered at the very
 * bottom of the chat surface (below the Composer).
 *
 * Renders a single right-aligned line summarising the most recent
 * `usage` event from the WebSocket protocol, with cached vs fresh
 * prompt tokens broken out so the user can SEE that prompt caching
 * is paying off.
 *
 * Layout (omits segments that are zero / undefined):
 *
 *   ● 47K cached  3K fresh  50K in · 2.1K out
 *
 * The component is purely presentational. The owning view (ChatView)
 * is responsible for tracking the latest `usage` event from the WS
 * feed and feeding the numbers as props.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import { formatTokens } from '../util/model-context';
import styles from './UsageFooter.module.css';

export interface UsageFooterProps {
  /** Total prompt (input) tokens for the most recent turn. */
  readonly tokensIn?: number;
  /** Output tokens for the most recent turn. */
  readonly tokensOut?: number;
  /** Prompt tokens served from the provider's prefix cache. */
  readonly cachedTokens?: number;
  /** Prompt tokens that had to be processed fresh. */
  readonly freshTokens?: number;
  /** Anthropic-only — tokens written into the cache by this turn. */
  readonly cacheCreationTokens?: number;
}

function isPositive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function UsageFooter(props: UsageFooterProps): JSX.Element | null {
  const t = useT();
  const {
    tokensIn,
    tokensOut,
    cachedTokens,
    freshTokens,
    cacheCreationTokens,
  } = props;

  const hasAny =
    isPositive(tokensIn) ||
    isPositive(tokensOut) ||
    isPositive(cachedTokens) ||
    isPositive(cacheCreationTokens);
  if (!hasAny) return null;

  // Derive fresh from in - cached when the adapter didn't provide it.
  let freshDerived: number | undefined = freshTokens;
  if (
    freshDerived === undefined &&
    typeof tokensIn === 'number' &&
    typeof cachedTokens === 'number'
  ) {
    freshDerived = Math.max(0, tokensIn - cachedTokens);
  }

  return (
    <div className={styles.root} aria-label={t('usage.aria')}>
      {isPositive(cachedTokens) ? (
        <span className={`${styles.segment} ${styles.cached}`}>
          <span
            className={`${styles.dot} ${styles.dotCached}`}
            aria-hidden="true"
          />
          {formatTokens(cachedTokens)} {t('usage.cached')}
        </span>
      ) : null}
      {isPositive(freshDerived) ? (
        <span className={styles.segment}>
          <span
            className={`${styles.dot} ${styles.dotFresh}`}
            aria-hidden="true"
          />
          {formatTokens(freshDerived)} {t('usage.fresh')}
        </span>
      ) : null}
      {isPositive(tokensIn) ? (
        <span className={styles.segment}>
          {formatTokens(tokensIn)} {t('usage.in')}
        </span>
      ) : null}
      {isPositive(tokensIn) && isPositive(tokensOut) ? (
        <span className={styles.sep} aria-hidden="true">
          ·
        </span>
      ) : null}
      {isPositive(tokensOut) ? (
        <span className={styles.segment}>
          {formatTokens(tokensOut)} {t('usage.out')}
        </span>
      ) : null}
      {isPositive(cacheCreationTokens) ? (
        <span className={`${styles.segment} ${styles.creation}`}>
          +{formatTokens(cacheCreationTokens)} {t('usage.cacheWrite')}
        </span>
      ) : null}
    </div>
  );
}

export default UsageFooter;
