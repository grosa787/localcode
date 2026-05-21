/**
 * OverlayHost — single mount point for every modal-style overlay.
 *
 * Reads `state.activeOverlay` from the store and renders at most one
 * overlay component at a time. Replaces the previous "scatter open
 * booleans across App.tsx" pattern (which let overlays stack on each
 * other when a user clicked multiple top-right icons in sequence).
 *
 * The dispatcher only knows how to render overlays — opening one is
 * still the caller's responsibility via the store's `openOverlay()` /
 * legacy `openX` actions, both of which set `activeOverlay` and close
 * any peer overlay in the same `set()` call.
 *
 * Some overlays require parent-supplied callbacks (e.g. `setProvider`
 * for `BackendServerOverlay`, `onSave` for `AgentSettingsOverlay`).
 * Those props are passed in via `OverlayHostProps` so the host stays
 * the single render site.
 */

import type { JSX } from 'react';

import type { RestClient } from '../api/rest-client';
import type {
  AgentsConfigSnapshot,
  PerProviderConfig,
} from '../../../src/web/protocol/rest-types.js';
import { useStore, type OpenOverlay } from '../state/store';

import { AddProjectDialog } from './AddProjectDialog';
import { AddSkillDialog } from './AddSkillDialog';
import { AgentSettingsOverlay } from './AgentSettingsOverlay';
import { BackendServerOverlay } from './BackendServerOverlay';
import { HookSettingsOverlay, type HookSummary } from './HookSettingsOverlay';
import { MemoryOverlay } from './MemoryOverlay';
import { PluginsOverlay } from './PluginsOverlay';
import { SessionSearchOverlay } from './SessionSearchOverlay';
import { SettingsOverlay } from './SettingsOverlay';
import { SkillsOverlay } from './SkillsOverlay';
import { SlashCommandsOverlay } from './SlashCommandsOverlay';
import { UsageDashboard } from './UsageDashboard';

interface GenerationParams {
  temperature: number;
  topP: number;
  repeatPenalty: number;
  maxTokens: number;
}

export interface OverlayHostProps {
  /** The currently active overlay descriptor from the store. */
  activeOverlay: OpenOverlay;
  /** Bound REST setter used by BackendServerOverlay. */
  setProvider?: RestClient['setProvider'];
  /** Bound REST refresher used by BackendServerOverlay. */
  refreshProvidersConfig?: () => Promise<void>;
  /** Bound REST saver used by AgentSettingsOverlay. */
  saveAgentsConfig?: (snap: AgentsConfigSnapshot) => Promise<AgentsConfigSnapshot>;
  /** Bound REST callback to add a project — supplied by App.tsx. */
  onAddProject?: (req: { root: string; label?: string }) => Promise<void>;
  /** Generation params snapshot fed into SettingsOverlay. */
  generation?: GenerationParams | null;
  /** Optional onSaved callback after SettingsOverlay persists. */
  onGenerationSaved?: (gen: GenerationParams) => void;
  /** Fallback PerProviderConfig surface so the overlay seeds with data. */
  providersConfig?: PerProviderConfig | null;
  /**
   * Hook summary list passed down to `<HookSettingsOverlay>`. Fetched by
   * the parent via `RestClient.listHooks()` so the host stays stateless.
   * Empty array is fine — the overlay shows a "no hooks configured" hint.
   */
  hooksData?: readonly HookSummary[];
}

/**
 * Dispatches to the right overlay component based on `activeOverlay`.
 * Returns `null` when `kind === 'none'` (and for kinds that don't map
 * to an existing modal-style overlay yet).
 */
export function OverlayHost(props: OverlayHostProps): JSX.Element | null {
  const closeOverlay = useStore((s) => s.closeOverlay);
  const closeAddProject = useStore((s) => s.closeAddProject);

  switch (props.activeOverlay.kind) {
    case 'none':
      return null;

    case 'settings':
      return (
        <SettingsOverlay
          generation={props.generation ?? null}
          onClose={closeOverlay}
          {...(props.onGenerationSaved !== undefined
            ? { onSaved: props.onGenerationSaved }
            : {})}
        />
      );

    case 'usage':
      return <UsageDashboard />;

    case 'agents-config':
      if (props.saveAgentsConfig === undefined) return null;
      return <AgentSettingsOverlay onSave={props.saveAgentsConfig} />;

    case 'memory':
      return <MemoryOverlay />;

    case 'hooks':
      return (
        <HookSettingsOverlay
          open={true}
          hooks={props.hooksData ?? []}
          onClose={closeOverlay}
        />
      );

    case 'plugins':
      return <PluginsOverlay />;

    case 'skills':
      return <SkillsOverlay />;

    case 'backend-server':
      if (props.setProvider === undefined || props.refreshProvidersConfig === undefined) {
        return null;
      }
      return (
        <BackendServerOverlay
          onSave={props.setProvider}
          onRefresh={props.refreshProvidersConfig}
        />
      );

    case 'session-search':
      return <SessionSearchOverlay />;

    case 'slash-commands':
      return <SlashCommandsOverlay />;

    case 'add-skill':
      return <AddSkillDialog />;

    case 'add-project':
      if (props.onAddProject === undefined) return null;
      return (
        <AddProjectDialog
          onCancel={closeAddProject}
          onSubmit={props.onAddProject}
        />
      );

    // The following kinds do NOT currently map to a modal-style overlay
    // (they live in side panels / right dock — see RightDock /
    // BrowserPanel / TasksPanel). Returning null keeps the union
    // exhaustive without forcing UI changes that aren't part of this
    // refactor batch.
    case 'notifications':
    case 'cost':
    case 'tasks':
    case 'browser':
    case 'files':
    case 'profile':
    case 'style':
    case 'wakeups':
      return null;
  }
}
