/**
 * HookSettingsOverlay — read-only viewer for settings-driven hooks.
 *
 * Hooks are user-authored shell commands wired into 4 trigger points.
 * v1 is intentionally read-only: editing hooks via UI risks
 * miscommunicating the security implications of executing shell
 * commands, so we point the user at `~/.localcode/config.toml`.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import { Modal, ModalBody, ModalFooter } from './Modal';
import styles from './HookSettingsOverlay.module.css';

export interface HookSummary {
  trigger: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart';
  toolPattern?: string;
  command: string;
  timeout?: number;
  blocking?: boolean;
  description?: string;
}

export interface HookSettingsOverlayProps {
  open: boolean;
  hooks: readonly HookSummary[];
  onClose: () => void;
}

const TRIGGER_ORDER: ReadonlyArray<HookSummary['trigger']> = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
];

const EXAMPLE = `[[hooks]]
trigger = "PreToolUse"
toolPattern = "write_file"
command = "prettier --check \${TOOL_ARG_path}"
blocking = true
description = "Format check before writes"

[[hooks]]
trigger = "SessionStart"
command = "echo 'session started' >> ~/.localcode/last-session.log"
blocking = false`;

export function HookSettingsOverlay({
  open,
  hooks,
  onClose,
}: HookSettingsOverlayProps): JSX.Element | null {
  const t = useT();
  if (!open) return null;

  const grouped = new Map<HookSummary['trigger'], HookSummary[]>();
  for (const h of hooks) {
    const bucket = grouped.get(h.trigger) ?? [];
    bucket.push(h);
    grouped.set(h.trigger, bucket);
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={t('hooks.title')}
      subtitle={t('hooks.subtitle')}
      ariaLabel={t('hooks.title')}
      size="lg"
    >
      <ModalBody className={styles.body}>
        <p className={styles.intro}>{t('hooks.intro')}</p>

        {hooks.length === 0 ? (
          <p className={styles.empty}>{t('hooks.empty')}</p>
        ) : (
          TRIGGER_ORDER.map((trig) => {
            const list = grouped.get(trig) ?? [];
            if (list.length === 0) return null;
            return (
              <section key={trig} className={styles.group}>
                <h3 className={styles.groupTitle}>{trig}</h3>
                <ul className={styles.list}>
                  {list.map((h, idx) => (
                    <li key={`${trig}-${idx}`} className={styles.row}>
                      <div className={styles.rowHead}>
                        <span
                          className={`${styles.badge} ${
                            h.blocking === true
                              ? styles.badgeBlocking
                              : styles.badgeNonBlocking
                          }`}
                        >
                          {h.blocking === true
                            ? t('hooks.blocking')
                            : t('hooks.nonBlocking')}
                        </span>
                        {h.toolPattern !== undefined ? (
                          <span className={styles.pattern}>
                            {h.toolPattern}
                          </span>
                        ) : null}
                        {h.timeout !== undefined ? (
                          <span className={styles.timeout}>
                            {Math.round(h.timeout / 1000)}s
                          </span>
                        ) : null}
                      </div>
                      <code className={styles.command}>{h.command}</code>
                      {h.description !== undefined &&
                      h.description.length > 0 ? (
                        <span className={styles.description}>
                          {h.description}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}

        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t('hooks.editHint.title')}</h3>
          <p className={styles.hint}>{t('hooks.editHint.body')}</p>
          <pre className={styles.example}>{EXAMPLE}</pre>
        </section>
      </ModalBody>

      <ModalFooter>
        <button type="button" onClick={onClose}>
          {t('common.close')}
        </button>
      </ModalFooter>
    </Modal>
  );
}
