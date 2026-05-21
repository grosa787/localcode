# Development

This guide covers the contributor workflow: how to set up the repo,
how the code is laid out, and what gates a change has to pass before
it ships.

## Prerequisites

- [Bun](https://bun.sh) >= 1.1 — runtime, package manager, bundler,
  test runner.
- A working Ollama or LM Studio install for live testing (most tests
  do not need it; they stub the LLM adapter or use `:memory:` SQLite).

## Setup

```sh
git clone <this repo> localcode
cd localcode
bun install
```

The lockfile is `bun.lock` and dependencies are pinned. There is no
`package-lock.json`.

## Common commands

```sh
bun run dev          # alias for `bun run src/cli.tsx`
bun run start        # same as dev (used by some shells/IDE runners)
bun run build        # bun build src/cli.tsx --outdir dist --target bun
bun test             # run every test under tests/
bunx tsc --noEmit    # type-check without emitting
./install.sh         # build + sudo-symlink to /usr/local/bin/localcode
```

`bunfig.toml` keeps the runtime tuned for ink (jsx automatic, etc.).

## Repository layout

```
localcode/
├── src/                   # Source — see docs/ARCHITECTURE.md for the module map
├── tests/                 # Mirrors src/ tree
│   ├── commands/
│   ├── config/
│   ├── init/
│   ├── integration/
│   ├── llm/
│   ├── sessions/
│   ├── skills/
│   ├── tools/
│   └── ui/
├── docs/                  # This documentation
├── dist/                  # Output of `bun run build`
├── install.sh             # Build + sudo symlink installer
├── package.json           # Bin entry: `localcode -> ./dist/cli.js`
├── tsconfig.json          # `@/*` path alias → `src/*`
├── bunfig.toml
├── README.md
├── AGENTS_LOG.md          # Append-only change log
└── FIXES_PLAN.md          # The 33-item fix plan
```

`@/*` resolves to `src/*` via `tsconfig.json` and is honoured by Bun's
bundler. Use it for every cross-module import — relative paths are
fine *within* a module folder but discouraged across modules.

## Tests

The bun test runner lives at `bun test`. As of the docs pass, the
suite is **416 pass / 0 fail**:

```
$ bun test
…
 416 pass
   0 fail
```

Each src module has a sibling test file under `tests/`:

| Source | Test |
| --- | --- |
| `src/llm/adapter.ts` | `tests/llm/adapter.test.ts`, `tests/llm/adapter-r4.test.ts` |
| `src/llm/tool-executor.ts` | `tests/llm/tool-executor.test.ts`, `tests/llm/tool-executor-r4.test.ts` |
| `src/integration/chat-state.ts` | `tests/integration/chat-state.test.ts`, `tests/integration/chat-state-r3.test.ts` |
| `src/tools/lint-file.ts` | `tests/tools/lint-file.test.ts` |
| `src/integration/sound.ts` | `tests/integration/sound.test.ts` |
| … | …each src file has at least one mirror test. |

### Patterns

- **Real services where possible.** Tests use the real
  `ContextManager`, `SessionManager` (with `:memory:` SQLite),
  `SkillsManager` (with tmpdir directories), and `ConfigManager` (with
  override paths). Network is the one thing that's stubbed.
- **No top-level mocks.** Bun's test runner does have mock helpers
  but the suite avoids them — every dependency is constructor-injected.
- **`tests/setup.ts`** preserves test isolation by resetting the
  default DB handle before each test.

### Running a single file

```sh
bun test tests/llm/adapter.test.ts
bun test --filter "stall"          # name-based filter
```

### Adding a test

1. Place it under the matching `tests/<area>/` directory, mirroring
   the source path.
2. Use real dependencies wherever cheap; isolate real I/O with
   `mkdtempSync` (FS) or `:memory:` (SQLite).
3. Match the existing style — `describe(...) -> test(...) -> expect`,
   no jest globals, no React rendering (the reducer + adapter tests
   exercise behaviour without mounting ink).

## Type-checking

`bunx tsc --noEmit` is the gate. The repo uses `"strict": true` in
`tsconfig.json` plus `"noUncheckedIndexedAccess"` and
`"exactOptionalPropertyTypes"`. Many places use `as` only after a
narrowing check; please follow that pattern instead of disabling
strictness.

## Build

`bun run build` produces `dist/cli.js`. The bundler externalises
nothing by default (so the result is a self-contained bin), but
`react-devtools-core` is marked `optional` in `package.json` and
externalised by `install.sh` to keep production startup clean.

The bundle is roughly 2.9 MB across ~480 modules; runtime startup is
sub-second on commodity hardware.

## Running locally vs installed

```sh
# Source-tree dev loop (auto-rebuilds nothing — Bun handles JIT):
bun run dev <projectRoot>

# Installed CLI:
localcode <projectRoot>
```

`./install.sh` symlinks `dist/cli.js`, so a rebuild + the existing
symlink picks up changes without re-running `install.sh`. Re-run it
only if you also need to change the bin location.

## Logging

The TUI uses ink, which writes to `process.stdout`. There is no
ambient logger; transient diagnostics go through `process.stderr` via
`cli.tsx`'s `printError`. The streaming filter and adapter use
`console.warn` for *programmer-visible* failures (e.g.
`[ToolExecutor] post-commit hook failed`); these are intended to
appear in the TUI's lower frame and do not indicate test failures.

## Coding conventions

- `import` ordering: builtins → packages → `@/...`.
- Prefer `readonly` arrays + `Record<...>` over enums for shared
  string unions.
- Errors carry `cause` when wrapping (`new SkillsError(msg, cause)`)
  so callers can still get to the original.
- Tests assert behaviour, not internal state. The reducer is exposed
  exactly so tests can avoid rendering ink.
- Comments above non-trivial functions explain *why* (not the line-by-
  line *what* — the code already says that).
- No emojis in source. UI strings may use a small set of pictographs
  (e.g. `▎`, `❯`, `◆`, `●`) defined in `theme.ts`.

## Adding a feature

1. **Plan** — note the user-facing surface in `FIXES_PLAN.md` if it's
   a new feature.
2. **Schema first** — if you touch `[backend]`, `[permissions]`,
   `[context]`, or `[sound]`, update `src/config/types.ts` *and* the
   `Config → AppConfig` structural assertion at the bottom.
3. **Construct** — new services land under `src/<module>/`. Wire them
   from `app.tsx` only. Avoid cross-cutting imports.
4. **Test** — every new feature ships with at least one mirror test.
5. **Update docs** — at least the relevant `docs/*.md` and the README
   slash-command/tool tables if visible to users.
6. **Append to `AGENTS_LOG.md`** — start/done markers + a short list
   of files touched.

## Release

The repo doesn't yet publish to npm or as a binary. The release flow
today is "tag, push, ask users to `git pull && ./install.sh`". A
future tag-driven release pipeline is open work; see
[ROADMAP.md](ROADMAP.md).

## Gotchas

- `bun:sqlite` only works under Bun. Don't import it from Node-only
  test harnesses; tests already run under Bun.
- `chokidar` watchers leak handles if you forget to `.close()` them
  in `useEffect` cleanup. The existing skills watcher follows the
  pattern.
- The HarmonyFilter has internal state (the partial-token tail). Use
  one filter per stream; don't share an instance across streams.
- Multimodal `Message.content` is typed as `string` in the public
  API but `buildImageMessage` smuggles a `MessageContentPart[]`
  through. Adapter / context-manager helpers check `Array.isArray`.
- Approval prompts are gated on `pendingResolverRef`. If you forget
  to clear it after `chatDispatch SET_PENDING_APPROVAL`, the next
  approval may resolve the stale promise. The reducer handles the UI
  side; `App.onApprove` / `onReject` clear the ref.
