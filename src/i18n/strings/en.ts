/**
 * English string table for the TUI.
 *
 * Flat map of stable keys → user-visible strings. Keys are dot-namespaced
 * by surface (`onboarding.*`, `chat.*`, `slash.*`, `language.*`). When you
 * add a key here, mirror it in `./ru.ts` — missing keys fall back to the
 * English table at lookup time, so the TUI stays usable in either locale
 * even if the translation table drifts.
 *
 * Placeholder syntax: `{name}` — `t('queue.count', { n: 3 })` substitutes
 * `{n}` for `3`. Substitution is a plain string replace, no escaping —
 * never inject user-controlled keys.
 */

export const en = {
  // ---------- Onboarding ----------
  'onboarding.welcome':
    'Welcome. Pick the LLM backend you want to talk to. Local providers (Ollama, LM Studio) need no key — cloud providers do.',
  'onboarding.needsApiKey': '[needs API key]',
  'onboarding.navHint': '↑/↓ navigate · Enter to select · Esc to exit',
  'onboarding.selected': 'Selected: {name}',
  'onboarding.serverUrl': 'Server URL:',
  'onboarding.urlFooter':
    'Enter to confirm · Esc to go back · Current: {value}',
  'onboarding.apiKey': 'API key:',
  'onboarding.apiKeyOptional': 'API key (optional):',
  'onboarding.envDetected':
    '✓ Detected ${name} in env — press Enter on an empty field to use it.',
  'onboarding.keyWarning':
    'Warning: terminal may not mask the key while typing — clear scrollback after pasting if pasting from a clipboard.',
  'onboarding.apiKeyFooter': 'Enter to confirm · Esc to go back',
  'onboarding.apiKeyFooterSkip':
    'Enter to confirm · Esc to go back · empty Enter = skip',
  'onboarding.apiKeyRequired':
    'API key required for {name}{envHint}.',
  'onboarding.apiKeyEnvHint': ' (or set ${var} in your shell)',
  'onboarding.scanning': 'Scanning models at {url}…',
  'onboarding.connected': '✓ Connected to {name}',
  'onboarding.availableModels': 'Available models ({n}):',
  'onboarding.noModels':
    '(none found — you may need to pull a model first)',
  'onboarding.moreModels': '…and {n} more',
  'onboarding.pressEnter': 'Press Enter to start chatting.',
  'onboarding.cantReach':
    'Could not reach {url}. Is the server running / does the URL look right?',
  'onboarding.noModelsHint.ollama': 'Try: `ollama pull qwen2.5-coder`.',
  'onboarding.noModelsHint.lmstudio': 'Load a model in LM Studio first.',
  'onboarding.noModelsHint.custom':
    'Custom endpoint returned no /v1/models — check the URL.',
  'onboarding.noModelsHint.cloud':
    'Check that your API key has access to {name} models.',
  'onboarding.serverReachableNoModels':
    'Server is reachable but returned no models. {hint}',
  'onboarding.scanFailed': 'Scan failed: {msg}',

  // ---------- Language picker ----------
  'language.welcome': 'Welcome to LocalCode',
  'language.choose': 'Choose your language',
  'language.navHint': '↑/↓ navigate · Enter to confirm',
  'language.current': 'Current language: {name}',
  'language.notSet': '(not set)',
  'language.switchHint': 'Switch with `/language <en|ru>`.',
  'language.alreadyOn': "Already on '{name}'.",
  'language.unknown':
    "Unknown language: '{value}'. Valid options: en, ru.",
  'language.failed': 'Failed to switch language: {msg}',
  'language.setTo': "Language set to '{name}'.",

  // ---------- Chat empty state / banners / hints ----------
  'chat.emptyHint':
    "Start by typing a message or `/` for commands. Press Esc while generating to cancel.",
  'chat.placeholderApproval':
    'Type to queue — first respond to the prompt above (y/n)…',
  'chat.placeholderStreaming':
    'Type to queue your next message — Esc cancels the stream…',
  'chat.queuePausedBanner':
    'Queue paused — last turn failed. Retry the failed message or send a new one to resume. (Ctrl+R retry · Ctrl+X discard)',
  'chat.queueCountOne': '↳ 1 message queued (will send after this turn)',
  'chat.queueCountMany': '↳ {n} messages queued (will send after this turn)',
  'chat.toast.answerApprovalFirst': 'Answer the approval prompt first',
  'chat.toast.queued': 'Queued — will send after current turn',
  'chat.readingMode': 'READING MODE — press F to exit',
  'chat.selectMode':
    'SELECT MODE — ↑/↓ pick · Y yank · Esc exit (row {row}/{total})',
  'chat.modelSwap': 'MODEL SWAP — opening picker…',
  'chat.configLoadFailed': 'Failed to load config.',
  'chat.reconfigureHint':
    'Run `localcode --reconfigure` to re-run onboarding.',

  // ---------- Slash menu ----------
  'slash.noMatch': 'No commands match "{query}"',
  'slash.moreAbove': '↑ {n} more',
  'slash.moreBelow': '↓ {n} more',

  // ---------- Input bar ----------
  'input.placeholder': 'Type a message or /command…',
  'input.bashModeHint':
    "$ Bash mode — output goes to chat only, model won't see it",
} as const;

export type StringKey = keyof typeof en;
export type StringTable = Readonly<Record<StringKey, string>>;
