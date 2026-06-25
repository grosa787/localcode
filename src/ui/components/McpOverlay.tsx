/**
 * `/mcp` add-server overlay.
 *
 * Bare `/mcp` opens this takeover overlay so the user can register their
 * own HTTP MCP server (URL + optional auth) and connect to it right
 * away. `/mcp browse …` still routes to the marketplace.
 *
 * Structural mirror of {@link ProviderOverlay}: a full-takeover ink
 * overlay with text-input fields, top-to-bottom navigation, a per-field
 * edit mode, Ctrl+Enter (or `a`) to apply, Esc to cancel.
 *
 *   <McpOverlay
 *     existingServers={['github', 'fs']}
 *     onApply={({ name, server }) => …}    // persist + registry.start
 *     onClose={() => …}
 *   />
 *
 * Keybindings:
 *   ↑/↓           — move between fields
 *   ←/→ or space  — cycle the auth type (None / Bearer / Basic)
 *   enter         — enter edit mode for a text field
 *     (enter)     — commit edit, back to navigation
 *     (esc)       — discard edit, back to navigation
 *   ctrl+enter    — apply (build the server, fire onApply)
 *   a             — alternative apply key for terminals that swallow
 *                   ctrl+enter
 *   esc           — cancel, close without applying
 *
 * Auth → headers mapping (see {@link buildMcpServerFromForm}):
 *   None    → no Authorization header
 *   Bearer  → { Authorization: 'Bearer <token>' }
 *   Basic   → { Authorization: 'Basic <base64(login:password)>' }
 *
 * URL is normalised: a bare `host:port` (no scheme) gets `http://`
 * prepended before validation.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { noxPalette, textMuted } from '../theme.js';
import type { McpServerConfig } from '../../types/global.js';
// I18N-STRINGS-START
import { useT } from '../../i18n/index.js';
// I18N-STRINGS-END

/** Auth modes the user can cycle through. */
export type McpAuthKind = 'none' | 'bearer' | 'basic';

const AUTH_ORDER: readonly McpAuthKind[] = ['none', 'bearer', 'basic'];

/** Raw form state — purely strings + the auth selector. */
export interface McpServerForm {
  readonly name: string;
  readonly url: string;
  readonly auth: McpAuthKind;
  readonly token: string;
  readonly login: string;
  readonly password: string;
  /**
   * Existing server names — used by the helper to reject duplicates.
   * Optional so unit tests can omit it for the "no duplicates" path.
   */
  readonly existingNames?: readonly string[];
}

/** Discriminated result of {@link buildMcpServerFromForm}. */
export type BuildMcpResult =
  | { readonly name: string; readonly server: McpServerConfig }
  | { readonly error: string };

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Error codes returned by {@link buildMcpServerFromForm}. The codes are
 * stable (testable without i18n); the UI maps them to localised strings.
 */
export type McpFormErrorCode =
  | 'nameRequired'
  | 'nameInvalid'
  | 'nameDuplicate'
  | 'urlRequired'
  | 'urlInvalid'
  | 'tokenRequired'
  | 'loginRequired'
  | 'passwordRequired';

/**
 * Normalise a user-supplied URL. A bare `host:port` (or `host`) with no
 * scheme gets `http://` prepended so the LAN-IP case the user asked for
 * (`192.168.1.10:8080`) works without them typing the scheme.
 */
export function normalizeMcpUrl(raw: string): string {
  const u = raw.trim();
  if (u.length === 0) return u;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) return u;
  return `http://${u}`;
}

/**
 * Base64-encode a UTF-8 string without depending on Node's Buffer typings
 * leaking `any`. `btoa` only handles Latin-1, so we widen via TextEncoder
 * and map bytes to a binary string first.
 */
function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/**
 * Pure validation + header construction. The component calls this; tests
 * test it directly. Returns either `{ name, server }` ready for
 * `config.mcpServers[name] = server` + `registry.start`, or `{ error }`
 * with a stable error code (the UI localises it).
 */
