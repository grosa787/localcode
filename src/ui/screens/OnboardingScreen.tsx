/**
 * First-run onboarding flow.
 *
 * Step machine (R27):
 *   backendSelect → urlInput → apiKeyInput? → scanning → done
 *
 * The `apiKeyInput` step is skipped for local providers (`ollama`,
 * `lmstudio`) and for `custom` when the user submits an empty key.
 *
 * The parent (Agent 8) supplies `pingBackend` and `fetchModels`
 * callbacks — these wrap `LLMAdapter` so this screen stays pure UI.
 * On completion we hand the parent an `AppConfig`; the parent is
 * responsible for persisting it to disk.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { noxPalette, spinnerFrames, textMuted, theme } from '../theme.js';
import { NoxBig } from '../components/Nox.js';
import { PROVIDER_DEFAULTS, PROVIDER_META, resolveApiKey } from '../../config/defaults.js';
import type { AppConfig, Backend } from '../../types/global.js';

export interface OnboardingScreenProps {
  readonly onComplete: (config: AppConfig) => void;
  readonly pingBackend: (url: string) => Promise<boolean>;
  readonly fetchModels: (url: string) => Promise<string[]>;
}

type Step = 'backendSelect' | 'urlInput' | 'apiKeyInput' | 'scanning' | 'done';

interface BackendChoice {
  readonly id: Backend | 'exit';
  readonly label: string;
  readonly defaultUrl: string;
  /** True for cloud providers requiring an API key (UI hint). */
  readonly cloud: boolean;
  readonly kind: 'backend' | 'separator' | 'exit';
}

/**
 * R27 — every Backend gets a row, ordered local-first then cloud, with
 * `custom` last as the OpenAI-compat escape hatch. Display labels and
 * default URLs are sourced from `PROVIDER_DEFAULTS` / `PROVIDER_META`
 * so the onboarding screen and the `/provider` overlay stay in sync.
 */
const CHOICES: readonly BackendChoice[] = [
  {
    id: 'ollama',
    label: PROVIDER_META.ollama.displayName,
    defaultUrl: PROVIDER_DEFAULTS.ollama.baseUrl,
    cloud: false,
    kind: 'backend',
  },
  {
    id: 'lmstudio',
    label: PROVIDER_META.lmstudio.displayName,
    defaultUrl: PROVIDER_DEFAULTS.lmstudio.baseUrl,
    cloud: false,
    kind: 'backend',
  },
  {
    id: 'openai',
    label: PROVIDER_META.openai.displayName,
    defaultUrl: PROVIDER_DEFAULTS.openai.baseUrl,
    cloud: true,
    kind: 'backend',
  },
  {
    id: 'anthropic',
    label: PROVIDER_META.anthropic.displayName,
    defaultUrl: PROVIDER_DEFAULTS.anthropic.baseUrl,
    cloud: true,
    kind: 'backend',
  },
  {
    id: 'openrouter',
    label: PROVIDER_META.openrouter.displayName,
    defaultUrl: PROVIDER_DEFAULTS.openrouter.baseUrl,
    cloud: true,
    kind: 'backend',
  },
  {
    id: 'google',
    label: PROVIDER_META.google.displayName,
    defaultUrl: PROVIDER_DEFAULTS.google.baseUrl,
    cloud: true,
    kind: 'backend',
  },
  {
    id: 'custom',
    label: PROVIDER_META.custom.displayName,
    defaultUrl: PROVIDER_DEFAULTS.custom.baseUrl,
    cloud: false,
    kind: 'backend',
  },
  { id: 'exit', label: '─────────', defaultUrl: '', cloud: false, kind: 'separator' },
  { id: 'exit', label: 'Exit', defaultUrl: '', cloud: false, kind: 'exit' },
];

interface BackendSelectProps {
  readonly onPick: (choice: BackendChoice) => void;
  readonly onExit: () => void;
}

