/**
 * `/ctxsize` overlay — FIX #32, extended in R8 (custom inputs) and R13
 * (response-timeout section).
 *
 * Eight-row picker:
 *   Row 1: "Window"           preset chips → 4K / 8K / 16K / 32K / 64K / 128K
 *   Row 2: "Custom"           free-form numeric TextInput (1024..1_048_576)
 *   Row 3: "Keep-alive"       preset chips → 0 / 5m / 30m / 1h / 24h
 *   Row 4: "Custom"           free-form numeric TextInput (0..86_400)
 *   Row 5: "Response timeout" preset chips → 60 / 180 / 300 / 600 / 1800
 *   Row 6: "Custom"           free-form numeric TextInput (30..7_200)
 *   Row 7: [ Apply ] [ Cancel ]
 *
 * Navigation:
 *   ↑ / ↓             walk row order (wraps at the ends)
 *   ← / →             on a preset row, cycle through chips; on the actions
 *                     row, switch between Apply / Cancel
 *   Enter (preset)    apply that preset value to the local draft and stay
 *   Enter (custom)    open inline TextInput edit mode
 *   Enter (action)    fire Apply or Cancel
 *   Esc (top-level)   close the overlay
 *   Esc (in edit)     revert to the previous draft value, exit edit mode
 *
 * The component owns a *draft* triple (maxTokens / keepAlive /
 * responseTimeout); nothing is persisted until the user reaches Apply.
 * Custom inputs are filtered to digits only and validated against the
 * field range — invalid commits surface an inline red error and keep the
 * user in edit mode so they can fix the value without losing their place.
 *
 * Footer note explicitly calls out the Ollama vs LM Studio asymmetry —
 * Ollama reloads with the new num_ctx parameter on the next request,
 * but LM Studio's context length is locked at model load time, so the
 * user must change it inside LM Studio first and then mirror the value
 * here. R13 also explains what response-timeout governs (request abort
 * on stalled streams, heartbeats and thinking blocks excluded).
 *
 * Backward compatibility: `currentResponseTimeout` is optional and
 * defaults to 300s (5m). The third arg of `onApply` is also optional
 * so existing 2-arg callers (Agent 8 will widen later) keep compiling.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { dimSeparator, noxPalette, textMuted, theme } from '../theme.js';

export interface CtxSizeOverlayProps {
  readonly currentMaxTokens: number;
  readonly currentKeepAlive: number;
  /** Optional: defaults to 300s (5m) when absent for backward compat. */
  readonly currentResponseTimeout?: number;
  /**
   * Third arg is optional so the existing 2-arg callers compile until
   * Agent 8 R10 wires the new value through. Once wiring lands, it'll
   * always be supplied.
   */
  readonly onApply: (
    maxTokens: number,
    keepAlive: number,
    responseTimeout?: number,
  ) => void;
  readonly onClose: () => void;
}

// ---- Preset tables ------------------------------------------------------

const CTX_PRESETS: readonly number[] = [4096, 8192, 16384, 32768, 65536, 131072];
const CTX_LABELS: readonly string[] = ['4K', '8K', '16K', '32K', '64K', '128K'];
const KEEP_PRESETS: readonly number[] = [0, 300, 1800, 3600, 86400];
const KEEP_LABELS: readonly string[] = ['0', '5m', '30m', '1h', '24h'];
const TIMEOUT_PRESETS: readonly number[] = [60, 180, 300, 600, 1800];
const TIMEOUT_LABELS: readonly string[] = ['1m', '3m', '5m', '10m', '30m'];

// Hard-coded ranges — also enforced server-side, but we clamp here so
// the user never lands on an unrecoverable Apply.
const CTX_MIN = 1024;
const CTX_MAX = 1_048_576;
const KEEP_MIN = 0;
const KEEP_MAX = 86_400;
const TIMEOUT_MIN = 30;
const TIMEOUT_MAX = 7200;

const DEFAULT_TIMEOUT = 300;

// ---- Focus model -------------------------------------------------------

