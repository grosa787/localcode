# Slash commands

LocalCode ships twelve built-in slash commands. They run **locally** —
nothing typed as `/cmd …` is ever sent to the LLM. Most of the
overlay-aware commands work in two modes:

- **Interactive**: bare `/cmd` opens an arrow-key overlay (FIX #32, #33).
- **Imperative**: `/cmd <args>` applies the change directly and prints
  a status line.

Use the `/` keystroke at the start of an empty input to open the
slash-command menu (`SlashMenu`); it auto-completes against the registry.

## Reference

### `/init`

Generate or update `.localcode/LOCALCODE.md` for the current project.

The command:

1. Runs `ProjectScanner.scan(projectRoot)` to build a tree + select key
   files (manifest, README, entry, config).
2. Reads any existing `.localcode/LOCALCODE.md`.
3. Builds the LLM prompt via `init/localcode-md.ts → buildInitPrompt`.
4. Streams the model's response and writes the result back to disk
   (creating `.localcode/`, `.localcode/skills/`, and ensuring
   `.gitignore` includes `.localcode/`).

```sh
/init
```

There are no arguments. Output is a single Markdown document with
`Project Overview / Tech Stack / Architecture / Key Files /
Development Conventions / Common Tasks` sections.

### `/model`

Switch the active model.

```sh
/model                    # opens the ModelSelectScreen
/model qwen2.5-coder:32b  # switches directly, persists to config
/model refresh            # re-fetches the model list from the server
```

The `ModelSelectScreen` lists `config.model.available`; press `r` to
refresh from the running backend, arrows to choose, `Enter` to apply.
Switching also rebuilds `LLMAdapter` (the memo keys on `model.current`).

### `/resume`

Replay a previous session.

```sh
/resume                   # opens ResumeOverlay (last 20 sessions)
/resume ab12cd34          # loads a session by id prefix (must be unique)
```

The overlay shows `id (8 chars) │ updated_at │ title │ summary`. Picking
one persists a summary of the **outgoing** session before swapping
context, so neither side loses memory.

### `/context`

Inspect the current context state.

```sh
/context                  # opens ContextOverlay
```

Shows token count, percent of `context.maxTokens`, message count,
active skills, and whether `LOCALCODE.md` is configured. Useful before
deciding whether to `/clear`.

### `/clear`

Drop in-memory chat and start a fresh session.

```sh
/clear
```

Behaviour:

1. Fire-and-forget summarise the outgoing session via the LLM and
   `sessionManager.updateSummary`.
2. Create a new session row.
3. Reset the reducer (`type: 'RESET'`) and `contextManager`.

Past sessions remain on disk under `~/.localcode/sessions.db`; resume
them via `/resume`.

### `/skills`

Open the skills management screen.

```sh
/skills
```

Inside `SkillsScreen`:

- arrows / `j` / `k` to move
- `space` to toggle active
- `a` to import a `.md` file by path
- `d` to delete the highlighted skill
- `Esc` to return to chat

### `/new-skill`

Open `SkillInputOverlay` to add a skill from text or a path.

```sh
/new-skill
```

The overlay accepts:

- **Text mode** — type a filename (`my-rules.md`) and a multiline
  body. Saves to `<projectRoot>/.localcode/skills/<filename>` by
  default.
- **Path mode** — supply an absolute path; LocalCode copies the file
  into the project skills dir.

Tab toggles between modes; `Enter` submits; `Esc` cancels.

### `/permissions`

Manage which destructive tools are pre-authorised.

```sh
/permissions                       # opens PermissionsOverlay
/permissions list                  # alias of bare /permissions in non-overlay mode
/permissions add write_file        # grant auto-approval
/permissions add run_command
/permissions remove run_command    # revoke
/permissions clear                 # wipe the grant list
```

Grantable tools: `write_file`, `run_command`. Read-only tools
(`read_file`, `list_dir`, `glob_search`) are always auto-approved by
the executor; `edit_file` runs without prompting but always shows a
diff. The grant list is persisted at
`~/.localcode/config.toml → [permissions] autoApprove`.

### `/ctxsize`

Tune `num_ctx` and `keep_alive`.

```sh
/ctxsize                       # opens CtxSizeOverlay
/ctxsize 32768                 # set max tokens
/ctxsize keepalive 1800        # set keep-alive seconds (0 = unload now)
```

Bounds: `maxTokens` 1024–1 048 576, `keepAliveSeconds` 0–86 400. The
LLMAdapter memo keys on both fields and rebuilds on change. With
Ollama, `num_ctx` reaches the runtime; LM Studio fixes the window at
model-load time, so `/ctxsize` there only governs LocalCode's local
budgeting.

### `/provider`

Switch backend or change the URL.

```sh
/provider                          # opens ProviderOverlay
/provider show                     # print current backend + URL
/provider ollama                   # switch backend; reset URL to default if changing types
/provider lmstudio                 # same, for LM Studio
/provider custom https://my-host/v1   # override URL, keep backend type
```

`ProviderOverlay` lets you tab through three tiles (Ollama / LM Studio
/ Custom), edit the URL inline, and press the "Test" hotkey to ping
before applying.

When the provider changes, any in-flight stream is aborted and the
adapter rebuilt before the next request.

### `/help`

Print every registered slash command and its description.

```sh
/help
```

### `/exit`

Persist the session summary (best effort) and quit.

```sh
/exit
```

Equivalent to a clean `Ctrl+C`. The CLI then prints a resume banner
to stdout:

```
Session saved. To resume:
  localcode --resume ab12cd34cd
```

## Behavioural details

**Slash commands never reach the LLM.** `App.onSlashExecute` calls
`cmd.execute(args, ctx)` directly. The `CommandContext.print`
mechanism injects synthetic `system`-role messages into the chat
log; they are *not* echoed to the backend.

**Overlay vs imperative.** `cmd-permissions`, `cmd-ctxsize`,
`cmd-resume`, `cmd-context`, and `cmd-provider` test
`ctx.showOverlay !== undefined`. The harness wires `showOverlay` to
`chatDispatch({ type: 'SHOW_OVERLAY', kind })`. Tests that don't
provide the dispatcher (and any non-interactive caller) get the
text-only fallback.

**Parsing.** Each command does its own arg parsing using
`args.trim().split(/\s+/)`. Quoted strings are not honoured anywhere —
no command needs them today.

**Adding a command.** Add a factory under `src/commands/`, declare
its dependencies in a `Deps` interface, register it in
`registerBuiltinCommands` from `src/commands/index.ts`, and surface
it via `App.useEffect → SlashRegistry`. The factory pattern means the
command itself never imports `app.tsx`.

See [docs/ARCHITECTURE.md](ARCHITECTURE.md) for the wiring map and
[docs/CONFIG.md](CONFIG.md) for the persistence shape touched by
`/permissions`, `/ctxsize`, and `/provider`.
