/**
 * SkillsOverlay — list, search, and toggle user skills.
 * Optimistic toggle with revert + toast on failure.
 *
 * Modal chrome (backdrop / ESC / focus trap / scroll lock) is provided
 * by the shared `<Modal>` primitive.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { Sparkles, ToggleLeft, ToggleRight } from '../icons';
import { useStore } from '../state/store';
import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './SkillsOverlay.module.css';

export function SkillsOverlay(): JSX.Element {
  const t = useT();
  const skills = useStore((s) => s.skills);
  const setSkills = useStore((s) => s.setSkills);
  const toggleSkillLocal = useStore((s) => s.toggleSkillLocal);
  const closeSkillsOverlay = useStore((s) => s.closeSkillsOverlay);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const pushToast = useStore((s) => s.pushToast);

  const clients = useApiClients();
  const inputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');

  // Refresh on open so we always have the latest from disk.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const projectId = activeProjectId ?? undefined;
        const res = await clients.rest.listSkills(projectId);
        if (!cancelled) setSkills(res.skills);
      } catch {
        // Non-fatal: keep stale list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, activeProjectId, setSkills]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    if (q.length === 0) return sorted;
    return sorted.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q),
    );
  }, [skills, filter]);

  const handleToggle = useCallback(
    async (id: string, current: boolean) => {
      // Optimistic flip.
      toggleSkillLocal(id);
      try {
        await clients.rest.toggleSkill(
          id,
          !current,
          activeProjectId ?? undefined,
        );
      } catch (err) {
        // Revert.
        toggleSkillLocal(id);
        const message = err instanceof Error ? err.message : String(err);
        pushToast({
          level: 'error',
          message: `${t('skills.title')}: ${message}`,
        });
      }
    },
    [clients, activeProjectId, toggleSkillLocal, pushToast, t],
  );

  return (
    <Modal
      open={true}
      onClose={closeSkillsOverlay}
      title={t('skills.title')}
      ariaLabel={t('skills.title')}
      icon={<Sparkles size={16} strokeWidth={1.5} />}
      size="md"
    >
      <ModalBody>
        <input
          ref={inputRef}
          className={styles.search}
          type="text"
          placeholder={t('skills.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={t('skills.filter.aria')}
        />

        <div className={styles.list} role="list">
          {filtered.length === 0 ? (
            <div className={styles.empty}>
              {skills.length === 0
                ? t('skills.empty.none')
                : t('skills.empty.filter')}
            </div>
          ) : (
            filtered.map((s) => (
              <div key={s.id} className={styles.item} role="listitem">
                <div className={styles.body}>
                  <div className={styles.row1}>
                    <span className={styles.name}>{s.name}</span>
                    <span
                      className={`${styles.badge} ${
                        s.source === 'project' ? styles.badgeProject : ''
                      }`}
                    >
                      {s.source}
                    </span>
                  </div>
                  {s.description.length > 0 ? (
                    <span className={styles.desc}>{s.description}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={styles.toggle}
                  data-on={s.active ? 'true' : 'false'}
                  aria-label={s.active ? t('skills.deactivate') : t('skills.activate')}
                  aria-pressed={s.active}
                  onClick={() => void handleToggle(s.id, s.active)}
                  title={
                    s.active ? t('skills.tooltip.active') : t('skills.tooltip.inactive')
                  }
                >
                  {s.active ? (
                    <ToggleRight size={22} strokeWidth={1.5} />
                  ) : (
                    <ToggleLeft size={22} strokeWidth={1.5} />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      </ModalBody>

      <ModalFooter>
        <span className={styles.footer}>{t('skills.footer')}</span>
      </ModalFooter>
    </Modal>
  );
}