type Row =
  | 'ctx-presets'
  | 'ctx-custom'
  | 'keep-presets'
  | 'keep-custom'
  | 'timeout-presets'
  | 'timeout-custom'
  | 'actions';

const ROW_ORDER: readonly Row[] = [
  'ctx-presets',
  'ctx-custom',
  'keep-presets',
  'keep-custom',
  'timeout-presets',
  'timeout-custom',
  'actions',
];

type EditingField = 'maxTokens' | 'keepAlive' | 'responseTimeout' | null;

// ---- Helpers -----------------------------------------------------------

/**
 * Pick the index of the preset closest to `current`; fall back to 1
 * (i.e. 8K / 5m) if `current` is absurdly small or missing. Keeps the
 * initial cursor at a sensible spot even when config holds an ad-hoc
 * value (which is exactly the case the new "custom" row exists to
 * cover).
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

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Strip everything that isn't a base-10 digit. Used as the live filter on
 * the custom TextInput's `onChange`; non-digit characters are dropped
 * silently rather than surfaced as an error so paste-with-commas works
 * (e.g. "80,000" → "80000").
 */
function digitsOnly(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (ch >= '0' && ch <= '9') {
      out += ch;
    }
  }
  return out;
}

/**
 * Parse a custom-field string against its [min..max] range. Empty
 * strings are rejected so the user can't accidentally Apply "0" by
 * tabbing through. Returns either a clean integer or a localized error
 * string suitable for inline display.
 */
function parseCustom(
  raw: string,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `${label} required` };
  }
  // digitsOnly() guarantees [0-9]+, but parseInt still has to confirm.
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

/**
 * Format keep-alive seconds in the human-friendly form used in the
 * preset chips ("0", "5m", "30m", "1h", "24h"). Falls back to "Ns" for
 * any custom value that doesn't land on a round preset.
 */
