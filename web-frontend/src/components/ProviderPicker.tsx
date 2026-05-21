/**
 * ProviderPicker — overlay listing the 7 supported providers.
 *
 * Behaviour:
 *   - Each row shows provider icon + display name + status dot.
 *     Status dot:
 *       green  → API key already configured (or local provider).
 *       red    → cloud provider needs API key.
 *   - For cloud providers without a key, an inline "Set API key" input
 *     appears beside the row. Submitting fires `onSwitch({...,apiKey})`.
 *   - Selecting a provider with a key (or any local provider) calls
 *     `onSwitch({type: backend})` immediately.
 *   - On success, updates the zustand store and pushes a success toast.
 *   - Esc closes the picker.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type RefObject,
} from 'react';

import type { Backend } from '../../../src/web/protocol/messages.js';
import type {
  SetProviderRequest,
  SetProviderResponse,
} from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
import { Check, ChevronRight, Cloud, Cpu, Loader2, X } from '../icons';
import { useStore } from '../state/store';

import styles from './ProviderPicker.module.css';

export interface ProviderPickerProps {
  onClose: () => void;
  onSwitch: (req: SetProviderRequest) => Promise<SetProviderResponse>;
  // POPOVER-FLIP-SECTION — the parent ProviderChip resolves a flip-
  // aware placement and forwards it here. Both are optional so the
  // overlay still renders standalone in older callers / tests.
  popoverRef?: RefObject<HTMLDivElement>;
  positionStyle?: CSSProperties;
  // /POPOVER-FLIP-SECTION
}

interface ProviderEntry {
  id: Backend;
  display: string;
  isLocal: boolean;
  /** When true the user must paste an API key to use this provider. */
  needsKey: boolean;
}

const PROVIDERS_ORDER: Backend[] = [
  'ollama',
  'lmstudio',
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'custom',
];

const DISPLAY: Record<Backend, string> = {
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  google: 'Google Gemini',
  custom: 'Custom (OpenAI-compat)',
};

const LOCAL: ReadonlySet<Backend> = new Set(['ollama', 'lmstudio']);

/**
 * We can't read env vars from the browser. The dot is "green" for the
 * currently active backend (the server already configured it) and for
 * any local provider; otherwise we treat it as "needs key".
 */
function buildEntries(active: Backend | null): ProviderEntry[] {
  return PROVIDERS_ORDER.map((id) => {
    const isLocal = LOCAL.has(id);
    const isActive = id === active;
    return {
      id,
      display: DISPLAY[id],
      isLocal,
      needsKey: !isLocal && !isActive,
    };
  });
}

export function ProviderPicker({
  onClose,
  onSwitch,
  popoverRef,
  positionStyle,
}: ProviderPickerProps): JSX.Element {
  const t = useT();
  const active = useStore((s) => s.activeBackend);
  const setProviderInfo = useStore((s) => s.setProviderInfo);
  const pushToast = useStore((s) => s.pushToast);
  const entries = buildEntries(active);

  const [pending, setPending] = useState<Backend | null>(null);
  const [keyEntry, setKeyEntry] = useState<{ backend: Backend; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // POPOVER-FLIP-SECTION — share a single node between the local
  // outside-click handler and the parent's measurement hook.
  const internalRef = useRef<HTMLDivElement>(null);
  const rootRef = popoverRef ?? internalRef;
  // /POPOVER-FLIP-SECTION

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Outside-click to dismiss.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (
        rootRef.current !== null &&
        e.target instanceof Node &&
        !rootRef.current.contains(e.target)
      ) {
        onClose();
      }
    };
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  const doSwitch = useCallback(
    async (req: SetProviderRequest) => {
      setPending(req.type);
      setError(null);
      try {
        const res = await onSwitch(req);
        setProviderInfo({
          backend: res.backend,
          baseUrl: res.baseUrl,
          models: res.models,
          currentModel: res.currentModel,
        });
        pushToast({
          level: 'success',
          message: t('providerPicker.switched', {
            name: DISPLAY[res.backend],
            model: res.currentModel,
          }),
        });
        onClose();
      } catch (e) {
        const msg = e instanceof Error ? e.message : t('providerPicker.failed');
        setError(msg);
        pushToast({ level: 'error', message: msg });
      } finally {
        setPending(null);
      }
    },
    [onSwitch, setProviderInfo, pushToast, onClose, t],
  );

  const onSelect = (entry: ProviderEntry): void => {
    if (entry.needsKey) {
      setKeyEntry({ backend: entry.id, value: '' });
      return;
    }
    void doSwitch({ type: entry.id });
  };

  const onSubmitKey = (): void => {
    if (keyEntry === null || keyEntry.value.trim().length === 0) return;
    void doSwitch({ type: keyEntry.backend, apiKey: keyEntry.value.trim() });
  };

  return (
    <div
      className={styles.root}
      role="dialog"
      aria-label="Select a provider"
      ref={rootRef}
      style={positionStyle}
    >
      <div className={styles.header}>
        <span>{t('providerPicker.title')}</span>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label={t('providerPicker.close')}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <ul className={styles.list} role="listbox">
        {entries.map((e) => {
          const isActive = e.id === active;
          const isPending = pending === e.id;
          const Icon = e.isLocal ? Cpu : Cloud;
          return (
            <li key={e.id} className={styles.item} aria-selected={isActive} role="option">
              <button
                type="button"
                className={styles.row}
                onClick={() => onSelect(e)}
                disabled={pending !== null}
                aria-label={`Select ${e.display}`}
              >
                <span className={styles.providerIcon}>
                  <Icon size={14} strokeWidth={1.5} />
                </span>
                <span className={styles.name}>{e.display}</span>
                <span
                  className={`${styles.dot} ${e.needsKey ? styles.dotRed : styles.dotGreen}`}
                  aria-hidden="true"
                />
                {isActive ? (
                  <Check size={14} strokeWidth={1.5} />
                ) : isPending ? (
                  <Loader2 size={14} strokeWidth={1.5} className={styles.spin} />
                ) : (
                  <ChevronRight size={14} strokeWidth={1.5} />
                )}
              </button>
              {keyEntry !== null && keyEntry.backend === e.id ? (
                <div className={styles.keyRow}>
                  <input
                    type="password"
                    className={styles.keyInput}
                    placeholder={t('providerPicker.pasteKey')}
                    value={keyEntry.value}
                    onChange={(ev) =>
                      setKeyEntry({ backend: e.id, value: ev.target.value })
                    }
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') {
                        ev.preventDefault();
                        onSubmitKey();
                      }
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className={styles.keySubmit}
                    onClick={onSubmitKey}
                    disabled={
                      pending !== null || keyEntry.value.trim().length === 0
                    }
                  >
                    {isPending ? (
                      <Loader2 size={14} strokeWidth={1.5} className={styles.spin} />
                    ) : (
                      t('providerPicker.use')
                    )}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error !== null ? (
        <div className={styles.errorBanner} role="alert">{error}</div>
      ) : null}
    </div>
  );
}