export function buildMcpServerFromForm(form: McpServerForm): BuildMcpResult {
  const name = form.name.trim();
  if (name.length === 0) return { error: 'nameRequired' };
  if (!NAME_PATTERN.test(name)) return { error: 'nameInvalid' };
  const existing = form.existingNames ?? [];
  if (existing.includes(name)) return { error: 'nameDuplicate' };

  const rawUrl = form.url.trim();
  if (rawUrl.length === 0) return { error: 'urlRequired' };
  const url = normalizeMcpUrl(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'urlInvalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'urlInvalid' };
  }

  const headers: Record<string, string> = {};
  if (form.auth === 'bearer') {
    const token = form.token.trim();
    if (token.length === 0) return { error: 'tokenRequired' };
    headers.Authorization = `Bearer ${token}`;
  } else if (form.auth === 'basic') {
    const login = form.login.trim();
    // Password is intentionally NOT trimmed — leading/trailing spaces
    // can be significant in a credential. We only reject the empty case.
    const password = form.password;
    if (login.length === 0) return { error: 'loginRequired' };
    if (password.length === 0) return { error: 'passwordRequired' };
    headers.Authorization = `Basic ${base64Utf8(`${login}:${password}`)}`;
  }

  const server: McpServerConfig = {
    type: 'http',
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  return { name, server };
}

/** Fields in top-to-bottom order. Conditional on the selected auth. */
type FieldId = 'name' | 'url' | 'auth' | 'token' | 'login' | 'password';

interface FieldDescriptor {
  readonly id: FieldId;
  /** True for secret fields (token, password) — show the paste warning. */
  readonly secret: boolean;
}

export interface McpOverlayProps {
  /** Names of already-configured servers, for the context list + dup check. */
  readonly existingServers?: readonly string[];
  readonly onApply: (result: {
    readonly name: string;
    readonly server: McpServerConfig;
  }) => void;
  readonly onClose: () => void;
}

const LABEL_WIDTH = 12;

function McpOverlay({
  existingServers,
  onApply,
  onClose,
}: McpOverlayProps): React.JSX.Element {
  // I18N-STRINGS-START
  const { t } = useT();
  // I18N-STRINGS-END

  const [name, setName] = useState<string>('');
  const [url, setUrl] = useState<string>('');
  const [auth, setAuth] = useState<McpAuthKind>('none');
  const [token, setToken] = useState<string>('');
  const [login, setLogin] = useState<string>('');
  const [password, setPassword] = useState<string>('');

  const [cursor, setCursor] = useState<number>(0);
  // Which field is being edited (null = navigation mode).
  const [editing, setEditing] = useState<FieldId | null>(null);
  // Remount key so TextInput picks up a fresh defaultValue each edit.
  const [editKey, setEditKey] = useState<number>(0);
  const [submitError, setSubmitError] = useState<McpFormErrorCode | null>(null);

  // Visible fields depend on the selected auth mode.
  const fields = useMemo<readonly FieldDescriptor[]>(() => {
    const base: FieldDescriptor[] = [
      { id: 'name', secret: false },
      { id: 'url', secret: false },
      { id: 'auth', secret: false },
    ];
    if (auth === 'bearer') {
      base.push({ id: 'token', secret: true });
    } else if (auth === 'basic') {
      base.push({ id: 'login', secret: false });
      base.push({ id: 'password', secret: true });
    }
    return base;
  }, [auth]);

  // Clamp the cursor if the field list shrank (auth → none).
  const clampedCursor = cursor >= fields.length ? fields.length - 1 : cursor;
  const currentField: FieldDescriptor = fields[clampedCursor] ?? fields[0]!;
  const anySecretVisible = fields.some((f) => f.secret);

  const valueFor = useCallback(
    (id: FieldId): string => {
      switch (id) {
        case 'name':
          return name;
        case 'url':
          return url;
        case 'token':
          return token;
        case 'login':
          return login;
        case 'password':
          return password;
        case 'auth':
          return auth;
      }
    },
    [auth, login, name, password, token, url],
  );

  const writeValue = useCallback((id: FieldId, value: string): void => {
    switch (id) {
      case 'name':
        setName(value);
        return;
      case 'url':
        setUrl(value);
        return;
      case 'token':
        setToken(value);
        return;
      case 'login':
        setLogin(value);
        return;
      case 'password':
        setPassword(value);
        return;
      case 'auth':
        // auth is cycled, never typed.
        return;
    }
  }, []);

  const cycleAuth = useCallback((dir: 1 | -1): void => {
    setAuth((prev) => {
      const idx = AUTH_ORDER.indexOf(prev);
      const next =
        (idx + dir + AUTH_ORDER.length) % AUTH_ORDER.length;
      return AUTH_ORDER[next] ?? 'none';
    });
    setSubmitError(null);
  }, []);

  const applyNow = useCallback((): void => {
    const result = buildMcpServerFromForm({
      name,
      url,
      auth,
      token,
      login,
      password,
      existingNames: existingServers ?? [],
    });
    if ('error' in result) {
      setSubmitError(result.error as McpFormErrorCode);
      return;
    }
    onApply({ name: result.name, server: result.server });
  }, [auth, existingServers, login, name, onApply, password, token, url]);

  const errorMessage = useMemo<string | null>(() => {
    if (submitError === null) return null;
    // I18N-STRINGS-START
    switch (submitError) {
      case 'nameRequired':
        return t('mcp.add.error.nameRequired');
      case 'nameInvalid':
        return t('mcp.add.error.nameInvalid');
      case 'nameDuplicate':
        return t('mcp.add.error.nameDuplicate', { name: name.trim() });
      case 'urlRequired':
        return t('mcp.add.error.urlRequired');
      case 'urlInvalid':
        return t('mcp.add.error.urlInvalid');
      case 'tokenRequired':
        return t('mcp.add.error.tokenRequired');
      case 'loginRequired':
        return t('mcp.add.error.loginRequired');
      case 'passwordRequired':
        return t('mcp.add.error.passwordRequired');
    }
    // I18N-STRINGS-END
  }, [name, submitError, t]);

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
          ctrl?: boolean;
        },
      ): void => {
        // While a TextInput is mounted it owns Enter/typing; we only
        // intercept Esc here to cancel the edit cleanly.
        if (editing !== null) {
          if (key.escape === true) {
            setEditing(null);
          }
          return;
        }

        if (key.escape === true) {
          onClose();
          return;
        }

        // Ctrl+Enter or plain 'a' → apply.
        if (
          (key.ctrl === true && key.return === true) ||
          input === 'a' ||
          input === 'A'
        ) {
          applyNow();
          return;
        }

        if (key.upArrow === true) {
          setCursor((i) => (i - 1 + fields.length) % fields.length);
          return;
        }
        if (key.downArrow === true) {
          setCursor((i) => (i + 1) % fields.length);
          return;
        }

        // Auth row: ←/→ or space cycles the auth type. Elsewhere space
        // is ignored (text editing happens inside TextInput).
        if (currentField.id === 'auth') {
          if (key.leftArrow === true) {
            cycleAuth(-1);
            return;
          }
          if (key.rightArrow === true || input === ' ') {
            cycleAuth(1);
            return;
          }
          return;
        }

        // Enter on a text field → edit mode.
        if (key.return === true) {
          setEditing(currentField.id);
          setEditKey((k) => k + 1);
          setSubmitError(null);
          return;
        }
      },
      [applyNow, currentField, cycleAuth, editing, fields.length, onClose],
    ),
  );

  const commitEdit = useCallback(
    (value: string): void => {
      if (editing === null) return;
      writeValue(editing, value);
      setEditing(null);
    },
    [editing, writeValue],
  );

  const updateEditLive = useCallback(
    (value: string): void => {
      if (editing === null) return;
      writeValue(editing, value);
    },
    [editing, writeValue],
  );

  const labelFor = useCallback(
    (id: FieldId): string => {
      // I18N-STRINGS-START
      switch (id) {
        case 'name':
          return t('mcp.add.field.name');
        case 'url':
          return t('mcp.add.field.url');
        case 'auth':
          return t('mcp.add.field.auth');
        case 'token':
          return t('mcp.add.field.token');
        case 'login':
          return t('mcp.add.field.login');
        case 'password':
          return t('mcp.add.field.password');
      }
      // I18N-STRINGS-END
    },
    [t],
  );

  const placeholderFor = useCallback(
    (id: FieldId): string => {
      // I18N-STRINGS-START
      switch (id) {
        case 'name':
          return t('mcp.add.placeholder.name');
        case 'url':
          return t('mcp.add.placeholder.url');
        case 'token':
          return t('mcp.add.placeholder.token');
        case 'login':
          return t('mcp.add.placeholder.login');
        case 'password':
          return t('mcp.add.placeholder.password');
        case 'auth':
          return '';
      }
      // I18N-STRINGS-END
    },
    [t],
  );

  const authLabel = useMemo<string>(() => {
    // I18N-STRINGS-START
    if (auth === 'bearer') return t('mcp.add.auth.bearer');
    if (auth === 'basic') return t('mcp.add.auth.basic');
    return t('mcp.add.auth.none');
    // I18N-STRINGS-END
  }, [auth, t]);

  const existingLine = useMemo<string>(() => {
    const names = existingServers ?? [];
    // I18N-STRINGS-START
    if (names.length === 0) return t('mcp.add.existing.none');
    return t('mcp.add.existing', { names: [...names].sort().join(', ') });
    // I18N-STRINGS-END
  }, [existingServers, t]);

  const renderFieldValue = (
    field: FieldDescriptor,
    active: boolean,
  ): React.JSX.Element => {
    if (field.id === 'auth') {
      return (
        <Text color={active ? noxPalette.white : noxPalette.light}>
          ◂ {authLabel} ▸
        </Text>
      );
    }
    const isEditing = editing === field.id;
    if (isEditing) {
      return (
        <Box
          paddingX={1}
          borderStyle="round"
          borderColor={field.secret ? noxPalette.yellow : noxPalette.light}
        >
          <TextInput
            key={`mcp-${field.id}-${editKey}`}
            defaultValue={valueFor(field.id)}
            placeholder={placeholderFor(field.id)}
            onChange={updateEditLive}
            onSubmit={commitEdit}
          />
        </Box>
      );
    }
    const value = valueFor(field.id);
    // I18N-STRINGS-START
    const display = value.length === 0 ? t('mcp.add.notSet') : value;
    // I18N-STRINGS-END
    const colour =
      value.length === 0
        ? textMuted
        : active
          ? noxPalette.white
          : noxPalette.light;
    return <Text color={colour}>{display}</Text>;
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={noxPalette.light}
      paddingX={1}
      paddingY={1}
    >
      <Box>
        {/* I18N-STRINGS-START */}
        <Text color={noxPalette.white} bold>
          {t('mcp.add.title')}
        </Text>
        {/* I18N-STRINGS-END */}
      </Box>

      <Box marginTop={1}>
        <Text color={textMuted}>{existingLine}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {fields.map((field, i) => {
          const active = i === clampedCursor;
          const arrow = active ? '❯ ' : '  ';
          return (
            <Box key={`mcp-row-${field.id}`} flexDirection="row">
              <Text color={active ? noxPalette.light : textMuted}>{arrow}</Text>
              <Box width={LABEL_WIDTH}>
                <Text color={active ? noxPalette.white : noxPalette.light}>
                  {labelFor(field.id)}
                </Text>
              </Box>
              {renderFieldValue(field, active)}
            </Box>
          );
        })}
      </Box>

      {anySecretVisible && (
        <Box marginTop={1}>
          {/* I18N-STRINGS-START */}
          <Text color={noxPalette.yellow}>{t('mcp.add.secretWarn')}</Text>
          {/* I18N-STRINGS-END */}
        </Box>
      )}

      {editing !== null && (
        <Box marginTop={1}>
          {/* I18N-STRINGS-START */}
          <Text color={textMuted}>{t('mcp.add.editing')}</Text>
          {/* I18N-STRINGS-END */}
        </Box>
      )}

      {errorMessage !== null && (
        <Box marginTop={1}>
          {/* I18N-STRINGS-START */}
          <Text color="#fca5a5">
            {t('mcp.add.error.prefix', { msg: errorMessage })}
          </Text>
          {/* I18N-STRINGS-END */}
        </Box>
      )}

      <Box marginTop={1}>
        {/* I18N-STRINGS-START */}
        <Text color={textMuted}>{t('mcp.add.footer')}</Text>
        {/* I18N-STRINGS-END */}
      </Box>
    </Box>
  );
}

export default McpOverlay;
