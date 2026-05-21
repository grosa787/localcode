/**
 * `/provider` overlay — FIX #33 (R27 expansion to all 7 providers).
 *
 * Originally a three-row picker (Ollama / LM Studio / Custom). R27
 * widens it to cover every `Backend` declared in `src/types/global.d.ts`
 * — the four cloud providers (OpenAI, Anthropic, OpenRouter, Google)
 * gain an API-key field on top of the existing URL editor:
 *
 *   <ProviderOverlay
 *     currentBackend={cfg.backend.type}
 *     urls={{ ollama, lmstudio, openai, anthropic, openrouter,
 *             google, custom }}
 *     apiKeys={{ openai, anthropic, openrouter, google, custom }}
 *     onApply={(backend, baseUrl, apiKey) => …}
 *     onCancel={() => …}
 *     onPing={async (u) => fetch(u) …}  // optional liveness probe
 *   />
 *
 * Keybindings:
 *   ↑/↓           — navigate rows
 *   space         — select that row's provider as active (the ● dot)
 *   enter         — enter URL edit mode for the highlighted row
 *     (enter)     — commit URL edit, back to row navigation
 *     (esc)       — discard URL edit, back to row navigation
 *   tab / 'e'     — when on a cloud row, jump straight into KEY edit
 *                   mode (skips URL edit). Inside URL edit, tab also
 *                   commits-current-URL → KEY edit, so the user can
 *                   one-shot edit both fields without leaving the row.
 *   ctrl+enter    — apply and close (calls onApply with the selected
 *                   backend, its current URL, and its current API key
 *                   when the provider is a cloud one).
 *   a             — alternative apply key for terminals that swallow
 *                   ctrl+enter.
 *   esc           — cancel, closes without calling onApply.
 *
 * Per-row UI:
 *   [●] OpenAI               https://api.openai.com/v1   [edit] [key: sk-●●● set]
 *   [ ] Google Gemini        https://generative…          [edit] [key: from env $GEMINI_API_KEY]
 *
 * For local providers (`ollama`, `lmstudio`) the key cell is omitted
 * — they don't require auth. For `custom`, the key is optional; the
 * apply-time validator only requires the URL.
 *
 * Ping indicator:
 *   If `onPing` is provided, on mount and whenever the selected
 *   provider changes we ping its current URL and render a coloured
 *   ● next to the row (green = alive, red = unreachable). Edits to the
 *   URL debounce the next ping by ~400 ms so fast typing doesn't spam
 *   the target. Pings for non-selected rows are not fired — keeps the
 *   MVP light.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { noxPalette, textMuted } from '../theme.js';
import type { Backend } from '../../types/global.js';
import { PROVIDER_DEFAULTS, PROVIDER_META } from '../../config/defaults.js';

/**
 * URLs keyed by Backend — one entry per row in the overlay.
 *
 * Every backend is required so the overlay never has to render an
 * undefined cell. Callers that don't have a saved URL for a given
 * provider should seed the field from
 * `PROVIDER_DEFAULTS[backend].baseUrl`.
 */
export interface ProviderUrls {
  readonly ollama: string;
  readonly lmstudio: string;
  readonly openai: string;
  readonly anthropic: string;
  readonly openrouter: string;
  readonly google: string;
  readonly custom: string;
}

/**
 * API keys keyed by Backend. Local providers (`ollama`, `lmstudio`)
 * have no key field, so they're omitted from the type. Cloud providers
 * may also be left empty — `resolveApiKey()` falls back to the
 * provider's published env var (e.g. `OPENAI_API_KEY`).
 */
export interface ProviderApiKeys {
  readonly openai: string;
  readonly anthropic: string;
  readonly openrouter: string;
  readonly google: string;
  readonly custom: string;
}

/**
 * Row identifier — one per Backend. Mirrors `Backend` exactly so the
 * apply payload doesn't need a translation step.
 */
export type ProviderRow = Backend;

export interface ProviderOverlayProps {
  readonly currentBackend: Backend;
  readonly urls: ProviderUrls;
  /**
   * R27 addition. Optional for backwards compatibility — callers that
   * haven't been updated yet pass an undefined record and the cloud
   * rows render with empty key fields (still resolvable via env vars).
   */
  readonly apiKeys?: ProviderApiKeys;
  /**
   * R27 widened signature — third arg is the API key for cloud
   * providers (or `undefined` for local/empty). Existing callers that
   * ignore the third arg keep working unchanged.
   */
  readonly onApply: (
    backend: Backend,
    baseUrl: string,
    apiKey?: string,
  ) => void;
  readonly onCancel: () => void;
  /**
   * Optional liveness probe; returns true if the URL is reachable.
   * When provided, a coloured dot is rendered next to the active row.
   */
  readonly onPing?: (url: string) => Promise<boolean>;
}

