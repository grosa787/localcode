/**
 * NotificationCenter — popover anchored under the bell. Lists
 * notifications in two sections (Unread / Read), supports per-row
 * "mark read" + jump-to-session, and exposes "Mark all as read" /
 * "Clear all" actions plus a browser-permission toggle.
 *
 * Rendered conditionally by <NotificationBell /> when
 * `notificationsOpen` is true.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { useT } from '../i18n';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  ShieldCheck,
  X,
  Zap,
} from '../icons';
import { requestBrowserNotificationPermission } from '../services/notifications-service';
import {
  useStore,
  type Notification as NotificationEntry,
  type NotificationType,
} from '../state/store';

import styles from './NotificationCenter.module.css';

export interface NotificationCenterProps {
  onClose: () => void;
}

/**
 * Map each notification type to a small icon element. We render via a
 * switch rather than storing the component reference because lucide-react
 * icons expose `size: string | number` and TS rejects the narrower
 * `size: number` we use throughout the SPA.
 */
function iconForType(type: NotificationType): JSX.Element {
  switch (type) {
    case 'agent_completed':
    case 'stream_completed':
      return <CheckCircle2 size={14} strokeWidth={1.5} aria-hidden="true" />;
    case 'agent_errored':
      return <AlertCircle size={14} strokeWidth={1.5} aria-hidden="true" />;
    case 'wakeup_fired':
      return <Clock size={14} strokeWidth={1.5} aria-hidden="true" />;
    case 'approval_required':
      return <ShieldCheck size={14} strokeWidth={1.5} aria-hidden="true" />;
    case 'circuit_open':
      return <AlertTriangle size={14} strokeWidth={1.5} aria-hidden="true" />;
    case 'hook_blocked':
      return <Zap size={14} strokeWidth={1.5} aria-hidden="true" />;
  }
}

