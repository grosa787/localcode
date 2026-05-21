# LocalCode — Будущий roadmap

> Создан 2026-04-25. Содержит approved items от пользователя + дополнительные идеи.

---

## Approved next batch (выбрано пользователем 2026-04-29)

### Stability + UI (батч 1)
1. **Tool output size cap для run_command** — режем при >50KB, остаток заменяем на `[truncated, NMB more — re-run with grep/head]`. Предотвращает context blow-up.
2. **Graceful shutdown на SIGHUP** — handler как для SIGTERM. Сохранять state когда терминал закрывают.
3. **Beautiful code-fence syntax highlighting** — НЕ минимум, а реально красиво. Tree-sitter parser + кастомные цвета per token type (keyword, string, number, comment, function, type). Фоны/dim'ы для разных языков.
4. **Lazy SQLite pagination** — `getMessages(sid)` берёт последние 100, остальные lazy-load по скроллу. Long-session resume больше не лагает.

### Quality of code with local models (батч 2)
5. **Tool result trimming для старых вызовов** — старые `read_file` results (старше последних 5) заменяются на `[read_file(path) — 2KB collapsed; re-call to view]`. 40-60% экономия токенов.
6. **Streaming chunk batching на уровне адаптера** — накопить 3-4 SSE chunks перед dispatch. -10-20% CPU во время стрима.
7. **Code style memory per project** — при `/init` извлекаем стилевые паттерны (indent, naming, test framework, import style) → инжектим в system prompt как `## Project conventions`.
8. **AST-based edit_file** — tree-sitter, замена через семантические правки («функция X в файле Y, замени тело») вместо string-replace. Большой надёжностный win.
9. **Self-test before commit** — после `write_file` авто-запуск `lint_file` + связанного `bun test src/foo.test.ts`. Если упало — модель видит и исправляет в том же turn'е.
10. **Two-phase generation для крупных задач** — модель сначала пишет план (file tree + описание), юзер approve'ит → модель идёт по плану файл за файлом.
11. **Symbol search via tree-sitter** — новый tool `find_symbol(name, kind?)`. Резко уменьшает flailing `read_file` поиск.
12. **JSON mode для tool calls** — `response_format: { type: 'json_object' }` через LM Studio. Меньше malformed tool calls у Qwen/Gemma 7B.
13. **Adaptive temperature per task** — code = 0.1, brainstorm = 0.7, tool calls = 0.0. Auto-adjust по detected intent.
14. **Model-specific prompt presets** — Qwen/Gemma/Llama/DeepSeek разные prompt стили. Auto-detect → swap preset.

### Senior-engineer prompt + agentic mode (батч 3 — обсуждается)
15. **Senior developer system prompt** — переписать system prompt чтобы модель вела себя как senior:
    - Считает trade-offs архитектуры
    - Проверяет invariants после каждого изменения
    - Не пишет throwaway / hack-код
    - Документирует non-obvious decisions
    - Reviewит свой код перед submit'ом
    - Знает когда отказаться («это плохая идея, потому что...»)
16. **Agentic loop mode (бесконечная работа)** — модель получает задачу и работает автономно часами:
    - Циклы: "написал → запустил → ошибка → анализ → исправил → запустил → success → next subtask"
    - Не останавливается пока задача не завершена ИЛИ юзер не прервал
    - Лимиты безопасности: max iterations / max time / max cost (tokens)
    - Watchdog: если 5 итераций подряд не приближается к цели → пауза, спрашивает юзера
    - Persistent state: чекпоинты в `.localcode/agent-state.json` чтобы можно было прервать и продолжить
    - Запуск через `/agent <task description>`
    - UI: progress dashboard (current step / iterations / elapsed / tokens used)

---

---

## Известные баги (фиксить ПЕРЕД новыми фичами)

### Paste collapse rendering glitch
- При вставке большого текста в InputBar показывается пилюля `[Paste #N · X lines]` — это работает.
- НО при отправке сообщения текст накладывается на текст (overlap). Render race между уничтожением InputBar state и появлением сообщения в Static.
- Owner: Agent 4 (InputBar.tsx + ChatScreen.tsx). Проверить что при submit полный raw text расширяется ДО рендера в Static, и что committed message сразу не содержит markers.
- ~50-100 строк фикс.

---

## Approved (executing later)

### Tier 1 — Quick wins

