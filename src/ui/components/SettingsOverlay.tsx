/**
 * `/settings` overlay — FIX #35, extended in R17 (Timeouts section).
 *
 * Two-panel editor for generation parameters. The TOP panel always
 * renders the global config (`~/.localcode/config.toml`), the BOTTOM
 * panel renders the per-project overrides
 * (`<projectRoot>/.localcode/settings.json`). Project values are
 * sparse — any field set to "—" falls back to global at runtime.
 *
 * R17 (Agent 4) — added an optional THIRD section ("Timeouts (global)")
 * mirroring what CtxSizeOverlay does for `responseTimeoutSeconds` and
 * `keepAliveSeconds` (`config.context`). Both overlays editing the
 * same fields is fine — the underlying config keeps them in sync. The
 * section is gated behind the optional `globalTimeouts` prop: if the
 * caller doesn't pass it, the section hides cleanly so existing tests
 * (and any caller still on the pre-R17 prop shape) keep working.
 *
 * The caller owns persistence; the overlay is purely presentational
 * and reports edits via `onApplyGlobal` / `onApplyProject`:
 *
 *   <SettingsOverlay
 *     globalGeneration={cfg.generation}
 *     projectGeneration={projectOverrides ?? null}
 *     source={resolveSource(cfg.generation, projectOverrides)}
 *     globalTimeouts={{
 *       responseTimeoutSeconds: cfg.context.responseTimeoutSeconds,
 *       keepAliveSeconds: cfg.context.keepAliveSeconds,
 *     }}
 *     onApplyGlobal={(next, timeouts) => writeGlobal(next, timeouts)}
 *     onApplyProject={(next) => writeProject(next)}  // null = remove
 *     onClose={() => setOverlay(null)}
 *   />
 *
 * Keybindings:
 *   ↑/↓     navigate fields (top-to-bottom across all panels)
 *   ←/→     decrement / increment focused number by step (generation
 *           rows) OR cycle preset chips (timeout-preset rows)
 *   space   on a project field — toggle "—" ↔ active override
 *   enter   on a save/reset button — fire action; on a custom timeout
 *           row — open inline TextInput edit mode
 *   esc     onClose() at top level; abandon edit while in edit mode
 *
 * Step sizes (generation):
 *   temperature      0.05  range [0..2]
 *   top_p            0.05  range [0..1]
 *   repeat_penalty   0.05  range [0..2]
 *   max_tokens       256   range [1..1_048_576]
 *
 * Timeout ranges (R17):
 *   responseTimeoutSeconds  [30..7200]  presets: 60 / 180 / 300 / 600 / 1800
 *   keepAliveSeconds        [0..86400]  presets: 0 / 300 / 1800 / 3600 / 86400
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { dimSeparator, noxPalette, textMuted, theme } from '../theme.js';
import type { GenerationConfig } from '../../types/global.js';
// I18N-STRINGS-START
import { useT } from '../../i18n/index.js';
import type { StringKey } from '../../i18n/strings/en.js';
// I18N-STRINGS-END

// ---------- Public API ---------------------------------------------------

export interface SettingsOverlayTimeouts {
  readonly responseTimeoutSeconds: number;
  readonly keepAliveSeconds: number;
}

export interface SettingsOverlayProps {
  readonly globalGeneration: GenerationConfig;
  /** `null` means the project hasn't customized any field yet. */
  readonly projectGeneration: Partial<GenerationConfig> | null;
  /** Resolved source for the currently effective values. */
  readonly source: 'project' | 'global' | 'mixed';
  /**
   * R17 — optional global timeout values. Mirror of
   * `config.context.responseTimeoutSeconds` /
   * `config.context.keepAliveSeconds`. If undefined, the entire
   * Timeouts section is hidden (graceful degradation for tests and
   * pre-R17 callers).
   */
  readonly globalTimeouts?: SettingsOverlayTimeouts;
  /**
   * The second arg `timeouts` is optional so existing callers that
   * only persist generation params keep compiling. When supplied (and
   * the user has touched a timeout field), the caller should write
   * `config.context.{responseTimeoutSeconds,keepAliveSeconds}` in
   * addition to `config.generation`.
   */
  readonly onApplyGlobal: (
    next: GenerationConfig,
    timeouts?: SettingsOverlayTimeouts,
  ) => void;
  /** `null` = remove the entire project override file. */
  readonly onApplyProject: (next: Partial<GenerationConfig> | null) => void;
  readonly onClose: () => void;
}

// ---------- Field metadata ----------------------------------------------

type FieldKey = keyof GenerationConfig;

// I18N-STRINGS-START
// `label` is kept as the canonical English string so existing tests that
// assert error text against the English locale still pass. `labelKey`
// drives the localised render so users see Russian / English copy based
// on the active locale.
interface FieldSpec {
  readonly key: FieldKey;
  readonly label: string;
  readonly labelKey: StringKey;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Number of decimals to render (0 → integer). */
  readonly decimals: number;
}

