# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install                                       # install deps (pinned via bun.lock)
bun run dev                                       # run the CLI in dev mode (alias for src/cli.tsx)
bun test                                          # full test suite (bun:test) — 3377 passing
bun test tests/llm/adapter-cloud.test.ts          # single file
bun test --test-name-pattern "preview"            # subset by test name
bunx tsc --noEmit                                 # type-check (no emit)
(cd web-frontend && bunx tsc --noEmit)            # type-check the SPA
(cd web-frontend && bunx vitest run)              # web tests (vitest)
bun run build                                     # vite build → embed-web → bun build → dist/cli.js
./install.sh                                      # build + symlink to /usr/local/bin/localcode
bun dist/cli.js --help                            # smoke the bundled binary
```

CI (`.github/workflows/ci.yml`) on push/PR runs `bunx tsc --noEmit`, `bun test`, and `bun build` on Ubuntu+macOS, plus a lint job that greps for `: any`/`<any>`/`as any` and `@ts-ignore` in `src/` and **fails the build if any are introduced**. Mirror those gates locally.

`.github/workflows/release.yml` fires on `v*` tags — builds prebuilt binaries for darwin-arm64/x64 + linux-x64/arm64, computes SHA256SUMS + SBOM + bsdiff patches between previous and current tag, publishes to GitHub Releases. `.github/workflows/lockdown.yml` is designed for the post-private-migration state and will fail until source is removed from this public repo.

## Big-picture architecture

LocalCode is a single-process Bun + ink TUI **with a sibling Web UI** (Vite + React) embedded as base64 into the CLI binary. The composition root is `src/app.tsx` — it instantiates every concrete service and wires them into the screen tree via React state. Tests inject fakes through constructor options.

```
cli.tsx → app.tsx ─┬─→ LLMAdapter / AnthropicAdapter   src/llm/
                   ├─→ ToolExecutor                    src/llm/, src/tools/
                   ├─→ ContextManager                  src/llm/
                   ├─→ SessionManager (bun:sqlite)     src/sessions/
                   ├─→ ConfigManager (TOML)            src/config/
                   ├─→ SkillsManager (chokidar)        src/skills/
                   ├─→ MemoryStore                     src/memory/
                   ├─→ SlashRegistry + commands        src/commands/
                   ├─→ Plugin loader                   src/plugins/
                   ├─→ MCPRegistry                     src/mcp/
                   ├─→ HookEngine                      src/hooks/
                   ├─→ AgentOrchestrator + TeamBus     src/agents/
                   ├─→ ProcessMonitor                  src/process-monitor/
                   ├─→ OntologyIndexer (TS LSP)        src/ontology/
                   ├─→ ArchitectureValidator           src/architecture/
                   ├─→ SecretScanner + SensitiveFiles  src/security/
                   ├─→ Updater                         src/updater/
                   ├─→ WakeupRegistry + PersistentScheduler   src/scheduling/
                   ├─→ Recorder + Player               src/recordings/
                   ├─→ LanDiscovery + ShareCoordinator src/networking/
                   ├─→ I18n (active locale)            src/i18n/
                   └─→ Screens                         src/ui/
                       └─→ ChatScreen / overlays       src/ui/screens, src/ui/overlays

