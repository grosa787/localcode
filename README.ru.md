<div align="center">

# 🌙 LocalCode

**Локальный AI-ассистент для парного программирования уровня Claude Code — в терминале и в браузере.**

[**English**](README.md) · [**Русский**](README.ru.md)

[![Bun ≥ 1.1](https://img.shields.io/badge/Bun-≥1.1-black?logo=bun)](https://bun.sh)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests 3196 passing](https://img.shields.io/badge/тесты-3196_pass-brightgreen)](#тестирование)
[![Local-first](https://img.shields.io/badge/local--first-да-purple)](#поддерживаемые-провайдеры)

</div>

---

## Что такое LocalCode?

LocalCode — это AI-ассистент для парного программирования с двумя интерфейсами (**терминал + браузер**). Он работает с **любой** LLM (локальной или облачной), выдаёт модели набор инструментов (читать/писать файлы, запускать команды, ходить в веб, смотреть картинки, работать с Jupyter-ноутбуками и т.д.), хранит всё локально в SQLite и даёт детальные ручки контроля, чтобы ассистент был **быстрым, безопасным и наблюдаемым**.

Построен на [Bun](https://bun.sh) + [ink](https://github.com/vadimdemedes/ink) (TUI) + Vite/React (Web). Один статически собранный бинарь, без Electron, без облачных вызовов без явного согласия.

```sh
localcode                            # терминальный UI (по умолчанию)
localcode --web                      # браузерный UI (откроется автоматом)
```

<br/>

## Содержание

- [Что нового](#что-нового)
- [Поддерживаемые провайдеры](#поддерживаемые-провайдеры)
- [Требования](#требования)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Флаги CLI](#флаги-cli)
- [Веб-режим](#веб-режим)
- [Слэш-команды](#слэш-команды)
- [Инструменты для модели](#инструменты-для-модели)
- [Профили разрешений](#профили-разрешений)
- [Память и скиллы](#память-и-скиллы)
- [Хуки и чувствительные файлы](#хуки-и-чувствительные-файлы)
- [Суб-агенты](#суб-агенты)
- [MCP-серверы](#mcp-серверы)
- [Конфигурация](#конфигурация)
- [Архитектура](#архитектура)
- [Тестирование](#тестирование)
- [Лицензия](#лицензия)

<br/>

## Что нового

- **Любая LLM** — Ollama, LM Studio, OpenAI, Anthropic, OpenRouter, Google Gemini и любой OpenAI-совместимый URL (Groq, Together, Fireworks, Mistral, vLLM, llama.cpp…). Один UI, семь бэкендов.
- **Два интерфейса, общий мозг** — красивый ink TUI **и** отполированный web UI (табы, dock, голос, drag-drop, PDF, whiteboard).
- **Реальный tool-calling с approval-гейтами** — диффы и превью команд, авто-approve по инструменту, **5 профилей разрешений** (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`).
- **Суб-агенты по требованию** — спавн специалистов из каталога (`architect`, `debugger`, `security-reviewer`, ревьюверы по языкам и др.). Переключайся между ними, отправляй доп.контекст, смотри прогресс.
- **Память** — персистентная память по проекту (`user` / `feedback` / `project` / `reference`) автоматически инжектится в system prompt.
- **Хуки** — shell-скрипты на `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` / `Stop` / `PreCompact` / `SessionEnd`.
- **Поддержка MCP** — Model Context Protocol через `stdio` или `http`; tools автоматически именуются как `mcp__<server>__<tool>`.
- **Учёт стоимости** — чип стоимости под каждым сообщением, реальные цены OpenRouter / static-pricing. `/usage` dashboard, `/cost` по сессии, sparkline-визуализатор токенов.
- **Умный ввод** — путь к картинке в строке → автоматически прикрепляется как multimodal. Drag-drop в браузере. Голос (ввод/вывод) через Web Speech API. Парсинг PDF.
- **Диагностика + recovery** — наблюдение за процессами (`/watch <cmd>` + `/diagnose`), branching сессий, `/undo`, full-screen diff viewer, health watchdog, error banner с retry.
- **Онтология кодовой базы** — граф знаний через TypeScript LSP; новые tools `find_call_sites`, `impacts_of`, `type_hierarchy`.
- **Архитектурные правила** — задавай слои в `.localcode/arch.toml`; PreToolUse-валидатор блокирует запрещённые импорты.
- **Безопасность из коробки** — pre-commit secret scanner (AWS / GitHub / OpenAI / Anthropic / Stripe / private-key + энтропия), gating чувствительных файлов, редакция.
- **LAN-шаринг** — mDNS discovery + HMAC pairing + AES-GCM session sync; делись сессией с коллегой по локальной сети без облака.
- **i18n** — полная локализация на английский и русский, переключение в одно касание.

<br/>

## Поддерживаемые провайдеры

| Провайдер         | Тип     | Настройка                                                                  |
| ----------------- | ------- | -------------------------------------------------------------------------- |
| Ollama            | Локал.  | Поставь Ollama, запусти `ollama serve`                                     |
| LM Studio         | Локал.  | Поставь LM Studio, включи локальный сервер                                 |
| OpenAI            | Облако  | Ключ через `OPENAI_API_KEY` или `/provider`                                |
| Anthropic         | Облако  | Ключ через `ANTHROPIC_API_KEY` или `/provider`                             |
| OpenRouter        | Облако  | Ключ через `OPENROUTER_API_KEY` или `/provider`                            |
| Google Gemini     | Облако  | Ключ через `GEMINI_API_KEY` или `/provider`                                |
| Custom            | Облако  | Любой OpenAI-совместимый base URL (Groq, Together, Fireworks, Mistral, …)  |

Явный `apiKey` в `~/.localcode/config.toml` выигрывает; переменные окружения — fallback. Примеры по каждому провайдеру: [docs/PROVIDERS.md](localcode/docs/PROVIDERS.md).

<br/>

## Требования

- **[Bun](https://bun.sh) ≥ 1.1** — runtime, package manager, bundler.
- **macOS** или **Linux**. Windows поддерживается через WSL.
- Хотя бы один доступный LLM-бэкенд (локальный сервер или облачный API-ключ).

<br/>

## Установка

```sh
git clone https://github.com/<твой-логин>/localcode.git
cd localcode
./install.sh
```

`install.sh` выполняет `bun install`, собирает `dist/cli.js` и через `sudo` создаёт симлинк в `/usr/local/bin/localcode`. После этого `localcode` доступен глобально.

Без установки:

```sh
bun install
bun run dev          # алиас для: bun run src/cli.tsx
```

<br/>

## Быстрый старт

```sh
localcode                            # открыть текущую директорию
localcode ~/path/to/project          # открыть конкретный проект
localcode --resume ab12cd34          # возобновить сессию по префиксу id
localcode --model claude-3-5-sonnet  # переопределить модель на этот запуск
localcode --profile plan             # стартовать в Plan Mode (без мутаций)
localcode --web                      # браузерный UI
localcode --help                     # полный список флагов
localcode --version
```

**Первый запуск** → онбординг: выбор бэкенда, проверка URL, выбор модели — и ты в чате.

<br/>

## Флаги CLI

```
localcode [projectRoot] [флаги]
```

| Флаг                            | Что делает                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `[projectRoot]`                 | Позиционный аргумент. Путь к проекту. По умолчанию — `process.cwd()`.                                                    |
| `--profile <имя>`               | Профиль разрешений: `default` · `acceptEdits` · `plan` · `dontAsk` · `bypassPermissions`. Перекрывает persisted-конфиг.  |
| `--dangerously-allow-all`       | **УСТАРЕЛО.** Эквивалент `--profile dontAsk`. Пропускает все подтверждения.                                              |
| `--resume <sessionId>`          | Возобновить сессию. Принимает полный UUID или достаточно уникальный префикс.                                             |
| `--model <имя>`                 | Переопределить активную модель только на этот запуск (НЕ меняет persisted-конфиг).                                       |
| `--reconfigure`                 | Заново пройти онбординг, перезаписав конфиг.                                                                             |
| `--no-refresh-models`           | Пропустить refresh списка моделей при старте.                                                                            |
| `--web`                         | Запустить веб-интерфейс вместо TUI.                                                                                      |
| `--web-host <host>`             | Хост биндинга для `--web`. По умолчанию `127.0.0.1`. `0.0.0.0` — открыть в LAN.                                          |
| `--web-port <порт>`             | Первый порт для `--web`. По умолчанию `7777`. Если занят, пробует следующие.                                             |
| `--no-open`                     | Не открывать браузер автоматически при `--web`. URL всё равно выводится в stdout.                                        |
| `--lan`                         | Включить LAN P2P session sharing через mDNS (по умолчанию выключено).                                                    |
| `--help`, `-h`                  | Показать справку и выйти.                                                                                                |
| `--version`, `-v`               | Показать версию и выйти.                                                                                                 |

### Подкоманды

| Подкоманда                   | Описание                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `localcode plugin <action>`  | Управление плагинами: `install <path>` · `uninstall <id>` · `list` · `enable <id>` · `disable <id>` |
| `localcode daemon`           | Запустить persistent cron daemon (фоновые расписания).                                            |

<br/>

## Веб-режим

`localcode --web` поднимает локальный сервер на `127.0.0.1:7777` (настраивается), печатает URL с одноразовым CSRF-токеном в URL fragment'е и автоматически открывает браузер.

Возможности веб-интерфейса:

- Табы сессий (Cmd/Ctrl + 1…9 — переключение, Cmd/Ctrl + T — новый, Cmd/Ctrl + W — закрыть).
- Resize и dock панелей.
- Иконки в шапке: Tasks · Agents · Browser · Memory · Files · Usage · Notifications · Settings.
- Голосовой ввод (push-to-talk) + голосовой вывод (TTS) через Web Speech API.
- Drag-drop файлов из OS (картинки → multimodal-аттач, текст → `@path`).
- Парсинг PDF с превью постраничной.
- Whiteboard уровня `tldraw` — нарисуй схему → отправь в чат как multimodal.
- Mermaid-диаграммы как SVG с full-screen zoom/pan.
- Светлая и тёмная темы.
- Live-счётчик стоимости, индикатор очереди сообщений, error banner с **Retry last**.

<br/>

## Слэш-команды

Все слэш-команды выполняются **локально** — ни одна не отправляется в LLM.

<details>
<summary><b>Показать все команды</b></summary>

| Команда            | Что делает                                                                            |
| ------------------ | ------------------------------------------------------------------------------------- |
| `/help`            | Список всех зарегистрированных команд.                                                |
| `/init`            | Сканирует проект и пишет `.localcode/LOCALCODE.md`.                                   |
| `/model [name]`    | Открыть выбор или переключить напрямую.                                               |
| `/provider [...]`  | Переключить бэкенд (Ollama / LM Studio / OpenAI / Anthropic / OpenRouter / Google / custom). |
| `/profile [name]`  | Переключить профиль разрешений: `default` · `acceptEdits` · `plan` · `dontAsk` · `bypassPermissions`. |
| `/style [name]`    | Стиль вывода: `concise` · `explanatory` · `verbose`.                                  |
| `/statusline`      | Настроить шаблон статус-строки.                                                       |
| `/resume [id]`     | Выбрать или загрузить сессию.                                                         |
| `/clear`           | Сохранить summary, начать новый чат.                                                  |
| `/context`         | Показать использование токенов, активные скиллы, статус LOCALCODE.md.                 |
| `/ctxsize [n]`     | Настроить `num_ctx` и keep-alive.                                                     |
| `/compress`        | Сжать контекст в одно summary-сообщение.                                              |
| `/settings`        | Параметры генерации (temperature, top_p, repeat_penalty, max_tokens).                 |
| `/permissions`     | Переключить авто-approve по инструменту.                                              |
| `/diff [ref]`      | Открыть full-screen diff viewer.                                                      |
| `/undo [N\|list]`  | Откатить последние N мутаций файлов из in-memory snapshot stack'а.                    |
| `/review`          | Однократный LLM code review.                                                          |
| `/plan`            | Двухфазная генерация плана.                                                           |
| `/skills`          | Управление скиллами.                                                                  |
| `/new-skill`       | Создать скилл вставкой текста или указанием пути.                                     |
| `/memory`          | Открыть список memory entries.                                                        |
| `/memory-save <id>`| Сохранить предложенный feedback proposal.                                             |
| `/todos`           | Открыть Tasks panel.                                                                  |
| `/usage`           | Кумулятивный dashboard со стоимостью по моделям.                                      |
| `/cost`            | Стоимость текущей сессии по turn'ам.                                                  |
| `/perf` `/tokens`  | Визуализатор токенов со sparkline-чартами.                                            |
| `/agent`           | Запустить agentic loop на задаче.                                                     |
| `/spawn [id task]` | Спавн специалиста из каталога.                                                        |
| `/agents diff <id>`| Diff worktree суб-агента.                                                             |
| `/branch [...]`    | Branching сессий: `list` · `<name>` · `switch <name>` · `delete <name>`.              |
| `/conv diff A B`   | Сравнить две ветки.                                                                   |
| `/record`          | Запись/воспроизведение: `start` · `stop` · `save` · `list`.                           |
| `/replay <file>`   | Воспроизвести запись на выбранной скорости.                                           |
| `/cron`            | Persistent cron-расписания.                                                           |
| `/wakeups`         | In-session deferred continuations.                                                    |
| `/watch <cmd>`     | Наблюдать за долгим процессом (dev server, тесты) — диагностические сигналы.          |
| `/diagnose [id]`   | Сообщить о compile / test ошибках в watched-процессах.                                |
| `/arch`            | Architecture rules: `check` · `rules` · `init` · `ignore <pattern>`.                  |
| `/ontology`        | Граф знаний кодовой базы: `status` · `refresh` · `graph <symbol>`.                    |
| `/secrets`         | Secret scanner: `scan` · `scan-all` · `allow <pattern>`.                              |
| `/sensitive`       | Sensitive-files gating: `list` · `add <pattern>` · `check <path>`.                    |
| `/worktrees`       | Управление worktree'ями суб-агентов.                                                  |
| `/plugin`          | Управление плагинами.                                                                 |
| `/share`           | LAN P2P session sharing: `start` · `stop` · `peers` · `accept`.                       |
| `/whiteboard`      | Открыть web whiteboard.                                                               |
| `/filter`          | Скрыть/показать thinking / tool calls / system notes в чате.                          |
| `/suggest`         | Toggle панели проактивных подсказок.                                                  |
| `/exit`            | Выйти и сохранить summary сессии.                                                     |

</details>

<br/>

## Инструменты для модели

Модель получает типизированный набор инструментов. Read-only — выполняются автоматически; мутирующие — через approval (если не pre-approved или не под `dontAsk`).

<details>
<summary><b>Read-only / инспектирование</b></summary>

| Инструмент          | Назначение                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `read_file`         | Читает файл под projectRoot; авто-постранично для файлов >1 MB.         |
| `list_dir`          | Tree-листинг с уважением `.gitignore`.                                  |
| `glob_search`       | `fast-glob` lookup, gitignore-aware, защита от symlink-петель.          |
| `find_symbol`       | Поиск символа через tsserver.                                           |
| `find_call_sites`   | Ontology-запрос: все вызовы функции/метода.                             |
| `impacts_of`        | Ontology-запрос: транзитивный граф влияний.                             |
| `type_hierarchy`    | Ontology-запрос: предки/потомки/братья типа.                            |
| `lint_file`         | Нативная проверка синтаксиса (tsc / ruff / go vet / rustc).             |
| `fetch_image`       | Скачать HTTPS или `data:image/*` URL; прикрепить как multimodal.        |
| `web_fetch`         | URL → markdown.                                                         |
| `web_search`        | DuckDuckGo top results.                                                 |
| `notebook_read`     | Прочитать `.ipynb`.                                                     |
| `pdf_read`          | Парсинг PDF постранично в текст.                                        |
| `monitor`           | Статус фоновой bash-задачи.                                             |
| `process_status`    | Статус watched-процессов.                                               |
| `git_status`/`diff`/`log`/`branch` | Read-only операции Git.                                  |

</details>

<details>
<summary><b>Мутирующие (требуют approval по умолчанию)</b></summary>

| Инструмент          | Назначение                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `write_file`        | Замена файла (two-phase preview + commit).                              |
| `edit_file`         | Search/replace с проверкой уникальности подстроки.                      |
| `multi_edit`        | Атомарный batch правок в одном файле.                                   |
| `notebook_edit`     | Replace / insert / delete ячейки notebook'а.                            |
| `run_command`       | `sh -c …` (опционально `runInBackground: true`).                        |
| `git_commit`        | Сделать коммит (тут же срабатывает secret-scanner hook).                |
| `todo_write`        | Обновить in-session task list.                                          |
| `schedule_wakeup`   | Отложить продолжение на 60–3600 сек.                                    |
| `spawn_agent`       | Спавн суб-агента.                                                       |
| `team_send` / `team_read` | Inter-agent коммуникация через TeamBus.                           |

</details>

<br/>

## Профили разрешений

| Профиль              | read-only | `write_file` / `edit_file` | `run_command` / `git_commit` / `browser_evaluate` |
| -------------------- | --------- | -------------------------- | ------------------------------------------------- |
| `default`            | run       | approval                   | approval                                          |
| `acceptEdits`        | run       | **auto**                   | approval                                          |
| `plan`               | run       | **блокировка**             | **блокировка**                                    |
| `dontAsk`            | run       | auto                       | auto                                              |
| `bypassPermissions`  | run       | auto + ⚠ banner            | auto + ⚠ banner                                   |

Переключение в любое время: `/profile <имя>` или **Ctrl+P** (TUI). Sensitive-files gating перекрывает каждый профиль.

<br/>

## Память и скиллы

**Память** живёт в `<projectRoot>/.localcode/memory/*.md`. 4 типа: `user` / `feedback` / `project` / `reference`. Каждая запись — markdown с YAML frontmatter. Memory-секция инжектится в system prompt **байт-стабильно**, чтобы prompt-prefix cache оставался горячим. Индекс в `MEMORY.md` в корне.

**Скиллы** — markdown в `.localcode/skills/` (проектные) + `~/.localcode/skills/` (глобальные). Проектные побеждают при коллизии id. Hot-reload через `chokidar`. Управление: `/skills` и `/new-skill`.

<br/>

## Хуки и чувствительные файлы

**Хуки** — shell-скрипты через `[[hooks]]` блоки в `~/.localcode/config.toml`. Триггеры:

- `PreToolUse` — может БЛОКИРОВАТЬ вызов инструмента (non-zero exit → tool fails).
- `PostToolUse` — synthetic system note only.
- `UserPromptSubmit` — срабатывает до коммита контекста; блокирующий fail прерывает turn.
- `SessionStart` / `SessionEnd` / `Stop` / `PreCompact` — lifecycle.

Встроенный **secret-scanner** хук автоматически регистрируется на `PreToolUse:git_commit` — отказывается коммитить AWS-ключи, GitHub PAT, OpenAI/Anthropic/Stripe/Google ключи, приватные ключи или high-entropy assignments.

**Чувствительные файлы** в `~/.localcode/sensitive-files.toml` (или `.localcode/sensitive-files.toml`) объявляют glob-паттерны (например, `.env*`, `**/secrets/**`, `*.pem`, `**/.ssh/**`), которые **всегда требуют approval — даже под `dontAsk`**.

<br/>

## Суб-агенты

Спавн специалистов из каталога (10 шаблонов):

```
architect · debugger · security-reviewer · typescript-reviewer ·
python-reviewer · rust-reviewer · go-reviewer · test-engineer ·
performance-optimizer · doc-writer
```

```sh
/spawn debugger "почему миграция отвалилась по таймауту"
```

Воркеры работают в изолированных git worktree'ях, общаются через TeamBus. В TUI нажми **Tab** для входа в agent-focus mode, ↑/↓ для выбора, **Enter** для прикрепления к воркеру; **Esc** обратно к лиду. В web кликни воркера в Agents panel → попадаешь в reply mode.

Завершённые воркеры автоматически уезжают в history.

<br/>

## MCP-серверы

LocalCode — клиент Model Context Protocol. Конфиг в TOML:

```toml
[[mcpServers.my-server]]
type = "stdio"
command = "uvx"
args = ["mcp-server-time"]

[[mcpServers.docs]]
type = "http"
url = "https://example.com/mcp"
headers = { Authorization = "Bearer …" }
```

Tools автоматически именуются как `mcp__<server>__<tool>`. Статус: `GET /api/mcp`.

<br/>

## Конфигурация

Весь конфиг в `~/.localcode/config.toml` (глобально) + переопределения по проекту в `<projectRoot>/.localcode/settings.json`. На первом запуске пишутся defaults; дальнейшие правки атомарны (tmp + rename) и Zod-валидированы.

Пример:

```toml
[backend]
type = "openrouter"
baseUrl = "https://openrouter.ai/api/v1"

[model]
current = "anthropic/claude-3.5-sonnet"

[permissions]
profile = "acceptEdits"
autoApprove = ["read_file", "list_dir"]

[context]
maxTokens = 32768
keepAliveSeconds = 1800
autoCompressPercent = 0.80
maxRecentMessages = 20

[sound]
enabled = false

outputStyle = "concise"

[statusline]
enabled = true
template = "{provider} · {model} · {tokens}/{maxTokens} ({pct}%) · {profile}"
```

Полная схема: [docs/CONFIG.md](localcode/docs/CONFIG.md).

<br/>

## Архитектура

```
src/
├── cli.tsx                    argv + mount ink
├── app.tsx                    composition root
├── llm/                       adapter (OpenAI-compat + Anthropic), context, executor, pricing
├── tools/                     30+ реализаций инструментов
├── sessions/                  bun:sqlite, FTS5 search, branching
├── commands/                  фабрики слэш-команд
├── config/                    Zod-валидированный TOML
├── skills/                    chokidar-наблюдаемые markdown-скиллы
├── memory/                    persistent memory entries
├── hooks/                     shell-hook engine (7 триггеров)
├── mcp/                       MCP-клиент
├── agents/                    orchestrator, TeamBus, worker pool, worktree GC, каталог
├── ontology/                  TS LSP knowledge graph
├── architecture/              arch.toml validator
├── security/                  secret scanner, sensitive files
├── process-monitor/           watched-process diagnoser
├── networking/                LAN P2P (mDNS + HMAC + AES-GCM)
├── recordings/                запись/воспроизведение сессий
├── scheduling/                wakeups + persistent crons
├── web/                       REST + WS сервер, runtime pool, approval bridge
└── ui/                        ink TUI (screens, components, overlays)

web-frontend/                  Vite + React SPA (Zustand, CSS Modules, tldraw)
```

Single-process Bun, без демонов (кроме опционального `localcode daemon` для cron'ов). Web SPA встроен как base64 в CLI-бинарь через `scripts/embed-web.ts`.

<br/>

## Тестирование

```sh
bun test                            # полный набор (3196 проходят)
bun test tests/llm/adapter.test.ts  # отдельный файл
bunx tsc --noEmit                   # type-check
bun run build                       # сборка в dist/cli.js
cd web-frontend && bunx vitest run  # web-тесты (435 проходят)
```

CI: `bunx tsc --noEmit`, `bun test`, `bun build`, плюс lint-джоб, который валит сборку при любом `: any` / `<any>` / `as any` / `@ts-ignore` в `src/`.

<br/>

## Лицензия

[MIT](LICENSE)

---

<div align="center">

Сделано с ☕, бессонными ночами и кучей `/undo`.

</div>