const FIELDS: readonly FieldSpec[] = [
  {
    key: 'temperature',
    label: 'Temperature',
    labelKey: 'settings.field.tempLabel',
    min: 0,
    max: 2,
    step: 0.05,
    decimals: 2,
  },
  {
    key: 'topP',
    label: 'Top-p',
    labelKey: 'settings.field.topPLabel',
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
  },
  {
    key: 'repeatPenalty',
    label: 'Repeat penalty',
    labelKey: 'settings.field.repeatPenaltyLabel',
    min: 0,
    max: 2,
    step: 0.05,
    decimals: 2,
  },
  {
    key: 'maxTokens',
    label: 'Max tokens',
    labelKey: 'settings.field.maxTokensLabel',
    min: 1,
    max: 1_048_576,
    step: 256,
    decimals: 0,
  },
];
// I18N-STRINGS-END

// R17 — timeout presets (mirrors CtxSizeOverlay's tables so users see
// the same labels in both surfaces).
const RESPONSE_PRESETS: readonly number[] = [60, 180, 300, 600, 1800];
const RESPONSE_LABELS: readonly string[] = ['1m', '3m', '5m', '10m', '30m'];
const KEEP_PRESETS: readonly number[] = [0, 300, 1800, 3600, 86400];
const KEEP_LABELS: readonly string[] = ['0', '5m', '30m', '1h', '24h'];

const RESPONSE_MIN = 30;
const RESPONSE_MAX = 7200;
const KEEP_MIN = 0;
const KEEP_MAX = 86400;

// Cursor index → which row receives focus.
//   0..3  → Global field at FIELDS[i]
//   4     → [ Save Global ]
//   5..8  → Project field at FIELDS[i-5]
//   9     → [ Save Project ]
//   10    → [ Reset Project ]
//   11    → Response timeout presets row    (R17)
//   12    → Response timeout custom row     (R17)
//   13    → Keep-alive presets row          (R17)
//   14    → Keep-alive custom row           (R17)
//   15    → [ Save Timeouts ]               (R17)
const FOCUS_GLOBAL_FIELD_START = 0;
const FOCUS_GLOBAL_FIELD_END = 3;
const FOCUS_SAVE_GLOBAL = 4;
const FOCUS_PROJECT_FIELD_START = 5;
const FOCUS_PROJECT_FIELD_END = 8;
const FOCUS_SAVE_PROJECT = 9;
const FOCUS_RESET_PROJECT = 10;
// R17 — timeout-section focus indices. Only reachable when the
// section is rendered (i.e. globalTimeouts !== undefined).
const FOCUS_RESPONSE_PRESETS = 11;
const FOCUS_RESPONSE_CUSTOM = 12;
const FOCUS_KEEP_PRESETS = 13;
const FOCUS_KEEP_CUSTOM = 14;
const FOCUS_SAVE_TIMEOUTS = 15;

const FOCUS_LAST_NO_TIMEOUTS = FOCUS_RESET_PROJECT;
const FOCUS_LAST_WITH_TIMEOUTS = FOCUS_SAVE_TIMEOUTS;

// ---------- Helpers ------------------------------------------------------

/**
 * Clamp a number into [min, max] and round to the field's resolution
 * (so we don't accumulate floating-point drift after many ←/→ taps).
 * Integer fields short-circuit the rounding.
 */
function clampAndRound(value: number, spec: FieldSpec): number {
  const clamped = Math.max(spec.min, Math.min(spec.max, value));
  if (spec.decimals === 0) return Math.round(clamped);
  const factor = 10 ** spec.decimals;
  return Math.round(clamped * factor) / factor;
}

function formatValue(value: number, spec: FieldSpec): string {
  if (spec.decimals === 0) return String(Math.round(value));
  return value.toFixed(spec.decimals);
}

/**
 * Validate a final draft against the field range; returns `null` when
 * sound, otherwise a short human-readable reason. Defensive — the only
 * input mechanism is ←/→ which already clamps, but a corrupted prop
 * value or a future text-input mode could violate the bounds.
 */
function validateDraft(draft: GenerationConfig): string | null {
  for (const spec of FIELDS) {
    const v = draft[spec.key];
    if (!Number.isFinite(v)) return `${spec.label} is not a number`;
    if (v < spec.min || v > spec.max) {
      return `${spec.label} out of range [${spec.min}..${spec.max}]`;
    }
    if (spec.decimals === 0 && !Number.isInteger(v)) {
      return `${spec.label} must be an integer`;
    }
  }
  return null;
}

/**
 * Build the `Partial<GenerationConfig>` we hand back to the caller —
 * only fields the user has activated (i.e. not `—`) are included.
 * If the result is empty we return `null` so the caller can delete the
 * file rather than write `{}`.
 */
