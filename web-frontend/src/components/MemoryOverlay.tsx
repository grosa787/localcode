/**
 * MemoryOverlay — read-only (v1) modal listing all project memory entries
 * grouped by type, with a per-entry delete button.
 *
 * Opens from SettingsOverlay's "Memory" section via the store action
 * `openMemoryOverlay`. Fetches entries from `GET /api/memory?projectId=…`.
 */

import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { useStore } from '../state/store';
import { Modal, ModalBody } from './Modal';
import styles from './MemoryOverlay.module.css';

interface MemoryEntryWire {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  body: string;
}

const TYPE_ORDER: MemoryEntryWire['type'][] = ['user', 'feedback', 'project', 'reference'];

export function MemoryOverlay(): JSX.Element {
  const t = useT();
  const closeMemoryOverlay = useStore((s) => s.closeMemoryOverlay);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const { rest } = useApiClients();

  const [entries, setEntries] = useState<MemoryEntryWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    rest
      .listMemory(activeProjectId)
      .then((data) => {
        setEntries(data.entries);
      })
      .catch(() => {
        setError(t('memory.loadFailed'));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [activeProjectId, rest, t]);

  const handleDelete = async (name: string): Promise<void> => {
    if (!activeProjectId || deleting !== null) return;
    setDeleting(name);
    try {
      await rest.deleteMemory(activeProjectId, name);
      setEntries((prev) => prev.filter((e) => e.name !== name));
    } catch {
      setError(t('memory.deleteFailed'));
    } finally {
      setDeleting(null);
    }
  };

  const grouped = new Map<MemoryEntryWire['type'], MemoryEntryWire[]>();
  for (const type of TYPE_ORDER) {
    grouped.set(type, []);
  }
  for (const entry of entries) {
    const bucket = grouped.get(entry.type);
    if (bucket !== undefined) bucket.push(entry);
  }

  return (
    <Modal
      open={true}
      onClose={closeMemoryOverlay}
      title={t('memory.title')}
      ariaLabel={t('memory.title')}
      size="md"
    >
      <ModalBody>
        <p className={styles.intro}>{t('memory.intro')}</p>

        {loading && <p className={styles.state}>Loading…</p>}
        {error !== null && <p className={styles.errorState}>{error}</p>}

        {!loading && !error && entries.length === 0 && (
          <p className={styles.state}>{t('memory.empty')}</p>
        )}

        {!loading && entries.length > 0 && (
          <div className={styles.groups}>
            {TYPE_ORDER.map((type) => {
              const bucket = grouped.get(type);
              if (!bucket || bucket.length === 0) return null;
              return (
                <section key={type} className={styles.group}>
                  <h4 className={styles.groupTitle}>
                    {t(`memory.type.${type}` as Parameters<typeof t>[0])}
                  </h4>
                  <ul className={styles.entryList}>
                    {bucket.map((entry) => (
                      <li key={entry.name} className={styles.entry}>
                        <div className={styles.entryMeta}>
                          <span className={styles.entryName}>{entry.name}</span>
                          <span className={styles.entryDesc}>{entry.description}</span>
                        </div>
                        <button
                          type="button"
                          className={styles.deleteBtn}
                          aria-label={t('memory.deleteAria').replace('{name}', entry.name)}
                          disabled={deleting === entry.name}
                          onClick={() => void handleDelete(entry.name)}
                        >
                          {t('memory.delete')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </ModalBody>
    </Modal>
  );
}