function fmtRelative(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function isUrgent(type: NotificationType): boolean {
  return type === 'approval_required' || type === 'hook_blocked';
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

interface RowProps {
  notification: NotificationEntry;
  onMarkRead: (id: string) => void;
  onJump: (n: NotificationEntry) => void;
  now: number;
  markAsReadLabel: string;
}

function NotificationRow({
  notification,
  onMarkRead,
  onJump,
  now,
  markAsReadLabel,
}: RowProps): JSX.Element {
  const urgent = isUrgent(notification.type);
  return (
    <div
      className={`${styles.row} ${urgent ? styles.rowUrgent ?? '' : ''} ${
        notification.read ? '' : styles.rowUnread ?? ''
      }`}
      role="button"
      tabIndex={0}
      data-testid={`notification-row-${notification.id}`}
      onClick={() => onJump(notification)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onJump(notification);
        }
      }}
    >
      <div className={styles.rowIcon} aria-hidden="true">
        {iconForType(notification.type)}
      </div>
      <div className={styles.rowBody}>
        <div className={styles.rowTitle}>{notification.title}</div>
        {notification.body !== undefined ? (
          <div className={styles.rowText}>{truncate(notification.body, 120)}</div>
        ) : null}
        <div className={styles.rowMeta}>{fmtRelative(notification.timestamp, now)}</div>
      </div>
      <button
        type="button"
        className={styles.rowDismiss}
        onClick={(e) => {
          e.stopPropagation();
          onMarkRead(notification.id);
        }}
        aria-label={markAsReadLabel}
        title={markAsReadLabel}
        data-testid={`notification-dismiss-${notification.id}`}
      >
        <X size={12} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

export function NotificationCenter({
  onClose,
}: NotificationCenterProps): JSX.Element {
  const t = useT();
  const notifications = useStore((s) => s.notifications);
  const markRead = useStore((s) => s.markRead);
  const markAllRead = useStore((s) => s.markAllRead);
  const clearAll = useStore((s) => s.clearAll);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const browserEnabled = useStore((s) => s.browserNotificationsEnabled);
  const setBrowserEnabled = useStore(
    (s) => s.setBrowserNotificationsEnabled,
  );

  const [readCollapsed, setReadCollapsed] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    () => {
      if (typeof window === 'undefined') return null;
      const Ctor = (window as unknown as { Notification?: typeof Notification })
        .Notification;
      if (Ctor === undefined) return null;
      return (
        (Ctor as unknown as { permission?: NotificationPermission })
          .permission ?? null
      );
    },
  );

  // Close on click-outside (anchored popover).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onDocClick = (e: MouseEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      const target = e.target;
      if (target instanceof Node && root.contains(target)) return;
      // Don't close on the bell trigger click (the bell toggles itself).
      if (target instanceof Element) {
        const trigger = target.closest('[data-testid="notification-bell"]');
        if (trigger !== null) return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Sorted newest-first so the most relevant entry is at the top of
  // each section.
  const unread = useMemo(
    () =>
      notifications
        .filter((n) => !n.read)
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp),
    [notifications],
  );
  const read = useMemo(
    () =>
      notifications
        .filter((n) => n.read)
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp),
    [notifications],
  );

  const now = Date.now();

  const handleJump = (n: NotificationEntry): void => {
    if (n.sessionId !== undefined) {
      setActiveSession(n.sessionId);
    }
    markRead(n.id);
    onClose();
  };

  const handleTogglePermission = async (): Promise<void> => {
    if (browserEnabled) {
      setBrowserEnabled(false);
      return;
    }
    const result = await requestBrowserNotificationPermission();
    setPermission(result);
    setBrowserEnabled(result === 'granted');
  };

  const empty = notifications.length === 0;

  return (
    <div
      ref={rootRef}
      className={styles.popover}
      role="dialog"
      aria-label={t('notifications.title')}
      data-testid="notification-center"
    >
      <header className={styles.header}>
        <span className={styles.title}>
          <Bell size={14} strokeWidth={1.5} aria-hidden="true" />{' '}
          {t('notifications.title')}
        </span>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label={t('notifications.close')}
          title={t('notifications.close')}
        >
          <X size={12} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>
      <div className={styles.body}>
        {empty ? (
          <div className={styles.empty}>{t('notifications.empty')}</div>
        ) : (
          <>
            {unread.length > 0 ? (
              <section className={styles.section} aria-label={t('notifications.unreadSection', { count: unread.length })}>
                <div className={styles.sectionLabel}>
                  {t('notifications.unreadSection', { count: unread.length })}
                </div>
                {unread.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    onMarkRead={markRead}
                    onJump={handleJump}
                    now={now}
                    markAsReadLabel={t('notifications.markAsRead')}
                  />
                ))}
              </section>
            ) : null}
            {read.length > 0 ? (
              <section className={styles.section} aria-label={t('notifications.readSection', { count: read.length })}>
                <button
                  type="button"
                  className={styles.sectionToggle}
                  onClick={() => setReadCollapsed((v) => !v)}
                  aria-expanded={!readCollapsed}
                  data-testid="notification-read-toggle"
                >
                  {t('notifications.readSection', { count: read.length })}{' '}
                  {readCollapsed ? '▸' : '▾'}
                </button>
                {readCollapsed
                  ? null
                  : read.map((n) => (
                      <NotificationRow
                        key={n.id}
                        notification={n}
                        onMarkRead={markRead}
                        onJump={handleJump}
                        now={now}
                        markAsReadLabel={t('notifications.markAsRead')}
                      />
                    ))}
              </section>
            ) : null}
          </>
        )}
      </div>
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={browserEnabled && permission === 'granted'}
              onChange={() => {
                void handleTogglePermission();
              }}
              data-testid="notification-browser-toggle"
            />
            <span>{t('notifications.enableBrowser')}</span>
          </label>
          {permission === 'denied' ? (
            <span className={styles.permHint}>
              {t('notifications.permissionBlocked')}
            </span>
          ) : null}
        </div>
        <div className={styles.footerActions}>
          <button
            type="button"
            className={styles.footerBtn}
            onClick={markAllRead}
            disabled={unread.length === 0}
            data-testid="notification-mark-all-read"
          >
            {t('notifications.markAllRead')}
          </button>
          <button
            type="button"
            className={styles.footerBtn}
            onClick={clearAll}
            disabled={empty}
            data-testid="notification-clear-all"
          >
            {t('notifications.clearAll')}
          </button>
        </div>
      </footer>
    </div>
  );
}
