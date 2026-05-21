/**
 * ContextUsageRing — small SVG donut showing the % of the model's
 * context window consumed by the most recent turn.
 *
 * Sized 14px outer / 4px stroke. The arc colour shifts based on
 * usage:
 *   - <60%   → --success (green)
 *   - 60-85% → --warning (amber)
 *   - >85%   → --danger (red)
 *
 * Hidden via the parent — render only when `latestUsage !== null`
 * AND a model is selected (model is required to resolve the
 * context window). Mounted in `<ProjectBar>` between LocaleToggle
 * and the file-browser button.
 *
 * The rendered arc is animated with a 200ms ease transition on
 * `stroke-dashoffset` whenever the percent changes — opted out
 * via `prefers-reduced-motion`.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import {
  contextUsagePercent,
  formatTokens,
  resolveContextWindow,
} from '../util/model-context';

import styles from './ContextUsageRing.module.css';

export interface ContextUsageRingProps {
  /**
   * Total prompt tokens for the most recent turn — drives the ring.
   * When undefined or zero, the component renders nothing.
   */
  readonly tokensIn: number | undefined;
  /** Current model id — used to resolve the context window. */
  readonly modelId: string | null;
  /** `cfg.context.maxTokens` from the bootstrap snapshot, fallback. */
  readonly configMaxTokens: number | null;
  /** Visual size in CSS pixels. Defaults to 14 (matches the spec). */
  readonly size?: number;
  /** Stroke width in CSS pixels. Defaults to 4 (matches the spec). */
  readonly strokeWidth?: number;
}

export function ContextUsageRing({
  tokensIn,
  modelId,
  configMaxTokens,
  size = 14,
  strokeWidth = 4,
}: ContextUsageRingProps): JSX.Element | null {
  const t = useT();

  // Hidden when there's no usage signal or no model. The ring is a
  // status indicator — it must not render placeholder data.
  if (
    typeof tokensIn !== 'number' ||
    !Number.isFinite(tokensIn) ||
    tokensIn <= 0 ||
    modelId === null ||
    modelId.length === 0
  ) {
    return null;
  }

  const total = resolveContextWindow(modelId, configMaxTokens);
  const percent = contextUsagePercent(tokensIn, total);

  // SVG circle geometry. Radius and circumference are computed from
  // the configured `size`/`strokeWidth` so the ring scales cleanly if
  // an embedder tweaks dimensions in CSS.
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent / 100);

  let toneClass = styles.ok ?? '';
  if (percent >= 85) toneClass = styles.danger ?? '';
  else if (percent >= 60) toneClass = styles.warn ?? '';

  const tooltip = t('contextRing.tooltip', {
    used: formatTokens(tokensIn),
    total: formatTokens(total),
    percent,
  });
  const ariaLabel = t('contextRing.aria');

  return (
    <span
      className={styles.root}
      role="img"
      aria-label={`${ariaLabel}: ${tooltip}`}
      data-tooltip={tooltip}
      data-percent={percent}
    >
      <svg
        className={styles.svg}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <circle
          className={styles.track}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
        />
        <circle
          className={`${styles.arc} ${toneClass}`}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          /* Rotate so the arc starts at 12 o'clock. */
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </span>
  );
}

export default ContextUsageRing;
