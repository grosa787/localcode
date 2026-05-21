/**
 * SlashCommandsOverlay — full-screen browser of every registered
 * slash command, with a search filter. Picking a row inserts
 * `/<name> ` into the Composer via `setComposerDraft`.
 *
 * Modal chrome (backdrop / ESC / focus trap / scroll lock) is provided
 * by the shared `<Modal>` primitive.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import { useT } from '../i18n';
import { useStore } from '../state/store';
import { Slash } from '../icons';
import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './SlashCommandsOverlay.module.css';

export function SlashCommandsOverlay(): JSX.Element {
  const t = useT();
  const commands = useStore((s) => s.slashCommands);
  const closeSlashCommands = useStore((s) => s.closeSlashCommands);
  const setComposerDraft = useStore((s) => s.setComposerDraft);

  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
    if (q.length === 0) return sorted;
    return sorted.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [commands, filter]);

  const handlePick = useCallback(
    (name: string) => {
      setComposerDraft(`/${name} `);
      closeSlashCommands();
    },
    [setComposerDraft, closeSlashCommands],
  );

  return (
    <Modal
      open={true}
      onClose={closeSlashCommands}
      title={t('slash.title')}
      ariaLabel={t('slash.title')}
      size="md"
    >
      <ModalBody>
        <div className={styles.searchRow}>
          <input
            ref={inputRef}
            className={styles.search}
            type="text"
            placeholder={t('slash.filter')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t('slash.filter.aria')}
          />
        </div>

        <div className={styles.list} role="list">
          {filtered.length === 0 ? (
            <div className={styles.empty}>{t('slash.empty')}</div>
          ) : (
            filtered.map((cmd) => (
              <button
                type="button"
                key={cmd.name}
                role="listitem"
                className={styles.item}
                onClick={() => handlePick(cmd.name)}
              >
                <span className={styles.itemIcon} aria-hidden="true">
                  <Slash size={14} strokeWidth={1.5} />
                </span>
                <span className={styles.itemBody}>
                  <span className={styles.itemName}>/{cmd.name}</span>
                  <span className={styles.itemDesc}>{cmd.description}</span>
                </span>
                {cmd.usage !== undefined && cmd.usage.length > 0 ? (
                  <span className={styles.itemUsage}>{cmd.usage}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </ModalBody>

      <ModalFooter>
        <span className={styles.footer}>{t('slash.footer')}</span>
      </ModalFooter>
    </Modal>
  );
}
