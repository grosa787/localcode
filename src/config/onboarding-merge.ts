import type { Config } from './types';

/**
 * Overlay an onboarding result onto an existing config.
 *
 * `OnboardingScreen` builds a full `Config` from scratch because the type
 * demands every section, but the flow only ever *decides* three of them:
 * `backend`, `model` and `onboarding`. Everything else it emits is
 * schema-default filler.
 *
 * `--reconfigure` re-runs that flow over an existing install, so writing
 * the onboarding result wholesale silently resets permissions (profile,
 * autoApprove, batchApprovalThreshold), context, generation, sound,
 * outputStyle and locale to defaults — `ConfigManager.write` preserves
 * only keys ABSENT from the payload, and every known section is present.
 *
 * `base === null` means a genuine first run (nothing on disk, nothing in
 * memory): the onboarding result is then the whole truth.
 */
export function mergeOnboardingResult(
  base: Config | null,
  onboarded: Config,
): Config {
  if (base === null) return onboarded;
  return {
    ...base,
    backend: onboarded.backend,
    model: onboarded.model,
    onboarding: onboarded.onboarding,
    // Onboarding never asks for a locale today, but honour it if a future
    // step does rather than pinning the user to the persisted value.
    ...(onboarded.locale !== undefined ? { locale: onboarded.locale } : {}),
  };
}
