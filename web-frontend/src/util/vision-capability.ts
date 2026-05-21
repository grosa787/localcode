/**
 * Web-side mirror of `src/llm/model-capabilities.ts`'s `supportsVision`.
 *
 * The canonical helper lives in the Bun runtime and imports types from
 * the `@/types/global` path alias which isn't configured for the
 * `web-frontend` tsconfig. Rather than reach across the workspace
 * boundary (and pull the whole `model-capabilities` module + its
 * `Backend` import chain into the SPA's type graph), we redeclare a
 * narrow, behaviour-equivalent helper here.
 *
 * If you change the rules in one place, mirror them in the other —
 * tests in `vision-capability.test.ts` and the canonical
 * `model-capabilities.test.ts` should agree on every (backend, model)
 * pair they exercise.
 */

/**
 * Backend identifiers the web SPA cares about. Kept lowercase + as a
 * narrow union to match the canonical wire shape (`Backend`).
 */
export type VisionBackend =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'google'
  | 'custom';

/**
 * Returns `true` when the (backend, model) pair is heuristically known
 * to accept inline images. The check is intentionally permissive — it
 * fires a warning toast (not a hard block) at the call site.
 */
export function supportsVision(
  backend: VisionBackend | string | undefined | null,
  model: string,
): boolean {
  if (typeof model !== 'string' || model.length === 0) return false;
  const m = model.toLowerCase();

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

    case 'openrouter':
      if (m.includes('gpt-4o')) return true;
      if (
        m.includes('claude-3') ||
        m.includes('claude-4') ||
        m.includes('claude-5')
      ) {
        return true;
      }
      if (m.includes('gemini-1.5') || m.includes('gemini-2')) return true;
      if (m.includes('llama-3.2') && m.includes('vision')) return true;
      return false;

    case 'ollama':
    case 'lmstudio':
    case 'custom':
    default:
      return false;
  }
}
