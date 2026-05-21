/**
 * ModelChip — pill button showing the current model. Click opens
 * ModelPicker overlay anchored above the composer.
 *
 * Selection flow:
 *   1. User clicks a row in <ModelPicker>.
 *   2. Picker calls back into the chip with the chosen modelId.
 *   3. Chip optimistically updates the zustand store
 *      (`setProviderInfo` keeps backend/baseUrl/models, swaps currentModel).
 *   4. Chip POSTs `/api/config/model` via the REST client so the server
 *      persists the choice.
 *   5. Picker closes.
 *   6. If the parent supplied an `onSelect` (e.g. ChatView wires it to a
 *      WS `set_model` for the active session) it fires too.
 *   7. On REST failure the previous model is restored and a toast pushed.
 */

import { useCallback, useRef, useState, type JSX } from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { ChevronDown } from '../icons';
import { useStore } from '../state/store';
// POPOVER-FLIP-SECTION
import { usePopoverPosition } from '../util/use-popover-position';
// /POPOVER-FLIP-SECTION

import { ModelPicker } from './ModelPicker';

import styles from './ModelChip.module.css';

export interface ModelChipProps {
  /**
   * Optional extra handler called after a model is selected. The chip
   * already updates the store + POSTs `/api/config/model`; ChatView can
   * pass a handler to also `set_model` over WS for the active session.
   */
  onSelect?: (model: string) => void | Promise<void>;
  disabled?: boolean;
}

export function ModelChip({ onSelect, disabled = false }: ModelChipProps): JSX.Element {
  const t = useT();
  const currentModel = useStore((s) => s.currentModel);
  const models = useStore((s) => s.models);
  const activeBackend = useStore((s) => s.activeBackend);
  const baseUrl = useStore((s) => s.baseUrl);
  const setProviderInfo = useStore((s) => s.setProviderInfo);
  const pushToast = useStore((s) => s.pushToast);
  const { rest } = useApiClients();
  const [open, setOpen] = useState(false);
  // POPOVER-FLIP-SECTION
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const placement = usePopoverPosition({
    anchorRef,
    popoverRef,
    preferredSide: 'top',
    gap: 8,
    open,
  });
  // /POPOVER-FLIP-SECTION

  const label = currentModel !== null && currentModel.length > 0
    ? currentModel
    : t('modelPicker.empty.title');

  const empty = models.length === 0;

  const handleSelect = useCallback(
    (model: string): void => {
      setOpen(false);
      if (model === currentModel) {
        // Still let the parent know if it cares.
        void onSelect?.(model);
        return;
      }
      const previous = currentModel;
      // Optimistic store update so the chip reflects the new model
      // immediately. We need the full provider payload to call
      // `setProviderInfo`; if any field is missing we skip the optimistic
      // update and rely on the server's eventual `provider_changed` push.
      if (activeBackend !== null && baseUrl !== null) {
        setProviderInfo({
          backend: activeBackend,
          baseUrl,
          models,
          currentModel: model,
        });
      }
      void (async () => {
        try {
          await rest.setModel({ model });
          await onSelect?.(model);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pushToast({
            level: 'error',
            message: t('modelPicker.failedToSet', { message }),
          });
          if (previous !== null && activeBackend !== null && baseUrl !== null) {
            setProviderInfo({
              backend: activeBackend,
              baseUrl,
              models,
              currentModel: previous,
            });
          }
        }
      })();
    },
    [
      activeBackend,
      baseUrl,
      currentModel,
      models,
      onSelect,
      pushToast,
      rest,
      setProviderInfo,
      t,
    ],
  );

  return (
    <div className={styles.wrap}>
      <button
        ref={anchorRef}
        type="button"
        className={styles.chip}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || empty}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={empty ? t('modelPicker.tipEmpty') : t('modelPicker.tip', { name: label })}
      >
        <span className={styles.label}>{label}</span>
        <ChevronDown size={14} strokeWidth={1.5} />
      </button>
      {open ? (
        <ModelPicker
          onClose={() => setOpen(false)}
          onSelect={handleSelect}
          popoverRef={popoverRef}
          positionStyle={placement.style}
        />
      ) : null}
    </div>
  );
}
