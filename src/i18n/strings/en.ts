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
  'chat.toast.clipboardNoImage': 'No image on clipboard',
  'chat.toast.clipboardSaveFailed': 'Failed to save clipboard image',
  'chat.toast.clipboardImageAttached': 'Image attached from clipboard',
  'journal.recovery.title': 'Unfinished sessions detected',
  'journal.recovery.message':
    'Found {n} unfinished session(s) from a previous run.',
  'journal.recovery.hintResume':
    'Press R to resume the most recent',
  'journal.recovery.hintArchive': 'Press A to archive all',
  'journal.recovery.hintIgnore': 'Press Esc to ignore',
  'journal.recovery.archived': 'Archived unfinished session journals.',
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

  // ---------- /permissions overlay ----------
  'permissions.title': 'Permissions',
  'permissions.note.alwaysOn': 'always auto-approved',
  'permissions.note.alwaysOnDiff': 'always auto-approved, shows diff',
  'permissions.note.grantPrompt': 'grant? (space)',
  'permissions.footer.enter': '(enter) accept all',
  'permissions.footer.a': '(a) accept all',
  'permissions.footer.space': '(space) toggle',
  'permissions.footer.esc': '(esc) close',
  'permissions.granted': 'Currently granted: {list}',
  'permissions.granted.none': '(none)',

  // ---------- /context overlay ----------
  'context.title': 'Context',
  'context.label.tokens': 'Tokens:',
  'context.label.messages': 'Messages:',
  'context.label.skills': 'Skills ({n}):',
  'context.label.skills.none': '(none active)',
  'context.label.localcodeMd': 'LOCALCODE.md:',
  'context.localcodeMd.present': 'present (injected)',
  'context.localcodeMd.absent': 'absent',
  'context.footer': '(esc / enter) close',

  // ---------- /ctxsize overlay ----------
  'ctxsize.title': 'Context Size',
  'ctxsize.draft':
    'Draft: {ctx} window · {keep} keep-alive · {tmo} timeout',
  'ctxsize.row.window': 'Window:',
  'ctxsize.row.custom': 'Custom:',
  'ctxsize.row.keepAlive': 'Keep-alive:',
  'ctxsize.row.responseTimeout': 'Response timeout:',
  'ctxsize.suffix.tokens': 'tokens',
  'ctxsize.suffix.seconds': 'seconds',
  'ctxsize.suffix.secondsRange': 'seconds (30..7200)',
  'ctxsize.suffix.editHint': '   (enter to edit)',
  'ctxsize.action.apply': 'Apply',
  'ctxsize.action.cancel': 'Cancel',
  'ctxsize.error': 'Error: {msg}',
  'ctxsize.footer':
    '↑/↓ rows · ←/→ cycle preset · (enter) confirm/edit · (esc) cancel',
  'ctxsize.note':
    "Note: Ollama models reload with the new num_ctx. LM Studio's context is set at model load — change it in LM Studio first, then match it here. Response timeout aborts the request if the model produces no content for that many seconds (heartbeats and thinking blocks don't count). Increase if your model writes long code slowly.",

  // ---------- /provider overlay ----------
  'provider.title': 'Provider',
  'provider.url.notSet': '(not set)',
  'provider.edit': '[edit]',
  'provider.key.set': 'key: {mask} set',
  'provider.key.fromEnv': 'key: from env ${var}',
  'provider.key.notSet': 'key: not set',
  'provider.key.optional': 'key: optional',
  'provider.key.notSetMask': 'not set',
  'provider.notes.title': 'Notes:',
  'provider.notes.openrouterRu':
    '  • OpenRouter from Russia: VPN may be required (Россия блокирует OpenRouter напрямую). Use Cloudflare WARP, Outline VPN, or proxy via the Custom row.',
  'provider.notes.cloudKeys':
    "  • Cloud providers need an API key — get one from each provider's dashboard, or set the env var (e.g. $OPENAI_API_KEY).",
  'provider.warn.openrouter':
    '  ! OpenRouter selected — confirm you can reach openrouter.ai before applying.',
  'provider.error.customUrlRequired': 'Custom URL required',
  'provider.error.cloudUrlEmpty': 'Cloud provider URL is empty',
  'provider.error.urlScheme': 'URL must start with http:// or https://',
  'provider.error.cloudLocalhost':
    'Cloud provider URL must not be localhost',
  'provider.error.apiKeyRequired':
    'API key required for {name}{envHint}',
  'provider.error.apiKeyEnvHint': ' (or set ${var})',
  'provider.error.prefix': 'Error: {msg}',
  'provider.editingUrl':
    'Editing URL — Enter to save · Tab to switch to key · Esc to cancel',
  'provider.editingKey':
    'Editing API key (visible — clear after pasting) · Enter to save · Tab to switch to URL · Esc to cancel',
  'provider.footer':
    '↑/↓ navigate · (space) select · (enter) edit URL · (tab/e) edit key · (ctrl+enter / a) apply · (esc) cancel',

  // ---------- /mcp add-server overlay ----------
  'mcp.add.title': 'Add MCP server',
  'mcp.add.existing': 'Configured servers: {names}',
  'mcp.add.existing.none': 'No MCP servers configured yet.',
  'mcp.add.field.name': 'Name',
  'mcp.add.field.url': 'URL',
  'mcp.add.field.auth': 'Auth',
  'mcp.add.field.token': 'Token',
  'mcp.add.field.login': 'Login',
  'mcp.add.field.password': 'Password',
  'mcp.add.auth.none': 'None',
  'mcp.add.auth.bearer': 'Bearer token',
  'mcp.add.auth.basic': 'Basic (login + password)',
  'mcp.add.placeholder.name': 'my-server',
  'mcp.add.placeholder.url': 'http://192.168.1.10:8080/mcp',
  'mcp.add.placeholder.token': 'paste token…',
  'mcp.add.placeholder.login': 'username',
  'mcp.add.placeholder.password': 'password',
  'mcp.add.notSet': '(empty)',
  'mcp.add.secretWarn':
    'Secrets are visible while typing — clear your terminal scrollback after pasting.',
  'mcp.add.editing': 'Editing — Enter to save · Esc to cancel',
  'mcp.add.error.prefix': 'Error: {msg}',
  'mcp.add.error.nameRequired': 'Name is required',
  'mcp.add.error.nameInvalid':
    'Name may only contain letters, digits, dot, dash and underscore',
  'mcp.add.error.nameDuplicate': "A server named '{name}' already exists",
  'mcp.add.error.urlRequired': 'URL is required',
  'mcp.add.error.urlInvalid': 'URL is not valid (expected http://host:port[/path])',
  'mcp.add.error.tokenRequired': 'Bearer token is required',
  'mcp.add.error.loginRequired': 'Login is required',
  'mcp.add.error.passwordRequired': 'Password is required',
  'mcp.add.footer':
    '↑/↓ navigate · ←/→ auth · (enter) edit field · (ctrl+enter / a) add · (esc) cancel',
  'mcp.add.toast.success':
    "Added MCP server '{name}'. Its tools appear after you restart localcode.",
  'mcp.add.toast.savedButError':
    "Saved MCP server '{name}' but could not connect: {msg}. Fix the URL/auth and retry, or restart localcode.",
  'mcp.add.toast.saveFailed': "Failed to save MCP server '{name}': {msg}",

  // ---------- /settings overlay ----------
  'settings.title': 'Generation Settings',
  'settings.source.globalOnly': 'Source: global (no project overrides)',
  'settings.source.projectAll':
    'Source: project (all 4 fields overridden)',
  'settings.source.mixed':
    'Source: mixed (project overrides {overridden} of {total} fields)',
  'settings.field.tempLabel': 'Temperature',
  'settings.field.topPLabel': 'Top-p',
  'settings.field.repeatPenaltyLabel': 'Repeat penalty',
  'settings.field.maxTokensLabel': 'Max tokens',
  'settings.fieldHint.stepRange':
    'step {step} · range [{min}..{max}]',
  'settings.project.spaceRemove': '(space to remove override)',
  'settings.project.spaceEnable': '(space to enable override)',
  'settings.button.saveGlobal': 'Save Global',
  'settings.button.saveProject': 'Save Project',
  'settings.button.resetProject': 'Reset Project',
  'settings.button.saveTimeouts': 'Save Timeouts',
  'settings.panel.global': 'Global',
  'settings.panel.global.path': '  (~/.localcode/config.toml)',
  'settings.panel.project': 'Project',
  'settings.panel.project.suffix':
    '  (<projectRoot>/.localcode/settings.json) — {n}/{total} active',
  'settings.panel.timeouts': 'Timeouts (global)',
  'settings.panel.timeouts.path':
    '  (~/.localcode/config.toml [context])',
  'settings.row.responseWait': 'Response wait',
  'settings.row.keepAlive': 'Keep-alive',
  'settings.row.custom': 'Custom',
  'settings.suffix.secondsRange': 'seconds ({min}..{max})',
  'settings.suffix.editHint': '   (enter to edit)',
  'settings.error': 'Error: {msg}',
  'settings.footer':
    '↑/↓ navigate · ←/→ adjust · (space) toggle override · (enter) save section · (esc) close',
  'settings.validate.notNumber': '{label} is not a number',
  'settings.validate.outOfRange':
    '{label} out of range [{min}..{max}]',
  'settings.validate.notInteger': '{label} must be an integer',
  'settings.validate.required': '{label} required',

  // ---------- /resume overlay ----------
  'resume.title': 'Resume a previous session',
  'resume.empty': 'No saved sessions yet.',
  'resume.untitled': '(untitled)',
  'resume.summary': 'Summary:',
  'resume.summary.none': '(no summary available)',
  'resume.footer':
    '↑/↓ select · Enter resume · Esc close · showing up to 20 entries',
  'resume.footer.olderHidden': ' ({n} older hidden)',

  // ---------- Plan Mode overlay (banner + blocked badge + toasts) ----------
  // Surfaced when `config.permissions.profile === 'plan'`. Banner sits at
  // top of ChatScreen; badge replaces approval prompts for write/run/
  // git_commit; toasts fire on Ctrl+P toggle.
  'plan.banner.title': 'PLAN MODE',
  'plan.banner.hint':
    'write & run tools blocked — Ctrl+P to exit, or /profile default',
  'plan.toolBlocked': '[BLOCKED IN PLAN] {tool}',
  'plan.toast.on':
    'Plan Mode ON — edit + command tools blocked. Press Ctrl+P or run /profile default to exit.',
  'plan.toast.off': 'Plan Mode OFF — back to default profile.',

  // ---------- /metrics overlay ----------
  'metrics.title': 'Metrics (local-only)',
  'metrics.tab.tools': 'Tools',
  'metrics.tab.cache': 'Cache',
  'metrics.tab.cost': 'Cost',
  'metrics.tab.sessions': 'Sessions',
  'metrics.disabled':
    'Telemetry is opt-in. Enable in ~/.localcode/config.toml [telemetry] enabled = true',
  'metrics.window': 'Window: {start} → {end}',

  // ---------- Marketplace overlay (/skills browse, /mcp browse) ----------
  'marketplace.title': 'Marketplace',
  'marketplace.title.skills': 'Skills catalog (Anthropic)',
  'marketplace.title.mcp': 'MCP servers catalog',
  'marketplace.empty': 'No entries available.',
  'marketplace.loading': 'Loading catalog…',
  'marketplace.cached': 'cached {age} ago',
  'marketplace.rateLimited':
    'GitHub rate-limit reached — showing cached entries.',
  'marketplace.installed': 'Installed: {name}',
  'marketplace.installFailed': 'Install failed: {msg}',
  'marketplace.hint.global': 'install global',
  'marketplace.hint.project': 'install project',
  'marketplace.hint.refresh': 'refresh',

  // BATCH-APPROVAL-SECTION
  // Unified batch-approval modal (fired when the LLM emits N or more
  // mutating tool calls in one turn — typical multi-file refactor).
  'batch.title': 'Approve {n} changes',
  'batch.empty': '(no items to review)',
  'batch.hint.approve': '[space/enter] toggle',
  'batch.hint.reject': '[r] reject all',
  'batch.hint.all':
    '[a] approve all  [Ctrl+Enter] confirm  [Esc] cancel',
  'batch.status':
    'approved: {approved} · rejected: {rejected} · pending: {pending}',
  // BATCH-APPROVAL-SECTION-END

  // SKILL-SUGGEST-SECTION
  // Auto-suggested-skill toast surfaced when the user's input matches a
  // non-active skill's `triggers` frontmatter. Tab activates the first
  // suggestion; Esc dismisses. Auto-dismisses after 8s.
  'skill.suggest.toast': 'Skill {name} looks relevant',
  'skill.suggest.hint.tab': 'to activate',
  'skill.suggest.hint.esc': 'to dismiss',
  // SKILL-SUGGEST-SECTION-END

  // IMPORT-CMD-SECTION
  // `/import claude-code` and the first-run prompt that fires when we
  // detect a populated `~/.claude/projects/` and zero LocalCode sessions.
  'import.title': 'Import from Claude Code',
  'import.scanning': 'Scanning ~/.claude/projects…',
  'import.empty': 'No Claude Code sessions found.',
  'import.projects': 'Projects ({n})',
  'import.sessions': 'Sessions ({n})',
  'import.confirm': 'Import {n} sessions?',
  'import.progress': 'Imported {done} of {total}',
  'import.done': 'Imported {imported} sessions.',
  'import.firstRun.prompt': 'Found Claude Code sessions. Import?',
  'import.firstRun.yes': 'Yes',
  'import.firstRun.no': 'Not now',
  'import.firstRun.never': 'Never ask',
  // IMPORT-CMD-SECTION-END

  // PRESENCE-SECTION — multi-user collaboration (web only).
  'presence.typing.one': '{name} is typing…',
  'presence.typing.many': '{n} peers are typing…',
  'presence.peers': '{n} peers',
  // PRESENCE-SECTION-END
} as const;

export type StringKey = keyof typeof en;
export type StringTable = Readonly<Record<StringKey, string>>;
