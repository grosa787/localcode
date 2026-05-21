/**
 * Breadcrumbs — horizontal path navigator for the file browser.
 *
 * Render contract:
 *   `[Root] / src / components`
 *   - Each segment is a button when not the last; the last is plain
 *     text styled bolder.
 *   - Clicking a segment fires `onNavigate(absoluteSubpath)` where the
 *     subpath is relative to the project root (empty string for root).
 *
 * Overflow: long paths ellipsise the middle segments via an inline
 * `…` button. This keeps the toolbar visually tight without losing
 * navigability.
 */

import { useMemo, type JSX } from 'react';

import { useT } from '../i18n';
import { ChevronRight } from '../icons';

import styles from './Breadcrumbs.module.css';

export interface BreadcrumbsProps {
  /** Absolute project root — rendered as the first crumb's label. */
  rootLabel: string;
  /** Subpath relative to the project root. Empty string means root. */
  subpath: string;
  /** Called with the new subpath when the user clicks a crumb. */
  onNavigate: (subpath: string) => void;
}

interface Segment {
  /** Display text for the crumb. */
  label: string;
  /** Subpath this crumb navigates to. */
  subpath: string;
}

/**
 * Maximum number of intermediate crumbs to render fully before
 * collapsing the middle into a single ellipsis button. Tuned so a
 * deep path like `src/web/components/foo/bar/baz.ts` still fits in
 * the typical 360–520px panel width.
 */
const MAX_INLINE_SEGMENTS = 5;

export function Breadcrumbs({
  rootLabel,
  subpath,
  onNavigate,
}: BreadcrumbsProps): JSX.Element {
  const t = useT();
  const segments = useMemo<Segment[]>(() => {
    const root: Segment = { label: rootLabel, subpath: '' };
    if (subpath === '') return [root];
    const parts = subpath.split('/').filter((p) => p.length > 0);
    const out: Segment[] = [root];
    let acc = '';
    for (const part of parts) {
      acc = acc === '' ? part : `${acc}/${part}`;
      out.push({ label: part, subpath: acc });
    }
    return out;
  }, [rootLabel, subpath]);

  // Decide which segments to render inline. When we have more than
  // `MAX_INLINE_SEGMENTS`, collapse the middle. Always keep the root,
  // the last segment, and the parent of the last segment visible.
  const visible = useMemo<{ kind: 'seg'; seg: Segment }[] | { kind: 'ellipsis' | 'seg'; seg?: Segment }[]>(() => {
    if (segments.length <= MAX_INLINE_SEGMENTS) {
      return segments.map((s): { kind: 'seg'; seg: Segment } => ({ kind: 'seg', seg: s }));
    }
    // Keep root + last 3 segments inline; collapse the middle.
    const out: { kind: 'ellipsis' | 'seg'; seg?: Segment }[] = [];
    const first = segments[0];
    if (first !== undefined) out.push({ kind: 'seg', seg: first });
    out.push({ kind: 'ellipsis' });
    const tail = segments.slice(-3);
    for (const s of tail) {
      out.push({ kind: 'seg', seg: s });
    }
    return out;
  }, [segments]);

  return (
    <nav className={styles.root} aria-label={t('fileBrowser.breadcrumbRoot')}>
      {visible.map((item, idx) => {
        const isLast = idx === visible.length - 1;
        if (item.kind === 'ellipsis') {
          // The ellipsis jumps the user back two levels — a pragmatic
          // shortcut when the middle is hidden. Hovering reveals the
          // full path via the `title` attribute.
          const jump = segments[segments.length - 4]?.subpath ?? '';
          return (
            <span key={`ellipsis-${idx}`} className={styles.row}>
              <button
                type="button"
                className={styles.segment}
                title={subpath}
                onClick={() => onNavigate(jump)}
                aria-label={subpath}
              >
                …
              </button>
              <span className={styles.sep} aria-hidden="true">
                <ChevronRight size={10} strokeWidth={1.5} />
              </span>
            </span>
          );
        }
        const seg = item.seg;
        if (seg === undefined) return null;
        return (
          <span key={`${seg.subpath}-${idx}`} className={styles.row}>
            {isLast ? (
              <span
                className={`${styles.segment} ${styles.last}`}
                title={seg.subpath === '' ? rootLabel : seg.subpath}
              >
                {seg.label}
              </span>
            ) : (
              <button
                type="button"
                className={styles.segment}
                onClick={() => onNavigate(seg.subpath)}
                title={seg.subpath === '' ? rootLabel : seg.subpath}
              >
                {seg.label}
              </button>
            )}
            {!isLast ? (
              <span className={styles.sep} aria-hidden="true">
                <ChevronRight size={10} strokeWidth={1.5} />
              </span>
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
