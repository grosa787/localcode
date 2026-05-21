/**
 * REST handlers for `/api/config`, `/api/config/model`, `/api/config/provider`.
 *
 * - `GET  /api/config`             — full `AppConfig`, with `apiKey` redacted.
 * - `POST /api/config/model`       — persist `model.current`.
 * - `POST /api/config/provider`    — switch backend; rebuild adapter; refresh models.
 */

import { z } from 'zod';

import type { AppConfig, Backend, PermissionProfile } from '@/types/global';

import { PROVIDER_DEFAULTS, resolveApiKey } from '@/config/defaults';
import { OutputStyleSchema, PermissionProfileSchema } from '@/config/types';
import type {
  GetConfigResponse,
  ListProvidersConfigResponse,
  PerProviderEntry,
  SetGenerationResponse,
  SetModelResponse,
  SetOutputStyleResponse,
  SetProfileResponse,
  SetProviderResponse,
} from '../protocol/rest-types.js';
import { BackendSchema } from '../protocol/messages.js';
import { jsonError, jsonOk, parseJsonBody } from './http.js';
import type { ApiDeps } from './types.js';

const SetModelSchema = z.object({ model: z.string().min(1) });

const SetProviderSchema = z.object({
  type: BackendSchema,
  baseUrl: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (v === undefined || v.length === 0) return true;
        try {
          // eslint-disable-next-line no-new
          new URL(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'baseUrl must be a valid URL' },
    ),
  apiKey: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.trim())),
  customHeaders: z.record(z.string()).optional(),
});

const SetGenerationSchema = z.object({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  repeatPenalty: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(1_000_000),
});

/** Strip secrets before serialising the config. */
function redactConfig(cfg: AppConfig): GetConfigResponse {
  const out: GetConfigResponse = {
    ...cfg,
    backend: { ...cfg.backend },
  };
  if (out.backend.apiKey !== undefined) {
    // Drop the field entirely — clients use `hasApiKey` semantics via
    // env-var resolution rather than reading the literal value.
    delete out.backend.apiKey;
  }
  return out;
}

export async function handleConfig(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  try {
    const cfg = deps.configManager.read();
    return jsonOk(redactConfig(cfg));
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to read config',
      500,
    );
  }
}

export async function handleConfigModel(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const parsed = await parseJsonBody(req, SetModelSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const updated = deps.configManager.update({ model: { current: parsed.value.model } });
    const body: SetModelResponse = { model: updated.model.current };
    return jsonOk(body);
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to update model',
      500,
    );
  }
}

export async function handleConfigProvider(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const parsed = await parseJsonBody(req, SetProviderSchema);
  if (!parsed.ok) return parsed.response;
  const { type, baseUrl: bodyBaseUrl, apiKey, customHeaders } = parsed.value;

  const baseUrl = bodyBaseUrl && bodyBaseUrl.length > 0
    ? bodyBaseUrl
    : PROVIDER_DEFAULTS[type as Backend].baseUrl;

  // Read current config so we can preserve unrelated fields.
  let current: AppConfig;
  try {
    current = deps.configManager.read();
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to read config',
      500,
    );
  }

  const effectiveKey = resolveApiKey(type, apiKey ?? current.backend.apiKey);

  // Probe the new provider before persisting — surface auth errors
  // directly to the UI without committing a broken config to disk.
  let models: readonly string[];
  try {
    const adapter = deps.createAdapterForBackend(type, baseUrl, effectiveKey);
    models = await adapter.getModels();
  } catch (err) {
    return jsonError(
      'provider_unreachable',
      err instanceof Error ? err.message : 'Failed to reach provider',
      502,
    );
  }

  // Pick a stable current model: keep the existing one if it survives
  // the new provider's catalogue, otherwise fall back to the first
  // entry. An empty list keeps the previous current (UI will surface
  // the gap).
  const existingModel = current.model.current;
  const modelInList = models.includes(existingModel);
  const firstModel = models[0];
  const currentModel = modelInList
    ? existingModel
    : firstModel !== undefined
      ? firstModel
      : existingModel;

  try {
    deps.configManager.update({
      backend: {
        type,
        baseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(customHeaders !== undefined ? { customHeaders } : {}),
      },
      model: {
        current: currentModel,
        available: [...models],
      },
    });
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to persist provider',
      500,
    );
  }

  const body: SetProviderResponse = {
    ok: true,
    backend: type,
    baseUrl,
    models,
    currentModel,
  };
  return jsonOk(body);
}

