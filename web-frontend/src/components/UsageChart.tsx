/**
 * UsageChart — pure-SVG stacked bar chart for the usage dashboard.
 *
 * Renders up to ~30 daily bars with two stacked segments (input + output
 * tokens). Hover surfaces a tooltip with exact values. No dependencies —
 * hand-rolled SVG to keep bundle size flat.
 *
 * Layout: the SVG fills its container's width via `viewBox`. Bars are
 * positioned with computed x offsets; the y-axis is implicit (we leave
 * room at the bottom for date labels). Empty days have a 1px placeholder
 * stripe so visitors can see the calendar continuity.
 */

import { useMemo, useState, type JSX } from 'react';

import { useT } from '../i18n';
import styles from './UsageChart.module.css';

export interface ChartDay {
  /** ISO yyyy-mm-dd. */
  date: string;
  tokensIn: number;
  tokensOut: number;
}

export interface UsageChartProps {
  /** Daily data points — assumed pre-sorted ascending by date. */
  days: ChartDay[];
  /** Empty-state copy used when `days` is empty. */
  emptyMessage?: string;
}

interface HoverState {
  index: number;
  x: number;
  y: number;
  day: ChartDay;
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 200;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDateLabel(iso: string): string {
  // "2025-11-04" → "Nov 4". Pure ASCII; locale-aware month names would
  // need Intl.DateTimeFormat which is fine but adds a few KB.
  const parts = iso.split('-');
  const monthRaw = parts[1];
  const dayRaw = parts[2];
  if (monthRaw === undefined || dayRaw === undefined) return iso;
  const monthNum = Number.parseInt(monthRaw, 10);
  const dayNum = Number.parseInt(dayRaw, 10);
  if (!Number.isFinite(monthNum) || !Number.isFinite(dayNum)) return iso;
  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const monthName = MONTHS[monthNum - 1];
  if (monthName === undefined) return iso;
  return `${monthName} ${dayNum}`;
}

export function UsageChart({ days, emptyMessage }: UsageChartProps): JSX.Element {
  const t = useT();
  const [hover, setHover] = useState<HoverState | null>(null);

  const maxValue = useMemo(() => {
    let m = 0;
    for (const d of days) {
      const sum = d.tokensIn + d.tokensOut;
      if (sum > m) m = sum;
    }
    return m;
  }, [days]);

  if (days.length === 0) {
    return (
      <div className={styles.empty} role="figure" aria-label={t('usageDashboard.chart.title')}>
        {emptyMessage ?? t('usageDashboard.chart.empty')}
      </div>
    );
  }

  const plotWidth = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const slot = plotWidth / days.length;
  // Reserve ~25% of the slot as gap.
  const barWidth = Math.max(2, slot * 0.75);
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));

  return (
    <div className={styles.root}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className={styles.svg}
        preserveAspectRatio="none"
        role="figure"
        aria-label={t('usageDashboard.chart.title')}
        onMouseLeave={() => setHover(null)}
      >
        {/* Axis baseline */}
        <line
          x1={PAD_LEFT}
          x2={CHART_WIDTH - PAD_RIGHT}
          y1={CHART_HEIGHT - PAD_BOTTOM}
          y2={CHART_HEIGHT - PAD_BOTTOM}
          className={styles.axis}
        />
        {days.map((d, i) => {
          const total = d.tokensIn + d.tokensOut;
          const baseX = PAD_LEFT + i * slot + (slot - barWidth) / 2;
          if (total === 0 || maxValue === 0) {
            return (
              <rect
                key={d.date}
                x={baseX}
                y={CHART_HEIGHT - PAD_BOTTOM - 1}
                width={barWidth}
                height={1}
                className={styles.barEmpty}
                onMouseEnter={() =>
                  setHover({
                    index: i,
                    x: baseX + barWidth / 2,
                    y: CHART_HEIGHT - PAD_BOTTOM,
                    day: d,
                  })
                }
              />
            );
          }
          const inHeight = (d.tokensIn / maxValue) * plotHeight;
          const outHeight = (d.tokensOut / maxValue) * plotHeight;
          const baseY = CHART_HEIGHT - PAD_BOTTOM;
          return (
            <g
              key={d.date}
              onMouseEnter={() =>
                setHover({
                  index: i,
                  x: baseX + barWidth / 2,
                  y: baseY - inHeight - outHeight,
                  day: d,
                })
              }
            >
              <rect
                x={baseX}
                y={baseY - inHeight}
                width={barWidth}
                height={inHeight}
                className={styles.barIn}
              />
              <rect
                x={baseX}
                y={baseY - inHeight - outHeight}
                width={barWidth}
                height={outHeight}
                className={styles.barOut}
              />
            </g>
          );
        })}
        {/* X-axis labels (every Nth bar) */}
        {days.map((d, i) => {
          if (i % labelEvery !== 0 && i !== days.length - 1) return null;
          const baseX = PAD_LEFT + i * slot + slot / 2;
          return (
            <text
              key={`lbl-${d.date}`}
              x={baseX}
              y={CHART_HEIGHT - PAD_BOTTOM + 14}
              textAnchor="middle"
              className={styles.label}
            >
              {formatDateLabel(d.date)}
            </text>
          );
        })}
      </svg>
      {hover !== null ? (
        <div
          className={styles.tooltip}
          style={{
            left: `${(hover.x / CHART_WIDTH) * 100}%`,
            top: `${(hover.y / CHART_HEIGHT) * 100}%`,
          }}
          role="tooltip"
        >
          <div className={styles.tooltipDate}>
            {formatDateLabel(hover.day.date)}
          </div>
          <div className={styles.tooltipRow}>
            <span className={styles.swatchIn} aria-hidden="true" />
            <span>
              {t('usageDashboard.chart.in')}: {formatNumber(hover.day.tokensIn)}
            </span>
          </div>
          <div className={styles.tooltipRow}>
            <span className={styles.swatchOut} aria-hidden="true" />
            <span>
              {t('usageDashboard.chart.out')}: {formatNumber(hover.day.tokensOut)}
            </span>
          </div>
        </div>
      ) : null}
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.swatchIn} aria-hidden="true" />
          {t('usageDashboard.chart.in')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchOut} aria-hidden="true" />
          {t('usageDashboard.chart.out')}
        </span>
      </div>
    </div>
  );
}