interface RowDescriptor {
  readonly id: ProviderRow;
  readonly defaultUrl: string;
  /** True when the provider needs an API key (cloud). */
  readonly requiresApiKey: boolean;
  /** True when the provider supports an API key (cloud + custom). */
  readonly supportsApiKey: boolean;
}

/**
 * Row order — mirrors the visual top-to-bottom layout. Local first
 * (the recommended path for new users), then cloud ordered by
 * familiarity, custom last (escape hatch).
 */
const ROW_ORDER: readonly Backend[] = [
  'ollama',
  'lmstudio',
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'custom',
];

const ROWS: readonly RowDescriptor[] = ROW_ORDER.map((id) => ({
  id,
  defaultUrl: PROVIDER_DEFAULTS[id].baseUrl,
  requiresApiKey: PROVIDER_DEFAULTS[id].requiresApiKey,
  // `custom` doesn't strictly require a key but supports one.
  supportsApiKey:
    PROVIDER_DEFAULTS[id].requiresApiKey || id === 'custom',
}));

const LABEL_WIDTH = 26;
const URL_WIDTH = 36;
const PING_DEBOUNCE_MS = 400;

type PingState = 'idle' | 'pending' | 'alive' | 'dead';

/** Two edit slots per row — URL or API key. */
type EditField = 'url' | 'key';

interface EditCursor {
  readonly row: ProviderRow;
  readonly field: EditField;
}

/**
 * Validate a candidate base URL.
 *
 * - Empty is treated as valid here; the apply-time validator below
 *   surfaces a tailored error for "URL required" cases.
 * - For cloud providers we additionally reject non-https() schemes
 *   (caller passes `requireHttps`).
 */
function isValidUrl(raw: string, requireHttps: boolean): boolean {
  const u = raw.trim();
  if (u.length === 0) return true;
  if (requireHttps) return /^https?:\/\//.test(u);
  return /^https?:\/\//.test(u);
}

/**
 * Mutable counterpart to `ProviderUrls` used internally while we mutate
 * a freshly-cloned record before handing it back to React state.
 */
type MutableProviderUrls = {
  -readonly [K in keyof ProviderUrls]: ProviderUrls[K];
};

type MutableProviderApiKeys = {
  -readonly [K in keyof ProviderApiKeys]: ProviderApiKeys[K];
};

function cloneUrls(u: ProviderUrls): MutableProviderUrls {
  return {
    ollama: u.ollama,
    lmstudio: u.lmstudio,
    openai: u.openai,
    anthropic: u.anthropic,
    openrouter: u.openrouter,
    google: u.google,
    custom: u.custom,
  };
}

function cloneKeys(k: ProviderApiKeys): MutableProviderApiKeys {
  return {
    openai: k.openai,
    anthropic: k.anthropic,
    openrouter: k.openrouter,
    google: k.google,
    custom: k.custom,
  };
}

const EMPTY_KEYS: ProviderApiKeys = {
  openai: '',
  anthropic: '',
  openrouter: '',
  google: '',
  custom: '',
};

/**
 * Mask an API key for display.
 *
 * Shows the leading 3 chars + 8 fixed dots + the trailing 3 chars in
 * parens — enough to identify *which* key is configured (e.g. distinguish
 * a personal key from a team key) without revealing the secret.
 *
 * Examples:
 *   'sk-abc123def456ghi'  → 'sk-●●●●●●●● (ghi)'
 *   ''                    → 'not set'
 *   'short'               → '●●●●'        (too short to mask safely)
 */
export function maskKey(key: string | undefined): string {
  if (key === undefined || key.length === 0) return 'not set';
  if (key.length < 8) return '●●●●';
  return `${key.slice(0, 3)}${'●'.repeat(8)} (${key.slice(-3)})`;
}

/**
 * Type-narrowing helper — true when the row id refers to a cloud
 * provider that surfaces an API key in `ProviderApiKeys`.
 */