/**
 * Build the per-provider snapshot consumed by the SPA's "Backend
 * server" overlay. The active provider's row reflects what's persisted
 * in `~/.localcode/config.toml`; non-active rows fall back to defaults
 * (the SPA prefills the field but lets the user override).
 */
export async function handleConfigProviders(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  let cfg: AppConfig;
  try {
    cfg = deps.configManager.read();
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to read config',
      500,
    );
  }
  const types: Backend[] = [
    'ollama',
    'lmstudio',
    'openai',
    'anthropic',
    'openrouter',
    'google',
    'custom',
  ];
  const byType = {} as Record<Backend, PerProviderEntry>;
  for (const t of types) {
    if (t === cfg.backend.type) {
      // Audit M4 — surface only `hasApiKey`, never the literal value.
      const entry: PerProviderEntry = {
        baseUrl:
          cfg.backend.baseUrl.length > 0
            ? cfg.backend.baseUrl
            : PROVIDER_DEFAULTS[t].baseUrl,
        hasApiKey:
          cfg.backend.apiKey !== undefined && cfg.backend.apiKey.length > 0,
      };
      if (cfg.backend.customHeaders !== undefined) {
        entry.customHeaders = cfg.backend.customHeaders;
      }
      byType[t] = entry;
    } else {
      byType[t] = {
        baseUrl: PROVIDER_DEFAULTS[t].baseUrl,
        hasApiKey: false,
      };
    }
  }
  const body: ListProvidersConfigResponse = {
    current: cfg.backend.type,
    byType,
  };
  return jsonOk(body);
}

export async function handleConfigGeneration(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const parsed = await parseJsonBody(req, SetGenerationSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const updated = deps.configManager.update({ generation: parsed.value });
    const body: SetGenerationResponse = {
      ok: true,
      generation: {
        temperature: updated.generation.temperature,
        topP: updated.generation.topP,
        repeatPenalty: updated.generation.repeatPenalty,
        maxTokens: updated.generation.maxTokens,
      },
    };
    return jsonOk(body);
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to update generation params',
      500,
    );
  }
}

const SetProfileSchema = z.object({ profile: PermissionProfileSchema });

const SetOutputStyleSchema = z.object({ outputStyle: OutputStyleSchema });

/**
 * POST /api/config/output-style — switch the active output style.
 *
 * Persists `outputStyle` at the TOP level of the config (NOT nested
 * under `[generation]` or `[context]`) so the next-turn system prompt
 * picks up the new preamble. The change is purely additive: the prompt
 * gets one extra short sentence, and the cache prefix shifts only for
 * the swapped style.
 */
export async function handleConfigOutputStyle(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const parsed = await parseJsonBody(req, SetOutputStyleSchema);
  if (!parsed.ok) return parsed.response;

  try {
    deps.configManager.update({ outputStyle: parsed.value.outputStyle });
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to persist output style',
      500,
    );
  }

  const body: SetOutputStyleResponse = {
    ok: true,
    outputStyle: parsed.value.outputStyle,
  };
  return jsonOk(body);
}

/**
 * POST /api/config/profile — switch the active permission profile.
 *
 * The new profile is persisted via `ConfigManager.update`. Per-session
 * ChatRuntimes pick up the change at their next reconstruction; the
 * frontend mirrors the value into the zustand store so the chip + banner
 * reflect it immediately.
 */
export async function handleConfigProfile(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const parsed = await parseJsonBody(req, SetProfileSchema);
  if (!parsed.ok) return parsed.response;

  // Read the current permissions block so we preserve `autoApprove`
  // alongside the new profile (the partial-merge in ConfigManager only
  // goes one level deep on this field, so we hand it the full slice).
  let current: AppConfig;
  try {
    current = deps.configManager.read();
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to read config',
      500,
    );
  }

  try {
    deps.configManager.update({
      permissions: {
        autoApprove: current.permissions.autoApprove,
        profile: parsed.value.profile,
      },
    });
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to persist profile',
      500,
    );
  }

  const body: SetProfileResponse = {
    ok: true,
    profile: parsed.value.profile as PermissionProfile,
  };
  return jsonOk(body);
}
