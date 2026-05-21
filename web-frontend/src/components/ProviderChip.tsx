/**
 * ProviderChip — pill exposing the active backend (Cloud/Cpu icon).
 * Click opens ProviderPicker overlay, which calls the supplied
 * `onSwitch` (typically wired to `restClient.setProvider`) and lets the
 * caller update the zustand store on success.
 */

import { useRef, useState, type JSX } from 'react';

import type { Backend } from '../../../src/web/protocol/messages.js';
import type { SetProviderRequest, SetProviderResponse } from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
import { ChevronDown, Cloud, Cpu, Server } from '../icons';
import { useStore } from '../state/store';
// POPOVER-FLIP-SECTION
import { usePopoverPosition } from '../util/use-popover-position';
// /POPOVER-FLIP-SECTION

import { ProviderPicker } from './ProviderPicker';

import styles from './ProviderChip.module.css';

export interface ProviderChipProps {
  /**
   * Switch the active provider. The chip surfaces the result via
   * `setProviderInfo` in the store, but the caller owns the network
   * call so tests can stub it deterministically.
   */
  onSwitch: (req: SetProviderRequest) => Promise<SetProviderResponse>;
  disabled?: boolean;
}

const DISPLAY: Record<Backend, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  google: 'Gemini',
  custom: 'Custom',
};

const LOCAL: ReadonlySet<Backend> = new Set(['ollama', 'lmstudio']);

export function ProviderChip({ onSwitch, disabled = false }: ProviderChipProps): JSX.Element {
  const t = useT();
  const backend = useStore((s) => s.activeBackend);
  const openBackendServer = useStore((s) => s.openBackendServer);
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

  const label = backend !== null ? DISPLAY[backend] : t('provider.empty');
  const isLocal = backend !== null && LOCAL.has(backend);
  const Icon = isLocal ? Cpu : Cloud;

  return (
    <div className={styles.wrap}>
      <button
        ref={anchorRef}
        type="button"
        className={styles.chip}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('provider.label', { name: label })}
        data-testid="provider-chip-button"
      >
        <Icon size={14} strokeWidth={1.5} />
        <span className={styles.label}>{label}</span>
        <ChevronDown size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className={styles.cog}
        onClick={openBackendServer}
        disabled={disabled}
        aria-label={t('provider.editServerTip')}
        title={t('provider.editServer')}
      >
        <Server size={14} strokeWidth={1.5} />
      </button>
      {open ? (
        <ProviderPicker
          onClose={() => setOpen(false)}
          onSwitch={onSwitch}
          popoverRef={popoverRef}
          positionStyle={placement.style}
        />
      ) : null}
    </div>
  );
}
