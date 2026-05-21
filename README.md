<div align="center">

# 🌙 LocalCode

**A local-first, Claude-Code-class AI coding assistant for your terminal — and your browser.**

[**English**](README.md) · [**Русский**](README.ru.md)

[![Bun ≥ 1.1](https://img.shields.io/badge/Bun-≥1.1-black?logo=bun)](https://bun.sh)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests 3196 passing](https://img.shields.io/badge/tests-3196_passing-brightgreen)](#testing)
[![Local-first](https://img.shields.io/badge/local--first-yes-purple)](#supported-providers)

</div>

---

## What is LocalCode?

LocalCode is a **terminal + web** AI pair-programming assistant. It speaks to **any** LLM (local or cloud), gives the model a curated toolbox (read/write files, run commands, browse the web, view images, manage Jupyter notebooks, etc.), keeps everything you do in a local SQLite session store, and ships extensive controls so the assistant is **fast, safe, and inspectable**.

Built on [Bun](https://bun.sh) + [ink](https://github.com/vadimdemedes/ink) (TUI) + Vite/React (Web). Single statically-compiled binary, no Electron, no cloud calls unless you opt in.

```sh
localcode                            # terminal UI (default)
localcode --web                      # browser UI (opens automatically)
```

<br/>

## Table of contents

- [Highlights](#highlights)
- [Supported providers](#supported-providers)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI flags](#cli-flags)
- [Web mode](#web-mode)
- [Slash commands](#slash-commands)
- [Tools for the model](#tools-for-the-model)
- [Permission profiles](#permission-profiles)
- [Memory & skills](#memory--skills)
- [Hooks & sensitive files](#hooks--sensitive-files)
- [Sub-agents](#sub-agents)
- [MCP servers](#mcp-servers)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Testing](#testing)
- [License](#license)

<br/>

## Highlights

- **Bring your own LLM** — Ollama, LM Studio, OpenAI, Anthropic, OpenRouter, Google Gemini, and any OpenAI-compatible URL (Groq, Together, Fireworks, Mistral, vLLM, llama.cpp…). One UI, seven backends.
- **Two surfaces, same brain** — gorgeous ink TUI **and** a polished web UI (tabs, dock, voice in/out, drag-drop, PDF, whiteboard).
- **Real tool calling with approval gates** — diff previews, command previews, per-tool auto-approve, five **permission profiles** (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`).
- **Sub-agents on-demand** — spawn specialist workers (`architect`, `debugger`, `security-reviewer`, language reviewers, etc.) from a curated catalog. Switch between them, send extra context, see live progress.
- **Memory** — persistent file-based per-project memory (`user` / `feedback` / `project` / `reference`) injected into every system prompt.
- **Hooks** — shell scripts at `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` / `Stop` / `PreCompact` / `SessionEnd`.
- **MCP support** — Model Context Protocol over `stdio` or `http`; tools auto-namespaced as `mcp__<server>__<tool>`.
- **Cost tracking** — per-message cost chip using real OpenRouter / static pricing. `/usage` dashboard, `/cost` per-session, token visualizer with sparklines.
- **Smart inputs** — paste an image path → auto-attached as multimodal. Drag-drop files in the web. Voice in/out via Web Speech API. PDF parsing.
- **Diagnostics + recovery** — process introspection (`/watch <cmd>` + `/diagnose`), conversation branching, `/undo`, full diff viewer, health watchdog, error banner with retry.
- **Codebase ontology** — TypeScript LSP-powered knowledge graph; new tools `find_call_sites`, `impacts_of`, `type_hierarchy`.
- **Architecture rules** — declare layering rules in `.localcode/arch.toml`; PreToolUse validator blocks forbidden imports.
- **Built-in security** — secret scanner pre-commit hook (AWS / GitHub / OpenAI / Anthropic / Stripe / private-key patterns + entropy heuristic), sensitive-files gating, redaction.
- **LAN sharing** — mDNS discovery + HMAC pairing + AES-GCM session sync; share a session with a colleague on the same network without any cloud round-trip.
- **i18n** — full UI in English and Russian, switchable live.

<br/>

## Supported providers

| Provider          | Type  | Setup                                                                   |
| ----------------- | ----- | ----------------------------------------------------------------------- |
| Ollama            | Local | Install Ollama, run `ollama serve`                                      |
| LM Studio         | Local | Install LM Studio, enable the local server                              |
| OpenAI            | Cloud | API key via `OPENAI_API_KEY` or `/provider`                             |
| Anthropic         | Cloud | API key via `ANTHROPIC_API_KEY` or `/provider`                          |
| OpenRouter        | Cloud | API key via `OPENROUTER_API_KEY` or `/provider`                         |
| Google Gemini     | Cloud | API key via `GEMINI_API_KEY` or `/provider`                             |
| Custom            | Cloud | Any OpenAI-compatible base URL (Groq, Together, Fireworks, Mistral, …)  |

Explicit `apiKey` in `~/.localcode/config.toml` wins; environment variables are the fallback. See [docs/PROVIDERS.md](localcode/docs/PROVIDERS.md) for per-provider examples.

<br/>

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1** — runtime, package manager, and bundler.
- **macOS** or **Linux**. Windows is supported via WSL.
- At least one reachable LLM backend (local server or cloud API key).

<br/>

## Install

```sh
# One-command install (Claude-Code-style)
curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | bash

# Or pin a version / branch / tag
curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | LOCALCODE_REF=v0.19.0 bash
```

The installer detects your OS/arch, installs Bun if missing (via the official `bun.sh/install`), clones LocalCode into `~/.local/share/localcode`, runs `bun install && bun run build`, and symlinks `dist/cli.js`. It prefers `~/.local/bin` (no sudo); only if that directory isn't writable does it fall back to `/usr/local/bin` with `sudo`. Re-running the same command updates an existing install.

Flags & env overrides:

```sh
curl -fsSL .../install.sh | bash -s -- --update      # git pull + rebuild
curl -fsSL .../install.sh | bash -s -- --uninstall   # remove symlink + install dir
curl -fsSL .../install.sh | bash -s -- --verbose     # debug output
LOCALCODE_HOME=/opt/localcode bash install.sh        # custom install dir
LOCALCODE_BIN_DIR=$HOME/bin bash install.sh          # custom PATH dir
```

Manual install (existing clone):

```sh
git clone https://github.com/grosa787/localcode.git
cd localcode
./install.sh
```

To run without installing:

```sh
bun install
bun run dev          # alias for: bun run src/cli.tsx
```

<br/>

## Quick start

```sh
localcode                            # open the current directory
localcode ~/path/to/project          # open a specific project
localcode --resume ab12cd34          # resume a session by id prefix
localcode --model claude-3-5-sonnet  # override the model
localcode --profile plan             # start in Plan Mode (no mutations)
localcode --web                      # browser UI
localcode --help                     # full flag list
localcode --version
```

**First launch** triggers onboarding: pick a backend, confirm the URL, choose a model, and you're in the chat.

<br/>

## CLI flags

```
localcode [projectRoot] [flags]
```

| Flag                            | What it does                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `[projectRoot]`                 | Positional. Path to the project. Defaults to `process.cwd()`.                                                             |
| `--profile <name>`              | Permission profile: `default` · `acceptEdits` · `plan` · `dontAsk` · `bypassPermissions`. Overrides persisted config.     |
| `--dangerously-allow-all`       | **DEPRECATED.** Equivalent to `--profile dontAsk`. Skips approvals.                                                       |
| `--resume <sessionId>`          | Resume a session. Accepts full UUID or sufficiently-unique prefix.                                                        |
| `--model <name>`                | Override the active model for this run only (does NOT modify persisted config).                                           |
| `--reconfigure`                 | Re-run onboarding, overwriting config.                                                                                    |
| `--no-refresh-models`           | Skip startup model-list refresh.                                                                                          |
| `--web`                         | Launch the browser-based UI instead of the terminal.                                                                      |
| `--web-host <host>`             | Bind host for `--web`. Default `127.0.0.1`. Pass `0.0.0.0` to expose on the LAN.                                          |
| `--web-port <port>`             | First port to try for `--web`. Default `7777`. Probes subsequent ports if busy.                                           |
| `--no-open`                     | Do not auto-open the browser when `--web` starts. URL still printed to stdout.                                            |
| `--lan`                         | Enable LAN P2P session sharing via mDNS (off by default).                                                                 |
| `--help`, `-h`                  | Show usage and exit.                                                                                                      |
| `--version`, `-v`               | Print version and exit.                                                                                                   |

### Subcommands

| Subcommand               | Description                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `localcode plugin <action>`  | Manage plugins: `install <path>` · `uninstall <id>` · `list` · `enable <id>` · `disable <id>` |
| `localcode daemon`           | Run the persistent cron daemon (background scheduled wakeups).                                |

<br/>

## Web mode

`localcode --web` boots a local server on `127.0.0.1:7777` (configurable), prints the URL with a one-shot CSRF token in the fragment, and auto-opens your default browser.

The web UI features:

- Tabbed sessions (Cmd/Ctrl + 1…9 to switch, Cmd/Ctrl + T new, Cmd/Ctrl + W close).
- Resizable / dockable panels.
- Top-bar icon panels: Tasks · Agents · Browser · Memory · Files · Usage · Notifications · Settings.
- Voice input (push-to-talk) + voice output (TTS) via the Web Speech API.
- Drag-drop files from OS (images become multimodal attachments, text becomes `@path`).
- PDF parsing with page-by-page preview.
- High-quality whiteboard via `tldraw` — sketch a diagram → send to chat as multimodal image.
- Mermaid diagrams rendered as SVG, full-screen zoom/pan.
- Light & dark themes.
- Live cost meter, queued-message indicator, error banner with **Retry last**.

<br/>

## Slash commands

Every slash command runs **locally** — none are sent to the LLM.

<details>
<summary><b>Show all commands</b></summary>

| Command            | What it does                                                                          |
| ------------------ | ------------------------------------------------------------------------------------- |
| `/help`            | List every registered command.                                                        |
| `/init`            | Scan project & write `.localcode/LOCALCODE.md`.                                       |
| `/model [name]`    | Open picker or switch directly.                                                       |
| `/provider [...]`  | Switch backend (Ollama / LM Studio / OpenAI / Anthropic / OpenRouter / Google / custom). |
| `/profile [name]`  | Switch permission profile: `default` · `acceptEdits` · `plan` · `dontAsk` · `bypassPermissions`. |
| `/style [name]`    | Output style: `concise` · `explanatory` · `verbose`.                                  |
| `/statusline`      | Configure the status line template.                                                   |
| `/resume [id]`     | Pick or load a session.                                                               |
| `/clear`           | Persist a summary, start a fresh chat.                                                |
| `/context`         | Show token usage, active skills, LOCALCODE.md status.                                 |
| `/ctxsize [n]`     | Tune `num_ctx` and keep-alive.                                                        |
| `/compress`        | Compact context into one summary message.                                             |
| `/settings`        | Edit generation params (temperature, top_p, repeat_penalty, max_tokens).              |
| `/permissions`     | Toggle per-tool auto-approval.                                                        |
| `/diff [ref]`      | Open the full-screen diff viewer.                                                     |
| `/undo [N\|list]`  | Roll back the last N file mutations from the in-memory snapshot stack.                |
| `/review`          | One-shot LLM code review.                                                             |
| `/plan`            | Two-phase plan generation.                                                            |
| `/skills`          | Manage skills.                                                                        |
| `/new-skill`       | Paste or supply a path for a new skill.                                               |
| `/memory`          | Open memory entries list.                                                             |
| `/memory-save <id>`| Save a staged feedback proposal.                                                      |
| `/todos`           | Open the Tasks panel.                                                                 |
| `/usage`           | Cumulative usage dashboard with cost per model.                                       |
| `/cost`            | Current-session cost breakdown per turn.                                              |
| `/perf` `/tokens`  | Token visualizer with sparkline charts.                                               |
| `/agent`           | Run the agentic loop on a task.                                                       |
| `/spawn [id task]` | Spawn a specialist worker from the catalog.                                           |
| `/agents diff <id>`| Show worktree diff for a sub-agent.                                                   |
| `/branch [...]`    | Branching sessions: `list` · `<name>` · `switch <name>` · `delete <name>`.            |
| `/conv diff A B`   | Compare two branches.                                                                 |
| `/record`          | Record / replay session: `start` · `stop` · `save` · `list`.                          |
| `/replay <file>`   | Replay a recording at chosen speed.                                                   |
| `/cron`            | Persistent cron schedules.                                                            |
| `/wakeups`         | In-session deferred-continuation list.                                                |
| `/watch <cmd>`     | Watch a long-running process (dev server, test runner) for diagnostic signals.        |
| `/diagnose [id]`   | Surface compile / test errors from watched processes.                                 |
| `/arch`            | Architecture rules: `check` · `rules` · `init` · `ignore <pattern>`.                  |
| `/ontology`        | Codebase knowledge graph: `status` · `refresh` · `graph <symbol>`.                    |
| `/secrets`         | Secret scanner: `scan` · `scan-all` · `allow <pattern>`.                              |
| `/sensitive`       | Sensitive-files gating: `list` · `add <pattern>` · `check <path>`.                    |
| `/worktrees`       | Worktree management for sub-agents.                                                   |
| `/plugin`          | Plugin management.                                                                    |
| `/share`           | LAN P2P session sharing: `start` · `stop` · `peers` · `accept`.                       |
| `/whiteboard`      | Open the web whiteboard.                                                              |
| `/filter`          | Hide/show thinking / tool calls / system notes in chat.                               |
| `/suggest`         | Toggle proactive suggestions panel.                                                   |
| `/exit`            | Quit and persist the session summary.                                                 |

</details>

<br/>

## Tools for the model

The model gets a typed toolbox. Read-only tools auto-run; mutating tools go through approval (unless pre-approved or under `dontAsk`).

<details>
<summary><b>Read-only / inspect</b></summary>

| Tool                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `read_file`         | Read file under projectRoot; auto-paginate >1 MB.                    |
| `list_dir`          | Tree listing with `.gitignore` honoured.                             |
| `glob_search`       | `fast-glob` lookup, gitignore-aware, symlink-safe.                   |
| `find_symbol`       | Symbol search via tsserver.                                          |
| `find_call_sites`   | Ontology query: all callers of a function/method.                    |
| `impacts_of`        | Ontology query: transitive impact graph.                             |
| `type_hierarchy`    | Ontology query: ancestors/descendants/siblings.                      |
| `lint_file`         | Native syntax check (tsc / ruff / go vet / rustc).                   |
| `fetch_image`       | Download HTTPS or `data:image/*` URL; attach as multimodal.          |
| `web_fetch`         | URL → markdown.                                                      |
| `web_search`        | DuckDuckGo top results.                                              |
| `notebook_read`     | Read a `.ipynb`.                                                     |
| `pdf_read`          | Parse PDF pages to text.                                             |
| `monitor`           | Status of a background bash task.                                    |
| `process_status`    | Status of watched processes.                                         |
| `git_status`/`diff`/`log`/`branch` | Read-only Git ops.                                    |

</details>

<details>
<summary><b>Mutating (approval required by default)</b></summary>

| Tool                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `write_file`        | Replace file (two-phase preview + commit).                           |
| `edit_file`         | Unique-string search/replace.                                        |
| `multi_edit`        | Atomic batch edits on one file.                                      |
| `notebook_edit`     | Replace / insert / delete a notebook cell.                           |
| `run_command`       | `sh -c …` (optionally `runInBackground: true`).                      |
| `git_commit`        | Make a commit (also runs secret-scanner hook).                       |
| `todo_write`        | Update in-session task list.                                         |
| `schedule_wakeup`   | Defer continuation 60–3600 s.                                        |
| `spawn_agent`       | Spawn a sub-agent worker.                                            |
| `team_send` / `team_read` | Inter-agent communication via TeamBus.                          |

</details>

<br/>

## Permission profiles

| Profile              | read-only | `write_file` / `edit_file` | `run_command` / `git_commit` / `browser_evaluate` |
| -------------------- | --------- | -------------------------- | ------------------------------------------------- |
| `default`            | run       | approval                   | approval                                          |
| `acceptEdits`        | run       | **auto**                   | approval                                          |
| `plan`               | run       | **blocked**                | **blocked**                                       |
| `dontAsk`            | run       | auto                       | auto                                              |
| `bypassPermissions`  | run       | auto + ⚠ banner            | auto + ⚠ banner                                   |

Switch at any time with `/profile <name>` or **Ctrl+P** (TUI). Sensitive-files gating overrides every profile.

<br/>

## Memory & skills

**Memory** lives at `<projectRoot>/.localcode/memory/*.md`. Four types: `user` / `feedback` / `project` / `reference`. Each entry is a markdown file with YAML frontmatter. The full memory section is injected into the system prompt **byte-stably** so prompt-prefix caching stays hot. Indexed in `MEMORY.md` at the root.

**Skills** are markdown files in `.localcode/skills/` (project-local) + `~/.localcode/skills/` (global). Project wins on id collision. Hot-reloaded via `chokidar`. Manage via `/skills` and `/new-skill`.

<br/>

## Hooks & sensitive files

**Hooks** are shell scripts wired through `[[hooks]]` blocks in `~/.localcode/config.toml`. Triggers:

- `PreToolUse` — can BLOCK a tool call (non-zero exit → tool fails).
- `PostToolUse` — synthetic system note only.
- `UserPromptSubmit` — fires before context commit; blocking aborts the turn.
- `SessionStart` / `SessionEnd` / `Stop` / `PreCompact` — lifecycle.

Built-in **secret-scanner** hook auto-registers on `PreToolUse:git_commit` — refuses to commit AWS keys, GitHub PATs, OpenAI/Anthropic/Stripe/Google keys, private keys, or high-entropy assignments.

**Sensitive files** at `~/.localcode/sensitive-files.toml` (or `.localcode/sensitive-files.toml`) declare path globs (e.g. `.env*`, `**/secrets/**`, `*.pem`, `**/.ssh/**`) that **always require approval, even under `dontAsk`**.

<br/>

## Sub-agents

Spawn specialist workers from the curated catalog (10 templates):

```
architect · debugger · security-reviewer · typescript-reviewer ·
python-reviewer · rust-reviewer · go-reviewer · test-engineer ·
performance-optimizer · doc-writer
```

```sh
/spawn debugger "find why the migration timed out"
```

Workers run in isolated git worktrees, communicate via TeamBus. In TUI press **Tab** to enter agent-focus mode, ↑/↓ to select, **Enter** to attach and chat with a worker; **Esc** to return to the lead. In the web UI click a worker in the Agents panel to enter reply mode.

Completed workers automatically move to history; toggle visibility per panel.

<br/>

## MCP servers

LocalCode is a Model Context Protocol client. Configure via TOML:

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

Tools are auto-namespaced as `mcp__<server>__<tool>`. Status panel at `GET /api/mcp`.

<br/>

## Configuration

All config lives at `~/.localcode/config.toml` (global) + per-project overrides at `<projectRoot>/.localcode/settings.json`. The first run scaffolds defaults; subsequent edits are atomic (temp + rename) and Zod-validated.

Sample:

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

Full schema: [docs/CONFIG.md](localcode/docs/CONFIG.md).

<br/>

## Architecture

```
src/
├── cli.tsx                    argv + ink mount
├── app.tsx                    composition root
├── llm/                       adapter (OpenAI-compat + Anthropic), context, executor, pricing
├── tools/                     30+ tool implementations
├── sessions/                  bun:sqlite, FTS5 search, branching
├── commands/                  slash-command factories
├── config/                    Zod-validated TOML
├── skills/                    chokidar-watched markdown skills
├── memory/                    persistent memory entries
├── hooks/                     shell-hook engine (7 triggers)
├── mcp/                       Model Context Protocol client
├── agents/                    orchestrator, TeamBus, worker pool, worktree GC, catalog
├── ontology/                  TS LSP knowledge graph
├── architecture/              arch.toml validator
├── security/                  secret scanner, sensitive files
├── process-monitor/           watched-process diagnoser
├── networking/                LAN P2P (mDNS + HMAC + AES-GCM)
├── recordings/                session record/replay
├── scheduling/                wakeups + persistent crons
├── web/                       REST + WS server, runtime pool, approval bridge
└── ui/                        ink TUI (screens, components, overlays)

web-frontend/                  Vite + React SPA (Zustand, CSS Modules, tldraw)
```

Single-process Bun, no daemons (except optional `localcode daemon` for crons). Web SPA is embedded as base64 in the CLI binary by `scripts/embed-web.ts`.

<br/>

## Testing

```sh
bun test                            # full suite (3196 passing)
bun test tests/llm/adapter.test.ts  # single file
bunx tsc --noEmit                   # type-check
bun run build                       # bundle to dist/cli.js
cd web-frontend && bunx vitest run  # web tests (435 passing)
```

CI: `bunx tsc --noEmit`, `bun test`, `bun build`, and a lint job that fails the build on any `: any` / `<any>` / `as any` / `@ts-ignore` in `src/`.

<br/>

## License

[MIT](LICENSE)

---

<div align="center">

Made with ☕, late nights, and a lot of `/undo`s.

</div>
