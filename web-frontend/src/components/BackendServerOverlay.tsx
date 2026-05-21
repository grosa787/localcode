/**
 * BackendServerOverlay — modal editor for per-provider backend config.
 *
 * Lets the user edit `baseUrl` / `apiKey` / `customHeaders` for any of
 * the seven supported backends without dropping into the terminal.
 * Persists via the existing `POST /api/config/provider`. The "Save"
 * button updates the chosen provider's stored values; "Save & switch"
 * additionally makes that provider active. "Test connection" reuses
 * the same endpoint (which probes `getModels()` server-side) and
 * reports success / failure inline.
 *
 * The form uses a single React-state-resident draft per backend type,
 * so flipping between provider tabs preserves in-progress edits until
 * the dialog closes.
 *
 * Modal chrome (backdrop / ESC / focus trap / scroll lock) is provided
 * by the shared `<Modal>` primitive.
 */

import type { JSX, FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { Backend } from '../../../src/web/protocol/messages.js';
import type {
  PerProviderEntry,
  SetProviderRequest,
  SetProviderResponse,
} from '../../../src/web/protocol/rest-types.js';

import { useT } from '../i18n';
import { Eye, EyeOff, X } from '../icons';
import { useStore } from '../state/store';
import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './BackendServerOverlay.module.css';

const TYPES: readonly Backend[] = [
  'ollama',
  'lmstudio',
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'custom',
];

const DISPLAY: Record<Backend, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  google: 'Gemini',
  custom: 'Custom',
};

const PLACEHOLDERS: Record<Backend, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  custom: 'https://your-gateway.example.com/v1',
};

/** Local providers don't need an API key. */
const LOCAL: ReadonlySet<Backend> = new Set(['ollama', 'lmstudio']);

/** Per-backend draft state edited by the user. */
interface Draft {
  baseUrl: string;
  apiKey: string;
  headers: Array<{ k: string; v: string }>;
  showKey: boolean;
}

function entryToDraft(e: PerProviderEntry | undefined): Draft {
  // Audit M4 — the server never returns the literal apiKey, only the
  // `hasApiKey` flag. The input is always seeded empty; submitting a
  // blank value preserves the existing key server-side (see write path
  // in `buildRequest`).
  if (e === undefined) {
    return { baseUrl: '', apiKey: '', headers: [], showKey: false };
  }
  const headers = e.customHeaders
    ? Object.entries(e.customHeaders).map(([k, v]) => ({ k, v }))
    : [];
  return {
    baseUrl: e.baseUrl,
    apiKey: '',
    headers,
    showKey: false,
  };
}

export interface BackendServerOverlayProps {
  /**
   * Calls `POST /api/config/provider`. The host owns the network call
   * so tests can stub deterministically.
   */
  onSave: (req: SetProviderRequest) => Promise<SetProviderResponse>;
  /** Refresh the providersConfig snapshot in the store after a save. */
  onRefresh: () => Promise<void>;
}

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; modelCount: number }
  | { kind: 'err'; message: string };

