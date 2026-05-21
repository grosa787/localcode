/**
 * Public barrel for the hook engine. Wire-up sites should import from
 * here so the engine internals can evolve without per-file fan-out.
 */

export {
  HookEngine,
  expandPlaceholders,
  shellEscape,
  type HookEngineOptions,
  type SpawnFn,
} from './engine';
export { globToRegex, matchesGlob } from './matchers';
export {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookConfig,
  type HookContext,
  type HookLogger,
  type HookOutcome,
  type HookSessionEndReason,
  type HookTrigger,
  type HookUsageSnapshot,
} from './types';
