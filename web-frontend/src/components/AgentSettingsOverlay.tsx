/**
 * AgentSettingsOverlay — modal "team configuration" surface.
 *
 * Five sections: Lead model · Worker slots · Behaviour · LM Studio hint
 * (conditional) · Team visualization. Footer: Reset · Cancel · Save.
 *
 * Loads the snapshot from the store. The overlay maintains its own
 * draft state and only commits to the store on save (via REST). This
 * keeps cancel cleanly destructive and avoids forcing the visualizer
 * to track in-progress edits via store roundtrips.
 *
 * Modal chrome (backdrop / ESC / focus trap / scroll lock) is provided
 * by the shared `<Modal>` primitive.
 */

import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type {
  AgentsConfigSnapshot,
  AgentsWorkerSlotWire,
} from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
import { Crown, ExternalLink, Info, Plus, Users } from '../icons';
import { useStore } from '../state/store';
import { AgentSlotEditor } from './AgentSlotEditor';
import { AgentTeamVisualizer } from './AgentTeamVisualizer';
import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './AgentSettingsOverlay.module.css';

const MAX_SLOTS = 8;
const DEFAULT_SNAPSHOT: AgentsConfigSnapshot = {
  leadModel: null,
  workerSlots: [],
  isolation: 'worktree',
  maxConcurrent: 3,
  approval: 'auto',
  defaultTimeoutSec: 600,
};

const LMSTUDIO_DOCS_URL =
  'https://lmstudio.ai/docs/configuration/parallel-inference';

export interface AgentSettingsOverlayProps {
  onSave: (snapshot: AgentsConfigSnapshot) => Promise<AgentsConfigSnapshot>;
}

