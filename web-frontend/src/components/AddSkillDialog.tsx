/**
 * AddSkillDialog — minimal modal for creating a new skill markdown file.
 *
 * Posts to `/api/skills` with a chosen scope (project | global).
 * On success, refreshes the skills list and closes.
 *
 * Modal chrome (backdrop / ESC / focus trap / scroll lock) is provided
 * by the shared `<Modal>` primitive.
 */
import { useState, type FormEvent, type JSX } from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { BookOpen } from '../icons';
import { useStore, type SkillSummary } from '../state/store';
import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './AddSkillDialog.module.css';

type Scope = 'project' | 'global';

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function AddSkillDialog(): JSX.Element {
  const t = useT();
  const closeAddSkill = useStore((s) => s.closeAddSkill);
  const setSkills = useStore((s) => s.setSkills);
  const pushToast = useStore((s) => s.pushToast);
  const activeProjectId = useStore((s) => s.activeProjectId);

  const clients = useApiClients();

  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<Scope>(
    activeProjectId !== null ? 'project' : 'global',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);

    const trimmedId = id.trim();
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();

    if (!ID_RE.test(trimmedId)) {
      setError(t('addSkill.error.idFormat'));
      return;
    }
    if (trimmedTitle.length === 0) {
      setError(t('addSkill.error.titleRequired'));
      return;
    }
    if (trimmedBody.length === 0) {
      setError(t('addSkill.error.bodyRequired'));
      return;
    }
    if (scope === 'project' && activeProjectId === null) {
      setError(t('addSkill.error.noProject'));
      return;
    }

    setSubmitting(true);
    try {
      const req = {
        id: trimmedId,
        title: trimmedTitle,
        body: trimmedBody,
        scope,
        ...(description.trim().length > 0
          ? { description: description.trim() }
          : {}),
      };
      await clients.rest.addSkill(req, activeProjectId ?? undefined);

      // Refresh list.
      try {
        const res = await clients.rest.listSkills(
          activeProjectId ?? undefined,
        );
        const list: SkillSummary[] = res.skills;
        setSkills(list);
      } catch {
        // Non-fatal.
      }

      pushToast({ level: 'success', message: t('addSkill.created', { id: trimmedId }) });
      closeAddSkill();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={true}
      onClose={closeAddSkill}
      title={t('addSkill.title')}
      ariaLabel={t('addSkill.title')}
      icon={<BookOpen size={16} strokeWidth={1.5} />}
      size="md"
      disableBackdropClose={submitting}
      disableEscapeClose={submitting}
    >
      <form id="add-skill-form" onSubmit={(e) => void handleSubmit(e)}>
        <ModalBody>
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>{t('addSkill.id')}</span>
              <input
                className={styles.input}
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value.toLowerCase())}
                placeholder={t('addSkill.placeholder.id')}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                required
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('addSkill.name')}</span>
              <input
                className={styles.input}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('addSkill.placeholder.title')}
                required
              />
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.label}>{t('addSkill.description')}</span>
            <input
              className={styles.input}
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('addSkill.placeholder.description')}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t('addSkill.body')}</span>
            <textarea
              className={styles.textarea}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('addSkill.placeholder.body')}
              rows={10}
              required
            />
          </label>

          <div className={styles.field}>
            <span className={styles.label}>{t('addSkill.scope')}</span>
            <div className={styles.scope} role="radiogroup">
              <label
                className={styles.scopeOption}
                data-on={scope === 'global' ? 'true' : 'false'}
              >
                <input
                  type="radio"
                  name="scope"
                  value="global"
                  checked={scope === 'global'}
                  onChange={() => setScope('global')}
                />
                {t('addSkill.scope.global')}
              </label>
              <label
                className={styles.scopeOption}
                data-on={scope === 'project' ? 'true' : 'false'}
              >
                <input
                  type="radio"
                  name="scope"
                  value="project"
                  checked={scope === 'project'}
                  onChange={() => setScope('project')}
                  disabled={activeProjectId === null}
                />
                {t('addSkill.scope.project')}
              </label>
            </div>
          </div>

          {error !== null ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </ModalBody>

        <ModalFooter>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={closeAddSkill}
            disabled={submitting}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className={styles.btnPrimary}
            disabled={submitting}
          >
            {submitting ? t('addSkill.saving') : t('addSkill.save')}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