function formatKeepAlive(seconds: number): string {
  if (seconds === 0) return '0';
  if (seconds === 300) return '5m';
  if (seconds === 1800) return '30m';
  if (seconds === 3600) return '1h';
  if (seconds === 86400) return '24h';
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Format response-timeout seconds. Smaller-grained than keep-alive (we
 * never deal in days here), so we lean on minute / second formatting
 * with a fall-through to raw seconds for awkward values.
 */
function formatTimeout(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Format a context-window size for the inline summary. Uses "K" for
 * <1024K and "M" for ≥1024K so 80000 renders as "80K", 1_048_576 as
 * "1024K"… correction: per spec, ≥1024K shows "M". So 1_048_576 → "1M".
 */
function formatTokens(n: number): string {
  if (n >= 1024 * 1024) {
    const m = n / (1024 * 1024);
    // Trim trailing ".0" for whole-megs so 1M doesn't render as "1.0M".
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1024) {
    const k = n / 1024;
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return String(n);
}

// ---- Component ---------------------------------------------------------

function CtxSizeOverlay({
  currentMaxTokens,
  currentKeepAlive,
  currentResponseTimeout,
  onApply,
  onClose,
}: CtxSizeOverlayProps): React.JSX.Element {
  // Resolve the optional prop once; downstream code can treat it as a
  // plain number from here on out.
  const initialTimeout =
    currentResponseTimeout === undefined
      ? DEFAULT_TIMEOUT
      : currentResponseTimeout;

  const [row, setRow] = useState<Row>('ctx-presets');
  const [ctxIndex, setCtxIndex] = useState<number>(() =>
    nearestIndex(CTX_PRESETS, currentMaxTokens),
  );
  const [keepIndex, setKeepIndex] = useState<number>(() =>
    nearestIndex(KEEP_PRESETS, currentKeepAlive),
  );
  const [timeoutIndex, setTimeoutIndex] = useState<number>(() =>
    nearestIndex(TIMEOUT_PRESETS, initialTimeout),
  );

  // Drafts hold the *currently chosen* values across both preset and
  // custom rows. They start from the caller's props so users that opened
  // the overlay just to tweak keep-alive don't blow away their custom
  // window size by accident.
  const [draftMaxTokens, setDraftMaxTokens] = useState<number>(() =>
    clamp(Math.round(currentMaxTokens), CTX_MIN, CTX_MAX),
  );
  const [draftKeepAlive, setDraftKeepAlive] = useState<number>(() =>
    clamp(Math.round(currentKeepAlive), KEEP_MIN, KEEP_MAX),
  );
  const [draftResponseTimeout, setDraftResponseTimeout] = useState<number>(() =>
    clamp(Math.round(initialTimeout), TIMEOUT_MIN, TIMEOUT_MAX),
  );

  const [actionIndex, setActionIndex] = useState<number>(0); // 0 = Apply, 1 = Cancel

  // Inline-edit state for the three custom rows.
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [editBuffer, setEditBuffer] = useState<string>('');
  // Remount key so TextInput picks up a fresh defaultValue each open.
  const [editKey, setEditKey] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  // ---- Navigation helpers ------------------------------------------------

  const moveRow = useCallback(
    (direction: 1 | -1): void => {
      setRow((current) => {
        const idx = ROW_ORDER.indexOf(current);
        const next = (idx + direction + ROW_ORDER.length) % ROW_ORDER.length;
        return ROW_ORDER[next] ?? current;
      });
      // Leaving a custom row clears any stale error so the user isn't
      // left staring at red text once they're focused elsewhere.
      setError(null);
    },
    [],
  );

  // ---- Edit-mode helpers -------------------------------------------------

  const startEdit = useCallback(
    (field: 'maxTokens' | 'keepAlive' | 'responseTimeout'): void => {
      setEditingField(field);
      const current =
        field === 'maxTokens'
          ? draftMaxTokens
          : field === 'keepAlive'
            ? draftKeepAlive
            : draftResponseTimeout;
      setEditBuffer(String(current));
      setEditKey((k) => k + 1);
      setError(null);
    },
    [draftMaxTokens, draftKeepAlive, draftResponseTimeout],
  );

  const cancelEdit = useCallback((): void => {
    setEditingField(null);
    setEditBuffer('');
    setError(null);
  }, []);

  const commitEdit = useCallback(
    (raw: string): void => {
      const field = editingField;
      if (field === null) return;
      const min =
        field === 'maxTokens'
          ? CTX_MIN
          : field === 'keepAlive'
            ? KEEP_MIN
            : TIMEOUT_MIN;
      const max =
        field === 'maxTokens'
          ? CTX_MAX
          : field === 'keepAlive'
            ? KEEP_MAX
            : TIMEOUT_MAX;
      const label =
        field === 'maxTokens'
          ? 'Window'
          : field === 'keepAlive'
            ? 'Keep-alive'
            : 'Response timeout';
      const result = parseCustom(raw, min, max, label);
      if (!result.ok) {
        setError(result.error);
        // Stay in edit mode so the user can fix without retyping.
        return;
      }
      if (field === 'maxTokens') {
        setDraftMaxTokens(result.value);
        // If the new value happens to coincide with a preset chip,
        // realign the cursor so the highlight stays in sync.
        const matchIdx = CTX_PRESETS.indexOf(result.value);
        if (matchIdx >= 0) setCtxIndex(matchIdx);
      } else if (field === 'keepAlive') {
        setDraftKeepAlive(result.value);
        const matchIdx = KEEP_PRESETS.indexOf(result.value);
        if (matchIdx >= 0) setKeepIndex(matchIdx);
      } else {
        setDraftResponseTimeout(result.value);
        const matchIdx = TIMEOUT_PRESETS.indexOf(result.value);
        if (matchIdx >= 0) setTimeoutIndex(matchIdx);
      }
      setEditingField(null);
      setEditBuffer('');
      setError(null);
    },
    [editingField],
  );

  // Live filter — strip non-digits as they're typed so paste of "80,000"
  // resolves to "80000" without tripping the validator.
  const onEditChange = useCallback((raw: string): void => {
    setEditBuffer(digitsOnly(raw));
  }, []);

  // ---- Apply / Cancel ----------------------------------------------------

  const applyNow = useCallback((): void => {
    // Defensive clamp — the draft values are already inside-range under
    // the normal flow, but a corrupted prop or future code path could
    // skip the validation, and we'd rather pass a safe number to the
    // parent than blow up the backend.
    const ctx = clamp(Math.round(draftMaxTokens), CTX_MIN, CTX_MAX);
    const keep = clamp(Math.round(draftKeepAlive), KEEP_MIN, KEEP_MAX);
    const tmo = clamp(
      Math.round(draftResponseTimeout),
      TIMEOUT_MIN,
      TIMEOUT_MAX,
    );
    onApply(ctx, keep, tmo);
    // R22 (Agent 4) — close the overlay ourselves rather than relying
    // on the parent's onApply callback to dispatch CLOSE_OVERLAY. The
    // parent (`onCtxSizeApply` in app.tsx) does close, but only on a
    // happy-path render; if a future caller wires a no-op or async
    // handler that doesn't close synchronously, the overlay would
    // appear "stuck" to the user. Calling onClose() here makes the
    // component self-sufficient — Apply always dismisses the panel.
    // Idempotent: a duplicate CLOSE_OVERLAY dispatch on the parent is
    // a no-op (the reducer just sets overlayKind to null again).
    onClose();
  }, [draftMaxTokens, draftKeepAlive, draftResponseTimeout, onApply, onClose]);

  // ---- Top-level input dispatcher ---------------------------------------

  useInput(
    useCallback(
      (
        _input: string,
        key: {
          escape?: boolean;
          return?: boolean;
          tab?: boolean;
          leftArrow?: boolean;
          rightArrow?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
          shift?: boolean;
        },
      ): void => {
        // Edit mode: TextInput owns text + Enter; we only intercept Esc
        // so the user can bail without committing.
        if (editingField !== null) {
          if (key.escape === true) {
            cancelEdit();
          }
          return;
        }

        if (key.escape === true) {
          onClose();
          return;
        }
        if (key.tab === true) {
          moveRow(key.shift === true ? -1 : 1);
          return;
        }
        if (key.upArrow === true) {
          moveRow(-1);
          return;
        }
        if (key.downArrow === true) {
          moveRow(1);
          return;
        }

        if (key.leftArrow === true || key.rightArrow === true) {
          const direction: 1 | -1 = key.rightArrow === true ? 1 : -1;
          if (row === 'ctx-presets') {
            setCtxIndex((i) => {
              const next = (i + direction + CTX_PRESETS.length) % CTX_PRESETS.length;
              const presetVal = CTX_PRESETS[next];
              // Live-update the draft so the inline summary stays in
              // sync without requiring a separate Enter press.
              if (presetVal !== undefined) setDraftMaxTokens(presetVal);
              return next;
            });
            return;
          }
          if (row === 'keep-presets') {
            setKeepIndex((i) => {
              const next = (i + direction + KEEP_PRESETS.length) % KEEP_PRESETS.length;
              const presetVal = KEEP_PRESETS[next];
              if (presetVal !== undefined) setDraftKeepAlive(presetVal);
              return next;
            });
            return;
          }
          if (row === 'timeout-presets') {
            setTimeoutIndex((i) => {
              const next =
                (i + direction + TIMEOUT_PRESETS.length) % TIMEOUT_PRESETS.length;
              const presetVal = TIMEOUT_PRESETS[next];
              if (presetVal !== undefined) setDraftResponseTimeout(presetVal);
              return next;
            });
            return;
          }
          if (row === 'actions') {
            setActionIndex((i) => (i + direction + 2) % 2);
            return;
          }
          // Custom rows ignore ←/→ when not editing — they're for
          // chip-style cycling only.
          return;
        }

        if (key.return === true) {
          if (row === 'ctx-presets') {
            const v = CTX_PRESETS[ctxIndex];
            if (v !== undefined) setDraftMaxTokens(v);
            return;
          }
          if (row === 'keep-presets') {
            const v = KEEP_PRESETS[keepIndex];
            if (v !== undefined) setDraftKeepAlive(v);
            return;
          }
          if (row === 'timeout-presets') {
            const v = TIMEOUT_PRESETS[timeoutIndex];
            if (v !== undefined) setDraftResponseTimeout(v);
            return;
          }
          if (row === 'ctx-custom') {
            startEdit('maxTokens');
            return;
          }
          if (row === 'keep-custom') {
            startEdit('keepAlive');
            return;
          }
          if (row === 'timeout-custom') {
            startEdit('responseTimeout');
            return;
          }
          if (row === 'actions') {
            if (actionIndex === 0) applyNow();
            else onClose();
            return;
          }
        }
      },
      [
        actionIndex,
        applyNow,
        cancelEdit,
        ctxIndex,
        editingField,
        keepIndex,
        moveRow,
        onClose,
        row,
        startEdit,
        timeoutIndex,
      ],
    ),
  );

  // ---- Render helpers ---------------------------------------------------

  const summaryLine = useMemo(() => {
    const ctxLabel = formatTokens(draftMaxTokens);
    const keepLabel = formatKeepAlive(draftKeepAlive);
    const tmoLabel = formatTimeout(draftResponseTimeout);
    return `Draft: ${ctxLabel} window · ${keepLabel} keep-alive · ${tmoLabel} timeout`;
  }, [draftMaxTokens, draftKeepAlive, draftResponseTimeout]);

  const renderPresetRow = (
    labels: readonly string[],
    presets: readonly number[],
    index: number,
    active: boolean,
    draft: number,
  ): React.JSX.Element => (
    <Box flexDirection="row">
      {labels.map((label, i) => {
        const presetVal = presets[i];
        // Mark the chip as "selected" both when the user is hovering it
        // (active row + cursor) AND when its value matches the current
        // draft — so users can see at a glance which preset, if any,
        // their custom value happens to land on.
        const cursorHere = i === index;
        const matchesDraft = presetVal !== undefined && presetVal === draft;
        const isHot = active && cursorHere;
        const colour = isHot
          ? noxPalette.white
          : matchesDraft
            ? noxPalette.highlight
            : cursorHere
              ? noxPalette.light
              : textMuted;
        return (
          <Box key={`preset-${label}-${i}`} marginRight={1}>
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

  const renderCustomRow = (
    field: 'maxTokens' | 'keepAlive' | 'responseTimeout',
    active: boolean,
    draft: number,
    suffix: string,
  ): React.JSX.Element => {
    const isEditing = editingField === field;
    const placeholder =
      field === 'maxTokens'
        ? '80000'
        : field === 'keepAlive'
          ? '3600'
          : '300';
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
              onChange={onEditChange}
              onSubmit={commitEdit}
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
          borderColor={active ? noxPalette.light : dimSeparator}
          minWidth={16}
        >
          <Text
            color={active ? noxPalette.white : noxPalette.light}
            bold={active}
          >
            {display}
          </Text>
        </Box>
        <Box marginLeft={1}>
          <Text color={textMuted}>
            {suffix}
            {active ? '   (enter to edit)' : ''}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderActions = (): React.JSX.Element => {
    const labels = ['Apply', 'Cancel'];
    return (
      <Box flexDirection="row">
        {labels.map((label, i) => {
          const selected = i === actionIndex;
          const isHot = row === 'actions' && selected;
          if (isHot) {
            return (
              <Box key={`act-${label}`} marginRight={2}>
                <Text>{theme.selected(` [${label}] `)}</Text>
              </Box>
            );
          }
          return (
            <Box key={`act-${label}`} marginRight={2}>
              <Text
                color={selected ? noxPalette.light : textMuted}
                bold={selected}
              >
                {' '}
                [{label}]
                {' '}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  };

  // ---- Layout -----------------------------------------------------------

  // Wider label column now that the longest label is "Response timeout:"
  // — 18 cells leaves a comfortable gap before the chip strip.
  const LABEL_COL = 18;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={noxPalette.light}
      paddingX={1}
      paddingY={1}
    >
      <Box>
        <Text color={noxPalette.white} bold>
          Context Size
        </Text>
        <Text color={textMuted}>{`   ${summaryLine}`}</Text>
      </Box>

      {/* ----- Window presets ----- */}
      <Box flexDirection="row" marginTop={1}>
        <Box width={LABEL_COL}>
          <Text color={row === 'ctx-presets' ? noxPalette.light : textMuted}>
            {row === 'ctx-presets' ? '❯ ' : '  '}Window:
          </Text>
        </Box>
        {renderPresetRow(CTX_LABELS, CTX_PRESETS, ctxIndex, row === 'ctx-presets', draftMaxTokens)}
      </Box>

      {/* ----- Window custom ----- */}
      <Box flexDirection="row" marginTop={1}>
        <Box width={LABEL_COL}>
          <Text color={row === 'ctx-custom' ? noxPalette.light : textMuted}>
            {row === 'ctx-custom' ? '❯ ' : '  '}Custom:
          </Text>
        </Box>
        {renderCustomRow('maxTokens', row === 'ctx-custom', draftMaxTokens, 'tokens')}
      </Box>

      {/* ----- Keep-alive presets ----- */}
      <Box flexDirection="row" marginTop={1}>
        <Box width={LABEL_COL}>
          <Text color={row === 'keep-presets' ? noxPalette.light : textMuted}>
            {row === 'keep-presets' ? '❯ ' : '  '}Keep-alive:
          </Text>
        </Box>
        {renderPresetRow(KEEP_LABELS, KEEP_PRESETS, keepIndex, row === 'keep-presets', draftKeepAlive)}
      </Box>

      {/* ----- Keep-alive custom ----- */}
      <Box flexDirection="row" marginTop={1}>
        <Box width={LABEL_COL}>
          <Text color={row === 'keep-custom' ? noxPalette.light : textMuted}>
            {row === 'keep-custom' ? '❯ ' : '  '}Custom:
          </Text>
        </Box>
        {renderCustomRow('keepAlive', row === 'keep-custom', draftKeepAlive, 'seconds')}
      </Box>

      {/* ----- Response-timeout presets ----- */}
      <Box flexDirection="row" marginTop={1}>
        <Box width={LABEL_COL}>
          <Text color={row === 'timeout-presets' ? noxPalette.light : textMuted}>
            {row === 'timeout-presets' ? '❯ ' : '  '}Response timeout:
          </Text>
        </Box>
        {renderPresetRow(
          TIMEOUT_LABELS,
          TIMEOUT_PRESETS,
          timeoutIndex,
          row === 'timeout-presets',
          draftResponseTimeout,
        )}
      </Box>

      {/* ----- Response-timeout custom ----- */}
      <Box flexDirection="row" marginTop={1}>
        <Box width={LABEL_COL}>
          <Text color={row === 'timeout-custom' ? noxPalette.light : textMuted}>
            {row === 'timeout-custom' ? '❯ ' : '  '}Custom:
          </Text>
        </Box>
        {renderCustomRow(
          'responseTimeout',
          row === 'timeout-custom',
          draftResponseTimeout,
          'seconds (30..7200)',
        )}
      </Box>

      {/* ----- Actions ----- */}
      <Box flexDirection="row" marginTop={1}>
        <Box width={LABEL_COL}>
          <Text color={row === 'actions' ? noxPalette.light : textMuted}>
            {row === 'actions' ? '❯ ' : '  '}
          </Text>
        </Box>
        {renderActions()}
      </Box>

      {error !== null && (
        <Box marginTop={1}>
          <Text color="#fca5a5">Error: {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={textMuted}>
          ↑/↓ rows · ←/→ cycle preset · (enter) confirm/edit · (esc) cancel
        </Text>
      </Box>

      <Box>
        <Text color={textMuted} italic>
          Note: Ollama models reload with the new num_ctx. LM Studio&apos;s context is set at model load — change it in LM Studio first, then match it here. Response timeout aborts the request if the model produces no content for that many seconds (heartbeats and thinking blocks don&apos;t count). Increase if your model writes long code slowly.
        </Text>
      </Box>
    </Box>
  );
}

export default CtxSizeOverlay;
