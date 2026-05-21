/**
 * ProfileChip — composer chip exposing the active permission profile.
 * Click opens a small dropdown listing every profile with a one-line
 * description. Selecting one POSTs `/api/config/profile` and mirrors the
 * result into the zustand store.
 *
 * Visual states:
 *   - `default`            → neutral chip text.
 *   - `acceptEdits` / `plan` → yellow tint (matches ProfileBanner).
 *   - `dontAsk` / `bypassPermissions` → red tint.
 */

import { useCallback, useRef, useState, type JSX } from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { ChevronDown, ShieldCheck } from '../icons';
import { useStore, type PermissionProfile } from '../state/store';
// POPOVER-FLIP-SECTION
import { usePopoverPosition } from '../util/use-popover-position';
// /POPOVER-FLIP-SECTION

import styles from './ProfileChip.module.css';

export interface ProfileChipProps {
  disabled?: boolean;
}

const PROFILE_ORDER: readonly PermissionProfile[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
];

function tintFor(profile: PermissionProfile | null): string {
  if (profile === 'plan' || profile === 'acceptEdits') {
    return styles.warnTint ?? '';
  }
  if (profile === 'dontAsk' || profile === 'bypassPermissions') {
    return styles.dangerTint ?? '';
  }
  return '';
}

export function ProfileChip({ disabled = false }: ProfileChipProps): JSX.Element {
  const t = useT();
  const profile = useStore((s) => s.permissionProfile);
  const setPermissionProfile = useStore((s) => s.setPermissionProfile);
  const pushToast = useStore((s) => s.pushToast);
  const { rest } = useApiClients();
  const [open, setOpen] = useState(false);
  // POPOVER-FLIP-SECTION — chip lives in the bottom composer row;
  // prefer opening upward and auto-flip if the menu would overflow.
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = usePopoverPosition({
    anchorRef,
    popoverRef: menuRef,
    preferredSide: 'top',
    gap: 6,
    open,
  });
  // /POPOVER-FLIP-SECTION

  const current: PermissionProfile = profile ?? 'default';
  const label = t(`profile.short.${current}`);

  const handleSelect = useCallback(
    (next: PermissionProfile): void => {
      setOpen(false);
      if (next === current) return;
      const previous = current;
      // Optimistic update so the chip + banner flip instantly.
      setPermissionProfile(next);
      void (async () => {
        try {
          await rest.setProfile({ profile: next });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pushToast({
            level: 'error',
            message: t('profile.toast.switchFailed', { message }),
          });
          // Restore the previous selection on persist failure.
          setPermissionProfile(previous);
        }
      })();
    },
    [current, pushToast, rest, setPermissionProfile, t],
  );

  return (
    <div className={styles.wrap}>
      <button
        ref={anchorRef}
        type="button"
        className={`${styles.chip} ${tintFor(current)}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('profile.chip.title', { name: label })}
      >
        <ShieldCheck size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className={styles.label}>{label}</span>
        <ChevronDown size={14} strokeWidth={1.5} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={styles.menu}
          role="listbox"
          aria-label={t('profile.menu.aria')}
          style={placement.style}
          data-popover-side={placement.side}
        >
          {PROFILE_ORDER.map((p) => {
            const active = p === current;
            return (
              <button
                key={p}
                type="button"
                className={`${styles.option} ${active ? styles.optionActive : ''}`}
                role="option"
                aria-selected={active}
                onClick={() => handleSelect(p)}
              >
                <span>{t(`profile.short.${p}`)}</span>
                <span className={styles.optionHint}>
                  {t(`profile.hint.${p}`)}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