function buildProjectPayload(
  draft: GenerationConfig,
  active: Record<FieldKey, boolean>,
): Partial<GenerationConfig> | null {
  const out: Partial<GenerationConfig> = {};
  let any = false;
  for (const spec of FIELDS) {
    if (active[spec.key]) {
      out[spec.key] = draft[spec.key];
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Render a one-line "Source: …" summary used at the top of the panel.
 * Counts how many fields the project actually overrides so users can
 * tell at a glance how mixed the resolved settings are.
 */
function describeSource(
  source: 'project' | 'global' | 'mixed',
  active: Record<FieldKey, boolean>,
): string {
  const overridden = FIELDS.filter((f) => active[f.key]).length;
  if (source === 'global' || overridden === 0) return 'Source: global (no project overrides)';
  if (source === 'project' || overridden === FIELDS.length) {
    return 'Source: project (all 4 fields overridden)';
  }
  return `Source: mixed (project overrides ${overridden} of ${FIELDS.length} fields)`;
}

/**
 * R17 — find the closest preset to `current`. Mirrors the pattern from
 * CtxSizeOverlay so first-time render lands on the right chip when
 * the saved value coincides with a preset.
 */
function nearestIndex(presets: readonly number[], current: number): number {
  if (presets.length === 0) return 0;
  let best = 0;
  let bestDiff = Math.abs((presets[0] ?? 0) - current);
  for (let i = 1; i < presets.length; i += 1) {
    const p = presets[i];
    if (p === undefined) continue;
    const diff = Math.abs(p - current);
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  return best;
}

/** R17 — clamp helper for timeout integers. */
function clampInt(value: number, lo: number, hi: number): number {
  const r = Math.round(value);
  if (r < lo) return lo;
  if (r > hi) return hi;
  return r;
}

/**
 * R17 — strip non-digit characters. Allows pasting `"3,600"` → `"3600"`
 * without tripping the validator. Same helper CtxSizeOverlay R8 uses.
 */
function digitsOnly(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (ch >= '0' && ch <= '9') out += ch;
  }
  return out;
}

/**
 * R17 — parse a custom timeout string against [min..max]. Empty strings
 * are rejected so an accidental Apply on a blank field surfaces as a
 * clear validation error rather than silently writing `0`.
 */
function parseTimeout(
  raw: string,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: `${label} required` };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: `${label} must be an integer` };
  }
  if (n < min || n > max) {
    return {
      ok: false,
      error: `${label} out of range [${min}..${max.toLocaleString('en-US')}]`,
    };
  }
  return { ok: true, value: n };
}

// R17 — which custom timeout field is currently in inline-edit mode.
type EditingTimeoutField = 'response' | 'keepAlive' | null;

// ---------- Component ----------------------------------------------------

