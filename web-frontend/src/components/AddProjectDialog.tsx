/**
 * AddProjectDialog — modal for opening a project folder.
 *
 * The user pastes/types any absolute filesystem path; LocalCode runs
 * locally with full FS access so this is the natural entry point. A
 * "Browse…" button shells out to the native OS folder dialog via
 * `POST /api/pick-folder`, which spawns `osascript` (or zenity /
 * kdialog / PowerShell) on the user's own machine — works equally
 * well in Safari, Chrome, and Firefox because the dialog appears on
 * the desktop, not inside the browser.
 *
 * Inputs: absolute path (required, must start with `/`; `~` is
 * expanded client-side using the home-dir hint already in the store).
 *
 * Modal chrome (backdrop / ESC / focus trap / scroll lock) is provided
 * by the shared `<Modal>` primitive.
 */

import { useRef, useState, type FormEvent, type JSX } from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { FolderPlus, FolderSearch } from '../icons';
import { useStore } from '../state/store';
import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './AddProjectDialog.module.css';

export interface AddProjectDialogProps {
  onCancel: () => void;
  onSubmit: (req: { root: string; label?: string }) => Promise<void> | void;
}

export function AddProjectDialog({
  onCancel,
  onSubmit,
}: AddProjectDialogProps): JSX.Element {
  const t = useT();
  const [root, setRoot] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);

  const clients = useApiClients();
  const pushToast = useStore((s) => s.pushToast);

  const placeholder = t('addProject.placeholder.path');

  const handleBrowse = async (): Promise<void> => {
    if (browsing) return;
    setBrowsing(true);
    setError(null);
    try {
      const res = await clients.rest.pickFolder({
        prompt: t('addProject.pickPrompt'),
      });
      if (res.platform === 'unsupported') {
        pushToast({
          level: 'info',
          message: t('addProject.unsupported'),
        });
        return;
      }
      if (res.cancelled || res.path === null) {
        // Silent — user dismissed the dialog.
        return;
      }
      setRoot(res.path);
      // Defer focus so React commits the value first.
      setTimeout(() => submitRef.current?.focus(), 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast({
        level: 'error',
        message: t('addProject.pickerFailed', { message }),
      });
    } finally {
      setBrowsing(false);
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmedLabel = label.trim();
    const expanded = root.trim();
    if (expanded.length === 0) {
      setError(t('addProject.error.required'));
      return;
    }
    if (!expanded.startsWith('/')) {
      setError(t('addProject.error.absolute'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const req: { root: string; label?: string } = { root: expanded };
      if (trimmedLabel.length > 0) req.label = trimmedLabel;
      await onSubmit(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={true}
      onClose={onCancel}
      title={t('addProject.title')}
      ariaLabel={t('addProject.title')}
      icon={<FolderPlus size={16} strokeWidth={1.5} />}
      size="md"
      disableBackdropClose={submitting}
      disableEscapeClose={submitting}
    >
      <form id="add-project-form" onSubmit={(e) => void handleSubmit(e)}>
        <ModalBody>
          <div className={styles.field}>
            <label htmlFor="add-project-root" className={styles.label}>
              {t('addProject.path')}
            </label>
            <div className={styles.pathRow}>
              <input
                id="add-project-root"
                type="text"
                className={styles.input}
                placeholder={placeholder}
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                required
              />
              <button
                type="button"
                className={styles.browseBtn}
                onClick={() => void handleBrowse()}
                disabled={browsing || submitting}
                aria-label={t('addProject.browse.aria')}
              >
                <FolderSearch size={14} strokeWidth={1.5} aria-hidden="true" />
                <span>{browsing ? t('addProject.browsing') : t('addProject.browse')}</span>
              </button>
            </div>
            <span className={styles.hint}>
              {t('addProject.hint')}
            </span>
          </div>
          <label className={styles.field}>
            <span className={styles.label}>{t('addProject.label')}</span>
            <input
              type="text"
              className={styles.input}
              placeholder={t('addProject.placeholder.label')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>

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
            onClick={onCancel}
            disabled={submitting}
          >
            {t('common.cancel')}
          </button>
          <button
            ref={submitRef}
            type="submit"
            className={styles.btnPrimary}
            disabled={submitting}
          >
            {submitting ? t('addProject.opening') : t('addProject.open')}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