#### `/usage` — token statistics overlay
- Использует существующий `getSessionStats(sid)` из `SessionManager`.
- Новая команда `/usage [day | week | month | session | all]`.
- Overlay с разбивкой:
  - Tokens по моделям (gemma4: 12K, qwen3: 8K)
  - Tokens по дням (последние 7 дней — bar chart в ASCII)
  - Top 5 longest sessions
  - Average response time per model
  - Cost estimate (если у юзера в config задана цена за 1K tokens)
- Owner: Agent 5 (новые DB queries) + Agent 6 (cmd) + Agent 4 (UsageOverlay) + Agent 8 (wire)
- ~300-450 строк

#### `/search <query>` — поиск по истории
- SQLite FTS5 виртуальная таблица над `messages.content`.
- Migration: создать FTS5 таблицу + триггеры insert/update/delete для синка.
- Slash-команда: `/search bug fix` → fuzzy search по всем сессиям.
- Overlay показывает результаты с контекстом ±2 сообщения, можно перейти в сессию.
- Owner: Agent 5 (FTS schema + queries) + Agent 6 (cmd) + Agent 4 (SearchOverlay) + Agent 8 (wire)
- ~400-550 строк

#### Auto-compress на resume
- При `/resume <id>` если история > 50 сообщений ИЛИ > 30K токенов:
  - Автоматически вызвать `contextManager.compress()` с `keepLast: 10`.
  - Показать banner: "Compressed N old messages → summary. Use /history to restore full history."
- Owner: Agent 8
- ~50-80 строк

#### Tool-result trimming в истории
- При построении сообщений для следующего запроса: для tool-результатов старше последних 5:
  - Заменить content на `[tool: <name>(<args>) → N bytes / N lines collapsed; re-call to view]`.
  - Сохранить полный контент в SQLite (на случай восстановления).
- Опция в config: `context.trimToolResultsAfter: 5` (default).
- Owner: Agent 2 (context-manager)
- ~150-200 строк

---

### Tier 2 — Архитектурные улучшения

#### Wire `streamMultiple` для multi-file write
- Когда модель в одном response эмитит N tool calls И все они `write_file` ИЛИ `edit_file`:
  - Если paths не пересекаются → дозвонить `streamMultiple` с concurrency=2 для параллельной обработки.
  - Если пересекаются (тот же файл) → последовательно.
- Защита: после параллельных write проверить consistency через `lint_file`.
- Owner: Agent 8 (dispatcher) + Agent 2 (детектор пересечений)
- ~250-350 строк

#### Fuzzy `edit_file`
- Если `find_text` не найден точно:
  1. Нормализовать whitespace (collapse spaces, strip lines) и попробовать ещё раз.
  2. Если найден ≥ 1 candidate с similarity > 0.85 (Levenshtein или token-overlap) — вернуть top-3 кандидата с error: "Did you mean: <option1> | <option2> | <option3>?"
  3. Модель видит candidates и retry с правильным find_text.
- Owner: Agent 3 (edit-file.ts)
- ~150-220 строк

#### Better error recovery
- **Per-error toast в UI** — вместо stack trace показать понятную пилюлю: `✗ run_command failed: timeout (30s) — [r] retry [c] cancel`
- **Auto-retry transient errors** — сеть, 5xx, stall: retry 1 раз с exponential backoff. 4xx — fail fast.
- **Recovery state** — если `runStreamLoop` падает посреди multi-tool execution, сохранить state в `~/.localcode/recovery.json` и предложить продолжить при следующем запуске.
- Owner: Agent 8 (recovery state) + Agent 4 (error toast) + Agent 2 (retry logic)
- ~400-500 строк

---

### Tier 3 — Расширяемость

#### MCP (Model Context Protocol) support
- Подключение к внешним MCP серверам (database, GitHub, image gen, etc.).
- В config: `[[mcp_servers]]` с массивом серверов.
- Поддержка двух транспортов: stdio (subprocess) + SSE (HTTP).
- При старте — connect к каждому серверу, получить список tools, добавить в TOOLS_SCHEMA.
- ToolExecutor распознаёт MCP-tools по префиксу и роутит вызов через MCP клиент.
- Approval flow тот же.
- Owner: новый модуль `src/mcp/` (Agent A) + Agent 2 (TOOLS_SCHEMA dynamic) + Agent 5 (config schema) + Agent 8 (wire)
- ~700-1000 строк