function SettingsOverlay({
  globalGeneration,
  projectGeneration,
  source,
  globalTimeouts,
  onApplyGlobal,
  onApplyProject,
  onClose,
}: SettingsOverlayProps): React.JSX.Element {
  // I18N-STRINGS-START
  const { t } = useT();
  // I18N-STRINGS-END
  const showTimeouts = globalTimeouts !== undefined;

  // Drafts are seeded from props once and mutated locally — saves bounce
  // back through the parent's setState only on apply.
  const [globalDraft, setGlobalDraft] = useState<GenerationConfig>(() => ({
    ...globalGeneration,
  }));

  const [projectDraft, setProjectDraft] = useState<GenerationConfig>(() => ({
    temperature: projectGeneration?.temperature ?? globalGeneration.temperature,
    topP: projectGeneration?.topP ?? globalGeneration.topP,
    repeatPenalty: projectGeneration?.repeatPenalty ?? globalGeneration.repeatPenalty,
    maxTokens: projectGeneration?.maxTokens ?? globalGeneration.maxTokens,
  }));

  // Which project fields are currently active (i.e. NOT "—"). When the
  // overlay opens, every key that exists in `projectGeneration` is
  // active; absent keys default to inactive.
  const [projectActive, setProjectActive] = useState<Record<FieldKey, boolean>>(() => ({
    temperature: projectGeneration?.temperature !== undefined,
    topP: projectGeneration?.topP !== undefined,
    repeatPenalty: projectGeneration?.repeatPenalty !== undefined,
    maxTokens: projectGeneration?.maxTokens !== undefined,
  }));

  // R17 — timeout drafts. Default values are only consulted when the
  // section is hidden; React still requires the hooks to run in the
  // same order on every render, so we always initialise them from
  // either the prop (when present) or a sentinel default.
  const [responseDraft, setResponseDraft] = useState<number>(() =>
    clampInt(globalTimeouts?.responseTimeoutSeconds ?? 300, RESPONSE_MIN, RESPONSE_MAX),
  );
  const [keepAliveDraft, setKeepAliveDraft] = useState<number>(() =>
    clampInt(globalTimeouts?.keepAliveSeconds ?? 1800, KEEP_MIN, KEEP_MAX),
  );
  const [responseIndex, setResponseIndex] = useState<number>(() =>
    nearestIndex(
      RESPONSE_PRESETS,
      globalTimeouts?.responseTimeoutSeconds ?? 300,
    ),
  );
  const [keepIndex, setKeepIndex] = useState<number>(() =>
    nearestIndex(KEEP_PRESETS, globalTimeouts?.keepAliveSeconds ?? 1800),
  );

  // Inline-edit state for the two custom timeout rows.
  const [editingTimeout, setEditingTimeout] = useState<EditingTimeoutField>(null);
  const [editBuffer, setEditBuffer] = useState<string>('');
  const [editKey, setEditKey] = useState<number>(0);

  const [focus, setFocus] = useState<number>(FOCUS_GLOBAL_FIELD_START);
  const [error, setError] = useState<string | null>(null);

  // ---- Adjustment helpers -------------------------------------------------

  const adjustGlobal = useCallback((spec: FieldSpec, direction: 1 | -1): void => {
    setGlobalDraft((prev) => {
      const next = clampAndRound(prev[spec.key] + spec.step * direction, spec);
      return { ...prev, [spec.key]: next };
    });
  }, []);

  const adjustProject = useCallback(
    (spec: FieldSpec, direction: 1 | -1): void => {
      // Adjusting a `—` field has no effect — user must `space` first.
      if (!projectActive[spec.key]) return;
      setProjectDraft((prev) => {
        const next = clampAndRound(prev[spec.key] + spec.step * direction, spec);
        return { ...prev, [spec.key]: next };
      });
    },
    [projectActive],
  );

  const toggleProjectField = useCallback(
    (spec: FieldSpec): void => {
      setProjectActive((prev) => {
        const isOn = prev[spec.key];
        if (isOn) {
          // Turning OFF — drop the override; redisplay as "—". The
          // draft value is left untouched so a future re-toggle starts
          // from the previous edit, which feels less surprising than
          // snapping back to the global value.
          return { ...prev, [spec.key]: false };
        }
        // Turning ON — seed the draft from the current global value so
        // the user has a sensible starting point.
        setProjectDraft((d) => ({ ...d, [spec.key]: globalDraft[spec.key] }));
        return { ...prev, [spec.key]: true };
      });
    },
    [globalDraft],
  );

  // ---- R17 timeout helpers ----------------------------------------------

  const cycleResponse = useCallback((direction: 1 | -1): void => {
    setResponseIndex((i) => {
      const next = (i + direction + RESPONSE_PRESETS.length) % RESPONSE_PRESETS.length;
      const presetVal = RESPONSE_PRESETS[next];
      if (presetVal !== undefined) setResponseDraft(presetVal);
      return next;
    });
  }, []);

  const cycleKeep = useCallback((direction: 1 | -1): void => {
    setKeepIndex((i) => {
      const next = (i + direction + KEEP_PRESETS.length) % KEEP_PRESETS.length;
      const presetVal = KEEP_PRESETS[next];
      if (presetVal !== undefined) setKeepAliveDraft(presetVal);
      return next;
    });
  }, []);

  const startTimeoutEdit = useCallback(
    (field: 'response' | 'keepAlive'): void => {
      const current = field === 'response' ? responseDraft : keepAliveDraft;
      setEditingTimeout(field);
      setEditBuffer(String(current));
      setEditKey((k) => k + 1);
      setError(null);
    },
    [responseDraft, keepAliveDraft],
  );

  const cancelTimeoutEdit = useCallback((): void => {
    setEditingTimeout(null);
    setEditBuffer('');
    setError(null);
  }, []);

  const onTimeoutEditChange = useCallback((raw: string): void => {
    setEditBuffer(digitsOnly(raw));
  }, []);

  const commitTimeoutEdit = useCallback(
    (raw: string): void => {
      const field = editingTimeout;
      if (field === null) return;
      const min = field === 'response' ? RESPONSE_MIN : KEEP_MIN;
      const max = field === 'response' ? RESPONSE_MAX : KEEP_MAX;
      const label = field === 'response' ? 'Response timeout' : 'Keep-alive';
      const result = parseTimeout(raw, min, max, label);
      if (!result.ok) {
        setError(result.error);
        // Stay in edit mode so the user can fix without retyping.
        return;
      }
      if (field === 'response') {
        setResponseDraft(result.value);
        const matchIdx = RESPONSE_PRESETS.indexOf(result.value);
        if (matchIdx >= 0) setResponseIndex(matchIdx);
      } else {
        setKeepAliveDraft(result.value);
        const matchIdx = KEEP_PRESETS.indexOf(result.value);
        if (matchIdx >= 0) setKeepIndex(matchIdx);
      }
      setEditingTimeout(null);
      setEditBuffer('');
      setError(null);
    },
    [editingTimeout],
  );

  // ---- Apply actions ------------------------------------------------------

  const applyGlobal = useCallback((): void => {
    const v = validateDraft(globalDraft);
    if (v !== null) {
      setError(v);
      return;
    }
    setError(null);
    onApplyGlobal({ ...globalDraft });
  }, [globalDraft, onApplyGlobal]);

  const applyProject = useCallback((): void => {
    // Validate only the fields that are active — inactive ones don't
    // get persisted, so their draft values are irrelevant.
    for (const spec of FIELDS) {
      if (!projectActive[spec.key]) continue;
      const v = projectDraft[spec.key];
      if (!Number.isFinite(v) || v < spec.min || v > spec.max) {
        setError(`${spec.label} out of range [${spec.min}..${spec.max}]`);
        return;
      }
      if (spec.decimals === 0 && !Number.isInteger(v)) {
        setError(`${spec.label} must be an integer`);
        return;
      }
    }
    setError(null);
    onApplyProject(buildProjectPayload(projectDraft, projectActive));
  }, [onApplyProject, projectActive, projectDraft]);

  const resetProject = useCallback((): void => {
    setError(null);
    setProjectActive({
      temperature: false,
      topP: false,
      repeatPenalty: false,
      maxTokens: false,
    });
    onApplyProject(null);
  }, [onApplyProject]);

  /**
   * R17 — apply timeouts via the widened `onApplyGlobal` callback. We
   * forward the current generation draft together with the timeout
   * pair; `app.tsx` (Agent 8 R13) then calls `configManager.update`
   * with both `generation` and `context` keys. Validation is local
   * (range checks are already enforced by clampInt + parseTimeout but
   * we re-check defensively in case props seed an out-of-range value).
   */
  const applyTimeouts = useCallback((): void => {
    if (!showTimeouts) return;
    const r = clampInt(responseDraft, RESPONSE_MIN, RESPONSE_MAX);
    const k = clampInt(keepAliveDraft, KEEP_MIN, KEEP_MAX);
    if (r !== responseDraft || k !== keepAliveDraft) {
      // Snap drafts to clamped values so the UI reflects what was
      // persisted. (Defensive — should not normally trigger.)
      setResponseDraft(r);
      setKeepAliveDraft(k);
    }
    setError(null);
    onApplyGlobal({ ...globalDraft }, {
      responseTimeoutSeconds: r,
      keepAliveSeconds: k,
    });
  }, [
    globalDraft,
    keepAliveDraft,
    onApplyGlobal,
    responseDraft,
    showTimeouts,
  ]);

  // ---- Input dispatcher --------------------------------------------------

  const focusLast = showTimeouts ? FOCUS_LAST_WITH_TIMEOUTS : FOCUS_LAST_NO_TIMEOUTS;

  useInput(
    useCallback(
      (
        input: string,
        key: {
          escape?: boolean;
          return?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
          leftArrow?: boolean;
          rightArrow?: boolean;
        },
      ): void => {
        // Edit mode: TextInput owns text + Enter; we only intercept Esc
        // so the user can bail without committing.
        if (editingTimeout !== null) {
          if (key.escape === true) {
            cancelTimeoutEdit();
          }
          return;
        }

        if (key.escape === true) {
          onClose();
          return;
        }

        if (key.upArrow === true) {
          setFocus((f) => (f - 1 + (focusLast + 1)) % (focusLast + 1));
          return;
        }
        if (key.downArrow === true) {
          setFocus((f) => (f + 1) % (focusLast + 1));
          return;
        }

        // Left/Right adjust focused number (generation rows) or cycle
        // preset chips (timeout-preset rows).
        if (key.leftArrow === true || key.rightArrow === true) {
          const direction: 1 | -1 = key.rightArrow === true ? 1 : -1;
          if (focus >= FOCUS_GLOBAL_FIELD_START && focus <= FOCUS_GLOBAL_FIELD_END) {
            const spec = FIELDS[focus];
            if (spec !== undefined) adjustGlobal(spec, direction);
            return;
          }
          if (focus >= FOCUS_PROJECT_FIELD_START && focus <= FOCUS_PROJECT_FIELD_END) {
            const spec = FIELDS[focus - FOCUS_PROJECT_FIELD_START];
            if (spec !== undefined) adjustProject(spec, direction);
            return;
          }
          if (showTimeouts && focus === FOCUS_RESPONSE_PRESETS) {
            cycleResponse(direction);
            return;
          }
          if (showTimeouts && focus === FOCUS_KEEP_PRESETS) {
            cycleKeep(direction);
            return;
          }
          return;
        }

        // Space toggles project-field override on/off.
        if (input === ' ') {
          if (focus >= FOCUS_PROJECT_FIELD_START && focus <= FOCUS_PROJECT_FIELD_END) {
            const spec = FIELDS[focus - FOCUS_PROJECT_FIELD_START];
            if (spec !== undefined) toggleProjectField(spec);
          }
          return;
        }

        if (key.return === true) {
          if (focus === FOCUS_SAVE_GLOBAL) {
            applyGlobal();
            return;
          }
          if (focus === FOCUS_SAVE_PROJECT) {
            applyProject();
            return;
          }
          if (focus === FOCUS_RESET_PROJECT) {
            resetProject();
            return;
          }
          if (showTimeouts && focus === FOCUS_RESPONSE_PRESETS) {
            // Re-confirm the currently highlighted preset (idempotent —
            // ←/→ already updates the draft live, but Enter keeps the
            // surface explicit).
            const v = RESPONSE_PRESETS[responseIndex];
            if (v !== undefined) setResponseDraft(v);
            return;
          }
          if (showTimeouts && focus === FOCUS_KEEP_PRESETS) {
            const v = KEEP_PRESETS[keepIndex];
            if (v !== undefined) setKeepAliveDraft(v);
            return;
          }
          if (showTimeouts && focus === FOCUS_RESPONSE_CUSTOM) {
            startTimeoutEdit('response');
            return;
          }
          if (showTimeouts && focus === FOCUS_KEEP_CUSTOM) {
            startTimeoutEdit('keepAlive');
            return;
          }
          if (showTimeouts && focus === FOCUS_SAVE_TIMEOUTS) {
            applyTimeouts();
            return;
          }
          // Pressing Enter on a field row is a no-op — encourages users
          // to reach the explicit save buttons rather than guessing.
          return;
        }
      },
      [
        adjustGlobal,
        adjustProject,
        applyGlobal,
        applyProject,
        applyTimeouts,
        cancelTimeoutEdit,
        cycleKeep,
        cycleResponse,
        editingTimeout,
        focus,
        focusLast,
        keepIndex,
        onClose,
        resetProject,
        responseIndex,
        showTimeouts,
        startTimeoutEdit,
        toggleProjectField,
      ],
    ),
  );

  // ---- Render helpers -----------------------------------------------------

  const overriddenCount = useMemo(
    () => FIELDS.filter((f) => projectActive[f.key]).length,
    [projectActive],
  );

  // I18N-STRINGS-START
  const sourceLine = useMemo(() => {
    const overridden = FIELDS.filter((f) => projectActive[f.key]).length;
    if (source === 'global' || overridden === 0) {
      return t('settings.source.globalOnly');
    }
    if (source === 'project' || overridden === FIELDS.length) {
      return t('settings.source.projectAll');
    }
    return t('settings.source.mixed', {
      overridden,
      total: FIELDS.length,
    });
  }, [source, projectActive, t]);
  // I18N-STRINGS-END

  const renderGlobalRow = (spec: FieldSpec, index: number): React.JSX.Element => {
    const isFocused = focus === index;
    const value = globalDraft[spec.key];
    const display = `[${formatValue(value, spec)}]`;
    return (
      <Box key={`g-${spec.key}`} flexDirection="row">
        <Box width={4}>
          <Text color={isFocused ? noxPalette.light : textMuted}>
            {isFocused ? '  ❯ ' : '    '}
          </Text>
        </Box>
        <Box width={20}>
          {/* I18N-STRINGS-START */}
          <Text color={isFocused ? noxPalette.white : noxPalette.light}>{t(spec.labelKey)}</Text>
          {/* I18N-STRINGS-END */}
        </Box>
        <Box>
          <Text>
            {isFocused
              ? theme.selected(` ${display} `)
              : ` ${display} `}
          </Text>
        </Box>
        <Box marginLeft={2}>
          {/* I18N-STRINGS-START */}
          <Text color={textMuted}>
            {t('settings.fieldHint.stepRange', {
              step: formatValue(spec.step, spec),
              min: spec.min,
              max: spec.max,
            })}
          </Text>
          {/* I18N-STRINGS-END */}
        </Box>
      </Box>
    );
  };

  const renderProjectRow = (spec: FieldSpec, fieldIndex: number): React.JSX.Element => {
    const focusIndex = FOCUS_PROJECT_FIELD_START + fieldIndex;
    const isFocused = focus === focusIndex;
    const isActive = projectActive[spec.key];
    const display = isActive ? `[${formatValue(projectDraft[spec.key], spec)} *]` : '[—]';
    const valueColour = isActive ? noxPalette.highlight : textMuted;
    return (
      <Box key={`p-${spec.key}`} flexDirection="row">
        <Box width={4}>
          <Text color={isFocused ? noxPalette.light : textMuted}>
            {isFocused ? '  ❯ ' : '    '}
          </Text>
        </Box>
        <Box width={20}>
          {/* I18N-STRINGS-START */}
          <Text color={isFocused ? noxPalette.white : noxPalette.light}>{t(spec.labelKey)}</Text>
          {/* I18N-STRINGS-END */}
        </Box>
        <Box>
          {isFocused ? (
            <Text>{theme.selected(` ${display} `)}</Text>
          ) : (
            <Text color={valueColour}>{` ${display} `}</Text>
          )}
        </Box>
        <Box marginLeft={2}>
          {/* I18N-STRINGS-START */}
          <Text color={textMuted}>
            {isActive
              ? t('settings.project.spaceRemove')
              : t('settings.project.spaceEnable')}
          </Text>
          {/* I18N-STRINGS-END */}
        </Box>
      </Box>
    );
  };

  const renderButton = (
    label: string,
    focusIndex: number,
    flavour: 'primary' | 'danger',
  ): React.JSX.Element => {
    const isFocused = focus === focusIndex;
    const bracketed = `[ ${label} ]`;
    if (isFocused) {
      return <Text>{theme.selected(` ${bracketed} `)}</Text>;
    }
    const colour = flavour === 'danger' ? '#fca5a5' : noxPalette.light;
    return <Text color={colour}>{` ${bracketed} `}</Text>;
  };

  /**
   * R17 — render a row of preset chips. The chip whose value matches
   * the current draft is highlighted independently from the cursor so
   * the user can see at a glance which preset (if any) the saved
   * value lands on. Mirrors the styling used by CtxSizeOverlay.
   */
  const renderPresetChips = (
    labels: readonly string[],
    presets: readonly number[],
    cursorIndex: number,
    cursorActive: boolean,
    draft: number,
  ): React.JSX.Element => (
    <Box flexDirection="row">
      {labels.map((label, i) => {
        const presetVal = presets[i];
        const cursorHere = i === cursorIndex;
        const matchesDraft = presetVal !== undefined && presetVal === draft;
        const isHot = cursorActive && cursorHere;
        const colour = isHot
          ? noxPalette.white
          : matchesDraft
            ? noxPalette.highlight
            : cursorHere
              ? noxPalette.light
              : textMuted;
        return (
          <Box key={`tp-${label}-${i}`} marginRight={1}>
            <Text
              color={colour}
              backgroundColor={isHot ? noxPalette.primary : undefined}
              bold={cursorHere || matchesDraft}
            >
              {' '}
              {label}
              {' '}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  /**
   * R17 — render a custom timeout row (TextInput when editing, plain
   * read-only chip otherwise). Mirrors CtxSizeOverlay's `renderCustomRow`.
   */
  const renderCustomTimeout = (
    field: 'response' | 'keepAlive',
    cursorActive: boolean,
    draft: number,
    suffix: string,
    placeholder: string,
  ): React.JSX.Element => {
    const isEditing = editingTimeout === field;
    if (isEditing) {
      return (
        <Box flexDirection="row" alignItems="center">
          <Box
            paddingX={1}
            borderStyle="round"
            borderColor={noxPalette.light}
            minWidth={16}
          >
            <TextInput
              key={editKey}
              defaultValue={editBuffer}
              placeholder={placeholder}
              onChange={onTimeoutEditChange}
              onSubmit={commitTimeoutEdit}
            />
          </Box>
          <Box marginLeft={1}>
            <Text color={textMuted}>{suffix}</Text>
          </Box>
        </Box>
      );
    }
    const display = String(draft);
    return (
      <Box flexDirection="row" alignItems="center">
        <Box
          paddingX={1}
          borderStyle="round"
          borderColor={cursorActive ? noxPalette.light : dimSeparator}
          minWidth={16}
        >
          <Text
            color={cursorActive ? noxPalette.white : noxPalette.light}
            bold={cursorActive}
          >
            {display}
          </Text>
        </Box>
        <Box marginLeft={1}>
          <Text color={textMuted}>
            {suffix}
            {/* I18N-STRINGS-START */}
            {cursorActive ? t('settings.suffix.editHint') : ''}
            {/* I18N-STRINGS-END */}
          </Text>
        </Box>
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={dimSeparator}
      paddingX={1}
      paddingY={1}
    >
      <Box>
        {/* I18N-STRINGS-START */}
        <Text color={noxPalette.white} bold>
          {t('settings.title')}
        </Text>
        {/* I18N-STRINGS-END */}
      </Box>

      <Box marginTop={1}>
        <Text color={textMuted}>{sourceLine}</Text>
      </Box>

      {/* ----- Global panel ----- */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={dimSeparator}
        paddingX={1}
        marginTop={1}
      >
        <Box>
          {/* I18N-STRINGS-START */}
          <Text color={noxPalette.light} bold>
            {t('settings.panel.global')}
          </Text>
          <Text color={textMuted}>{t('settings.panel.global.path')}</Text>
          {/* I18N-STRINGS-END */}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {FIELDS.map((spec, i) => renderGlobalRow(spec, i + FOCUS_GLOBAL_FIELD_START))}
        </Box>
        <Box marginTop={1}>
          {/* I18N-STRINGS-START */}
          {renderButton(t('settings.button.saveGlobal'), FOCUS_SAVE_GLOBAL, 'primary')}
          {/* I18N-STRINGS-END */}
        </Box>
      </Box>

      {/* ----- Project panel ----- */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={dimSeparator}
        paddingX={1}
        marginTop={1}
      >
        <Box>
          {/* I18N-STRINGS-START */}
          <Text color={noxPalette.light} bold>
            {t('settings.panel.project')}
          </Text>
          <Text color={textMuted}>
            {t('settings.panel.project.suffix', {
              n: overriddenCount,
              total: FIELDS.length,
            })}
          </Text>
          {/* I18N-STRINGS-END */}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {FIELDS.map((spec, i) => renderProjectRow(spec, i))}
        </Box>
        <Box flexDirection="row" marginTop={1}>
          {/* I18N-STRINGS-START */}
          {renderButton(t('settings.button.saveProject'), FOCUS_SAVE_PROJECT, 'primary')}
          <Box marginLeft={2}>{renderButton(t('settings.button.resetProject'), FOCUS_RESET_PROJECT, 'danger')}</Box>
          {/* I18N-STRINGS-END */}
        </Box>
      </Box>

      {/* ----- Timeouts panel (R17) ----- */}
      {showTimeouts && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={dimSeparator}
          paddingX={1}
          marginTop={1}
        >
          <Box>
            {/* I18N-STRINGS-START */}
            <Text color={noxPalette.light} bold>
              {t('settings.panel.timeouts')}
            </Text>
            <Text color={textMuted}>{t('settings.panel.timeouts.path')}</Text>
            {/* I18N-STRINGS-END */}
          </Box>

          {/* Response wait — presets */}
          <Box flexDirection="row" marginTop={1}>
            <Box width={4}>
              <Text
                color={focus === FOCUS_RESPONSE_PRESETS ? noxPalette.light : textMuted}
              >
                {focus === FOCUS_RESPONSE_PRESETS ? '  ❯ ' : '    '}
              </Text>
            </Box>
            <Box width={20}>
              {/* I18N-STRINGS-START */}
              <Text
                color={
                  focus === FOCUS_RESPONSE_PRESETS ? noxPalette.white : noxPalette.light
                }
              >
                {t('settings.row.responseWait')}
              </Text>
              {/* I18N-STRINGS-END */}
            </Box>
            {renderPresetChips(
              RESPONSE_LABELS,
              RESPONSE_PRESETS,
              responseIndex,
              focus === FOCUS_RESPONSE_PRESETS,
              responseDraft,
            )}
          </Box>

          {/* Response wait — custom */}
          <Box flexDirection="row" marginTop={1}>
            <Box width={4}>
              <Text
                color={focus === FOCUS_RESPONSE_CUSTOM ? noxPalette.light : textMuted}
              >
                {focus === FOCUS_RESPONSE_CUSTOM ? '  ❯ ' : '    '}
              </Text>
            </Box>
            <Box width={20}>
              {/* I18N-STRINGS-START */}
              <Text
                color={
                  focus === FOCUS_RESPONSE_CUSTOM ? noxPalette.white : noxPalette.light
                }
              >
                {t('settings.row.custom')}
              </Text>
              {/* I18N-STRINGS-END */}
            </Box>
            {/* I18N-STRINGS-START */}
            {renderCustomTimeout(
              'response',
              focus === FOCUS_RESPONSE_CUSTOM,
              responseDraft,
              t('settings.suffix.secondsRange', { min: RESPONSE_MIN, max: RESPONSE_MAX }),
              '300',
            )}
            {/* I18N-STRINGS-END */}
          </Box>

          {/* Keep-alive — presets */}
          <Box flexDirection="row" marginTop={1}>
            <Box width={4}>
              <Text color={focus === FOCUS_KEEP_PRESETS ? noxPalette.light : textMuted}>
                {focus === FOCUS_KEEP_PRESETS ? '  ❯ ' : '    '}
              </Text>
            </Box>
            <Box width={20}>
              {/* I18N-STRINGS-START */}
              <Text
                color={focus === FOCUS_KEEP_PRESETS ? noxPalette.white : noxPalette.light}
              >
                {t('settings.row.keepAlive')}
              </Text>
              {/* I18N-STRINGS-END */}
            </Box>
            {renderPresetChips(
              KEEP_LABELS,
              KEEP_PRESETS,
              keepIndex,
              focus === FOCUS_KEEP_PRESETS,
              keepAliveDraft,
            )}
          </Box>

          {/* Keep-alive — custom */}
          <Box flexDirection="row" marginTop={1}>
            <Box width={4}>
              <Text color={focus === FOCUS_KEEP_CUSTOM ? noxPalette.light : textMuted}>
                {focus === FOCUS_KEEP_CUSTOM ? '  ❯ ' : '    '}
              </Text>
            </Box>
            <Box width={20}>
              {/* I18N-STRINGS-START */}
              <Text
                color={focus === FOCUS_KEEP_CUSTOM ? noxPalette.white : noxPalette.light}
              >
                {t('settings.row.custom')}
              </Text>
              {/* I18N-STRINGS-END */}
            </Box>
            {/* I18N-STRINGS-START */}
            {renderCustomTimeout(
              'keepAlive',
              focus === FOCUS_KEEP_CUSTOM,
              keepAliveDraft,
              t('settings.suffix.secondsRange', { min: KEEP_MIN, max: KEEP_MAX }),
              '1800',
            )}
            {/* I18N-STRINGS-END */}
          </Box>

          <Box marginTop={1}>
            {/* I18N-STRINGS-START */}
            {renderButton(t('settings.button.saveTimeouts'), FOCUS_SAVE_TIMEOUTS, 'primary')}
            {/* I18N-STRINGS-END */}
          </Box>
        </Box>
      )}

      {error !== null && (
        <Box marginTop={1}>
          {/* I18N-STRINGS-START */}
          <Text color="#fca5a5">{t('settings.error', { msg: error })}</Text>
          {/* I18N-STRINGS-END */}
        </Box>
      )}

      <Box marginTop={1}>
        {/* I18N-STRINGS-START */}
        <Text color={textMuted}>{t('settings.footer')}</Text>
        {/* I18N-STRINGS-END */}
      </Box>
    </Box>
  );
}

export default SettingsOverlay;
