/**
 * AgentSlotEditor — single worker-slot row inside the AgentSettingsOverlay.
 *
 * - Slot number circle (accent)
 * - Model dropdown (drawn from `availableModels`)
 * - Provider chip (auto-derived from model id)
 * - Skills multi-select chips (free-text-ish via store skills list)
 * - Settings popover with isolation override + custom timeout
 * - Remove button
 */

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { AgentsWorkerSlotWire } from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
import { Minus, SlidersHorizontal, X } from '../icons';
import { useStore } from '../state/store';
import {
  providerColor,
  providerForModel,
  providerLabel,
} from './AgentTeamVisualizer';

import styles from './AgentSlotEditor.module.css';

export interface AgentSlotEditorProps {
  index: number;
  slot: AgentsWorkerSlotWire;
  availableModels: string[];
  onChange: (next: AgentsWorkerSlotWire) => void;
  onRemove: () => void;
}

export function AgentSlotEditor(props: AgentSlotEditorProps): JSX.Element {
  const t = useT();
  const { index, slot, availableModels, onChange, onRemove } = props;
  const [popoverOpen, setPopoverOpen] = useState<boolean>(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const skillsAvailable = useStore((s) => s.skills);

  const provider = providerForModel(slot.model);
  const color = providerColor(provider);
  const providerName = providerLabel(provider);

  // Click-away to dismiss popover.
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target;
      if (t instanceof Node && popoverRef.current && !popoverRef.current.contains(t)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [popoverOpen]);

  const updateModel = (model: string): void => {
    onChange({ ...slot, model });
  };

  const toggleSkill = (id: string): void => {
    const cur = slot.skills ?? [];
    const next = cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id];
    if (next.length === 0) {
      const { skills: _drop, ...rest } = slot;
      void _drop;
      onChange(rest);
    } else {
      onChange({ ...slot, skills: next });
    }
  };

  const setIsolation = (v: 'worktree' | 'shared' | ''): void => {
    if (v === '') {
      const { isolationOverride: _drop, ...rest } = slot;
      void _drop;
      onChange(rest);
    } else {
      onChange({ ...slot, isolationOverride: v });
    }
  };

  const setTimeoutSec = (n: number | null): void => {
    if (n === null) {
      const { timeoutSec: _drop, ...rest } = slot;
      void _drop;
      onChange(rest);
    } else {
      onChange({ ...slot, timeoutSec: n });
    }
  };

  const activeSkills = slot.skills ?? [];

  // If the slot's model is not in the available list, surface it anyway.
  const modelOptions = availableModels.includes(slot.model)
    ? availableModels
    : [slot.model, ...availableModels];

  return (
    <div className={styles.row}>
      <div
        className={styles.slotNum}
        style={{ background: color }}
        aria-label={t('slotEditor.removeAria', { n: index + 1 })}
      >
        {index + 1}
      </div>
      <div className={styles.body}>
        <div className={styles.topLine}>
          <select
            className={styles.modelSelect}
            value={slot.model}
            onChange={(e) => {
              updateModel(e.target.value);
            }}
            aria-label={t('slotEditor.modelAria', { n: index + 1 })}
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span
            className={styles.providerBadge}
            style={{ background: `${color}26`, color, borderColor: `${color}55` }}
            title={t('slotEditor.providerLabel', { name: providerName })}
          >
            {providerName}
          </span>
        </div>

        {skillsAvailable.length > 0 ? (
          <div className={styles.skillsRow}>
            {skillsAvailable.slice(0, 6).map((s) => {
              const isOn = activeSkills.includes(s.id);
              return (
                <button
                  type="button"
                  key={s.id}
                  className={`${styles.skillChip} ${isOn ? styles.skillChipOn : ''}`}
                  onClick={() => {
                    toggleSkill(s.id);
                  }}
                  title={s.description}
                  aria-pressed={isOn}
                >
                  {s.name}
                </button>
              );
            })}
            {activeSkills.length > 0 ? (
              <span className={styles.skillCount}>
                {t('slotEditor.activeSkills', { count: activeSkills.length })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={styles.actions}>
        <div className={styles.popoverHost} ref={popoverRef}>
          <button
            type="button"
            className={`${styles.iconBtn} ${popoverOpen ? styles.iconBtnOpen : ''}`}
            onClick={() => {
              setPopoverOpen((v) => !v);
            }}
            aria-label={t('slotEditor.advancedAria')}
            title={t('slotEditor.advanced')}
          >
            <SlidersHorizontal size={14} strokeWidth={1.5} />
          </button>
          {popoverOpen ? (
            <div className={styles.popover} role="dialog" aria-label={t('slotEditor.aria')}>
              <div className={styles.popoverHead}>
                <span className={styles.popoverTitle}>
                  {t('slotEditor.slotOverrides', { n: index + 1 })}
                </span>
                <button
                  type="button"
                  className={styles.iconBtnTiny}
                  onClick={() => {
                    setPopoverOpen(false);
                  }}
                  aria-label={t('slotEditor.close')}
                >
                  <X size={12} strokeWidth={1.5} />
                </button>
              </div>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('slotEditor.isolationOverride')}</span>
                <select
                  className={styles.input}
                  value={slot.isolationOverride ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'worktree' || v === 'shared' || v === '') setIsolation(v);
                  }}
                >
                  <option value="">{t('slotEditor.isolationInherit')}</option>
                  <option value="worktree">{t('slotEditor.isolationWorktree')}</option>
                  <option value="shared">{t('slotEditor.isolationShared')}</option>
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('slotEditor.timeout')}</span>
                <input
                  type="number"
                  className={styles.input}
                  min={30}
                  max={7200}
                  step={30}
                  value={slot.timeoutSec ?? ''}
                  placeholder={t('slotEditor.timeoutInherit')}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '') {
                      setTimeoutSec(null);
                    } else {
                      const n = Number.parseInt(raw, 10);
                      if (!Number.isNaN(n)) setTimeoutSec(n);
                    }
                  }}
                />
              </label>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className={styles.iconBtnDanger}
          onClick={onRemove}
          aria-label={t('slotEditor.removeAria', { n: index + 1 })}
          title={t('slotEditor.removeSlot')}
        >
          <Minus size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
