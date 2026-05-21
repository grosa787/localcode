/**
 * UserBubble — right-aligned chat bubble for user-authored messages.
 *
 * Spec:
 *   - max-width 75% of column.
 *   - bg `--bubble-user-bg`, padding `10px 14px`, radius `16px 16px 4px 16px`.
 *   - body 14px / 22px line.
 *   - Timestamp on hover only, 12px `--text-faint`, right-aligned above.
 *
 * Perf: wrapped in `React.memo` — the props are primitives so shallow
 * compare avoids re-rendering every user bubble on every Composer
 * keystroke.
 */

import { memo, useMemo, type JSX } from 'react';

import { relativeTime } from '../util/format-time';

import styles from './UserBubble.module.css';

export interface UserBubbleProps {
  content: string;
  /** Epoch ms timestamp; rendered in a hover-revealed label. */
  createdAt?: number;
}

function UserBubbleImpl({ content, createdAt }: UserBubbleProps): JSX.Element {
  const stamp = useMemo(
    () => (createdAt !== undefined ? relativeTime(createdAt) : null),
    [createdAt],
  );

  return (
    <div className={styles.root}>
      <div className={styles.column}>
        {stamp !== null ? (
          <span className={styles.timestamp} aria-hidden="true">
            {stamp}
          </span>
        ) : null}
        <div className={styles.bubble} role="article" aria-label="Your message">
          {content}
        </div>
      </div>
    </div>
  );
}

export const UserBubble = memo(UserBubbleImpl);