src/web/                — Bun.serve REST + WS server (per-session ChatRuntime + RuntimePool)
web-frontend/src/       — Vite + React SPA (Zustand store, CSS Modules)
website/                — public landing page (Vite + Framer Motion + tldraw-class tilt)
```

Read `docs/COMMANDS.md`, `docs/TOOLS.md`, `docs/CONFIG.md`, `docs/PROVIDERS.md`, `docs/SKILLS.md`, `docs/TROUBLESHOOTING.md`, `docs/BROWSER.md` for end-user references. The rest of this doc covers contracts that aren't obvious from grep.

### Adapter abstraction

`LLMAdapter` (OpenAI-compatible) handles **Ollama, LM Studio, OpenAI, OpenRouter, Google Gemini, Custom**. `AnthropicAdapter` (separate file) handles Anthropic's Messages API — different endpoint, headers (`x-api-key`), system extraction, and SSE event shape. `app.tsx` has a `createAdapter(opts)` factory returning either. Both expose the same callback shape (`streamChat`, `getModels`, `ping`, `cancel`).

API keys: explicit `BackendConfig.apiKey` wins; otherwise `resolveApiKey(backend)` reads per-provider env vars. Multimodal: `MessageContentPart[]` with `image_url` is passed through for OpenAI-compat; `toAnthropicMessageContent()` converts to Anthropic's `image` source shape.

### Two-phase tool execution + permission profiles

Mutating tools (`write_file`, `edit_file`, `multi_edit`, `run_command`, `notebook_edit`, `git_commit`) split into `preview` and `commit`. The executor calls `preview`, surfaces the diff/command via `approvalCallback` (`<DiffView>` / `<ApprovalPrompt>`), and only invokes `commit` after approval.

Permission profiles (`src/config/types.ts` `PERMISSIONS-PROFILE-SECTION`):

| Profile             | read-only | write_file / edit_file | run_command / git_commit |
|---------------------|-----------|------------------------|--------------------------|
| `default`           | run       | approval               | approval                 |
| `acceptEdits`       | run       | auto                   | approval                 |
| `plan`              | run       | **blocked**            | **blocked**              |
| `dontAsk`           | run       | auto                   | auto                     |
| `bypassPermissions` | run       | auto + ⚠ banner        | auto + ⚠ banner          |

`SensitiveFiles` (`src/security/sensitive-files.ts`) overrides every profile — paths matching `.env*`, `**/secrets/**`, `*.pem`, etc. **always** require approval even under `dontAsk`.

Pre-approval also lives in `config.permissions.autoApprove`. The secret-scanner builtin hook (`src/security/builtin-hook.ts`) refuses `git_commit` if the staged diff contains real-looking API keys.

Read-only tools (`read_file`, `list_dir`, `glob_search`, `find_symbol`, `find_call_sites`, `impacts_of`, `type_hierarchy`, `lint_file`, `fetch_image`, `web_fetch`, `web_search`, `notebook_read`, `pdf_read`, `monitor`, `process_status`, git inspectors) skip approval entirely.

Auto-lint runs after every successful `write_file`/`edit_file`/`multi_edit` commit and feeds diagnostics back into the next turn via `onAutoCheckResult`.

### Slash commands never reach the LLM

`ChatScreen.submit()` classifies input via `classifySubmit()` into `command | literal-slash | bash | text`. Single `/foo` always dispatches through `SlashRegistry`; `//foo` is the literal-text escape; `!cmd` runs locally via `execa` and never touches the model; paths (`/Users/...`, `/var/log/...`) flow to the LLM as text. There is a defense-in-depth guard in `app.tsx` `onSubmit` that refuses command-shape input. **If you change submit routing, audit both call sites.**

Slash commands open overlays (`/permissions`, `/context`, `/ctxsize`, `/resume`, `/provider`, `/settings`, `/model`, `/usage`, `/cost`, `/perf`, `/branch`, `/agents`, `/memory`, `/whiteboard`, `/diff`, `/conv`, ...) — they are interactive UIs, not chat output.

### Streaming + rendering pipeline

`LLMAdapter.streamChat` runs SSE through `HarmonyFilter` (strips `<|channel|>` etc., handles asymmetric variants) and `ThinkingBlockSplitter` (routes `<think>...</think>` to `onThinkingChunk` — Qwen-friendly). The chat tree uses ink's `<Static>` for committed messages so they ride the terminal scrollback unchanged; only the dynamic area (streaming text + spinner + timer) re-renders.

Streaming chunk dispatch is **adaptive-throttled** in `src/integration/chat-state.ts` (`THROTTLE-ADAPTIVE-SECTION`): 80ms normal, 200ms during intermissions, instant flush on `\n` boundary. Highlighted code is FNV-1a hash cached (`src/ui/highlighting/syntax-highlight.ts`) with a `themeVersion` field so theme switches don't blow the cache.

### Storage

Sessions persist via **`bun:sqlite`** (NOT `better-sqlite3` — that fails to load under Bun; **do not reintroduce it**). Schema lives in `src/sessions/schema.sql` and is also inlined in `src/sessions/db.ts`. Migrations are idempotent `ALTER TABLE`s swallowing `duplicate column` errors. WAL mode + `synchronous=NORMAL` + `wal_autocheckpoint=1000` + `busy_timeout=5000` are set on file-backed DBs. A **read-only replica connection** is opened separately (Wave 5C TP2) for `getMessages` / `search` so heavy reads don't block writes.

`messages` table has `cost_usd` column populated on every assistant commit via `resolvePrice(backend, model)` + `computeCostBreakdown(usage, pricing).total`. Aggregated by `aggregateUsageByModel` / `aggregateUsageBySession` for the `/usage` dashboard.

Sessions can **branch**: `parent_session_id`, `branch_point_message_id`, `branch_name` columns enable `createBranch(fromSessionId, name)` (Wave 6B). Branches surface as `<BranchBreadcrumb>` + `<BranchPicker>` (Ctrl+B). `/conv diff <A> <B>` opens the DiffViewer on two branches' messages.

### Config layers

- `~/.localcode/config.toml` — global. `ConfigManager` (atomic tmp-then-rename writes, Zod validation, unknown sections preserved).
- `<projectRoot>/.localcode/settings.json` — per-project generation overrides (snake_case on disk, camelCase in TS). `resolveGeneration(projectRoot)` deep-merges project ▶ global per-field.
- `.localcoderc` (or `.localcoderc.toml`) at any directory walking UP — Wave A4. Overrides `model`, `permissions.profile`, `outputStyle`, `statusline.template`, etc. Loaded via `loadProjectRc(projectRoot)`.
- `~/.localcode/skills/` + `<projectRoot>/.localcode/skills/` — markdown skills. Project wins on id collision. Hot-reloaded via `chokidar`.
- `<projectRoot>/.localcode/memory/` — markdown memory entries (4 types: `user`, `feedback`, `project`, `reference`). Indexed in `MEMORY.md`. Byte-stably injected into system prompt (see prefix-cache invariant below).
- `<projectRoot>/.localcode/arch.toml` — architecture layering rules. Validator runs as PreToolUse-equivalent on write/edit tools; violations force approval.
- `~/.localcode/sensitive-files.toml` + `<projectRoot>/.localcode/sensitive-files.toml` — gate-override patterns.
- `.localcode/LOCALCODE.md` is auto-scaffolded on first launch via `ensureLocalcodeScaffold(projectRoot)`. **Walks up parent directories** (Wave 6C3 `loadHierarchy`) concatenating with separator `\n\n---\n\n# <relative path>\n\n`. If combined size > `LOCALCODE_INLINE_LIMIT` (5000 chars), the system prompt swaps inline content for pointers.

### Stable system prompt = prefix cache hits

`ContextManager.buildSystemPrompt({ localcodeMd, skills, memorySection, summary, modelName, outputStyle, ... })` is **deliberately byte-stable across turns** to keep llama.cpp's prefix cache hot in LM Studio/Ollama AND so cloud providers (Anthropic, OpenAI, DeepInfra via OpenRouter) hit their automatic prompt-prefix cache. **Don't append per-turn data (e.g. last user message) to the system prompt** — that defeats the cache and slows process-prompt by minutes on local models, and inflates billed input on cloud. Active skills, memory entries, and other arrays are **sorted by id/name before joining** for the same reason. Old tool results are trimmed (default `keepLast: 3`, range 0..50 via `context.trimToolResultsAfter`) to bound the per-turn payload.

`tests/llm/system-prompt-bytestable.test.ts` is the regression guard — any future edit to `buildSystemPrompt` must keep it deterministic for fixed inputs.

### Hooks (`src/hooks/`)

Settings-driven shell hooks at **seven** trigger points (Wave 3 + 6A4):
- `PreToolUse` — can **block** a tool call (non-zero exit → tool returns `{ success: false }` with stderr embedded).
- `PostToolUse` — synthetic system note via `onHookEvent`; never undo the tool.
- `UserPromptSubmit` — fires before context commit; blocking failure aborts the turn.
- `SessionStart` — fire-and-forget on TUI startup.
- `SessionEnd` — with reason `'user_quit' | 'session_switch' | 'shutdown' | 'evicted'`. Fire-and-forget.
- `Stop` — fires after assistant message committed, no tool calls pending.
- `PreCompact` — fires before `auto-compress`. Blocking failure aborts compress AND skips cooldown stamping.

`HookEngine` exposes `hasHooksFor(trigger)` (fast predicate — skip context build when no match) and `run(ctx)` (parallel exec). Engine itself satisfies the `ToolExecutorHookBridge` interface in `src/types/message.ts` — no adapter needed. Wire-up sites: `src/app.tsx` (TUI) and `src/web/index.ts` per-session.

**Builtin hooks** (Wave 7B B3): `HookConfigEntry.builtin` field can name an internal handler instead of a shell command. The `secret-scanner` builtin auto-registers on `PreToolUse:git_commit` — refuses to commit AWS / GitHub PAT / OpenAI / Anthropic / Stripe / Google / private-key patterns.

### MCP servers (`src/mcp/`)

Model Context Protocol clients spawned per server defined in `config.mcpServers`. Two transports: `stdio` (JSON-RPC over child-process stdio) and `http` (JSON-RPC over POST). `getProcessMcpRegistry()` returns the process-wide singleton.

**`MCPRegistry.start()` is idempotent** (Wave A v0.22.0 fix): returns gracefully when disposed, skips already-booted slots. The TUI's `useEffect` no longer disposes the registry on every config change — separate effect for unmount-only disposal. **If you regress this, `/web` crashes the TUI** with "MCPRegistry: already disposed".

Tools auto-namespaced as `mcp__<server>__<tool>` via `src/tools/mcp-tool.ts` `buildMcpToolHandlerMap` + `buildMcpToolSchema`. Merged after plugins (MCP shadows plugin, plugin shadows built-in). Single-phase — no commit, no approval dialog (matches MCP spec; server authors own destructive semantics).

### Sub-agents (`src/agents/`)

`AgentOrchestrator` (Wave 4 + 5) spawns workers via `runner-factory.ts` in isolated git worktrees. `TeamBus` is the in-memory pub/sub between agents. `WorkerPool` (Wave 5C TP2) caches warm workers per template.

**Catalog of 10 specialist templates** (Wave 6C `src/agents/catalog/`): `architect`, `debugger`, `security-reviewer`, `typescript-reviewer`, `python-reviewer`, `rust-reviewer`, `go-reviewer`, `test-engineer`, `performance-optimizer`, `doc-writer`. Spawn via `/spawn <id> "<task>"`.

**Critical agent-reliability invariant (Wave 8B FIX5):** in `runner-factory.ts`, tool calls execute **before** `<DONE>` termination — DO NOT regress this. Previous version short-circuited on `<DONE>` and dropped pending tool calls (files not getting written symptom). `MAX_TURNS` is 40 (bumped from 20) and surfaces as `onError` on cap-hit, not silent `onDone`.

`WorktreeGC` (Wave 5C TP4) reaps orphan worktrees at startup + on SIGINT — `<projectRoot>/.localcode/worktrees/<agent-id>` only; never deletes outside.

### Web frontend (`web-frontend/`)

Vite + React SPA. Built into `dist-web/` and embedded into the CLI binary by `scripts/embed-web.ts` (runs as part of `bun run build`). Launch via `bun dist/cli.js --web` — binary serves the SPA over an ephemeral localhost port with a one-shot CSRF token in the URL hash.

Architecture mirrors the TUI:
- **REST** (`src/web/api/*`) — read-only metadata + small mutations. All POSTs CSRF-gated.
- **WebSocket** (`src/web/server/ws.ts` + `runtime/chat-runtime.ts`) — streaming. One `ChatRuntime` per session via `runtime-pool.ts` (LRU=12, 30-min idle reap).
- **Per-session project root** (Wave 8B): each runtime resolves `projectRoot` from `sessionManager.getSession(sessionId).projectRoot`, NOT the global `--web` launch dir. Memory store + SessionEnd hooks per-project.
- **Frontend state** — Zustand store (`web-frontend/src/state/store.ts`); `WSClient.onMessage` fan-out via `subscribeFeed(handler)` to multiple subscribers.
- **Exclusive overlay state** (Wave 8B W2): `OpenOverlay` discriminated union — opening one closes another. `<ModalFrame>` is the shared wrapper.

**`/web` slash command** transfers the current TUI session into the browser by booting the embedded server (idempotent) and opening the URL with `&session=<id>` so the SPA auto-resumes. Both surfaces share the SQLite DB (WAL handles cross-process).

**Optimistic user bubbles use `id: local-${reqId}`.** When `message_committed` arrives for a user message, ChatView filters out matching `local-*` bubbles before appending the canonical record — otherwise the message renders twice.

**Per-message `model` label.** `messages.model` (DB column, optional Message field) records the model that actually generated the row. Capture at `streamChat` request time, NOT at commit time — `config.model.current` may diverge if user switches mid-stream.

**Queue-next-message** (Wave 8B W4): typing while streaming submits go into `pendingQueue` slice; auto-drained on `done` event. `<QueueIndicator>` near composer shows count.

### Locale + i18n

`src/i18n/index.ts` exports `setActiveLocale(loc)`, `useT()` hook with reactive subscription, and tables in `src/i18n/strings/{en,ru}.ts`. Locale chosen on first-run via `<LanguagePicker>` — **persisted to `~/.localcode/config.toml` IMMEDIATELY on confirm** (Wave v0.22.0 fix) so re-launches don't re-prompt.

`/language` / `/lang` slash commands switch live; `useT()` consumers re-render. Missing keys fall back to English, then to the raw key.

Web-frontend has its own i18n at `web-frontend/src/i18n/` with the same EN+RU contract.

### Updater (`src/updater/`)

GitHub Releases API → version compare → 24h disk cache → atomic background download → apply-on-restart. **Silent invisible background check** (5s post-mount delay, 6h interval). Skip-version list persisted to `~/.localcode/updates/skipped.json`.

`Updater.start()` arms the background scheduler with `setInterval(...).unref()`. `applyManifest` backs up current `cli.js` to `.bak`, atomic-renames staged → live, fixes the `/usr/local/bin/localcode` symlink, spawns the new binary, exits. **Apply runs BEFORE arg parsing in `cli.tsx`** so a pending update activates immediately.

**Delta patches** (Wave B3): release workflow runs `bsdiff` between previous and current binary, uploads as `localcode-<os>-<arch>-from-<prev>-to-<new>.patch`. Client tries patch first (~200 KB), falls back to full download (~13 MB) if missing.

`/update` slash command (v0.22.0) wraps the singleton: `/update` (status), `/update apply` (install staged), `/update download` (force), `/update skip <ver>`.

### Esc cancel + restore (v0.22.0)

Pressing Esc during a streaming response:
1. Aborts the in-flight stream via `streamAbortController.abort()`.
2. Re-inserts the LAST user message into the composer draft so the user can edit/resend.

Implemented in both TUI (`ChatScreen.tsx` ESC-CANCEL-SECTION) and web (`Composer.tsx` ESC-CANCEL-SECTION).

### Auto-compress + cached-tokens telemetry

`src/llm/auto-compress.ts` exports `shouldAutoCompress({ contextTokens, maxContextTokens, triggerAtPercent })` (default 0.80, configurable via `context.autoCompressPercent`) and `autoCompressCooldownElapsed(...)` (default cooldown `60_000 ms`). `app.tsx` wires both at the end of `runStreamLoop` — programmatic `compressCmd.execute` invocation, NOT through the slash router (so it doesn't echo `/compress` into chat).

`StreamUsage` carries `cachedInputTokens`, `freshInputTokens`, `cacheCreationTokens`. Anthropic populates from `message_start.usage.cache_read_input_tokens` + `cache_creation_input_tokens`; OpenAI/OpenRouter from `usage.prompt_tokens_details.cached_tokens`; local providers leave them undefined. Surface in `UsageFooter` (TUI: `(N cached)` annotation, web: dedicated row + cost chip per message).

### OpenRouter quirks (`src/llm/adapter.ts`)

The OpenRouter request body sets `route: 'fallback'`, `transforms: ['middle-out']`, `usage: { include: true }`, and `provider: { allow_fallbacks: true, sort: 'throughput' }`. Three error shapes get LocalCode-specific friendly messages:
- **404 "No allowed providers"** → drop `:free`, switch model, switch backend.
- **429** → `:free` per-IP/per-model rate limits explanation.
- **400 "Provider returned error"** → marked `transient: true` on `HttpError` so the retry loop kicks in. OpenRouter wraps upstream provider 5xx/timeouts as 400; retrying the same payload usually routes to a different upstream and succeeds.

`HttpError(message, status, transient)` — the third argument is the load-bearing one for the OpenRouter case. Don't drop it.

## TypeScript conventions

- **Strict mode + `noUncheckedIndexedAccess`** are on. Always guard `arr[i]` access.
- **No `any`, no `@ts-ignore`** — CI's lint job greps `src/` for these and fails. Use `unknown` + zod parsing or runtime narrowing instead.
- Path alias `@/*` → `src/*`. Always import shared types from `@/types/global` rather than redeclaring.
- Zod is the runtime-validation boundary for all external data (config, SSE chunks, tool args, model lists, plugin manifests, MCP RPC, LSP RPC, REST request/response, WS frames).

## Testing notes

Tests mirror `src/` under `tests/` and use **`bun:test`** (`import { test, expect, mock } from 'bun:test'`). `bunfig.toml` preloads `tests/setup.ts`. Use `:memory:` SQLite, `os.tmpdir() + crypto.randomUUID()` for filesystem, and swap `globalThis.fetch` for adapter tests. Don't introduce wall-clock dependencies — adapter stall tests use injected short timeouts.

Web tests use `vitest` from inside `web-frontend/`.

## Project conventions worth respecting

- Commit messages and code comments stay short and explain *why*, not *what*. The codebase is comment-light by design — load-bearing comments mark non-obvious invariants (e.g. "Static must never unmount mid-session", "isStreaming MUST reset in finally").
- Default to editing the smallest possible file set. Adapter / tool / overlay / command modules are intentionally decoupled — don't reach across module boundaries when an interface change would do.
- **Section markers** (`// FOO-SECTION` / `// FOO-SECTION-END`) are used heavily in hot-zone files (`src/app.tsx`, `src/cli.tsx`, `src/commands/index.ts`, `src/config/types.ts`) to let parallel agents avoid edit collisions. Respect them.
- The release pipeline expects `v*` tags. To cut a release: `git tag -a v0.X.Y -m "..." && git push origin v0.X.Y` — the GitHub Action takes it from there.
- `lockdown.yml` will fail on this branch until the public/private migration runs (`./scripts/migrate-to-private.sh --apply`). That's by design — the workflow is the post-migration contract.