#### Plugin system для custom tools
- Альтернатива MCP, проще для пользователя.
- Папка `~/.localcode/plugins/`, каждый файл — JS/TS модуль с экспортом:
  ```typescript
  export const tool: ToolDefinition = {
    name: 'my_tool',
    description: '...',
    parameters: { ... },  // JSON schema
    execute: async (args, ctx) => { return { success: true, output: '...' } },
  };
  ```
- При старте — динамический import каждого, валидация schema, регистрация в handler map.
- Watchman/chokidar reload на change.
- Owner: новый модуль `src/plugins/` + Agent 8
- ~300-400 строк

---

### Tier 4 — Hardening

#### Test coverage gaps
- **UI тесты**: добавить `ink-testing-library`, тестировать компоненты (focus navigation в overlays, paste handling, etc.).
- **Integration tests**: end-to-end с mock LM Studio (полный flow: input → tool → approval → write → response).
- **Stress tests**: создать сессию с 1000 сообщений, проверить performance + memory.
- ~800-1200 строк

#### Documentation refresh
- Полный обход `docs/`: ARCHITECTURE / COMMANDS / TOOLS / CONFIG / SKILLS / DEVELOPMENT / ROADMAP / TROUBLESHOOTING.
- Обновить все 12+ slash-команд (`/compress`, `/settings`, `/provider`, `/usage`, `/search`).
- Добавить screenshots секцию (если получится — ASCII captures).
- Owner: Docs Agent
- ~500-800 строк документации

#### Logging / debug mode
- `--debug` флаг → пишет structured logs (JSONL) в `~/.localcode/logs/<sessionId>.jsonl`.
- Уровни: trace (every fetch), debug (state transitions), info (commands), warn, error.
- Auto-rotation: keep last 7 days.
- Команда `/logs [follow | tail N | session <id>]` для просмотра.
- Owner: новый `src/logging/` + Agent 8 wire + Agent 6 cmd
- ~300-400 строк

---

### Tier 5 — Polish

#### i18n labels
- `~/.localcode/config.toml` поле `locale: 'en' | 'ru'`.
- Все UI лейблы (overlays, headers, error messages) — через функцию `t(key)`.
- Файлы перевода: `src/ui/i18n/en.ts`, `src/ui/i18n/ru.ts`.
- Полное покрытие — overlays, footer, hints.
- Owner: Agent 4
- ~400-600 строк

#### Vim mode в InputBar
- `Esc` → command mode (cursor становится блок).
- Поддержка: `h/j/k/l`, `w/b/e`, `dd`, `yy`, `p`, `0/$`, `gg/G`, `i/a/o/O`.
- Visual mode `v` для select+yank.
- `:` → командный prompt (опционально).
- Toggle через config: `editor.vim: true`.
- Owner: Agent 4 (InputBar rewrite)
- ~500-700 строк

#### Theme switcher
- Несколько готовых палитр в `src/ui/themes/`: nox-purple (current), monokai, solarized-dark, solarized-light, dracula.
- Команда `/theme [name]` или в onboarding.
- Live switch без перезапуска.
- Owner: Agent 4 (theme system) + Agent 6 (cmd)
- ~250-350 строк

#### Custom keybindings
- `~/.localcode/keybindings.json` — переопределение горячих клавиш.
- Default + override map.
- Команда `/keybindings` показывает текущие + позволяет редактировать.
- Owner: Agent 4 (keybinding registry) + Agent 5 (config) + Agent 6 (cmd)
- ~300-400 строк

#### Desktop notifications
- При длинной генерации (> 60s) и завершении — desktop notification через `node-notifier` или native (`osascript -e 'display notification'` на macOS).
- Toggle в config: `notifications.onCompletion: true`.
- Owner: Agent 8 + Agent 5 (config)
- ~100-150 строк

---

## Дополнительный план (мои идеи поверх)

### Performance / efficiency

#### Adaptive context window
- Если LM Studio отдаёт OOM при больших prompt (детект по error patterns) — автоматически уменьшать `num_ctx` на 25% и retry.
- Сохранять «working size» в config per model.

#### Embedding-based skill activation
- Использовать локальную small embedding model (e.g., bge-small-en) для индексации скиллов.
- При каждом user message — ANN search по embeddings, активировать топ-3 наиболее релевантных скилла на этот турн.
- Все скиллы загружаются только если явно `@-mention`.
- Огромная экономия токенов на длинных system prompts.
- ~500-700 строк (включая embedding модель wrapper).

