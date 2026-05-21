/**
 * Statusline template renderer.
 *
 * Substitutes `{placeholder}` tokens in a user-supplied template string
 * with values from a typed `StatuslineVars` map. Recognised placeholders:
 *   `{model}`, `{tokens}`, `{maxTokens}`, `{pct}`, `{cachedTokens}`,
 *   `{cost}`, `{profile}`, `{provider}`, `{sessionId}`, `{branch}`,
 *   `{cwd}`.
 *
 * Design notes:
 *   - Missing values render as empty strings (never `undefined` /
 *     `NaN`). Keeps the rendered output safe for any UI that drops it
 *     into a single line.
 *   - Unknown placeholders are left untouched. They render literally
 *     so the user can SEE that they typed an unrecognised name and
 *     fix the template — silently dropping them was the worse UX.
 *   - The function is pure — no I/O, no time-dependent values — so
 *     two calls with identical `vars` always yield identical output.
 *     The caller is responsible for snapshotting volatile values
 *     (e.g. `branch`, `tokens`) before invoking.
 */

export interface StatuslineVars {
  model?: string;
  tokens?: number;
  maxTokens?: number;
  /** Pre-computed percentage (0..100, integer). Empty if undefined. */
  pct?: number;
  cachedTokens?: number;
  /** Pre-formatted cost string (e.g. "$0.012"). */
  cost?: string;
  profile?: string;
  provider?: string;
  sessionId?: string;
  branch?: string;
  cwd?: string;
}

/**
 * Set of placeholder names this helper recognises. Kept as a `const`
 * union both for the runtime check inside `renderStatusline` and for
 * test introspection (`PLACEHOLDER_NAMES.includes(name)`).
 */
export const PLACEHOLDER_NAMES = [
  'model',
  'tokens',
  'maxTokens',
  'pct',
  'cachedTokens',
  'cost',
  'profile',
  'provider',
  'sessionId',
  'branch',
  'cwd',
] as const;

export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

const PLACEHOLDER_NAME_SET: ReadonlySet<string> = new Set(PLACEHOLDER_NAMES);

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * Stringify a numeric placeholder value. Returns an empty string for
 * undefined / non-finite / negative values so the UI never renders
 * a garbage "NaN" or "-1" by accident.
 */
function formatNumber(v: number | undefined): string {
  if (v === undefined) return '';
  if (!Number.isFinite(v)) return '';
  if (v < 0) return '';
  // Round to nearest integer — sub-token precision is meaningless on a
  // status line and burns characters.
  return Math.round(v).toString();
}

function valueFor(name: PlaceholderName, vars: StatuslineVars): string {
  switch (name) {
    case 'model':
      return vars.model ?? '';
    case 'tokens':
      return formatNumber(vars.tokens);
    case 'maxTokens':
      return formatNumber(vars.maxTokens);
    case 'pct':
      return formatNumber(vars.pct);
    case 'cachedTokens':
      return formatNumber(vars.cachedTokens);
    case 'cost':
      return vars.cost ?? '';
    case 'profile':
      return vars.profile ?? '';
    case 'provider':
      return vars.provider ?? '';
    case 'sessionId':
      return vars.sessionId ?? '';
    case 'branch':
      return vars.branch ?? '';
    case 'cwd':
      return vars.cwd ?? '';
  }
}

/**
 * Render a template by substituting recognised `{placeholder}` tokens
 * with their values from `vars`. Missing-but-recognised tokens render
 * as empty strings. Unknown tokens (e.g. `{foo}`) are left untouched.
 *
 * Edge cases:
 *   - Empty template → empty string.
 *   - Template with no placeholders → returned verbatim.
 *   - Adjacent placeholders → both substituted independently.
 */
export function renderStatusline(
  template: string,
  vars: StatuslineVars,
): string {
  if (template.length === 0) return '';
  return template.replace(PLACEHOLDER_RE, (full, rawName: string) => {
    if (!PLACEHOLDER_NAME_SET.has(rawName)) return full;
    return valueFor(rawName as PlaceholderName, vars);
  });
}