function isApiKeyRow(
  row: ProviderRow,
): row is keyof ProviderApiKeys {
  return row !== 'ollama' && row !== 'lmstudio';
}

/**
 * Resolve a backend's effective key for display purposes — either the
 * configured value (passed in via props) or the env-var fallback
 * declared in `PROVIDER_META[backend].apiKeyEnvVar`.
 *
 * Mirrors `resolveApiKey` in `src/config/defaults.ts` but reads from
 * the in-memory edit state so the user sees their unsaved edits
 * reflected in the "set"/"not set" indicator immediately.
 */
function resolveDisplayKey(
  row: ProviderRow,
  configKey: string,
): { value: string; source: 'config' | 'env' | 'none'; envVar?: string } {
  if (configKey.length > 0) return { value: configKey, source: 'config' };
  const meta = PROVIDER_META[row];
  if (meta.apiKeyEnvVar !== undefined) {
    const fromEnv = process.env[meta.apiKeyEnvVar];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return { value: fromEnv, source: 'env', envVar: meta.apiKeyEnvVar };
    }
    return { value: '', source: 'none', envVar: meta.apiKeyEnvVar };
  }
  return { value: '', source: 'none' };
}

function ProviderOverlay({
  currentBackend,
  urls,
  apiKeys,
  onApply,
  onCancel,
  onPing,
}: ProviderOverlayProps): React.JSX.Element {
  // Which row the user is currently highlighting with the arrow keys.
  const [cursor, setCursor] = useState<number>(() => {
    const idx = ROWS.findIndex((r) => r.id === currentBackend);
    return idx >= 0 ? idx : 0;
  });

  // Which provider is currently *selected* (the ● dot). Initialised to
  // the caller's currentBackend.
  const [selected, setSelected] = useState<ProviderRow>(currentBackend);

  // Editable URL map — held locally so edits are transient until apply.
  const [urlMap, setUrlMap] = useState<ProviderUrls>(() => cloneUrls(urls));
  // Editable API-key map — same pattern. Falls back to EMPTY_KEYS when
  // the caller hasn't passed `apiKeys` (back-compat).
  const [keyMap, setKeyMap] = useState<ProviderApiKeys>(() =>
    apiKeys === undefined ? EMPTY_KEYS : cloneKeys(apiKeys),
  );

  // Edit mode for the row under the cursor. `null` = not editing.
  const [editing, setEditing] = useState<EditCursor | null>(null);
  // Remount key so TextInput picks up a fresh defaultValue each edit.
  const [editKey, setEditKey] = useState<number>(0);

  const [pingState, setPingState] = useState<PingState>('idle');

  // Debounce timer for ping triggered by URL edits.
  const pingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonically increasing token so stale ping responses are ignored.
  const pingToken = useRef<number>(0);

  const currentRow: RowDescriptor = ROWS[cursor] ?? ROWS[0]!;
  const selectedUrl = useMemo(() => urlMap[selected], [urlMap, selected]);
  const selectedKey = useMemo<string>(() => {
    if (!isApiKeyRow(selected)) return '';
    return keyMap[selected];
  }, [keyMap, selected]);
  const selectedRequiresKey = useMemo<boolean>(() => {
    return PROVIDER_DEFAULTS[selected].requiresApiKey;
  }, [selected]);

  /**
   * Validation for the *selected* provider. Apply is gated on this
   * being null. We surface tailored messages for empty URL / bad
   * scheme / missing key so the user knows exactly what to fix.
   */
  const validationError = useMemo<string | null>(() => {
    const u = selectedUrl.trim();
    // URL required for `custom`; for cloud providers we also require
    // a non-empty URL (the default is pre-seeded so this should only
    // fire if the user blanks the field).
    if (u.length === 0) {
      if (selected === 'custom') return 'Custom URL required';
      if (selectedRequiresKey) return 'Cloud provider URL is empty';
      return null;
    }
    // Cloud providers must use http(s) — explicitly reject localhost
    // so a misconfigured cloud row doesn't silently point at a local
    // tunnel. Local providers and custom keep the relaxed check.
    if (selectedRequiresKey) {
      if (!/^https?:\/\//.test(u)) {
        return 'URL must start with http:// or https://';
      }
      // Reject localhost for cloud providers — almost certainly a
      // misconfig. (The user can use `custom` for tunneled cloud
      // endpoints.)
      if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(u)) {
        return 'Cloud provider URL must not be localhost';
      }
    } else {
      if (!isValidUrl(u, false)) {
        return 'URL must start with http:// or https://';
      }
    }
    // API-key check for cloud providers — accept either an explicit
    // key or a non-empty env-var fallback.
    if (selectedRequiresKey && isApiKeyRow(selected)) {
      const resolved = resolveDisplayKey(selected, keyMap[selected]);
      if (resolved.source === 'none') {
        const meta = PROVIDER_META[selected];
        const envHint =
          meta.apiKeyEnvVar !== undefined
            ? ` (or set $${meta.apiKeyEnvVar})`
            : '';
        return `API key required for ${meta.displayName}${envHint}`;
      }
    }
    return null;
  }, [keyMap, selected, selectedRequiresKey, selectedUrl]);

  const triggerPing = useCallback(
    (url: string): void => {
      if (onPing === undefined) return;
      const token = pingToken.current + 1;
      pingToken.current = token;
      setPingState('pending');
      void onPing(url)
        .then((alive) => {
          if (pingToken.current !== token) return;
          setPingState(alive ? 'alive' : 'dead');
        })
        .catch(() => {
          if (pingToken.current !== token) return;
          setPingState('dead');
        });
    },
    [onPing],
  );

  const schedulePing = useCallback(
    (url: string): void => {
      if (onPing === undefined) return;
      if (pingTimer.current !== null) {
        clearTimeout(pingTimer.current);
      }
      pingTimer.current = setTimeout(() => {
        triggerPing(url);
      }, PING_DEBOUNCE_MS);
    },
    [onPing, triggerPing],
  );

  // Ping the selected provider on mount and whenever selection changes.
  useEffect(() => {
    if (onPing === undefined) return;
    const url = urlMap[selected];
    if (url.trim().length === 0) {
      setPingState('idle');
      return;
    }
    triggerPing(url);
    // We intentionally depend on `selected` only — URL edits go through
    // schedulePing() in the TextInput onChange handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, onPing]);

  // Cleanup on unmount.
  useEffect(() => {
    return (): void => {
      if (pingTimer.current !== null) {
        clearTimeout(pingTimer.current);
        pingTimer.current = null;
      }
    };
  }, []);

  const applyNow = useCallback((): void => {
    if (validationError !== null) return;
    const baseUrl = selectedUrl.trim();
    if (isApiKeyRow(selected)) {
      const explicit = keyMap[selected];
      // Pass an explicit key only when the user actually typed one;
      // empty string → undefined so the caller (and resolveApiKey)
      // falls back to the env var cleanly.
      const apiKey = explicit.length > 0 ? explicit : undefined;
      onApply(selected, baseUrl, apiKey);
      return;
    }
    onApply(selected, baseUrl, undefined);
  }, [keyMap, onApply, selected, selectedUrl, validationError]);

  const enterUrlEdit = useCallback((): void => {
    setEditing({ row: currentRow.id, field: 'url' });
    setEditKey((k) => k + 1);
  }, [currentRow]);

  const enterKeyEdit = useCallback((): void => {
    if (!currentRow.supportsApiKey) return;
    setEditing({ row: currentRow.id, field: 'key' });
    setEditKey((k) => k + 1);
  }, [currentRow]);

  const writeUrl = useCallback(
    (row: ProviderRow, value: string): void => {
      setUrlMap((prev) => {
        const next: MutableProviderUrls = cloneUrls(prev);
        next[row] = value;
        return next;
      });
    },
    [],
  );

  const writeKey = useCallback(
    (row: ProviderRow, value: string): void => {
      if (!isApiKeyRow(row)) return;
      setKeyMap((prev) => {
        const next: MutableProviderApiKeys = cloneKeys(prev);
        next[row] = value;
        return next;
      });
    },
    [],
  );

  const commitEdit = useCallback(
    (value: string): void => {
      if (editing === null) return;
      const { row, field } = editing;
      if (field === 'url') {
        writeUrl(row, value);
        if (row === selected) schedulePing(value);
      } else {
        writeKey(row, value);
      }
      setEditing(null);
    },
    [editing, schedulePing, selected, writeKey, writeUrl],
  );

  const updateEditLive = useCallback(
    (value: string): void => {
      if (editing === null) return;
      const { row, field } = editing;
      if (field === 'url') writeUrl(row, value);
      else writeKey(row, value);
    },
    [editing, writeKey, writeUrl],
  );

  /**
   * On Esc inside an edit, restore the row's original value (from the
   * props snapshot taken on mount, not the current state) and exit
   * edit mode. We keep the props in a closure-stable ref so successive
   * edits in the same session restore consistently.
   */
  const propsUrlsRef = useRef<ProviderUrls>(urls);
  const propsKeysRef = useRef<ProviderApiKeys>(
    apiKeys === undefined ? EMPTY_KEYS : apiKeys,
  );
  // Update on each render — cheap and lets the parent push fresh
  // values mid-session if it ever needs to (rare).
  propsUrlsRef.current = urls;
  if (apiKeys !== undefined) propsKeysRef.current = apiKeys;

  useInput(
    useCallback(
      (
        input: string,
        key: {
          escape?: boolean;
          return?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
          tab?: boolean;
          ctrl?: boolean;
        },
      ): void => {
        // While TextInput is mounted it captures Enter/typing; we only
        // intercept Esc here to cancel the edit cleanly, plus Tab to
        // hop URL ↔ key inside the same row.
        if (editing !== null) {
          if (key.escape === true) {
            // Restore the original value for the row+field being edited.
            if (editing.field === 'url') {
              writeUrl(editing.row, propsUrlsRef.current[editing.row]);
            } else if (isApiKeyRow(editing.row)) {
              writeKey(editing.row, propsKeysRef.current[editing.row]);
            }
            setEditing(null);
            return;
          }
          if (key.tab === true) {
            // Tab from URL → key (cloud only). Tab from key cycles back
            // to URL. Falls through to a no-op for local rows.
            const row = editing.row;
            const desc = ROWS.find((r) => r.id === row);
            if (desc !== undefined && desc.supportsApiKey) {
              const nextField: EditField =
                editing.field === 'url' ? 'key' : 'url';
              setEditing({ row, field: nextField });
              setEditKey((k) => k + 1);
            }
            return;
          }
          return;
        }

        if (key.escape === true) {
          onCancel();
          return;
        }

        // Ctrl+Enter or plain 'a' → apply.
        if ((key.ctrl === true && key.return === true) || input === 'a' || input === 'A') {
          applyNow();
          return;
        }

        if (key.upArrow === true) {
          setCursor((i) => (i - 1 + ROWS.length) % ROWS.length);
          return;
        }
        if (key.downArrow === true) {
          setCursor((i) => (i + 1) % ROWS.length);
          return;
        }

        if (input === ' ') {
          setSelected(currentRow.id);
          return;
        }

        if (key.return === true) {
          enterUrlEdit();
          return;
        }

        // Tab or 'e' from row navigation → jump into KEY edit (cloud rows).
        if (key.tab === true || input === 'e' || input === 'E') {
          enterKeyEdit();
          return;
        }
      },
      [
        applyNow,
        currentRow,
        editing,
        enterKeyEdit,
        enterUrlEdit,
        onCancel,
        writeKey,
        writeUrl,
      ],
    ),
  );

  const renderPingDot = (row: ProviderRow): React.JSX.Element | null => {
    if (onPing === undefined) return null;
    if (row !== selected) return null;
    let colour: string = textMuted;
    let glyph: string = '·';
    if (pingState === 'alive') {
      colour = '#86efac';
      glyph = '●';
    } else if (pingState === 'dead') {
      colour = '#fca5a5';
      glyph = '●';
    } else if (pingState === 'pending') {
      colour = noxPalette.yellow;
      glyph = '◌';
    }
    return (
      <Text color={colour}>
        {' '}
        {glyph}
      </Text>
    );
  };

  const renderUrlCell = (
    row: RowDescriptor,
    active: boolean,
  ): React.JSX.Element => {
    const value = urlMap[row.id];
    const isEditing = editing?.row === row.id && editing.field === 'url';
    if (isEditing) {
      return (
        <Box width={URL_WIDTH} paddingX={1} borderStyle="round" borderColor={noxPalette.light}>
          <TextInput
            key={`url-${editKey}`}
            defaultValue={value}
            placeholder={
              row.defaultUrl.length > 0 ? row.defaultUrl : 'https://…'
            }
            onChange={updateEditLive}
            onSubmit={commitEdit}
          />
        </Box>
      );
    }
    const display = value.length === 0 ? '(not set)' : value;
    const colour =
      value.length === 0 ? textMuted : active ? noxPalette.white : noxPalette.light;
    return (
      <Box width={URL_WIDTH}>
        <Text color={colour}>{display}</Text>
      </Box>
    );
  };

  const renderKeyCell = (
    row: RowDescriptor,
    active: boolean,
  ): React.JSX.Element | null => {
    if (!row.supportsApiKey) return null;
    if (!isApiKeyRow(row.id)) return null;
    const isEditing = editing?.row === row.id && editing.field === 'key';
    if (isEditing) {
      // Plain-text key entry (terminal masking is unreliable across
      // emulators). The hint below the rows reminds the user the
      // value is visible during typing.
      const value = keyMap[row.id];
      return (
        <Box paddingX={1} borderStyle="round" borderColor={noxPalette.yellow}>
          <Text color={textMuted}>key </Text>
          <TextInput
            key={`key-${editKey}`}
            defaultValue={value}
            placeholder={
              row.requiresApiKey ? 'sk-…' : '(optional)'
            }
            onChange={updateEditLive}
            onSubmit={commitEdit}
          />
        </Box>
      );
    }
    const configKey = keyMap[row.id];
    const resolved = resolveDisplayKey(row.id, configKey);
    let label: string;
    let colour: string = textMuted;
    if (resolved.source === 'config') {
      label = `key: ${maskKey(configKey)} set`;
      colour = active ? noxPalette.white : noxPalette.light;
    } else if (resolved.source === 'env' && resolved.envVar !== undefined) {
      label = `key: from env $${resolved.envVar}`;
      colour = '#86efac';
    } else {
      label = row.requiresApiKey ? 'key: not set' : 'key: optional';
      colour = row.requiresApiKey ? '#fca5a5' : textMuted;
    }
    return (
      <Box marginLeft={1}>
        <Text color={colour}>[{label}]</Text>
      </Box>
    );
  };

  const editingHint: string | null = useMemo(() => {
    if (editing === null) return null;
    if (editing.field === 'url') {
      return 'Editing URL — Enter to save · Tab to switch to key · Esc to cancel';
    }
    return 'Editing API key (visible — clear after pasting) · Enter to save · Tab to switch to URL · Esc to cancel';
  }, [editing]);

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
          Provider
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {ROWS.map((row, i) => {
          const active = i === cursor;
          const isSelected = selected === row.id;
          const arrow = active ? '❯ ' : '  ';
          const dot = isSelected ? '●' : ' ';
          const meta = PROVIDER_META[row.id];
          return (
            <Box key={`prov-${row.id}`} flexDirection="row" marginBottom={0}>
              <Text color={active ? noxPalette.light : textMuted}>{arrow}</Text>
              <Text color={isSelected ? noxPalette.light : textMuted}>
                [{dot}]
              </Text>
              <Text>{' '}</Text>
              <Box width={LABEL_WIDTH}>
                <Text color={active ? noxPalette.white : noxPalette.light}>
                  {meta.displayName}
                </Text>
              </Box>
              {renderUrlCell(row, active)}
              {active && (editing === null || editing.row !== row.id) && (
                <Text color={textMuted}>{'  '}[edit]</Text>
              )}
              {renderKeyCell(row, active)}
              {renderPingDot(row.id)}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={textMuted}>
          Notes:
        </Text>
        <Text color={textMuted}>
          {'  • '}OpenRouter from Russia: VPN may be required (Россия
          блокирует OpenRouter напрямую). Use Cloudflare WARP, Outline
          VPN, or proxy via the Custom row.
        </Text>
        <Text color={textMuted}>
          {'  • '}Cloud providers need an API key — get one from each
          provider's dashboard, or set the env var (e.g. $OPENAI_API_KEY).
        </Text>
        {selected === 'openrouter' && (
          <Text color={noxPalette.yellow}>
            {'  ! '}OpenRouter selected — confirm you can reach
            openrouter.ai before applying.
          </Text>
        )}
      </Box>

      {validationError !== null && (
        <Box marginTop={1}>
          <Text color="#fca5a5">Error: {validationError}</Text>
        </Box>
      )}

      {editingHint !== null && (
        <Box marginTop={1}>
          <Text color={textMuted}>{editingHint}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={textMuted}>
          ↑/↓ navigate · (space) select · (enter) edit URL · (tab/e) edit
          key · (ctrl+enter / a) apply · (esc) cancel
        </Text>
      </Box>
    </Box>
  );
}

export default ProviderOverlay;
