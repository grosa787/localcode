/**
 * SettingsOverlay — modal dialog opened from the sidebar gear button.
 *
 * Editable form for generation params (temperature / top_p / repeat
 * penalty / max tokens). Persists via `POST /api/config/generation`.
 * Below the form, the read-only "Active provider", "Active model", and
 * slash-command list remain informative.
 *
 * Backdrop / Escape / focus-trap / scroll-lock semantics are owned by
 * the shared `<Modal>` primitive — this component focuses on form logic.
 */

import type { FormEvent, JSX } from 'react';
import { useState } from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { useStore } from '../state/store';
import { Modal, ModalBody, ModalFooter } from './Modal';
import styles from './SettingsOverlay.module.css';

export interface GenerationConfig {
  temperature: number;
  topP: number;
  repeatPenalty: number;
  maxTokens: number;
}

export interface SettingsOverlayProps {
  /** Optional — fetched generation params from `GET /api/config`. */
  generation?: GenerationConfig | null;
  onClose: () => void;
  /** Called after a successful save so the host can refresh local state. */
  onSaved?: (gen: GenerationConfig) => void;
}

const SLASH_COMMANDS: ReadonlyArray<{ name: string; desc: string }> = [
  { name: '/permissions', desc: 'Toggle auto-approved tools' },
  { name: '/context', desc: 'Inspect current context window usage' },
  { name: '/ctxsize', desc: 'Resize the context window' },
  { name: '/provider', desc: 'Switch backend / API key' },
  { name: '/model', desc: 'Switch model' },
  { name: '/settings', desc: 'Open generation params (TUI)' },
  { name: '/resume', desc: 'Resume a prior session' },
];

interface KeyboardShortcut {
  keys: string;
  descKey:
    | 'settings.shortcuts.send'
    | 'settings.shortcuts.newline'
    | 'settings.shortcuts.slash'
    | 'settings.shortcuts.escape'
    | 'settings.shortcuts.tab';
}

const KEYBOARD_SHORTCUTS: ReadonlyArray<KeyboardShortcut> = [
  { keys: 'Enter', descKey: 'settings.shortcuts.send' },
  { keys: 'Shift + Enter', descKey: 'settings.shortcuts.newline' },
  { keys: '/', descKey: 'settings.shortcuts.slash' },
  { keys: 'Esc', descKey: 'settings.shortcuts.escape' },
  { keys: 'Tab', descKey: 'settings.shortcuts.tab' },
];

const DEFAULT_GENERATION: GenerationConfig = {
  temperature: 0.7,
  topP: 1,
  repeatPenalty: 1,
  maxTokens: 2048,
};