#### Model warm-up
- Если последняя активность была > X минут назад, тихо отправить prompt-prefix request на model для прогрева KV cache.
- Trigger на input typing (юзер начал печатать → возможно сейчас будет запрос).

### Developer experience

#### `/diff` — git unstaged changes
- Показать `git diff` для текущей сессии.
- Удобно для review «что я уже сделал в этом сеансе?».

#### `/git` integration suite
- Модель может вызывать через `run_command`, но добавить специализированные tools: `git_status`, `git_diff`, `git_commit`, `git_branch`, `git_log`.
- Cleaner output чем raw shell.

#### Inline file references `@path:line`
- В user message: `@src/foo.ts:42` → auto-load этой строки + ±5 контекста в prompt.
- `@@symbol_name` → grep + load matched file.
- Уменьшает need for read_file calls.

#### `@-mention` skills
- `@frontend write a button component` → активирует только skill `frontend` для этого турна, остальные silent.
- Уменьшает токены, фокусирует модель.

#### Bash mode `!cmd`
- Префикс `!` в input → выполнить как shell, вывод в чат, НЕ отправлять модели.
- `!ls -la`, `!git status` — quick checks без entering tool flow.

#### Branch session
- `/branch <messageN>` → создаёт новую сессию начиная с указанного сообщения.
- Полезно для «давай попробуем другой подход с этого момента».

### Collaboration / sharing

#### Export / import sessions
- `/export [json | markdown]` → файл в текущую папку.
- `localcode --import session.json` → загружает сессию.

#### Skill packs
- Github-репы вида `localcode-skill-pack-frontend`.
- Команда `/skills install <github-url>` → клонит репу в `~/.localcode/skill-packs/<name>/`, парсит, регистрирует.
- Auto-update через `/skills update`.

### AI-specific features

#### Self-reflection loop
- После завершения задачи (модель сказала «done») — auto-prompt: «Review your work. Are there any edge cases, tests missing, or files you forgot? Be honest.»
- Модель ревьюит → если что-то найдено — auto-fix (с approval).
- Toggle в config: `agent.selfReflect: true`.

#### Auto-test on write
- После каждого `write_file` / `edit_file` в test file — автоматически запустить тесты этого файла (jest/vitest/bun:test detection).
- Если упали — модель видит результат, исправляет.

#### Diff-aware prompts
- При `read_file` если файл уже под git — отправить `git show HEAD:path` (старая версия) только если есть unstaged changes; иначе просто `read_file` как обычно.
- Часто экономит дофига токенов когда модель смотрит файл который ничем не отличается от HEAD.

#### Project RAG
- Embeddings всех файлов проекта при `/init`.
- При запросе модель сначала делает semantic search по project, получает топ-3 релевантных файла, потом читает только их.
- Альтернатива «модель угадывает что читать».
- Большая работа (~800+ строк) но мощная.

### Reliability

#### Crash recovery
- При unexpected exit / OS crash — сессия сохраняется автоматически (мы уже персистим в SQLite).
- При следующем старте: «Last session ended unexpectedly during streaming. Resume?» с опцией восстановить.

#### Token quota
- В config: `quota.dailyTokens: 100000`.
- Когда квота близка — warning в UI. Когда исчерпана — block requests до завтра.
- Полезно для контроля cost (если LM Studio + дешёвая модель → не критично, но для cloud providers — критично).

### Observability

#### `/dashboard` overlay
- Real-time metrics: текущая модель, активные tools, last error, uptime, memory used by ContextManager, sessions count.
- Refresh every 2s.

#### Slow request log
- Запросы > 60s записываются в `~/.localcode/slow.jsonl` с full context.
- Команда `/slow [N]` показывает top-N медленных.

#### Metrics export (Prometheus)
- На `--metrics-port 9090` поднять HTTP endpoint с Prometheus-compatible metrics.
- Total tokens, latency histograms, tool error rates.
- Для нердов которые мониторят локальный stack.

### UX

#### Command palette (Ctrl+P)
- Fuzzy-search overlay по ВСЕМ командам (включая slash + project files + recent messages).
- Ctrl+P → "permis" → highlight `/permissions`. Enter → execute.

#### File preview overlay
- Когда модель упоминает файл (`src/foo.ts`), inline кликабельная ссылка → открыть preview overlay с содержимым.
- Esc закрывает.