export function BackendServerOverlay({
  onSave,
  onRefresh,
}: BackendServerOverlayProps): JSX.Element {
  const t = useT();
  const close = useStore((s) => s.closeBackendServer);
  const providersConfig = useStore((s) => s.providersConfig);
  const activeBackend = useStore((s) => s.activeBackend);
  const pushToast = useStore((s) => s.pushToast);

  const initialType: Backend = providersConfig?.current ?? activeBackend ?? 'ollama';
  const [selected, setSelected] = useState<Backend>(initialType);

  // Per-type drafts keyed by backend.
  const [drafts, setDrafts] = useState<Record<Backend, Draft>>(() => {
    const init = {} as Record<Backend, Draft>;
    for (const t of TYPES) {
      init[t] = entryToDraft(providersConfig?.byType[t]);
    }
    return init;
  });

  // Re-seed drafts whenever the source config arrives (overlay can open
  // before bootstrap finishes).
  useEffect(() => {
    if (providersConfig === null) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const t of TYPES) {
        const cur = prev[t];
        if (cur.baseUrl === '' && cur.apiKey === '' && cur.headers.length === 0) {
          next[t] = entryToDraft(providersConfig.byType[t]);
        }
      }
      return next;
    });
  }, [providersConfig]);

  const [saving, setSaving] = useState<boolean>(false);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);

  const draft = drafts[selected];

  const updateDraft = (patch: Partial<Draft>): void => {
    setDrafts((prev) => ({ ...prev, [selected]: { ...prev[selected], ...patch } }));
    setTestStatus({ kind: 'idle' });
  };

  const dotClassFor = (t: Backend): string => {
    const e = providersConfig?.byType[t];
    if (e === undefined) return styles.dotGray ?? '';
    // Audit M4 — `hasApiKey` replaces the literal key check.
    const ok = LOCAL.has(t) ? e.baseUrl.length > 0 : e.baseUrl.length > 0 && e.hasApiKey;
    if (!ok) return styles.dotGray ?? '';
    if (providersConfig?.current === t) return styles.dotGreen ?? '';
    return styles.dotYellow ?? '';
  };

  const buildRequest = (): SetProviderRequest => {
    const req: SetProviderRequest = { type: selected };
    if (draft.baseUrl.length > 0) req.baseUrl = draft.baseUrl;
    if (!LOCAL.has(selected)) {
      // Audit M4 — the server never returns the existing key, so the
      // input always starts blank. Sending a blank string would clear
      // a persisted key, defeating the "leave blank to keep" UX. Only
      // forward `apiKey` when the user actually typed something.
      if (draft.apiKey.length > 0) req.apiKey = draft.apiKey;
    }
    const headerObj: Record<string, string> = {};
    for (const { k, v } of draft.headers) {
      const trimmed = k.trim();
      if (trimmed.length > 0) headerObj[trimmed] = v;
    }
    if (Object.keys(headerObj).length > 0) req.customHeaders = headerObj;
    return req;
  };

  const doSave = async (
    e: FormEvent<HTMLFormElement> | null,
    opts: { switchActive: boolean },
  ): Promise<void> => {
    if (e !== null) e.preventDefault();
    if (saving) return;
    setSaving(true);
    setTestStatus({ kind: 'idle' });
    try {
      const req = buildRequest();
      const prevActive = providersConfig?.current ?? activeBackend;
      const res = await onSave(req);
      if (
        !opts.switchActive &&
        prevActive !== undefined &&
        prevActive !== null &&
        prevActive !== selected
      ) {
        try {
          await onSave({ type: prevActive });
        } catch {
          /* non-fatal */
        }
      }
      await onRefresh();
      pushToast({
        level: 'success',
        message: opts.switchActive
          ? t('backend.toast.savedSwitched', {
              name: DISPLAY[selected],
              count: res.models.length,
            })
          : t('backend.toast.saved', { name: DISPLAY[selected] }),
      });
      close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast({
        level: 'error',
        message: t('backend.toast.saveFailed', { message }),
      });
      setSaving(false);
    }
  };

  const doTest = async (): Promise<void> => {
    if (saving) return;
    setTestStatus({ kind: 'running' });
    try {
      const req = buildRequest();
      const prevActive = providersConfig?.current ?? activeBackend;
      const res = await onSave(req);
      if (
        prevActive !== undefined &&
        prevActive !== null &&
        prevActive !== selected
      ) {
        try {
          await onSave({ type: prevActive });
        } catch {
          /* non-fatal */
        }
      }
      await onRefresh();
      setTestStatus({ kind: 'ok', modelCount: res.models.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestStatus({ kind: 'err', message });
    }
  };

  const headerCount = draft.headers.length;
  const showKey = draft.showKey;

  const renderTestStatus = useMemo((): JSX.Element | null => {
    if (testStatus.kind === 'idle') return null;
    if (testStatus.kind === 'running') {
      return (
        <p className={`${styles.testStatus} ${styles.testNeutral}`}>
          {t('backend.test.testing')}
        </p>
      );
    }
    if (testStatus.kind === 'ok') {
      return (
        <p className={`${styles.testStatus} ${styles.testOk}`}>
          {t('backend.test.connected', { count: testStatus.modelCount })}
        </p>
      );
    }
    return (
      <p className={`${styles.testStatus} ${styles.testErr}`}>
        {t('backend.test.failed', { message: testStatus.message })}
      </p>
    );
  }, [testStatus, t]);

  return (
    <Modal
      open={true}
      onClose={close}
      title={t('backend.title')}
      ariaLabel={t('backend.title')}
      size="md"
    >
      <ModalBody>
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('backend.section.provider')}</h3>
          <div className={styles.providers} role="tablist">
            {TYPES.map((t) => {
              const isActive = providersConfig?.current === t;
              const isSelected = selected === t;
              const cls = [
                styles.providerBtn,
                isSelected ? styles.providerBtnActive : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={cls}
                  onClick={() => {
                    setSelected(t);
                    setTestStatus({ kind: 'idle' });
                  }}
                >
                  <span className={`${styles.dot} ${dotClassFor(t)}`} />
                  <span style={isActive ? { fontWeight: 700 } : undefined}>
                    {DISPLAY[t]}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <form
          id="backend-server-form"
          className={styles.form}
          onSubmit={(e) => {
            void doSave(e, { switchActive: false });
          }}
        >
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('backend.field.baseUrl')}</span>
            <input
              type="text"
              className={styles.input}
              placeholder={PLACEHOLDERS[selected]}
              value={draft.baseUrl}
              onChange={(e) => {
                updateDraft({ baseUrl: e.target.value });
              }}
              disabled={saving}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>

          {!LOCAL.has(selected) ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('backend.field.apiKey')}</span>
              <div className={styles.keyRow}>
                <input
                  type={showKey ? 'text' : 'password'}
                  className={styles.input}
                  placeholder={
                    // Audit M4 — `hasApiKey` tells us whether a key is
                    // already persisted; the literal value is never
                    // returned by the server. "(leave blank to keep
                    // current)" is the cue when a key is already set.
                    providersConfig?.byType[selected]?.hasApiKey === true
                      ? t('backend.apiKey.placeholder.set')
                      : t('backend.apiKey.placeholder.empty')
                  }
                  value={draft.apiKey}
                  onChange={(e) => {
                    updateDraft({ apiKey: e.target.value });
                  }}
                  disabled={saving}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => {
                    updateDraft({ showKey: !showKey });
                  }}
                  aria-label={
                    showKey
                      ? t('backend.apiKey.toggleAriaHide')
                      : t('backend.apiKey.toggleAriaShow')
                  }
                  title={
                    showKey ? t('backend.apiKey.hide') : t('backend.apiKey.show')
                  }
                >
                  {showKey ? (
                    <EyeOff size={14} strokeWidth={1.5} />
                  ) : (
                    <Eye size={14} strokeWidth={1.5} />
                  )}
                </button>
              </div>
            </label>
          ) : (
            <p className={styles.helpText}>
              {t('backend.local.noKey')}
            </p>
          )}

          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => {
              setAdvancedOpen((v) => !v);
            }}
          >
            {advancedOpen ? '▾' : '▸'}{' '}
            {headerCount > 0
              ? t('backend.advanced.openCount', { count: headerCount })
              : t('backend.advanced.open')}
          </button>

          {advancedOpen ? (
            <div className={styles.field}>
              <div className={styles.headerRow}>
                <span className={styles.fieldLabel}>{t('backend.advanced.headerName')}</span>
                <span className={styles.fieldLabel}>{t('backend.advanced.headerValue')}</span>
                <span />
              </div>
              {draft.headers.map((h, i) => (
                <div key={i} className={styles.headerRow}>
                  <input
                    type="text"
                    className={styles.input}
                    value={h.k}
                    placeholder="X-Custom-Header"
                    onChange={(e) => {
                      const next = draft.headers.slice();
                      next[i] = { k: e.target.value, v: h.v };
                      updateDraft({ headers: next });
                    }}
                    disabled={saving}
                  />
                  <input
                    type="text"
                    className={styles.input}
                    value={h.v}
                    placeholder="value"
                    onChange={(e) => {
                      const next = draft.headers.slice();
                      next[i] = { k: h.k, v: e.target.value };
                      updateDraft({ headers: next });
                    }}
                    disabled={saving}
                  />
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => {
                      const next = draft.headers.filter((_, j) => j !== i);
                      updateDraft({ headers: next });
                    }}
                    aria-label={t('backend.advanced.removeHeader')}
                  >
                    <X size={12} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => {
                  updateDraft({
                    headers: [...draft.headers, { k: '', v: '' }],
                  });
                }}
                disabled={saving}
              >
                {t('backend.advanced.addHeader')}
              </button>
            </div>
          ) : null}

          {renderTestStatus}
        </form>
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={close}
          disabled={saving}
        >
          {t('backend.action.cancel')}
        </button>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={() => {
            void doTest();
          }}
          disabled={saving || testStatus.kind === 'running'}
        >
          {t('backend.action.test')}
        </button>
        <button
          type="submit"
          form="backend-server-form"
          className={styles.btnSecondary}
          disabled={saving}
        >
          {saving ? t('backend.action.saving') : t('backend.action.save')}
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => {
            void doSave(null, { switchActive: true });
          }}
          disabled={saving}
        >
          {t('backend.action.saveAndSwitch')}
        </button>
      </ModalFooter>
    </Modal>
  );
}