function BackendSelect({ onPick, onExit }: BackendSelectProps): React.JSX.Element {
  const [index, setIndex] = useState<number>(0);

  const moveUp = useCallback(() => {
    setIndex((i) => {
      let n = i - 1;
      if (n < 0) n = CHOICES.length - 1;
      while (n >= 0 && CHOICES[n]?.kind === 'separator') {
        n -= 1;
      }
      if (n < 0) return i;
      return n;
    });
  }, []);

  const moveDown = useCallback(() => {
    setIndex((i) => {
      let n = i + 1;
      if (n >= CHOICES.length) n = 0;
      while (n < CHOICES.length && CHOICES[n]?.kind === 'separator') {
        n += 1;
      }
      if (n >= CHOICES.length) return i;
      return n;
    });
  }, []);

  useInput(
    useCallback(
      (_input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
        if (key.upArrow) {
          moveUp();
          return;
        }
        if (key.downArrow) {
          moveDown();
          return;
        }
        if (key.return) {
          const chosen = CHOICES[index];
          if (chosen === undefined) return;
          if (chosen.kind === 'exit') {
            onExit();
            return;
          }
          if (chosen.kind === 'backend') {
            onPick(chosen);
            return;
          }
          return;
        }
        if (key.escape) {
          onExit();
          return;
        }
      },
      [index, moveUp, moveDown, onExit, onPick],
    ),
  );

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <NoxBig />
      <Box marginTop={1}>
        <Text color={textMuted}>
          Welcome. Pick the LLM backend you want to talk to. Local
          providers (Ollama, LM Studio) need no key — cloud providers
          do.
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {CHOICES.map((c, i) => {
          if (c.kind === 'separator') {
            return (
              <Box key={`sep-${i}`}>
                <Text color={textMuted}>{c.label}</Text>
              </Box>
            );
          }
          const active = i === index;
          // Cloud providers get a "[needs API key]" tag; render it
          // dimmed so the eye still parses the provider name first.
          return (
            <Box key={`choice-${i}`}>
              <Text color={active ? noxPalette.light : noxPalette.white}>
                {active ? '❯ ' : '  '}
                {c.label}
              </Text>
              {c.cloud && (
                <Text color={textMuted}>
                  {'  '}[needs API key]
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={textMuted}>↑/↓ navigate · Enter to select · Esc to exit</Text>
      </Box>
    </Box>
  );
}

interface UrlInputProps {
  readonly backend: Backend;
  readonly defaultUrl: string;
  readonly lastError: string | null;
  readonly onSubmit: (url: string) => void;
  readonly onBack: () => void;
}

function UrlInput({
  backend,
  defaultUrl,
  lastError,
  onSubmit,
  onBack,
}: UrlInputProps): React.JSX.Element {
  const [draft, setDraft] = useState<string>(defaultUrl);

  useInput(
    useCallback(
      (_input: string, key: { escape?: boolean }) => {
        if (key.escape) onBack();
      },
      [onBack],
    ),
  );

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{theme.logo}</Text>
      <Text color={textMuted}>
        Selected: {PROVIDER_META[backend].displayName}
      </Text>
      <Box marginTop={1}>
        <Text color={noxPalette.white}>Server URL:</Text>
      </Box>
      <Box>
        <Text>{theme.prompt} </Text>
        <TextInput
          defaultValue={defaultUrl}
          placeholder={defaultUrl.length > 0 ? defaultUrl : 'https://…'}
          onChange={setDraft}
          onSubmit={(v) => onSubmit(v.length === 0 ? defaultUrl : v)}
        />
      </Box>
      {lastError !== null && (
        <Box marginTop={1}>
          <Text color="red">⚠ {lastError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={textMuted}>
          Enter to confirm · Esc to go back · Current: {draft.length === 0 ? defaultUrl : draft}
        </Text>
      </Box>
    </Box>
  );
}

interface ApiKeyInputProps {
  readonly backend: Backend;
  readonly envVar: string | undefined;
  readonly envKeyDetected: boolean;
  readonly lastError: string | null;
  readonly onSubmit: (apiKey: string) => void;
  readonly onSkip: () => void;
  readonly onBack: () => void;
}

/**
 * R27 — third onboarding step (cloud providers only). Captures the API
 * key inline; an empty submission is treated as "use the env var
 * fallback" when one is detected. Keys are entered as plain text; we
 * surface a hint reminding the user to clear the terminal scrollback
 * after pasting (the terminal can't reliably mask `<TextInput>` glyphs
 * across emulators).
 */
function ApiKeyInput({
  backend,
  envVar,
  envKeyDetected,
  lastError,
  onSubmit,
  onSkip,
  onBack,
}: ApiKeyInputProps): React.JSX.Element {
  const [draft, setDraft] = useState<string>('');

  useInput(
    useCallback(
      (_input: string, key: { escape?: boolean }) => {
        if (key.escape) onBack();
      },
      [onBack],
    ),
  );

  const meta = PROVIDER_META[backend];
  const isCustom = backend === 'custom';
  const required = !isCustom; // custom: optional, others: required (or env)

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{theme.logo}</Text>
      <Text color={textMuted}>
        Selected: {meta.displayName}
      </Text>
      <Box marginTop={1}>
        <Text color={noxPalette.white}>
          API key{isCustom ? ' (optional)' : ''}:
        </Text>
      </Box>
      {envKeyDetected && envVar !== undefined && (
        <Box>
          <Text color="#86efac">
            ✓ Detected ${envVar} in env — press Enter on an empty field
            to use it.
          </Text>
        </Box>
      )}
      <Box>
        <Text>{theme.prompt} </Text>
        <TextInput
          defaultValue=""
          placeholder={isCustom ? '(leave blank if not needed)' : 'sk-…'}
          onChange={setDraft}
          onSubmit={(v) => {
            // Empty + env detected → skip (use env fallback).
            // Empty + no env + custom → skip (key truly optional).
            // Empty + no env + cloud → bubble back as error via parent.
            if (v.length === 0) {
              if (envKeyDetected || isCustom) onSkip();
              else onSubmit(''); // parent surfaces the missing-key error
              return;
            }
            onSubmit(v);
          }}
        />
      </Box>
      {meta.apiKeyHelp !== undefined && (
        <Box marginTop={1}>
          <Text color={textMuted}>{meta.apiKeyHelp}</Text>
        </Box>
      )}
      {required && !envKeyDetected && (
        <Box>
          <Text color={noxPalette.yellow}>
            Warning: terminal may not mask the key while typing —
            clear scrollback after pasting if pasting from a clipboard.
          </Text>
        </Box>
      )}
      {lastError !== null && (
        <Box marginTop={1}>
          <Text color="red">⚠ {lastError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={textMuted}>
          Enter to confirm · Esc to go back
          {envKeyDetected || isCustom ? ' · empty Enter = skip' : ''}
        </Text>
      </Box>
    </Box>
  );
}

interface ScanningProps {
  readonly url: string;
}

function Scanning({ url }: ScanningProps): React.JSX.Element {
  const [frame, setFrame] = useState<number>(0);
  useEffect(() => {
    const h = setInterval(() => setFrame((f) => (f + 1) % spinnerFrames.length), 80);
    return () => clearInterval(h);
  }, []);
  const glyph = spinnerFrames[frame] ?? spinnerFrames[0] ?? '⠋';
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{theme.logo}</Text>
      <Box marginTop={1}>
        <Text color={noxPalette.yellow}>{glyph}</Text>
        <Text> </Text>
        <Text color={noxPalette.white}>Scanning models at {url}…</Text>
      </Box>
    </Box>
  );
}

interface DoneProps {
  readonly backend: Backend;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly selectedModel: string;
  readonly onConfirm: () => void;
}

function Done({
  backend,
  baseUrl,
  models,
  selectedModel,
  onConfirm,
}: DoneProps): React.JSX.Element {
  useInput(
    useCallback(
      (_input: string, key: { return?: boolean }) => {
        if (key.return) onConfirm();
      },
      [onConfirm],
    ),
  );

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{theme.logo}</Text>
      <Box marginTop={1}>
        <Text color="green">
          ✓ Connected to {PROVIDER_META[backend].displayName}
        </Text>
      </Box>
      <Text color={textMuted}>{baseUrl}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={noxPalette.white}>Available models ({models.length}):</Text>
        {models.length === 0 ? (
          <Text color={noxPalette.yellow}>
            {'  '}(none found — you may need to pull a model first)
          </Text>
        ) : (
          models.slice(0, 10).map((m) => (
            <Box key={m}>
              <Text color={m === selectedModel ? noxPalette.light : textMuted}>
                {m === selectedModel ? '  ❯ ' : '    '}
                {m}
              </Text>
            </Box>
          ))
        )}
        {models.length > 10 && (
          <Text color={textMuted}>{`  …and ${models.length - 10} more`}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={textMuted}>Press Enter to start chatting.</Text>
      </Box>
    </Box>
  );
}

function OnboardingScreen({
  onComplete,
  pingBackend,
  fetchModels,
}: OnboardingScreenProps): React.JSX.Element {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('backendSelect');
  const [backend, setBackend] = useState<Backend>('ollama');
  const [baseUrl, setBaseUrl] = useState<string>(PROVIDER_DEFAULTS.ollama.baseUrl);
  // Captured from the apiKeyInput step. Empty string means "no
  // explicit key supplied" — we still try `resolveApiKey()` at scan
  // time which falls back to the env var when present.
  const [apiKey, setApiKey] = useState<string>('');
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const handleBackendPick = useCallback((choice: BackendChoice) => {
    if (choice.kind !== 'backend') return;
    if (choice.id === 'exit') return;
    setBackend(choice.id);
    setBaseUrl(choice.defaultUrl);
    setApiKey('');
    setError(null);
    setStep('urlInput');
  }, []);

  const handleUrlConfirm = useCallback((url: string) => {
    setError(null);
    setBaseUrl(url);
    // Cloud providers + custom (optional) advance to the key step;
    // local providers skip directly to scanning.
    const requiresKey = PROVIDER_DEFAULTS[backend].requiresApiKey;
    const supportsKey = requiresKey || backend === 'custom';
    if (supportsKey) {
      setStep('apiKeyInput');
      return;
    }
    // Local — kick off scan immediately. We schedule it via a state
    // transition then a micro-task; React will pick up the new state
    // and our useEffect drives the actual scan.
    setStep('scanning');
  }, [backend]);

  const runScan = useCallback(
    async (url: string, key: string): Promise<void> => {
      setError(null);
      setBaseUrl(url);
      setStep('scanning');
      try {
        const reachable = await pingBackend(url);
        if (!reachable) {
          setError(
            `Could not reach ${url}. Is the server running / does the URL look right?`,
          );
          // Cloud → return to API key step; local → URL step. Errors
          // typically point at one or the other depending on category.
          if (PROVIDER_DEFAULTS[backend].requiresApiKey) {
            setStep('apiKeyInput');
          } else {
            setStep('urlInput');
          }
          return;
        }
        const fetched = await fetchModels(url);
        if (fetched.length === 0) {
          let hint = '';
          if (backend === 'ollama') {
            hint = 'Try: `ollama pull qwen2.5-coder`.';
          } else if (backend === 'lmstudio') {
            hint = 'Load a model in LM Studio first.';
          } else if (backend === 'custom') {
            hint = 'Custom endpoint returned no /v1/models — check the URL.';
          } else {
            hint = `Check that your API key has access to ${PROVIDER_META[backend].displayName} models.`;
          }
          setError(
            `Server is reachable but returned no models. ${hint}`,
          );
          setStep(
            PROVIDER_DEFAULTS[backend].requiresApiKey ? 'apiKeyInput' : 'urlInput',
          );
          return;
        }
        // Pre-select the metadata default if it's in the list,
        // otherwise the first available.
        const defaultModel = PROVIDER_META[backend].defaultModel;
        const preselect =
          defaultModel !== undefined && fetched.includes(defaultModel)
            ? defaultModel
            : (fetched[0] ?? '');
        setModels(fetched);
        setSelectedModel(preselect);
        setApiKey(key);
        setStep('done');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Scan failed: ${msg}`);
        setStep(
          PROVIDER_DEFAULTS[backend].requiresApiKey ? 'apiKeyInput' : 'urlInput',
        );
      }
    },
    [backend, pingBackend, fetchModels],
  );

  const handleApiKeySubmit = useCallback(
    (key: string) => {
      // Validate before running scan: cloud providers must have either
      // an explicit key or a non-empty env-var fallback.
      const requiresKey = PROVIDER_DEFAULTS[backend].requiresApiKey;
      if (requiresKey) {
        const resolved = resolveApiKey(backend, key.length > 0 ? key : undefined);
        if (resolved === undefined || resolved.length === 0) {
          const meta = PROVIDER_META[backend];
          const envHint =
            meta.apiKeyEnvVar !== undefined
              ? ` (or set $${meta.apiKeyEnvVar} in your shell)`
              : '';
          setError(`API key required for ${meta.displayName}${envHint}.`);
          return;
        }
      }
      void runScan(baseUrl, key);
    },
    [backend, baseUrl, runScan],
  );

  const handleApiKeySkip = useCallback(() => {
    void runScan(baseUrl, '');
  }, [baseUrl, runScan]);

  const handleConfirm = useCallback(() => {
    const cfg: AppConfig = {
      backend: {
        type: backend,
        baseUrl,
        // Persist an explicit `apiKey` only when the user supplied one
        // — empty string would round-trip through the schema as a
        // configured-empty value, which trips `resolveApiKey()` later.
        ...(apiKey.length > 0 ? { apiKey } : {}),
      },
      model: { current: selectedModel, available: models },
      onboarding: { completed: true },
      // Agent 5 R2: permissions + context gained required fields; use
      // the same defaults as getDefaultConfig/ConfigSchema defaults.
      // Agent 5 R7: context.responseTimeoutSeconds added (LM Studio
      // stall timeout, default 5 min).
      permissions: { autoApprove: [], profile: 'default' },
      outputStyle: 'concise',
      context: {
        maxTokens: 8192,
        keepAliveSeconds: 1800,
        responseTimeoutSeconds: 300,
        // Agent D R8 (ROADMAP #5): tool-result trim threshold added to
        // ContextSettingsConfig — mirror the schema default so the
        // freshly-onboarded config is structurally complete.
        trimToolResultsAfter: 5,
        autoCompressPercent: 0.8,
        maxRecentMessages: 20,
      },
      // Agent 5 R5: sound gained required fields (FIX #29); mirror
      // getDefaultConfig/SoundSchema defaults — off, per-event toggles on.
      sound: {
        enabled: false,
        onCompletion: true,
        onApproval: true,
        onError: true,
        volume: 0.5,
        completionFile: null,
        approvalFile: null,
        errorFile: null,
      },
      // Agent 5 R6: generation gained required fields (FIX #35); mirror
      // getDefaultConfig/GenerationSchema defaults.
      generation: {
        temperature: 0.2,
        topP: 0.9,
        repeatPenalty: 1.1,
        maxTokens: 4096,
      },
    };
    onComplete(cfg);
  }, [apiKey, backend, baseUrl, selectedModel, models, onComplete]);

  const handleExit = useCallback(() => {
    exit();
  }, [exit]);

  switch (step) {
    case 'backendSelect':
      return <BackendSelect onPick={handleBackendPick} onExit={handleExit} />;
    case 'urlInput':
      return (
        <UrlInput
          backend={backend}
          defaultUrl={baseUrl}
          lastError={error}
          onSubmit={handleUrlConfirm}
          onBack={() => setStep('backendSelect')}
        />
      );
    case 'apiKeyInput': {
      const meta = PROVIDER_META[backend];
      const envVar = meta.apiKeyEnvVar;
      const envKeyDetected =
        envVar !== undefined &&
        process.env[envVar] !== undefined &&
        (process.env[envVar] ?? '').length > 0;
      return (
        <ApiKeyInput
          backend={backend}
          envVar={envVar}
          envKeyDetected={envKeyDetected}
          lastError={error}
          onSubmit={handleApiKeySubmit}
          onSkip={handleApiKeySkip}
          onBack={() => setStep('urlInput')}
        />
      );
    }
    case 'scanning':
      return <Scanning url={baseUrl} />;
    case 'done':
      return (
        <Done
          backend={backend}
          baseUrl={baseUrl}
          models={models}
          selectedModel={selectedModel}
          onConfirm={handleConfirm}
        />
      );
    default: {
      const _exhaustive: never = step;
      void _exhaustive;
      return <Text>unknown step</Text>;
    }
  }
}

export default OnboardingScreen;