#### Quick model switch (Ctrl+M)
- Без открытия full overlay — popup с last 5 models, arrow keys, enter selects.

#### Copy / yank
- Hover на сообщение, нажать `y` → текст в clipboard.
- Полезно для копирования код-ответов модели.

#### Bookmark messages
- `b` на сообщении → отметить.
- `/bookmarks` показывает все starred.

### Integrations

#### GitHub CLI bridge
- Модель может через специализированный tool `github_*`: `pr_create`, `pr_review`, `issue_create`, `repo_clone`.
- Реализуется через `run_command gh ...`, но cleaner UX.

#### Notion / Linear sync
- При завершении задачи модель может задать «Create Linear issue?» — отправит через API.
- Скиллы для шаблонов.

#### Browser preview bridge
- Если модель пишет HTML/CSS/React — открыть `localhost` preview, рендерить через локальный dev server.
- Auto-refresh при write.

#### Image drag-drop
- В iTerm2 / Kitty / WezTerm — поддержка drag-drop image в input.
- Конвертируется в `fetch_image({ url: 'data:...' })` автоматически.

### Privacy / Security

#### Secrets scanner
- Перед отправкой prompt — сканировать на pattern: API keys (sk-..., AKIA...), JWT, .env content.
- Если найдено — UI prompt: "Sensitive data detected. Send anyway? [y/n/redact]".
- Redact = заменить на `<REDACTED>` перед отправкой.

#### Approval audit log
- Каждое одобрение `write_file` / `run_command` пишется в `~/.localcode/audit.jsonl` с timestamp, command, user, decision.
- Команда `/audit [filter]` для просмотра.

#### Sandboxed run_command
- Опция `permissions.runCommandSandbox: 'docker' | 'firejail' | 'none'`.
- Docker: команды выполняются в эфемерном container, проект mount'ится readonly (или rw в специфическую папку).
- Защита от вредоносных команд (`rm -rf ~`).

#### Per-project allowlist
- В `<projectRoot>/.localcode/settings.json`: `commandAllowlist: ['npm test', 'bun test', 'git status']`.
- Команды НЕ из allowlist всегда требуют approval даже с `dangerouslyAllowAll`.

### Code quality (project-internal)

#### Refactor `app.tsx` (currently 2400+ lines)
- Извлечь хуки в `src/hooks/`: `useLLMAdapter`, `useToolExecutor`, `useChatLoop`, `useOverlayRouter`, `useExitFlow`.
- Каждый hook < 200 строк, тестируем независимо.
- Сам `App` component становится 100-150 строк композиции.

#### CI pipeline
- GitHub Actions:
  - On push: lint, tsc, bun test
  - On PR: ^ + bun build smoke
  - On tag: release с auto-changelog
- ~50 строк YAML

#### Versioning + release
- Conventional commits (feat:, fix:, chore:).
- Auto-tag через semantic-release.
- `localcode --version` показывает + git SHA + build date.

#### Performance benchmarks
- `bench/` папка с stress tests.
- Track: stream throughput, message render time, DB write speed.
- Регрессии фиксируются на каждый PR.

---

## Order of execution (моя рекомендация)

1. **Сначала field-test (1-2 недели)**: использовать localcode на реальных задачах, собрать список багов → поправить.
2. **Tier 1 (quick wins)**: `/usage`, `/search`, auto-compress, tool-result trimming. Низкий риск, высокий эффект.
3. **Tier 4 (hardening) частично**: добавить debug logging — пригодится для дебага следующих фич.
4. **Tier 2 (архитектура)**: streamMultiple wiring + fuzzy edit_file + error recovery.
5. **Tier 3 (расширяемость)**: MCP support **OR** plugin system. Не оба сразу — выбрать по востребованности.
6. **Tier 5 (polish)**: i18n + theme switcher + keybindings + notifications.
7. **Дополнительные идеи**: по запросу или по итогам field-testing.

---

## Принципы продолжения

- **Качество > скорость** (per user directive).
- **Test-first для новых фич**: каждая фича получает unit test до wire.
- **Incremental delivery**: small commits, каждый зелёный, можно остановиться в любой момент.
- **Backward compat**: опциональные fields, .default() в zod, миграции старых конфигов.
- **File ownership**: соблюдать per-agent boundaries.

---

*Этот документ — живой. Обновлять по мере выполнения и добавления новых идей.*
