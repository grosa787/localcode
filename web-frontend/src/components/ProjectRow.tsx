/**
 * ProjectRow — collapsible header for a single project in the sidebar
 * tree. Bundles:
 *   - Folder/FolderOpen icon (changes with expansion state)
 *   - Label
 *   - Session count badge
 *   - Pulsing dot when ANY child session is streaming
 *   - Hover-revealed kebab menu (Hide / Delete from LocalCode)
 *
 * Click on the row body toggles expansion. Click on the kebab opens
 * the menu. The kebab menu closes on outside-click, ESC, or after an
 * action.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import { useT } from '../i18n';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MoreVertical,
  Trash2,
} from '../icons';
import styles from './ProjectRow.module.css';

export interface ProjectRowProps {
  projectId: string;
  label: string;
  /** Absolute path — surfaced via tooltip. */
  path: string;
  sessionCount: number;
  expanded: boolean;
  /** True when this project's row should be rendered with the active styling. */
  active: boolean;
  /** True when at least one child session is currently streaming. */
  streaming: boolean;
  onToggle: () => void;
  onHide: () => void;
  onDelete: () => void;
}

export function ProjectRow({
  projectId,
  label,
  path,
  sessionCount,
  expanded,
  active,
  streaming,
  onToggle,
  onHide,
  onDelete,
}: ProjectRowProps): JSX.Element {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const kebabRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: globalThis.MouseEvent): void => {
      const target = e.target as Node | null;
      if (
        menuRef.current !== null &&
        target !== null &&
        !menuRef.current.contains(target) &&
        kebabRef.current !== null &&
        !kebabRef.current.contains(target)
      ) {
        closeMenu();
      }
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
        kebabRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, closeMenu]);

  const Chev = expanded ? ChevronDown : ChevronRight;
  const Fold = expanded ? FolderOpen : Folder;

  const handleKebab = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    setMenuOpen((v) => !v);
  };


  const handleDelete = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    closeMenu();
    onDelete();
  };

  const handleHeaderKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      className={`${styles.root} ${active ? styles.active : ''}`}
      data-project-id={projectId}
    >
      <div
        className={styles.header}
        onClick={onToggle}
        onKeyDown={handleHeaderKey}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        title={path}
      >
        <Chev size={14} strokeWidth={1.5} className={styles.chev} />
        <Fold size={14} strokeWidth={1.5} className={styles.folder} />
        <span className={styles.label}>{label}</span>
        <span
          className={styles.count}
          aria-label={t('projectRow.sessions.count', { count: sessionCount })}
        >
          ({sessionCount})
        </span>
        {streaming ? (
          <span
            className={styles.pulseDot}
            aria-label={t('projectRow.streaming.aria')}
            title={t('projectRow.streaming.tip')}
            role="status"
          />
        ) : null}
        <button
          type="button"
          ref={kebabRef}
          className={styles.kebab}
          aria-label={t('projectRow.options')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={handleKebab}
        >
          <MoreVertical size={14} strokeWidth={1.5} />
        </button>
      </div>
      {menuOpen ? (
        <div ref={menuRef} className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.menuItemDanger}`}
            onClick={handleDelete}
          >
            <Trash2 size={14} strokeWidth={1.5} />
            <span>{t('projectRow.delete')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
