/**
 * MemoryEditor — full markdown editor for `<projectRoot>/.localcode/memory/*.md`
 * entries. Mounted as the body of the `memory` tab in the right dock.
 *
 * Layout: 2-column inside the dock panel.
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Entries          [+ New] │  Type [chips]              │
 *   │ ┌─────────────────────┐  │  Name  [_______________]   │
 *   │ │ USER                │  │  Desc  [_______________]   │
 *   │ │  user-prefs   2d ago│  │  Body  [Edit | Preview]    │
 *   │ │  voice-style  3w ago│  │  ┌──────────────────────┐  │
 *   │ │ PROJECT             │  │  │ # Markdown body      │  │
 *   │ │  stack        1m ago│  │  │ goes here…           │  │
 *   │ └─────────────────────┘  │  └──────────────────────┘  │
 *   │                          │  [Delete]  [Cancel][Save] │
 *   └──────────────────────────────────────────────────────┘
 *
 * REST: list/create/update via `useApiClients().rest.{listMemory, writeMemory,
 * deleteMemory}`. `activeProjectId` from the Zustand store keys all calls.
 * The handler treats name as the primary key — POST upserts.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { useStore } from '../state/store';
import { Markdown } from '../util/markdown';
import styles from './MemoryEditor.module.css';

// ---------- Types ----------

type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

interface MemoryEntryWire {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

interface EntryRecord extends MemoryEntryWire {
  /** Client-tracked modification timestamp (set on load / save). */
  updatedAtMs: number;
}

