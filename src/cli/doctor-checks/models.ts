/**
 * Check #6 — Configured `model.current` is in the discovered model list.
 *
 * Pure-config check: we trust the `model.available` cache populated by
 * the most recent pre-mount refresh. When the list is empty we warn
 * (probably first run) rather than fail.
 */

import type { Config } from '@/config/types';
import type { DoctorCheckResult } from './types';

export async function checkModels(
  config: Config | null,
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  if (config === null) {
    return {
      name: 'Models',
      status: 'warn',
      message: 'Skipped — no parsed config.',
      durationMs: Date.now() - startedAt,
    };
  }
  const current = config.model.current;
  const available = config.model.available;
  if (available.length === 0) {
    return {
      name: 'Models',
      status: 'warn',
      message: 'model.available is empty — run LocalCode once to populate.',
      durationMs: Date.now() - startedAt,
    };
  }
  if (current.length === 0) {
    return {
      name: 'Models',
      status: 'warn',
      message: 'No active model selected.',
      durationMs: Date.now() - startedAt,
    };
  }
  if (!available.includes(current)) {
    return {
      name: 'Models',
      status: 'fail',
      message: `Active model "${current}" is not in available list (${available.length} entries).`,
      durationMs: Date.now() - startedAt,
    };
  }
  return {
    name: 'Models',
    status: 'ok',
    message: `Active: ${current} (of ${available.length} available).`,
    durationMs: Date.now() - startedAt,
  };
}