export function SettingsOverlay({
  generation = null,
  onClose,
  onSaved,
}: SettingsOverlayProps): JSX.Element {
  const t = useT();
  const activeBackend = useStore((s) => s.activeBackend);
  const baseUrl = useStore((s) => s.baseUrl);
  const currentModel = useStore((s) => s.currentModel);
  const pushToast = useStore((s) => s.pushToast);
  const closeSettings = useStore((s) => s.closeSettings);
  // SETTINGS-BUTTON-WIRE-SECTION — route hooks/memory buttons through
  // the exclusive-overlay opener so the App-level mount logic sees them.
  const openOverlay = useStore((s) => s.openOverlay);
  // /SETTINGS-BUTTON-WIRE-SECTION
  const { rest } = useApiClients();

  const initial = generation ?? DEFAULT_GENERATION;
  const [temperature, setTemperature] = useState<string>(
    String(initial.temperature),
  );
  const [topP, setTopP] = useState<string>(String(initial.topP));
  const [repeatPenalty, setRepeatPenalty] = useState<string>(
    String(initial.repeatPenalty),
  );
  const [maxTokens, setMaxTokens] = useState<string>(String(initial.maxTokens));
  const [saving, setSaving] = useState<boolean>(false);

  const handleSave = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (saving) return;

    const parsed: GenerationConfig = {
      temperature: Number(temperature),
      topP: Number(topP),
      repeatPenalty: Number(repeatPenalty),
      maxTokens: Math.trunc(Number(maxTokens)),
    };

    // Client-side range guard mirroring the server schema.
    const invalid =
      !Number.isFinite(parsed.temperature) ||
      parsed.temperature < 0 ||
      parsed.temperature > 2 ||
      !Number.isFinite(parsed.topP) ||
      parsed.topP < 0 ||
      parsed.topP > 1 ||
      !Number.isFinite(parsed.repeatPenalty) ||
      parsed.repeatPenalty < 0 ||
      parsed.repeatPenalty > 2 ||
      !Number.isFinite(parsed.maxTokens) ||
      parsed.maxTokens < 1 ||
      parsed.maxTokens > 1_000_000;
    if (invalid) {
      pushToast({
        level: 'error',
        message: t('settings.invalid'),
      });
      return;
    }

    setSaving(true);
    try {
      const res = await rest.setGeneration(parsed);
      onSaved?.(res.generation);
      pushToast({ level: 'success', message: t('settings.saved') });
      closeSettings();
    } catch (err) {
      pushToast({
        level: 'error',
        message:
          err instanceof Error
            ? `${t('settings.saveFailed')}: ${err.message}`
            : t('settings.saveFailed'),
      });
      setSaving(false);
    }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={t('settings.title')}
      ariaLabel={t('settings.title')}
      size="md"
    >
      <ModalBody>
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('settings.section.generation')}</h3>
          <form
            id="settings-generation-form"
            className={styles.form}
            onSubmit={(e) => void handleSave(e)}
          >
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.field.temperature')}</span>
              <input
                type="number"
                step="0.05"
                min={0}
                max={2}
                value={temperature}
                onChange={(e) => {
                  setTemperature(e.target.value);
                }}
                className={styles.input}
                disabled={saving}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.field.topP')}</span>
              <input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={topP}
                onChange={(e) => {
                  setTopP(e.target.value);
                }}
                className={styles.input}
                disabled={saving}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.field.repeatPenalty')}</span>
              <input
                type="number"
                step="0.05"
                min={0}
                max={2}
                value={repeatPenalty}
                onChange={(e) => {
                  setRepeatPenalty(e.target.value);
                }}
                className={styles.input}
                disabled={saving}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.field.maxTokens')}</span>
              <input
                type="number"
                step="1"
                min={1}
                max={1_000_000}
                value={maxTokens}
                onChange={(e) => {
                  setMaxTokens(e.target.value);
                }}
                className={styles.input}
                disabled={saving}
              />
            </label>
          </form>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('settings.section.provider')}</h3>
          <dl className={styles.kv}>
            <dt>{t('settings.kv.backend')}</dt>
            <dd>{activeBackend ?? '—'}</dd>
            <dt>{t('settings.kv.baseUrl')}</dt>
            <dd className={styles.mono}>{baseUrl ?? '—'}</dd>
            <dt>{t('settings.kv.model')}</dt>
            <dd className={styles.mono}>{currentModel ?? '—'}</dd>
          </dl>
          <p className={styles.hint}>
            {t('settings.providerHint')}
          </p>
        </section>

        {/* SETTINGS-BUTTON-WIRE-SECTION */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('hooks.title')}</h3>
          <p className={styles.hint}>{t('hooks.intro')}</p>
          <div>
            <button
              type="button"
              className={styles.btnSecondary}
              data-testid="settings-manage-hooks"
              onClick={() => {
                openOverlay({ kind: 'hooks' });
              }}
            >
              {t('hooks.manage')}
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('memory.section.settings')}</h3>
          <p className={styles.hint}>{t('memory.intro')}</p>
          <div>
            <button
              type="button"
              className={styles.btnSecondary}
              data-testid="settings-manage-memory"
              onClick={() => {
                openOverlay({ kind: 'memory' });
              }}
            >
              {t('memory.manage')}
            </button>
          </div>
        </section>
        {/* /SETTINGS-BUTTON-WIRE-SECTION */}

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('settings.section.commands')}</h3>
          <ul className={styles.cmds}>
            {SLASH_COMMANDS.map((c) => (
              <li key={c.name}>
                <code className={styles.cmd}>{c.name}</code>
                <span className={styles.cmdDesc}>{c.desc}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('settings.section.shortcuts')}</h3>
          <ul className={styles.cmds}>
            {KEYBOARD_SHORTCUTS.map((s) => (
              <li key={s.keys}>
                <code className={styles.cmd}>{s.keys}</code>
                <span className={styles.cmdDesc}>{t(s.descKey)}</span>
              </li>
            ))}
          </ul>
        </section>
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={onClose}
          disabled={saving}
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          form="settings-generation-form"
          className={styles.btnPrimary}
          disabled={saving}
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </ModalFooter>
    </Modal>
  );
}
