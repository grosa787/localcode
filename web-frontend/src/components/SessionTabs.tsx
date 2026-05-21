/**
 * SessionTabs — browser-style tab bar above the ProjectBar.
 *
 * Each open session renders as a pill (title + close ×). The active tab
 * is highlighted with --accent-soft + 2px bottom border. A trailing `+`
 * button opens a new session.
 *
 * Keyboard:
 *   - Cmd/Ctrl+W       close active tab
 *   - Cmd/Ctrl+T       open new tab (delegates to onNewTab handler)
 *   - Cmd/Ctrl+1..9    switch to tab N
 *
 * Closing a tab does NOT delete the session — it only hides it from the
 * tab bar. The session remains in `state.sessions` and can be reopened
 * via the sidebar.
 */

import { useCallback, useEffect, useMemo, type JSX } from 'react';

import { useT } from '../i18n';
import { Plus, X } from '../icons';
import { useStore } from '../state/store';

import styles from './SessionTabs.module.css';

export interface SessionTabsProps {
  /** Called when the user clicks the `+` button or presses Cmd+T. */
  onNewTab?: () => void;
}

interface TabDescriptor {
  id: string;
  title: string;
  unsaved: boolean;
}

export function SessionTabs({ onNewTab }: SessionTabsProps): JSX.Element | null {
  const t = useT();
  const openTabs = useStore((s) => s.openTabs);
  const activeTab = useStore((s) => s.activeTab);
  const sessions = useStore((s) => s.sessions);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const switchTabByIndex = useStore((s) => s.switchTabByIndex);

  const sessionLookup = useMemo(() => {
    const m = new Map<string, (typeof sessions)[number]>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  const tabs = useMemo<TabDescriptor[]>(() => {
    return openTabs.map((sid) => {
      const s = sessionLookup.get(sid);
      const title = (s?.title ?? '').trim();
      return {
        id: sid,
        title: title.length > 0 ? title : t('sessionRow.newChat'),
        unsaved: sessionStatus[sid]?.status === 'streaming',
      };
    });
  }, [openTabs, sessionLookup, sessionStatus, t]);

  // Cmd+W close, Cmd+T new, Cmd+1..9 switch.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Don't intercept while text-editing in inputs — except Cmd+W which
      // closes regardless (matches browser behaviour).
      const target = e.target;
      const isEditable =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key === 'w' || e.key === 'W') {
        if (activeTab === null) return;
        e.preventDefault();
        closeTab(activeTab);
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        if (isEditable) return;
        e.preventDefault();
        onNewTab?.();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        if (isEditable) return;
        e.preventDefault();
        switchTabByIndex(parseInt(e.key, 10) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTab, closeTab, onNewTab, switchTabByIndex]);

  if (openTabs.length === 0) {
    // Still render the bar so the `+` is reachable, even with no tabs.
    return (
      <div
        className={styles.bar}
        role="tablist"
        aria-label={t('sessionRow.newChat')}
      >
        <button
          type="button"
          className={styles.newTab}
          onClick={onNewTab}
          aria-label="New tab"
          title="New tab"
        >
          <Plus size={14} strokeWidth={1.7} />
        </button>
      </div>
    );
  }

  return (
    <div
      className={styles.bar}
      role="tablist"
      aria-label={t('sessionRow.newChat')}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            data-testid={`session-tab-${tab.id}`}
            className={`${styles.tab} ${isActive ? styles.tabActive ?? '' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            onAuxClick={(e) => {
              // Middle-click closes the tab (matches browser convention).
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveTab(tab.id);
              }
            }}
            tabIndex={isActive ? 0 : -1}
          >
            <span className={styles.tabTitle} title={tab.title}>
              {tab.title}
            </span>
            {tab.unsaved ? (
              <span className={styles.unsavedDot} aria-hidden="true" />
            ) : null}
            <button
              type="button"
              className={styles.closeBtn}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              aria-label={`Close ${tab.title}`}
              title="Close tab"
            >
              <X size={11} strokeWidth={1.8} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className={styles.newTab}
        onClick={onNewTab}
        aria-label="New tab"
        title="New tab (Cmd+T)"
      >
        <Plus size={14} strokeWidth={1.7} />
      </button>
    </div>
  );
}
