# LocalCode — Fix Plan (round 2)

Рабочий план правок, поступивших от пользователя 2026-04-24.

## Правки

| № | Что фиксим | Ответственный |
|---|---|---|
| 1 | Фильтровать `<\|channel\|>`, `<\|message\|>`, `<\|start\|>` и прочие Harmony-токены из стрима (не показывать в UI) | Agent 2 (streaming.ts) |
| 2 | `/permissions` — управление auto-approve для инструментов (persistent config) | Agent 5 (schema) + Agent 6 (cmd) + Agent 2 (ToolExecutor) |
| 3 | Header (модель/контекст) всегда ПОД строкой ввода, не сверху | Agent 4 (ChatScreen layout) |
| 4 | `/ctxsize <N>` — выбор размера контекста; `num_ctx` → Ollama, сохраняется в config | Agent 5 + Agent 2 + Agent 6 |
| 5 | Keep-alive: проект и система всегда в памяти модели между запросами (prefix cache + `keep_alive` Ollama) | Agent 2 |
| 6 | Неблокирующий ввод — можно печатать во время стриминга; submit ставит в очередь | Agent 4 (InputBar+ChatScreen) |
| 7 | Визуальные разделители между user/assistant + структурированный рендеринг (code fences) | Agent 4 (MessageBlock new) |
| 8 | При выходе печатается `localcode --resume <id>` | Agent 8 (cli.tsx exit hook) |
| 9 | Стрелки ↑/↓ в InputBar → история предыдущих запросов | Agent 4 (InputBar) |
| 10 | Stall-детектор: если LM Studio/Ollama не отдаёт чанки N секунд → abort + понятное сообщение | Agent 2 (adapter) |
| 11 | Рамка вокруг InputBar (чтобы визуально было понятно где печатать) | Agent 4 (InputBar.tsx) |
| 12 | Inline mini-diff: когда модель правит код — компактный сниппет с номерами строк, зелёное/красное (стиль Claude Code / Codex) | Agent 4 (InlineDiffView) + Agent 2 (уже отдаёт diff из write_file) |
| 13 | Footer после каждого ответа: `↳ N токенов · M.Ms` (usage из OpenAI-chunk или эстимейт) | Agent 2 (capture usage+timing) + Agent 4 (UsageFooter) + Agent 5 (persist tokens_in/out + duration_ms в messages) |
| 14 | Новый tool `edit_file` (search/replace) — модель правит куски, не переписывает файл целиком; keep-alive Ollama → модель живёт в VRAM всю сессию | Agent 3 (edit_file) + Agent 2 (schema + system prompt guidance + keep_alive) |
| 15 | `/new-skill` — overlay для вставки/ввода текста или пути к файлу; сохраняется в `<projectRoot>/.localcode/skills/`. Слэш-команды модели НЕ отправляются (verify) | Agent 6 (cmd) + Agent 4 (SkillInputOverlay) + Agent 8 (verify slash → no LLM) |
| 16 | `.localcode/` всегда создаётся в КОРНЕ проекта пользователя (не в нашей папке). Скиллы — приоритет project-local, fallback — global `~/.localcode/skills/` | Agent 6 (SkillsManager two-source loader) + Agent 7 (verify writeLocalcodeMd location) |
| 17 | Language consistency — модель отвечает на языке чата (русский→русский, английский→английский); код-вставки на других языках не меняют язык ответа | Agent 2 (buildSystemPrompt rule) |
| 18 | Professional senior-engineer system prompt — не болванка, а опытный инженер: знает best practices, умеет выбирать библиотеки, мыслит архитектурно | Agent 2 (buildSystemPrompt) |
| 19 | Сжатая история чата для resume — при `/resume` модель помнит о чём говорили: хранить сжатое саммари сессии | Agent 2 (summarize-on-save) + Agent 5 (sessions.summary column) + Agent 6 (resume injects summary) |
| 20 | RAM usage: сейчас 3-5 GB на крошечном проекте. Не забивать контекст всем кодом подряд — модель читает через tools; сообщения пейджинируются на диск; для UI оптимизировать ink-вывод | Agent 2 (context paging) + Agent 8 (bundle externalize + memory tuning) |
| 21 | Анализ картинок из URL — если юзер кидает ссылку на скрин, бэкграунд-задача качает и отправляет в multimodal API | Agent 3 (fetch_image tool) + Agent 2 (multimodal message содержание) |
| 22 | Label под ответом модели — вместо `llm` показывать реальное имя (`qwen2.5-coder`, `gemma4`) | Agent 4 (ChatScreen message label) |
| 23 | Self-modify settings — модель знает где лежит её `~/.localcode/config.toml`, может его читать и предлагать правки через `edit_file` с approval и diff | Agent 2 (system prompt addendum) + работает через existing tools |