interface DraftState {
  /** Original name of the entry being edited; null for a new entry. */
  originalName: string | null;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

// ---------- Constants ----------

const TYPE_ORDER: readonly MemoryType[] = [
  'user',
  'feedback',
  'project',
  'reference',
];

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const DESC_MAX = 200;
const DESC_WARN = 180;
const BODY_MAX = 50 * 1024;
const BODY_WARN = 40 * 1024;

// ---------- Helpers ----------

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function formatRelative(ms: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.floor(day / 365);
  return `${year}y ago`;
}

function makeBlankDraft(name: string): DraftState {
  return {
    originalName: null,
    name,
    description: '',
    type: 'user',
    body: '',
  };
}

function recordFromWire(entry: MemoryEntryWire, nowMs: number): EntryRecord {
  return { ...entry, updatedAtMs: nowMs };
}

function draftFromRecord(rec: EntryRecord): DraftState {
  return {
    originalName: rec.name,
    name: rec.name,
    description: rec.description,
    type: rec.type,
    body: rec.body,
  };
}

interface ValidationResult {
  nameError: string | null;
  descError: string | null;
  descWarn: string | null;
  bodyError: string | null;
  bodyWarn: string | null;
  ok: boolean;
}

function validateDraft(
  d: DraftState,
  t: ReturnType<typeof useT>,
): ValidationResult {
  let nameError: string | null = null;
  if (d.name.length === 0 || !NAME_RE.test(d.name)) {
    nameError = t('memoryEditor.error.nameFormat');
  }
  let descError: string | null = null;
  let descWarn: string | null = null;
  if (d.description.trim().length === 0) {
    descError = t('memoryEditor.error.descriptionRequired');
  } else if (d.description.length > DESC_MAX) {
    descError = t('memoryEditor.error.descriptionTooLong');
  } else if (d.description.length > DESC_WARN) {
    descWarn = t('memoryEditor.warn.descriptionLength');
  }
  let bodyError: string | null = null;
  let bodyWarn: string | null = null;
  const bodyBytes = new TextEncoder().encode(d.body).length;
  if (d.body.trim().length === 0) {
    bodyError = t('memoryEditor.error.bodyRequired');
  } else if (bodyBytes > BODY_MAX) {
    bodyError = t('memoryEditor.error.bodyTooLarge');
  } else if (bodyBytes > BODY_WARN) {
    bodyWarn = t('memoryEditor.warn.bodyLength');
  }
  return {
    nameError,
    descError,
    descWarn,
    bodyError,
    bodyWarn,
    ok: nameError === null && descError === null && bodyError === null,
  };
}

function groupEntries(
  entries: readonly EntryRecord[],
): Map<MemoryType, EntryRecord[]> {
  const grouped = new Map<MemoryType, EntryRecord[]>();
  for (const type of TYPE_ORDER) grouped.set(type, []);
  for (const e of entries) {
    const bucket = grouped.get(e.type);
    if (bucket !== undefined) bucket.push(e);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }
  return grouped;
}

// ---------- Component ----------

export function MemoryEditor(): JSX.Element {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const { rest } = useApiClients();

  const [entries, setEntries] = useState<EntryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Refresh the "Xs ago" labels every 30s. Cheap — only re-renders the list.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Load entries on project change.
  useEffect(() => {
    if (activeProjectId === null) {
      setEntries([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    rest
      .listMemory(activeProjectId)
      .then((data) => {
        if (cancelled) return;
        const now = Date.now();
        setEntries(data.entries.map((e) => recordFromWire(e, now)));
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(t('memory.loadFailed'));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, rest, t]);

  const grouped = useMemo(() => groupEntries(entries), [entries]);

  const validation = useMemo(
    () => (draft ? validateDraft(draft, t) : null),
    [draft, t],
  );

  const dirty = useMemo(() => {
    if (draft === null) return false;
    if (draft.originalName === null) return true;
    const original = entries.find((e) => e.name === draft.originalName);
    if (original === undefined) return true;
    return (
      original.name !== draft.name ||
      original.description !== draft.description ||
      original.type !== draft.type ||
      original.body !== draft.body
    );
  }, [draft, entries]);

  const selectEntry = useCallback(
    (name: string) => {
      const rec = entries.find((e) => e.name === name);
      if (rec === undefined) return;
      setDraft(draftFromRecord(rec));
      setSaveError(null);
      setConfirmDelete(false);
      setShowPreview(false);
    },
    [entries],
  );

  const startNewEntry = useCallback(() => {
    let candidate = 'untitled';
    let n = 1;
    while (entries.some((e) => e.name === candidate)) {
      n += 1;
      candidate = `untitled-${n}`;
    }
    setDraft(makeBlankDraft(candidate));
    setSaveError(null);
    setConfirmDelete(false);
    setShowPreview(false);
  }, [entries]);

  const updateDraft = useCallback(
    <K extends keyof DraftState>(key: K, value: DraftState[K]) => {
      setDraft((prev) => (prev === null ? prev : { ...prev, [key]: value }));
      setSaveError(null);
    },
    [],
  );

  const onCancel = useCallback(() => {
    if (draft === null) return;
    if (draft.originalName === null) {
      setDraft(null);
    } else {
      const rec = entries.find((e) => e.name === draft.originalName);
      if (rec) setDraft(draftFromRecord(rec));
    }
    setSaveError(null);
    setConfirmDelete(false);
  }, [draft, entries]);

  const onSave = useCallback(async () => {
    if (activeProjectId === null || draft === null || validation === null) return;
    if (!validation.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { entry } = await rest.writeMemory(activeProjectId, {
        name: draft.name,
        description: draft.description,
        type: draft.type,
        body: draft.body,
      });
      const now = Date.now();
      setEntries((prev) => {
        // If renaming, drop the old record.
        const filtered = prev.filter(
          (e) =>
            e.name !== entry.name &&
            (draft.originalName === null || e.name !== draft.originalName),
        );
        return [...filtered, recordFromWire(entry, now)];
      });
      setDraft({ ...draftFromRecord(recordFromWire(entry, now)) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(
        msg.includes('exists') || msg.includes('409')
          ? t('memoryEditor.error.duplicate')
          : t('memoryEditor.saveFailed'),
      );
    } finally {
      setSaving(false);
    }
  }, [activeProjectId, draft, rest, t, validation]);

  const onDelete = useCallback(async () => {
    if (
      activeProjectId === null ||
      draft === null ||
      draft.originalName === null
    ) {
      return;
    }
    const targetName = draft.originalName;
    setSaving(true);
    setSaveError(null);
    try {
      await rest.deleteMemory(activeProjectId, targetName);
      setEntries((prev) => prev.filter((e) => e.name !== targetName));
      setDraft(null);
      setConfirmDelete(false);
    } catch {
      setSaveError(t('memory.deleteFailed'));
    } finally {
      setSaving(false);
    }
  }, [activeProjectId, draft, rest, t]);

  const onBodyKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // Tab toggles preview without trapping focus (overrides the
      // textarea's default indent behaviour, which is fine for memory
      // entries — they don't need leading tabs).
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowPreview((v) => !v);
      }
    },
    [],
  );

  // ---------- Render ----------

  if (activeProjectId === null) {
    return (
      <div className={styles.root} data-testid="memory-editor">
        <div className={styles.emptyState}>
          <p className={styles.emptyHint}>{t('memoryEditor.selectHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="memory-editor">
      <aside
        className={styles.listColumn}
        aria-label={t('memoryEditor.listAria')}
      >
        <div className={styles.listHeader}>
          <h4 className={styles.listTitle}>{t('memoryEditor.title')}</h4>
          <button
            type="button"
            className={styles.newBtn}
            onClick={startNewEntry}
            data-testid="memory-editor-new"
          >
            + {t('memoryEditor.newEntry')}
          </button>
        </div>
        <div className={styles.listScroller}>
          {loading ? (
            <p className={styles.listEmpty}>Loading…</p>
          ) : loadError !== null ? (
            <p className={`${styles.listEmpty} ${styles.statusError ?? ''}`}>
              {loadError}
            </p>
          ) : entries.length === 0 ? (
            <p className={styles.listEmpty}>{t('memoryEditor.empty')}</p>
          ) : (
            TYPE_ORDER.map((type) => {
              const bucket = grouped.get(type) ?? [];
              if (bucket.length === 0) return null;
              return (
                <section key={type} className={styles.group}>
                  <h5 className={styles.groupTitle}>
                    {t(`memory.type.${type}` as Parameters<typeof t>[0])}
                  </h5>
                  {bucket.map((entry) => {
                    const isActive =
                      draft !== null &&
                      draft.originalName !== null &&
                      draft.originalName === entry.name;
                    return (
                      <button
                        key={entry.name}
                        type="button"
                        className={`${styles.entryRow ?? ''} ${
                          isActive ? styles.entryRowActive ?? '' : ''
                        }`}
                        onClick={() => selectEntry(entry.name)}
                        data-testid={`memory-editor-row-${entry.name}`}
                      >
                        <span className={styles.entryIcon} aria-hidden="true">
                          •
                        </span>
                        <span className={styles.entryMeta}>
                          <span className={styles.entryName}>{entry.name}</span>
                          <span className={styles.entryTime}>
                            {formatRelative(entry.updatedAtMs, nowMs)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </section>
              );
            })
          )}
        </div>
      </aside>

      <section className={styles.editorColumn}>
        {draft === null ? (
          <div className={styles.emptyState} data-testid="memory-editor-empty">
            <span className={styles.emptyIcon} aria-hidden="true">
              📝
            </span>
            <p className={styles.emptyHint}>
              {entries.length === 0
                ? t('memoryEditor.empty')
                : t('memoryEditor.selectHint')}
            </p>
            <button
              type="button"
              className={styles.emptyAction}
              onClick={startNewEntry}
            >
              + {t('memoryEditor.newEntry')}
            </button>
          </div>
        ) : (
          <form
            className={styles.editorForm}
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
            data-testid="memory-editor-form"
          >
            <div className={styles.fields}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>
                  {t('memoryEditor.field.type')}
                </label>
                <div className={styles.typeRow} role="radiogroup">
                  {TYPE_ORDER.map((type) => {
                    const active = draft.type === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`${styles.typeChip ?? ''} ${
                          active ? styles.typeChipActive ?? '' : ''
                        }`}
                        onClick={() => updateDraft('type', type)}
                        data-testid={`memory-editor-type-${type}`}
                      >
                        {t(`memory.type.${type}` as Parameters<typeof t>[0])}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="memory-editor-name"
                >
                  {t('memoryEditor.field.name')}
                </label>
                <input
                  id="memory-editor-name"
                  type="text"
                  className={`${styles.textInput ?? ''} ${styles.textInputMono ?? ''}`}
                  value={draft.name}
                  onChange={(e) => updateDraft('name', slugify(e.target.value))}
                  placeholder={t('memoryEditor.placeholder.name')}
                  spellCheck={false}
                  data-testid="memory-editor-name"
                />
                {validation?.nameError !== null &&
                validation?.nameError !== undefined ? (
                  <p
                    className={styles.fieldError}
                    data-testid="memory-editor-error-name"
                  >
                    {validation.nameError}
                  </p>
                ) : null}
              </div>

              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="memory-editor-desc"
                >
                  {t('memoryEditor.field.description')}
                </label>
                <input
                  id="memory-editor-desc"
                  type="text"
                  className={styles.textInput}
                  value={draft.description}
                  onChange={(e) => updateDraft('description', e.target.value)}
                  placeholder={t('memoryEditor.placeholder.description')}
                  maxLength={DESC_MAX + 1}
                  data-testid="memory-editor-desc"
                />
                {validation?.descError !== null &&
                validation?.descError !== undefined ? (
                  <p
                    className={styles.fieldError}
                    data-testid="memory-editor-error-desc"
                  >
                    {validation.descError}
                  </p>
                ) : validation?.descWarn !== null &&
                  validation?.descWarn !== undefined ? (
                  <p className={styles.fieldWarn}>{validation.descWarn}</p>
                ) : null}
              </div>
            </div>

            <div className={styles.bodyArea}>
              <div className={styles.bodyHeader}>
                <span className={styles.fieldLabel}>
                  {t('memoryEditor.field.body')}
                </span>
                <button
                  type="button"
                  className={`${styles.bodyToggle ?? ''} ${
                    showPreview ? styles.bodyToggleActive ?? '' : ''
                  }`}
                  aria-label={t('memoryEditor.preview.toggleAria')}
                  aria-pressed={showPreview}
                  onClick={() => setShowPreview((v) => !v)}
                  data-testid="memory-editor-preview-toggle"
                >
                  {showPreview
                    ? t('memoryEditor.edit')
                    : t('memoryEditor.preview')}
                </button>
              </div>
              {showPreview ? (
                <div
                  className={styles.bodyPreview}
                  data-testid="memory-editor-preview"
                >
                  <Markdown source={draft.body} />
                </div>
              ) : (
                <textarea
                  className={styles.bodyTextarea}
                  value={draft.body}
                  onChange={(e) => updateDraft('body', e.target.value)}
                  onKeyDown={onBodyKeyDown}
                  placeholder={t('memoryEditor.placeholder.body')}
                  spellCheck={false}
                  data-testid="memory-editor-body"
                />
              )}
              {validation?.bodyError !== null &&
              validation?.bodyError !== undefined ? (
                <p
                  className={`${styles.fieldError ?? ''}`}
                  style={{ padding: '4px 12px' }}
                  data-testid="memory-editor-error-body"
                >
                  {validation.bodyError}
                </p>
              ) : validation?.bodyWarn !== null &&
                validation?.bodyWarn !== undefined ? (
                <p
                  className={`${styles.fieldWarn ?? ''}`}
                  style={{ padding: '4px 12px' }}
                >
                  {validation.bodyWarn}
                </p>
              ) : null}
            </div>

            <div className={styles.actions}>
              <div className={styles.actionsLeft}>
                {draft.originalName !== null ? (
                  confirmDelete ? (
                    <span className={styles.confirmPrompt}>
                      <span>?</span>
                      <button
                        type="button"
                        className={`${styles.btn ?? ''} ${styles.btnDanger ?? ''}`}
                        onClick={() => void onDelete()}
                        disabled={saving}
                        data-testid="memory-editor-delete-confirm"
                      >
                        {t('memoryEditor.delete')}
                      </button>
                      <button
                        type="button"
                        className={styles.btn}
                        onClick={() => setConfirmDelete(false)}
                        disabled={saving}
                      >
                        {t('memoryEditor.cancel')}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`${styles.btn ?? ''} ${styles.btnDanger ?? ''}`}
                      onClick={() => setConfirmDelete(true)}
                      disabled={saving}
                      data-testid="memory-editor-delete"
                    >
                      {t('memoryEditor.delete')}
                    </button>
                  )
                ) : null}
              </div>
              <div className={styles.actionsRight}>
                {saveError !== null ? (
                  <span
                    className={`${styles.statusText ?? ''} ${styles.statusError ?? ''}`}
                  >
                    {saveError}
                  </span>
                ) : dirty ? (
                  <span className={styles.statusText}>
                    {t('memoryEditor.unsaved')}
                  </span>
                ) : null}
                <button
                  type="button"
                  className={styles.btn}
                  onClick={onCancel}
                  disabled={saving}
                  data-testid="memory-editor-cancel"
                >
                  {t('memoryEditor.cancel')}
                </button>
                <button
                  type="submit"
                  className={`${styles.btn ?? ''} ${styles.btnPrimary ?? ''}`}
                  disabled={
                    saving ||
                    validation === null ||
                    !validation.ok ||
                    (!dirty && draft.originalName !== null)
                  }
                  data-testid="memory-editor-save"
                >
                  {saving ? t('memoryEditor.saving') : t('memoryEditor.save')}
                </button>
              </div>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
