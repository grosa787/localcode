/**
 * NotificationBell — bell icon mounted in the ProjectBar. Renders a
 * red unread-count badge when there are unread notifications. Clicking
 * toggles the NotificationCenter popover.
 *
 * The popover itself lives in <NotificationCenter />; this component
 * owns only the trigger + badge.
 */

import { useMemo, type JSX } from 'react';

import { useT } from '../i18n';
import { Bell } from '../icons';
import { useStore } from '../state/store';

import { NotificationCenter } from './NotificationCenter';
import styles from './NotificationBell.module.css';

function formatUnread(n: number): string {
  if (n > 99) return '99+';
  return String(n);
}

export function NotificationBell(): JSX.Element {
  const t = useT();
  const notifications = useStore((s) => s.notifications);
  const notificationsOpen = useStore((s) => s.notificationsOpen);
  const toggleNotificationCenter = useStore((s) => s.toggleNotificationCenter);
  const closeNotificationCenter = useStore((s) => s.closeNotificationCenter);

  const unreadCount = useMemo(
    () => notifications.reduce((acc, n) => acc + (n.read ? 0 : 1), 0),
    [notifications],
  );
  const hasUnread = unreadCount > 0;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.bell} ${hasUnread ? styles.bellActive ?? '' : ''}`}
        onClick={toggleNotificationCenter}
        aria-label={
          hasUnread
            ? t('notifications.bell.aria.unread', { count: unreadCount })
            : t('notifications.bell.aria.empty')
        }
        aria-haspopup="dialog"
        aria-expanded={notificationsOpen}
        title={t('notifications.bell.tooltip')}
        data-testid="notification-bell"
      >
        <Bell size={14} strokeWidth={1.5} aria-hidden="true" />
        {hasUnread ? (
          <span
            className={styles.badge}
            aria-hidden="true"
            data-testid="notification-badge"
          >
            {formatUnread(unreadCount)}
          </span>
        ) : null}
      </button>
      {notificationsOpen ? (
        <NotificationCenter onClose={closeNotificationCenter} />
      ) : null}
    </div>
  );
}