## Round 3 — Mascot / Theme / UX polish

| № | Что фиксим | Ответственный |
|---|---|---|
| 24 | User messages — только цветная подложка, БЕЗ лейбла `You` (как в Claude Code) | Agent 4 R3 (MessageBlock) |
| 25 | NOX mascot — `<NoxBig>` центр экрана на старте (14 rows × 16 px карта), `<NoxMini>` 4×6 возле InputBar. Blink при streaming. Покидает экран вверх вместе со скроллом | Agent 4 R3 (new `src/ui/components/Nox.tsx`, ChatScreen layout) |
| 26 | Фиолетовая тема — весь UI в оттенках (#2d1b69 … #e9d5ff) | Agent 4 R3 (theme.ts rewrite) |
| 27 | Error-check loop — сгенерированный код валидируется (tsc/ruff/go vet по расширению) и автофиксится если поломан | Agent 2 R4 (новый post-tool-hook) + Agent 3 R4 (lint_file tool) |
| 28 | Thinking phrases — 30 фраз (ru/en по локали), цикл по 30 сек, rainbow-gradient перелив | Agent 4 R3 (ThinkingSpinner + phrases file) |
| 29 | Sound support — config.sound.{onApproval, onCompletion} + воспроизведение (afplay/beep) | Agent 5 R5 (schema) + Agent 8 R3 (wiring) |
| 30 | Parallel file generation — если модель создаёт N файлов, 2 генерации параллельно (LM Studio concurrency = 2) с последующей консистенси-проверкой | Agent 2 R4 (streamChatParallel / scheduler) + Agent 8 R3 (dispatcher) |
| 31 | Финальная документация — после всех тестов обновить README + создать `docs/` с подробным гайдом | Agent 7 R3 (project-scanner may emit docs) + Agent 8 R3 |
| 32 | Slash-команды → **локальные UI-оверлеи, НЕ текст в чате**. `/permissions`, `/context`, `/ctxsize`, `/resume`, `/model` открывают меню со стрелками и Enter. Никаких отправок на LLM. | Agent 4 R3 (overlay components) + Agent 6 R4 (commands return view) + Agent 8 R3 (route overlay in ChatScreen) |
| 33 | `/provider` — сменить backend (Ollama ↔ LM Studio ↔ custom). Если URL для выбранного не задан — поле ввода; если задан — можно изменить | Agent 4 R3 (ProviderOverlay) + Agent 6 R4 (cmd-provider) + Agent 8 R3 (rebuild adapter on provider change) |

## Round 4 — UX polish + per-project settings + compress

| № | Что фиксим | Ответственный |
|---|---|---|
| 34 | `/compress` — суммаризировать всю текущую сессию (юзер-сообщения + ответы + код в очень сжатом виде) и заменить контекст моделью одним саммари. Используется когда контекст заполнен | Agent 2 R5 (compress logic + system prompt) + Agent 6 R5 (cmd-compress) + Agent 8 R5 (wire) |
| 35 | `.localcode/settings.json` — per-project generation params (temperature, top_p, repeat_penalty, max_tokens). Проект > глобал. `/settings` показывает источник + редактирует оба уровня | Agent 5 R6 (schema + readProjectSettings/writeProjectSettings) + Agent 2 R5 (pass params to LLM) + Agent 6 R5 (cmd-settings) + Agent 4 R5 (SettingsOverlay) + Agent 8 R5 (wire) |






## Фазы

- **Фаза A** (sequential): Agent 5 расширяет config schema — `permissions.autoApprove`, `context.maxTokens`, `context.keepAlive`.
- **Фаза B** (parallel): Agents 2, 4, 6 работают в своих зонах.
- **Фаза C** (sequential): Agent 8 подключает новое в app.tsx/cli.tsx.
- **Фаза D**: Agent 9 пишет тесты.

Все правки — минимальные, без переписывания рабочего кода.
