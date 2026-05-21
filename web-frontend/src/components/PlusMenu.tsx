/**
 * PlusMenu — floating action menu anchored to the `+` button in the
 * Composer. Replaces the slash-only entry point with a curated grid
 * of high-level actions (skills, plugins, slash browser).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent,
} from 'react';

import { useT } from '../i18n';
import {
  BookOpen,
  Paperclip,
  Puzzle,
  Sparkles,
  Wrench,
} from '../icons';
import { useStore } from '../state/store';

import styles from './PlusMenu.module.css';

interface MenuItem {
  id: string;
  label: string;
  icon: (props: { size?: number; strokeWidth?: number }) => JSX.Element;
  hint?: string;
  disabled?: boolean;
  onActivate: () => void;
}

export interface PlusMenuProps {
  /** DOM element the menu anchors above. */
  anchor: HTMLElement | null;
  onClose: () => void;
}

export function PlusMenu({ anchor, onClose }: PlusMenuProps): JSX.Element {
  const t = useT();
  const openSkillsOverlay = useStore((s) => s.openSkillsOverlay);
  const openPluginsOverlay = useStore((s) => s.openPluginsOverlay);
  const openAddSkill = useStore((s) => s.openAddSkill);
  const openSlashCommands = useStore((s) => s.openSlashCommands);
  const closePlusMenu = useStore((s) => s.closePlusMenu);

  const menuRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState(0);

  const items = useMemo<MenuItem[]>(
    () => [
      {
        id: 'use-skill',
        label: t('plus.useSkill'),
        icon: (p) => <Sparkles {...p} />,
        onActivate: () => {
          openSkillsOverlay();
        },
      },
      {
        id: 'add-skill',
        label: t('plus.addSkill'),
        icon: (p) => <BookOpen {...p} />,
        onActivate: () => {
          openAddSkill();
        },
      },
      {
        id: 'open-plugin',
        label: t('plus.openPlugin'),
        icon: (p) => <Puzzle {...p} />,
        onActivate: () => {
          openPluginsOverlay();
        },
      },
      {
        id: 'browse-slash',
        label: t('plus.browseSlash'),
        hint: '/',
        icon: (p) => <Wrench {...p} />,
        onActivate: () => {
          closePlusMenu();
          openSlashCommands();
        },
      },
      {
        id: 'attach',
        label: t('plus.attach'),
        hint: t('plus.attach.soon'),
        icon: (p) => <Paperclip {...p} />,
        disabled: true,
        onActivate: () => {
          /* disabled */
        },
      },
    ],
    [
      openSkillsOverlay,
      openAddSkill,
      openPluginsOverlay,
      openSlashCommands,
      closePlusMenu,
      t,
    ],
  );

  // Position the menu above the anchor.
  const style = useMemo<CSSProperties>(() => {
    if (anchor === null) return { top: 0, left: 0 };
    const rect = anchor.getBoundingClientRect();
    // 280 width + 8 gap above the anchor
    return {
      left: Math.max(8, rect.left),
      top: Math.max(8, rect.top - 8),
      transform: 'translateY(-100%)',
    };
  }, [anchor]);

  const move = useCallback(
    (delta: number) => {
      setHoverIdx((cur) => {
        const len = items.length;
        let next = cur;
        for (let i = 0; i < len; i += 1) {
          next = (next + delta + len) % len;
          const candidate = items[next];
          if (candidate !== undefined && candidate.disabled !== true) return next;
        }
        return cur;
      });
    },
    [items],
  );

  const activate = useCallback(
    (idx: number) => {
      const item = items[idx];
      if (item === undefined || item.disabled === true) return;
      item.onActivate();
      onClose();
    },
    [items, onClose],
  );

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        activate(hoverIdx);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activate, hoverIdx, move, onClose]);

  const onBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div
      className={styles.backdrop}
      onClick={onBackdropClick}
      role="presentation"
    >
      <div
        ref={menuRef}
        className={styles.menu}
        style={style}
        role="menu"
        aria-label={t('plus.aria')}
      >
        {items.map((item, idx) => {
          const isLastBeforeBrowse =
            item.id === 'open-plugin' && items[idx + 1]?.id === 'browse-slash';
          const isBeforeAttach =
            item.id === 'browse-slash' && items[idx + 1]?.id === 'attach';
          return (
            <span key={item.id}>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                disabled={item.disabled === true}
                data-active={hoverIdx === idx ? 'true' : 'false'}
                onMouseEnter={() => setHoverIdx(idx)}
                onClick={() => activate(idx)}
              >
                <span className={styles.itemIcon} aria-hidden="true">
                  {item.icon({ size: 16, strokeWidth: 1.5 })}
                </span>
                <span className={styles.itemLabel}>{item.label}</span>
                {item.hint !== undefined ? (
                  <span className={styles.itemHint}>{item.hint}</span>
                ) : null}
              </button>
              {isLastBeforeBrowse || isBeforeAttach ? (
                <div className={styles.divider} aria-hidden="true" />
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
