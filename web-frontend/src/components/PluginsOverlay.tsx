/**
 * PluginsOverlay — read-only listing of installed plugins.
 *
 * Modal chrome (backdrop / ESC / focus trap / scroll lock) is provided
 * by the shared `<Modal>` primitive.
 */
import { useEffect, type JSX } from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { Puzzle } from '../icons';
import { useStore } from '../state/store';
import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './PluginsOverlay.module.css';

export function PluginsOverlay(): JSX.Element {
  const t = useT();
  const plugins = useStore((s) => s.plugins);
  const setPlugins = useStore((s) => s.setPlugins);
  const closePluginsOverlay = useStore((s) => s.closePluginsOverlay);
  const activeProjectId = useStore((s) => s.activeProjectId);

  const clients = useApiClients();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const projectId = activeProjectId ?? undefined;
        const res = await clients.rest.listPlugins(projectId);
        if (!cancelled) setPlugins(res.plugins);
      } catch {
        // Non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, activeProjectId, setPlugins]);

  return (
    <Modal
      open={true}
      onClose={closePluginsOverlay}
      title={t('plugins.title')}
      ariaLabel={t('plugins.title')}
      icon={<Puzzle size={16} strokeWidth={1.5} />}
      size="md"
    >
      <ModalBody>
        <div className={styles.list} role="list">
          {plugins.length === 0 ? (
            <div className={styles.empty}>
              <span>{t('plugins.empty')}</span>
              <span className={styles.emptyHint}>
                {t('plugins.empty.hint')}
              </span>
            </div>
          ) : (
            plugins.map((p) => {
              const dotClass =
                p.status === 'loaded'
                  ? styles.statusLoaded
                  : p.status === 'failed'
                    ? styles.statusFailed
                    : styles.statusDisabled;
              const badgeClass =
                p.status === 'loaded'
                  ? styles.statusBadgeLoaded
                  : p.status === 'failed'
                    ? styles.statusBadgeFailed
                    : '';
              const toolText =
                p.toolCount === 1
                  ? t('plugins.tools.one')
                  : t('plugins.tools.many', { count: p.toolCount });
              return (
                <div key={p.id} className={styles.item} role="listitem">
                  <span
                    className={`${styles.statusDot} ${dotClass}`}
                    aria-hidden="true"
                  />
                  <div className={styles.body}>
                    <div className={styles.row1}>
                      <span className={styles.name}>{p.name}</span>
                      {p.version !== undefined ? (
                        <span className={styles.version}>v{p.version}</span>
                      ) : null}
                      <span
                        className={`${styles.statusBadge} ${badgeClass}`}
                      >
                        {p.status}
                      </span>
                    </div>
                    {p.description !== undefined ? (
                      <span className={styles.desc}>{p.description}</span>
                    ) : (
                      <span className={styles.desc}>
                        {toolText} · {p.source}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ModalBody>

      <ModalFooter>
        <span className={styles.footer}>{t('plugins.footer')}</span>
      </ModalFooter>
    </Modal>
  );
}
