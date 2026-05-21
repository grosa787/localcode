/**
 * REST handlers for `/api/config/agents`.
 *
 * - `GET`  returns the current `cfg.agents` snapshot together with the
 *          available-models list so the SPA's settings overlay can drive
 *          its model pickers without an extra round-trip.
 * - `POST` validates a fresh snapshot and persists it back into
 *          `~/.localcode/config.toml`. Backward-compat: if the incoming
 *          slot list is non-empty we use the first slot's model as the
 *          legacy `workerModel` default; otherwise we keep whatever was
 *          previously persisted.
 */

import type { AppConfig } from '@/types/global';

import type {
  AgentsConfigSnapshot,
  AgentsWorkerSlotWire,
  GetAgentsConfigResponse,
  SetAgentsConfigResponse,
} from '../protocol/rest-types.js';
import {
  SetAgentsConfigRequestSchema,
} from '../protocol/rest-types.js';
import { jsonError, jsonOk, parseJsonBody } from './http.js';
import type { ApiDeps } from './types.js';

function snapshotFromConfig(cfg: AppConfig): AgentsConfigSnapshot {
  const a = cfg.agents;
  if (a === undefined) {
    return {
      leadModel: null,
      workerSlots: [],
      isolation: 'worktree',
      maxConcurrent: 3,
      approval: 'auto',
      defaultTimeoutSec: 600,
    };
  }
  const slots: AgentsWorkerSlotWire[] =
    a.workerSlots !== undefined && a.workerSlots.length > 0
      ? a.workerSlots.map((s) => {
          const out: AgentsWorkerSlotWire = { model: s.model };
          if (s.skills !== undefined) out.skills = [...s.skills];
          if (s.isolationOverride !== undefined) {
            out.isolationOverride = s.isolationOverride;
          }
          if (s.timeoutSec !== undefined) out.timeoutSec = s.timeoutSec;
          return out;
        })
      : [];
  return {
    leadModel: a.leadModel ?? null,
    workerSlots: slots,
    isolation: a.isolation,
    maxConcurrent: Math.min(8, Math.max(1, a.maxConcurrent)),
    approval: a.approval,
    defaultTimeoutSec: a.defaultTimeoutSec,
  };
}

export async function handleAgentsConfig(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method === 'GET') {
    try {
      const cfg = deps.configManager.read();
      const body: GetAgentsConfigResponse = {
        current: snapshotFromConfig(cfg),
        availableModels: [...cfg.model.available],
      };
      return jsonOk(body);
    } catch (err) {
      return jsonError(
        'config_error',
        err instanceof Error ? err.message : 'Failed to read agents config',
        500,
      );
    }
  }
  if (req.method !== 'POST') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }

  const parsed = await parseJsonBody(req, SetAgentsConfigRequestSchema);
  if (!parsed.ok) return parsed.response;
  const snap = parsed.value;

  try {
    const current = deps.configManager.read();
    const previousWorkerModel =
      current.agents?.workerModel ?? 'deepseek/deepseek-coder';
    // First populated slot is also the legacy `workerModel` default so
    // older orchestrator code paths (which only know about `workerModel`)
    // continue to spawn with a sensible model.
    const firstSlotModel =
      snap.workerSlots.length > 0 && snap.workerSlots[0] !== undefined
        ? snap.workerSlots[0].model
        : previousWorkerModel;

    const nextSlots = snap.workerSlots.map((s) => {
      const out: { model: string; skills?: string[]; isolationOverride?: 'worktree' | 'shared'; timeoutSec?: number } = {
        model: s.model,
      };
      if (s.skills !== undefined && s.skills.length > 0) out.skills = [...s.skills];
      if (s.isolationOverride !== undefined) out.isolationOverride = s.isolationOverride;
      if (s.timeoutSec !== undefined) out.timeoutSec = s.timeoutSec;
      return out;
    });

    // Use full write (not update) so an unset leadModel is actually
    // cleared rather than preserved by deep-merge semantics.
    const nextAgents: NonNullable<AppConfig['agents']> = {
      workerModel: firstSlotModel,
      workerSlots: nextSlots,
      isolation: snap.isolation,
      maxConcurrent: snap.maxConcurrent,
      approval: snap.approval,
      defaultTimeoutSec: snap.defaultTimeoutSec,
    };
    if (snap.leadModel !== null) nextAgents.leadModel = snap.leadModel;
    const nextCfg: AppConfig = { ...current, agents: nextAgents };
    deps.configManager.write(nextCfg);
    const updated = deps.configManager.read();

    const body: SetAgentsConfigResponse = {
      ok: true,
      current: snapshotFromConfig(updated),
    };
    return jsonOk(body);
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to persist agents config',
      500,
    );
  }
}
