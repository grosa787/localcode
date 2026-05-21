# Roadmap

This document captures the **shipped** state of LocalCode (every item
in [`FIXES_PLAN.md`](../FIXES_PLAN.md) plus the three feature rounds
chronicled in [`AGENTS_LOG.md`](../AGENTS_LOG.md)) and the obvious
follow-ups that fell outside the current scope.

## Shipped

### Round 1 — Core (foundation)

- [x] Bun + ink TUI scaffold, OnboardingScreen, ChatScreen, model
      selection, skills, tools, sessions, slash commands.
- [x] OpenAI-compatible `LLMAdapter` with retry/backoff, native
      `fetch` streaming.
- [x] Eight tools with two-phase preview/commit and approval gating.
- [x] SQLite session/message store with WAL journal mode.

### Round 2 — Polish & UX

- [x] **#1** Filter Harmony tokens (`<|channel|>`, `<|message|>`,
      `<|start|>`) from streamed text.
- [x] **#2** `/permissions` overlay + persistent `permissions.autoApprove`.
- [x] **#3** Header below input bar (not above).
- [x] **#4** `/ctxsize <N>` → Ollama `num_ctx`, persisted.
- [x] **#5** Keep-alive — Ollama `keep_alive`, persisted.
- [x] **#6** Non-blocking input — type-while-streaming queue.
- [x] **#7** User/assistant separators + structured rendering.
- [x] **#8** Exit prints `localcode --resume <id>` banner.
- [x] **#9** ↑/↓ history inside the input.
- [x] **#10** 90 s stall detector with friendly abort message.
- [x] **#11** Bordered InputBar.
- [x] **#12** Inline mini-diff after `write_file` / `edit_file`.
- [x] **#13** UsageFooter showing token in/out + duration + session total.
- [x] **#14** `edit_file` tool (search/replace).
- [x] **#15** `/new-skill` overlay; slash commands never reach the LLM.
- [x] **#16** `.localcode/` written in the project root; project-local
      skills shadow global.
- [x] **#17** Language consistency rule in system prompt.
- [x] **#18** Senior-engineer system prompt persona.
- [x] **#19** Session summary persisted; injected on `/resume`.
- [x] **#20** Context paging — `maxInMemoryMessages` cap; older messages
      offloaded but still in SQLite.
- [x] **#21** `fetch_image` tool + multimodal follow-up message.
- [x] **#22** Model name shown under each assistant reply.
- [x] **#23** Self-modify settings via `edit_file` on `~/.localcode/config.toml`.

### Round 3 — Mascot, theme, polish

- [x] **#24** User messages render as a coloured strip without label.
- [x] **#25** Nox mascot — `<NoxBig>` splash + `<NoxMini>` next to input,
      blinking on stream.
- [x] **#26** Lavender/purple theme (`theme.ts` + `noxPalette`).
- [x] **#27** Auto-lint after write — `lint_file` post-commit hook.
- [x] **#28** Thinking phrases — 30 each ru/en, 30 s rotate, rainbow gradient.
- [x] **#29** Sound cues — `[sound]` config, afplay/aplay/bell.
- [x] **#30** Parallel generation primitive — `LLMAdapter.streamMultiple`.
- [x] **#31** Final docs (this folder).
- [x] **#32** Slash commands open local overlays (no LLM round trip).
- [x] **#33** `/provider` overlay + backend switching at runtime.

### Test surface

416 tests across 9 module areas. `bun test → 416 pass / 0 fail`.

## Wired but not auto-fired

These primitives are exposed and tested, but the harness doesn't
trigger them automatically yet. They're easy first contributions.

- **`streamMultiple` dispatcher (FIX #30).** The method exists with
  bounded-concurrency semantics, but `App.runStreamLoop` still runs
  tool commits serially. A future "parallel file generation" feature
  could fan out N independent writes (e.g. scaffold a feature) and
  then run a consistency pass. Suggested entry point:
  detect when the model emits multiple `write_file` tool calls in one
  turn that don't depend on each other (no overlapping paths), and
  schedule them via `streamMultiple`.

- **Custom post-commit hook.** `ToolExecutor.setPostCommitHook` is
  exposed but not used outside tests. A natural feature: add a
  `[hooks]` config block letting users wire `prettier --write` after
  every successful TS write.

- **Multimodal audio.** The system prompt mentions images. Audio
  (e.g. transcribing a `.wav` via a local Whisper) is unimplemented
  and a natural extension of the multimodal scaffold.

## Open ideas (not scoped)

These haven't been started; they're sketches.

- **`/export` command** — serialise the current session to a
  standalone Markdown transcript (with diffs). Useful for sharing
  debugging logs.
- **`/branch` / git integration** — let the model create a feature
  branch + commit per logical step. Today the agent can `run_command
  git ...` but the harness doesn't help.
- **A web/Electron viewer for sessions.** SQLite is already the
  canonical store; a read-only Tauri/Electron or Next.js viewer over
  the DB would be quick to build.
- **First-class telemetry redaction.** Sessions store full message
  content; a `redact` mode that masks API keys / tokens before
  persistence would be useful for shared dev machines.
- **Context-aware skill activation.** Today skills are toggled
  manually; a future feature could auto-activate skills based on file
  extensions present in the project (`*.go` → activate the Go skill).
- **`/diff` command** — compare two sessions, or two messages within
  one session. Useful when iterating on a change.
- **A non-Bun host.** Bun is required because of `bun:sqlite` and the
  jsx-automatic transform. A Deno/Node port would widen the audience
  but means swapping the SQLite driver and bundler. The architecture
  is reasonably portable.
- **A real release pipeline.** GitHub Actions tagged release with
  per-platform binaries + a Homebrew tap.

## Known limitations

- LM Studio's `num_ctx` cannot be changed at runtime; `/ctxsize` is
  advisory there.
- `run_command` runs in the user's shell with no sandboxing.
  `--dangerously-allow-all` is named accordingly.
- `fetch_image` only accepts http(s) and `data:image/*` schemes; no
  `file://`. Locally hosted images need to be uploaded somewhere or
  re-encoded as a data URI.
- Auto-lint covers `.ts/.tsx/.js/.jsx/.py/.go/.rs`. Other languages
  return a friendly skip message.
- Stall detection assumes a single SSE stream; it does not currently
  watch the time **between** turns. A long-thinking model that emits
  zero tokens will trigger the stall after 90 s.

## How to land work

1. Pick a checkbox in the "Wired but not auto-fired" section, or pick
   from "Open ideas".
2. Sketch a one-paragraph proposal in `FIXES_PLAN.md`.
3. Build behind a flag in `[…]` config when there's risk of breaking
   existing users.
4. Land tests + docs in the same PR.

See [docs/DEVELOPMENT.md](DEVELOPMENT.md) for the contributor
workflow.
