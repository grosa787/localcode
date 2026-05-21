/**
 * InlineMessageEditor — overlay shown when the user clicks the
 * edit-pencil on an assistant message. Lets them rewrite the message
 * text and submit; submission forks the session at this message via
 * the REST endpoint and the new session becomes active.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import { useT } from '../i18n';

import styles from './InlineMessageEditor.module.css';

export interface InlineMessageEditorProps {
  /** Initial value loaded into the textarea. */
  initialContent: string;
  /** Called when the user clicks Cancel or presses Escape. */
  onCancel: () => void;
  /**
   * Called when the user clicks Save & Continue. The implementation
   * should perform the fork POST and switch sessions; the editor stays
   * in `submitting` state until the promise settles.
   */
  onSave: (editedContent: string) => Promise<void>;
}

export function InlineMessageEditor(
  props: InlineMessageEditorProps,
): JSX.Element {
  const t = useT();
  const [value, setValue] = useState(props.initialContent);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Pull focus + put the caret at the end on mount so the user can
    // start editing without an extra click.
    const el = textareaRef.current;
    if (el === null) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const save = useCallback(async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await props.onSave(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
    // On success the parent unmounts this component (session switches);
    // no need to clear submitting.
  }, [props, value, submitting]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!submitting) props.onCancel();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void save();
      }
    },
    [props, save, submitting],
  );

  const dirty = value !== props.initialContent;

  return (
    <div className={styles.root} role="form" aria-label={t('edit.assistant.aria')}>
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={value}
        onChange={(e) => { setValue(e.target.value); }}
        onKeyDown={onKeyDown}
        disabled={submitting}
        aria-label={t('edit.assistant.aria')}
      />
      {error !== null ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      <div className={styles.actions}>
        <span className={styles.hint}>
          {t('edit.assistant.hint')}
        </span>
        <button
          type="button"
          className={styles.cancel}
          onClick={props.onCancel}
          disabled={submitting}
        >
          {t('edit.assistant.cancel')}
        </button>
        <button
          type="button"
          className={styles.save}
          onClick={() => { void save(); }}
          disabled={submitting || !dirty}
        >
          {submitting
            ? t('edit.assistant.saving')
            : t('edit.assistant.save')}
        </button>
      </div>
    </div>
  );
}