export function AgentSettingsOverlay({
  onSave,
}: AgentSettingsOverlayProps): JSX.Element {
  const t = useT();
  const close = useStore((s) => s.closeAgentsConfig);
  const stored = useStore((s) => s.agentsConfig);
  const setAgentsConfig = useStore((s) => s.setAgentsConfig);
  const availableModels = useStore((s) => s.models);
  const currentModel = useStore((s) => s.currentModel);
  const activeBackend = useStore((s) => s.activeBackend);
  const pushToast = useStore((s) => s.pushToast);

  const [draft, setDraft] = useState<AgentsConfigSnapshot>(
    stored ?? DEFAULT_SNAPSHOT,
  );
  const [saving, setSaving] = useState<boolean>(false);

  // Re-seed when the stored snapshot arrives (overlay can open mid-fetch).
  useEffect(() => {
    if (stored !== null) setDraft(stored);
  }, [stored]);

  const fallbackModel = useMemo<string>(() => {
    if (currentModel !== null && currentModel.length > 0) return currentModel;
    if (availableModels.length > 0 && availableModels[0] !== undefined) {
      return availableModels[0];
    }
    return 'deepseek/deepseek-coder';
  }, [currentModel, availableModels]);

  const updateDraft = (patch: Partial<AgentsConfigSnapshot>): void => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  const updateSlot = (idx: number, next: AgentsWorkerSlotWire): void => {
    setDraft((d) => {
      const list = d.workerSlots.slice();
      list[idx] = next;
      return { ...d, workerSlots: list };
    });
  };

  const addSlot = (): void => {
    setDraft((d) => {
      if (d.workerSlots.length >= MAX_SLOTS) return d;
      return {
        ...d,
        workerSlots: [...d.workerSlots, { model: fallbackModel }],
      };
    });
  };

  const removeSlot = (idx: number): void => {
    setDraft((d) => ({
      ...d,
      workerSlots: d.workerSlots.filter((_, i) => i !== idx),
    }));
  };

  const resetToDefaults = (): void => {
    setDraft(DEFAULT_SNAPSHOT);
  };

  const doSave = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const persisted = await onSave(draft);
      setAgentsConfig(persisted);
      pushToast({ level: 'success', message: t('agents.saved') });
      close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast({
        level: 'error',
        message: t('agents.saveFailed', { message }),
      });
      setSaving(false);
    }
  };

  const slotCount = draft.workerSlots.length;
  const isLmStudio = activeBackend === 'lmstudio';

  return (
    <Modal
      open={true}
      onClose={close}
      title={t('agents.title')}
      subtitle={t('agents.subtitle')}
      ariaLabel={t('agents.title')}
      icon={<Users size={16} strokeWidth={1.6} />}
      size="lg"
    >
      <ModalBody>
        {/* Section 1 — Lead */}
        <section className={styles.card}>
          <header className={styles.cardHead}>
            <span className={styles.cardIcon}>
              <Crown size={14} strokeWidth={1.6} />
            </span>
            <div>
              <h3 className={styles.cardTitle}>{t('agents.lead.title')}</h3>
              <p className={styles.cardHint}>
                {t('agents.lead.hint')}
              </p>
            </div>
          </header>
          <select
            className={styles.select}
            value={draft.leadModel ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              updateDraft({ leadModel: v.length === 0 ? null : v });
            }}
            aria-label={t('agents.lead.aria')}
          >
            <option value="">{t('agents.lead.useActive')}</option>
            {availableModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </section>

        {/* Section 2 — Worker slots */}
        <section className={styles.card}>
          <header className={styles.cardHead}>
            <div className={styles.cardHeadFlex}>
              <h3 className={styles.cardTitle}>{t('agents.workers.title')}</h3>
              <span className={styles.slotCounter}>
                {slotCount} / {MAX_SLOTS}
              </span>
            </div>
            <button
              type="button"
              className={styles.addBtn}
              onClick={addSlot}
              disabled={slotCount >= MAX_SLOTS}
              aria-label={t('agents.workers.add')}
            >
              <Plus size={14} strokeWidth={1.8} />
              <span>{t('agents.workers.add')}</span>
            </button>
          </header>
          {slotCount === 0 ? (
            <div className={styles.empty}>
              {t('agents.workers.empty')}
            </div>
          ) : (
            <div className={styles.slots}>
              {draft.workerSlots.map((slot, i) => (
                <AgentSlotEditor
                  key={i}
                  index={i}
                  slot={slot}
                  availableModels={availableModels}
                  onChange={(next) => {
                    updateSlot(i, next);
                  }}
                  onRemove={() => {
                    removeSlot(i);
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {/* Section 3 — Behaviour */}
        <section className={styles.card}>
          <header className={styles.cardHead}>
            <h3 className={styles.cardTitle}>{t('agents.behaviour.title')}</h3>
          </header>

          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>{t('agents.isolation.title')}</span>
            <div className={styles.segmented} role="radiogroup" aria-label={t('agents.isolation.title')}>
              <button
                type="button"
                role="radio"
                aria-checked={draft.isolation === 'worktree'}
                className={`${styles.segBtn} ${draft.isolation === 'worktree' ? styles.segBtnActive : ''}`}
                onClick={() => {
                  updateDraft({ isolation: 'worktree' });
                }}
                title={t('agents.isolation.worktree.tip')}
              >
                {t('agents.isolation.worktree')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={draft.isolation === 'shared'}
                className={`${styles.segBtn} ${draft.isolation === 'shared' ? styles.segBtnActive : ''}`}
                onClick={() => {
                  updateDraft({ isolation: 'shared' });
                }}
                title={t('agents.isolation.shared.tip')}
              >
                {t('agents.isolation.shared')}
              </button>
            </div>
          </div>

          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>{t('agents.maxConcurrent.title')}</span>
            <div className={styles.numberRow}>
              <input
                type="number"
                min={1}
                max={MAX_SLOTS}
                step={1}
                value={draft.maxConcurrent}
                className={styles.numberInput}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (!Number.isNaN(n)) {
                    updateDraft({
                      maxConcurrent: Math.min(MAX_SLOTS, Math.max(1, n)),
                    });
                  }
                }}
                aria-label={t('agents.maxConcurrent.aria')}
              />
              <span className={styles.fieldHint}>
                {t('agents.maxConcurrent.hint')}
              </span>
            </div>
          </div>

          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>{t('agents.approval.title')}</span>
            <div className={styles.segmented} role="radiogroup" aria-label={t('agents.approval.title')}>
              <button
                type="button"
                role="radio"
                aria-checked={draft.approval === 'auto'}
                className={`${styles.segBtn} ${draft.approval === 'auto' ? styles.segBtnActive : ''}`}
                onClick={() => {
                  updateDraft({ approval: 'auto' });
                }}
              >
                {t('agents.approval.auto')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={draft.approval === 'per-action'}
                className={`${styles.segBtn} ${draft.approval === 'per-action' ? styles.segBtnActive : ''}`}
                onClick={() => {
                  updateDraft({ approval: 'per-action' });
                }}
              >
                {t('agents.approval.perAction')}
              </button>
            </div>
            <span className={styles.fieldHint}>
              {draft.approval === 'auto'
                ? t('agents.approval.auto.hint')
                : t('agents.approval.perAction.hint')}
            </span>
          </div>
        </section>

        {/* Section 4 — LM Studio hint */}
        {isLmStudio ? (
          <section className={`${styles.card} ${styles.banner}`}>
            <div className={styles.bannerIcon}>
              <Info size={16} strokeWidth={1.6} />
            </div>
            <div className={styles.bannerBody}>
              <strong className={styles.bannerTitle}>{t('agents.lmstudio.title')}</strong>
              <p className={styles.bannerText}>
                {t('agents.lmstudio.body')}
              </p>
              <a
                className={styles.bannerLink}
                href={LMSTUDIO_DOCS_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t('agents.lmstudio.docs')}
                <ExternalLink size={12} strokeWidth={1.6} />
              </a>
            </div>
          </section>
        ) : null}

        {/* Section 5 — Visualization */}
        <section className={styles.card}>
          <header className={styles.cardHead}>
            <h3 className={styles.cardTitle}>{t('agents.viz.title')}</h3>
            <span className={styles.cardHint}>
              {t('agents.viz.hint')}
            </span>
          </header>
          <AgentTeamVisualizer
            leadModel={draft.leadModel}
            activeModel={currentModel}
            workerSlots={draft.workerSlots}
            maxConcurrent={draft.maxConcurrent}
          />
        </section>
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          className={styles.btnGhost}
          onClick={resetToDefaults}
          disabled={saving}
        >
          {t('agents.reset')}
        </button>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={close}
          disabled={saving}
        >
          {t('agents.cancel')}
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => {
            void doSave();
          }}
          disabled={saving}
        >
          {saving ? t('agents.saving') : t('agents.save')}
        </button>
      </ModalFooter>
    </Modal>
  );
}
