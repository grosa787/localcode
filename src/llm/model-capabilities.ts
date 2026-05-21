/**
 * Model capability helpers.
 *
 * Centralised decision-making about whether a given (backend, model)
 * pair can accept an inline image attachment. Used by the composer to
 * decide whether to warn the user before sending a multimodal payload
 * to a model that probably doesn't accept images.
 *
 * The list is intentionally HEURISTIC, not authoritative — provider
 * catalogues change weekly and we cannot reach the network on every
 * keystroke. The detection rules are:
 *
 *   - Anthropic: every modern Claude (`claude-3*`, `claude-sonnet-*`,
 *     `claude-opus-*`, `claude-haiku-*`, `claude-4*`, `claude-5*`)
 *     accepts images. The legacy `claude-2` family does not.
 *   - OpenAI:    `gpt-4o*`, `gpt-4-vision*`, `gpt-4-turbo` (vision via
 *     the same endpoint), `o1` / `o3` / `o4` reasoning models with
 *     vision support, and `chatgpt-4o-latest`.
 *   - Google:    `gemini-1.5-*`, `gemini-2*`, `gemini-pro-vision`.
 *   - OpenRouter: many vision-tagged models, e.g. `openai/gpt-4o*`,
 *     `anthropic/claude-3*`, `google/gemini-1.5*`, `meta-llama/llama-3.2*-vision`,
 *     `qwen/qwen2-vl*`, `qwen/qwen-vl*`, `mistralai/pixtral*`. Anything
 *     with the literal substrings `vision`, `vl`, `pixtral`, `image`,
 *     `multimodal` in the slug is treated as vision-capable.
 *   - Ollama / LM Studio / Custom: heuristic — any model with `vision`,
 *     `vl`, `llava`, `pixtral`, `bakllava`, `moondream`, `minicpm-v` in
 *     the name. Includes the popular Llama-3.2 vision family, Qwen-VL,
 *     LLaVA, Moondream, MiniCPM-V.
 *
 * Callers that have stronger signal (e.g. the user explicitly toggled a
 * "force vision" flag, or downloaded a custom build of a known vision
 * model under a non-standard name) can bypass the heuristic by passing
 * `force: true` to {@link supportsVision}.
 */

import type { Backend } from '@/types/global';

/**
 * Returns `true` when (backend, model) is heuristically known to accept
 * inline images. The check is case-insensitive and prefix-tolerant —
 * `gpt-4o-2024-08-06` matches the `gpt-4o` prefix, `claude-3-5-sonnet`
 * matches `claude-3`, etc.
 *
 * `force === true` short-circuits the check and returns `true`. This is
 * the escape hatch for users who run a custom build of a known vision
 * model under a non-standard name (e.g. a fine-tuned LLaVA pushed to
 * Ollama as `mymodel:latest`).
 */
export function supportsVision(
  backend: Backend | undefined,
  model: string,
  force?: boolean,
): boolean {
  if (force === true) return true;
  if (typeof model !== 'string' || model.length === 0) return false;
  const m = model.toLowerCase();

  // Generic "vision hint" substring set — checked on every backend so a
  // model fine-tuned with a vision suffix is detected even when its
  // backend isn't typically vision-y.
  if (
    m.includes('vision') ||
    m.includes('-vl-') ||
    m.endsWith('-vl') ||
    m.includes('llava') ||
    m.includes('pixtral') ||
    m.includes('moondream') ||
    m.includes('minicpm-v') ||
    m.includes('bakllava') ||
    m.includes('multimodal')
  ) {
    return true;
  }

  switch (backend) {
    case 'anthropic':
      // Modern Claude families all accept images. The legacy claude-2
      // family does not — be conservative and return false for it.
      if (m.startsWith('claude-2')) return false;
      return (
        m.startsWith('claude-3') ||
        m.startsWith('claude-4') ||
        m.startsWith('claude-5') ||
        m.startsWith('claude-sonnet') ||
        m.startsWith('claude-opus') ||
        m.startsWith('claude-haiku')
      );

    case 'openai':
      return (
        m.startsWith('gpt-4o') ||
        m.startsWith('chatgpt-4o') ||
        m.startsWith('gpt-4-turbo') ||
        m.startsWith('gpt-4-vision') ||
        // Reasoning models — o1 / o3 / o4 have vision in the newer revs.
        m.startsWith('o1') ||
        m.startsWith('o3') ||
        m.startsWith('o4')
      );

    case 'google':
      return (
        m.includes('gemini-1.5') ||
        m.startsWith('gemini-2') ||
        m.startsWith('gemini-pro') ||
        m.startsWith('gemini-flash')
      );

    case 'openrouter': {
      // OpenRouter uses `provider/model` slugs. Detect by either the
      // generic substring hits above (already returned true) or by
      // matching common vision-capable provider/model pairs.
      if (m.includes('gpt-4o')) return true;
      if (m.includes('claude-3') || m.includes('claude-4') || m.includes('claude-5')) {
        return true;
      }
      if (m.includes('gemini-1.5') || m.includes('gemini-2')) return true;
      // Llama 3.2 ships an explicit vision variant; older Llama models
      // do not accept images.
      if (m.includes('llama-3.2') && m.includes('vision')) return true;
      // Qwen-VL family — already caught by the `-vl` substring check
      // above; this branch stays as documentation.
      return false;
    }

    case 'ollama':
    case 'lmstudio':
    case 'custom':
    default:
      // Local backends have no standard naming convention; the generic
      // vision-hint substring check above is the only signal.
      return false;
  }
}

/**
 * Warning message returned to the UI when the active model probably
 * does not support images. Kept as a single source of truth so the
 * composer and tests stay in lock-step.
 */
export const VISION_WARNING_MESSAGE =
  'Current model may not support images. Continue anyway?';
