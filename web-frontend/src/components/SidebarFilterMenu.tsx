/**
 * SidebarFilterMenu — popover anchored to the top filter button.
 * Lets the user pick between "By project" / "Recent" / "Active"
 * grouping modes, and trigger an explicit "Clean stale entries" action
 * that removes pattern-junk workspace rows (tmp dirs, integration-test
 * fixtures, dead worktree paths) from `workspaces.json`. Closes on
 * outside-click, ESC, or after picking a grouping item.
 *
 * NOTE: Cleanup is intentionally user-triggered. Auto-cleanup at boot
 * destructively evicted real projects when FS checks transiently
 * failed (Spotlight indexing, slow-mounted volumes, symlink resolution).
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Check, Search, Trash2 } from 'lucide-react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { useStore, type SidebarGroupBy } from '../state/store';
import styles from './SidebarFilterMenu.module.css';

interface ModeEntry {
  id: SidebarGroupBy;
  label: string;
  description: string;
}

export interface SidebarFilterMenuProps {
  onClose: () => void;
}

export function SidebarFilterMenu({
  onClose,
}: SidebarFilterMenuProps): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const groupBy = useStore((s) => s.sidebarGroupBy);
  const setSidebarGroupBy = useStore((s) => s.setSidebarGroupBy);
  const setProjects = useStore((s) => s.setProjects);
  const pushToast = useStore((s) => s.pushToast);
  const openSessionSearch = useStore((s) => s.openSessionSearch);
  const clients = useApiClients();
  const [cleaning, setCleaning] = useState<boolean>(false);

  const MODES = useMemo<readonly ModeEntry[]>(
    () => [
      {
        id: 'project',
        label: t('sidebar.groupBy.project'),
        description: t('sidebar.groupBy.project.desc'),
      },
      {
        id: 'recent',
        label: t('sidebar.groupBy.recent'),
        description: t('sidebar.groupBy.recent.desc'),
      },
      {
        id: 'active',
        label: t('sidebar.groupBy.active'),
        description: t('sidebar.groupBy.active.desc'),
      },
    ],
    [t],
  );

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (
        ref.current !== null &&
        target !== null &&
        !ref.current.contains(target)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const handleCleanStale = async (): Promise<void> => {
    if (cleaning) return;
    setCleaning(true);
    try {
      const res = await clients.rest.cleanupProjects();
      // Refresh the project list so any removed rows disappear.
      try {
        const list = await clients.rest.listProjects();
        setProjects(list.projects);
      } catch {
        // best-effort
      }
      if (res.removed > 0) {
        pushToast({
          level: 'success',
          message: t('toast.cleanedStale', { count: res.removed }),
        });
      } else {
        pushToast({
          level: 'info',
          message: t('toast.cleanedStaleNone'),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast({
        level: 'error',
        message: t('toast.cleanedStaleFailed', { message }),
      });
    } finally {
      setCleaning(false);
      onClose();
    }
  };

  return (
    <div ref={ref} className={styles.root} role="menu">
      <p className={styles.heading}>{t('sidebar.groupBy.heading')}</p>
      {MODES.map((m) => {
        const selected = m.id === groupBy;
        return (
          <button
            key={m.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={`${styles.item} ${selected ? styles.itemSelected : ''}`}
            onClick={() => setSidebarGroupBy(m.id)}
          >
            <span className={styles.check}>
              {selected ? <Check size={14} strokeWidth={2} /> : null}
            </span>
            <span className={styles.text}>
              <span className={styles.label}>{m.label}</span>
              <span className={styles.description}>{m.description}</span>
            </span>
          </button>
        );
      })}
      <div className={styles.divider} role="separator" />
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={() => {
          openSessionSearch();
        }}
      >
        <span className={styles.check}>
          <Search size={14} strokeWidth={1.75} />
        </span>
        <span className={styles.text}>
          <span className={styles.label}>{t('sessionSearch.open')}</span>
          <span className={styles.description}>
            {t('sessionSearch.openAria')}
          </span>
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={() => {
          void handleCleanStale();
        }}
        disabled={cleaning}
        aria-busy={cleaning}
      >
        <span className={styles.check}>
          <Trash2 size={14} strokeWidth={1.75} />
        </span>
        <span className={styles.text}>
          <span className={styles.label}>{t('sidebar.cleanStale')}</span>
          <span className={styles.description}>
            {t('sidebar.cleanStale.desc')}
          </span>
        </span>
      </button>
    </div>
  );
}
