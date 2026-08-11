# Troubleshooting

A pragmatic guide to the failure modes LocalCode users actually run
into. Each entry lists the symptom, the likely cause, and the fix.

## Backend connectivity

### "Failed to load config" on launch

`~/.localcode/config.toml` is missing, malformed, or doesn't match
`ConfigSchema`. Recovery:

```sh
localcode --reconfigure          # re-runs onboarding, overwrites config
```

If you'd rather hand-fix, the schema is documented in
[CONFIG.md](CONFIG.md). The error includes the Zod path so you can
find the bad field, e.g. `backend.type: invalid_enum_value`.

### Onboarding can't see any models

OnboardingScreen pings `/v1/models` first, then falls back to
Ollama's `/api/tags`. If both fail:

- Make sure the backend is actually listening on the URL you typed.
  Try `curl http://localhost:11434/api/tags` (Ollama) or
  `curl http://localhost:1234/v1/models` (LM Studio).
- LM Studio defaults to disabling its server — toggle "Start Server"
  in the LM Studio UI.
- Some Ollama installs bind to `0.0.0.0` only; if you're on a remote
  host, point LocalCode at the actual host:port via `/provider custom`.

### "Connection stalled (no response for 90s)"

The backend accepted the request but hasn't sent any chunks in 90
seconds. Common causes:

- **LM Studio + huge context.** LM Studio has been observed to hang
  silently when the prompt approaches the configured `n_ctx`. Either
  reduce `/ctxsize`, or pre-load a model with a larger window.
- **Cold model load.** First request after start can take >90 s on
  large models. Send a tiny prompt first (e.g. `hi`) so the weights
  warm up, then resume with the real work.
- **Ollama unloaded the model.** If `keep_alive` is 0 or expired, the
  next request reloads from disk. Setting `/ctxsize keepalive 1800`
  keeps it hot for 30 minutes after each request.

The stall timeout is fixed at 90 s in `app.tsx`
(`STALL_TIMEOUT_MS = 90_000`).

### "LLM server returned 4xx"

The adapter does not retry 4xx — those usually mean the request body
is wrong. Likely culprits:

- A custom backend that doesn't accept `tool_choice` or
  `stream_options.include_usage`. Try a different backend or open an
  issue.
- LM Studio with an incompatible model (some quantisations don't
  expose tool calling). Pick a function-calling-capable model.

### Can't resume a session

`localcode --resume ab12cd34` either matched zero or multiple
sessions. The CLI prints `No session matching '<id>'; starting a new
one.` Use a longer prefix (the banner prints 12 chars) or
`/resume <prefix>` from inside chat to disambiguate.

## Unsloth Studio

### Model replies but never calls a tool — nothing gets read or edited

**Cause: the server was started without `--disable-tools`.**

By default Unsloth's server runs its own server-side tool loop and
*intercepts* tool calls rather than returning them to the client.
LocalCode does all its work through tool calls, so when Unsloth swallows
them the agent looks like it is thinking and then does nothing. You may
see prose, an empty reply, or a reply that claims a file was edited when
it wasn't.

**There is no error.** No 4xx, no stderr, no warning — which is exactly
why this entry exists. If the agent is inert against Unsloth and healthy
against every other backend, this is the reason.

Fix — restart the server with the flag:

```sh
unsloth run --model unsloth/gemma-4-26B-A4B-it-GGUF --disable-tools -p 8888
```

Verify the tool loop is actually reaching LocalCode by asking for
something that must touch disk, e.g. "list the files in this directory".
If `list_dir` never appears in the transcript, the flag is still missing.

### Every request 401s against `localhost:8888`

**Cause: missing or wrong API key.**

Unlike Ollama and LM Studio, Unsloth Studio requires
`Authorization: Bearer sk-unsloth-...` on **every** request — including
on localhost. Running locally does not exempt it. LocalCode classifies
Unsloth with the bearer-auth providers for this reason, so if no key is
resolved the header goes out empty and the server rejects it.

Fix — supply the key by any of:

- `/provider` overlay → Unsloth Studio → API key field.
- `apiKey = "sk-unsloth-..."` under `[backend]` in
  `~/.localcode/config.toml`.
- `export UNSLOTH_API_KEY=sk-unsloth-...` (canonical), or
  `export UNSLOTH_STUDIO_AUTH_TOKEN=sk-unsloth-...` (accepted alias,
  consulted only after the canonical name misses).

Get the key from **Settings → API** in Unsloth Studio. `unsloth run`
also prints it on startup. Confirm out-of-band with:

```sh
curl -H "Authorization: Bearer sk-unsloth-..." http://localhost:8888/v1/models
```

A 200 with a `{"object":"list","data":[...]}` body means the key is
good and the problem is in LocalCode's config; a 401 means the key
itself is wrong.

`localcode doctor` probes the backend **with** the resolved key, so its
Backend row answers the same question: `ok` means the server accepted
the exact credential LocalCode will send on the next turn, and a `fail`
naming `UNSLOTH_API_KEY` means the key really is missing or wrong.

### Connection refused on `localhost:8888`

The default port is 8888 and LocalCode pre-fills it, but one page of the
Unsloth docs uses **8000**. If you launched without `-p`, try
`http://localhost:8000/v1`. Set `baseUrl` to whichever port the server
actually bound.

## Streaming + content rendering

### Garbled tokens like `<|channel|>` or `<|message|>` in output

These are *Harmony* control tokens that some Qwen-style fine-tunes
emit. LocalCode filters them in `src/llm/streaming.ts` —
`HarmonyFilter`. If you still see them:

- Make sure your bundle is up to date (`bun run build` if you're
  running from `dist/`, or `bun run dev` to bypass the bundle).
- A model that emits *non-standard* control tokens (anything not on
  the `<|channel|>` / `<|message|>` / `<|start|>` allow-list) will
  pass through the filter — file an issue with a sample.

### Vision model responds but ignores the image

`fetch_image` returns a `kind: "image"` JSON envelope; the adapter
splices a multimodal user message into context. Common slip-ups:

- The chosen model isn't actually multimodal. `qwen2.5-coder` is text
  only; `llava` / `bakllava` / `qwen2-vl` accept images.
- LM Studio's `tool_choice: auto` skipped the `fetch_image` call. The
  system prompt nudges the model when it sees an image URL in user
  text; if the URL is in a code block, the regex may miss it.
- The image URL is wrong or returns an HTML page (not an image MIME
  type). The adapter rejects non-whitelisted MIME types loudly.

### "Image too large (>10MB)"

The cap is 10 MB post-decode. Resize, re-host, or use a
`data:image/webp;base64,…` URI with a compressed WebP.

## Tool execution

### Approval prompt never appears

`pendingApproval` is set on the reducer but `<ApprovalPrompt>` may be
hidden if a slash overlay is also active. Press `Esc` to close the
overlay; the approval prompt should appear underneath.

### `write_file` blocked: "Path traversal blocked"

The argument resolved outside the project root. The model probably
tried `../something` or an absolute path. Re-prompt with a path
relative to the project root.

### `edit_file`: "find_text matches N locations; it must be unique"

Add more context to `find_text` so the snippet is unique in the file.
Including the surrounding 2–3 lines is usually enough.

### `edit_file`: "find_text not found"

Whitespace-sensitive — the search is exact. If the model produced
`find_text` from memory rather than `read_file`, it might disagree
with the file's actual indentation. Ask the model to `read_file`
first, then retry the edit.

### `run_command` times out

The wall-clock cap is 30 s in `tools/run-command.ts`. For longer
commands either split them up, run them outside LocalCode, or open a
PR to extend the timeout.

### `lint_file`: "Linter for ts/tsx/js/jsx not installed"

The dispatcher tries `bunx tsc`. If `bunx` isn't on `PATH`, the tool
returns success with that skip message — it never blocks the model.
Install Bun globally or run from a project where `bun install`
fetched TypeScript.

### Auto-lint fires on a file you don't want linted

Either rename to a non-lintable extension or set
`autoLintAfterWrite: false` when constructing the executor (requires
a code change in `app.tsx`). The default is on for source files.

## Storage + memory

### `~/.localcode/sessions.db` is huge

Each session stores full message content. To prune:

```sh
sqlite3 ~/.localcode/sessions.db "DELETE FROM sessions WHERE updated_at < strftime('%s','now','-90 days')*1000; VACUUM;"
```

(Adjust the cutoff to taste. The schema's foreign-key pointer means
you don't need to delete from `messages` separately if you also
delete the session row — but for safety LocalCode does a transaction
that deletes messages first; the SQL above doesn't, so messages
become orphans. Use `DELETE FROM messages WHERE session_id IN (...)`
first if it matters.)

### "Failed to delete session" errors after a manual edit

The schema lacks `ON DELETE CASCADE` (intentionally). If you've
manually edited the DB and your messages reference a missing session,
either re-add the session row or delete the orphaned messages first.

### Out-of-memory on a tiny project

LocalCode caps the in-memory message buffer at 200 entries
(`maxInMemoryMessages` in `ContextManager`). If you're hitting RAM
issues, suspect the model: large local models running alongside
LocalCode can easily eat 8–16 GB on their own. Use
`/ctxsize keepalive 0` to let Ollama unload between requests.

## Skills

### Dropped a `.md` into `~/.localcode/skills/` and it didn't appear

The watcher fires on `add` events with `ignoreInitial: true`. If the
file was there before LocalCode launched, it's loaded on the initial
`list()`; restart isn't needed for new files. If you copied via a
tool that doesn't trigger inotify (rare), `touch` the file.

### Project-local skill not winning over a global with the same name

The id is the **filename stem**. `tdd.md` in both directories
collides on id `tdd`; project wins. If you renamed one to `tdd2.md`,
they're now two different skills.

### `/skills` shows duplicates

Shouldn't happen; `SkillsManager.list()` dedupes by id. If you see
this, file an issue with the contents of `~/.localcode/skills/`,
`<projectRoot>/.localcode/skills/`, and the matching
`skills-active.json`.

## UI

### Nox doesn't appear

Check terminal width. `<NoxBig>` requires enough columns for a 14-row
× 16-cell pixel grid; on very narrow terminals the splash falls back.
The blink rate also depends on `chatState.isStreaming`.

### Colors look wrong

The theme uses 24-bit truecolor. Old terminals (e.g. macOS Terminal.app
in legacy mode) may quantise to xterm-256. Switch to iTerm2, kitty,
WezTerm, or Alacritty for the intended palette.

### `Ctrl+C` doesn't quit

If a stream is active, the first `Ctrl+C` cancels it; the second
quits. The status line tells you so.

## Sound

### No sound plays despite `enabled = true`

- macOS without a `completionFile` set falls back to the terminal
  bell. Set `completionFile = "/System/Library/Sounds/Glass.aiff"`
  (or any file `afplay` can play) to use a real cue.
- Linux: `aplay` must be on `PATH` and the file must be a `.wav`.
- Windows / WSL: the player always falls back to the bell. Make sure
  your terminal isn't muting `\x07`.

### Sound plays at the wrong moments

`onCompletion` fires on every successful `streamChat.onDone`,
including subordinate "summarise" calls fired by `/clear` or `/exit`.
This is intentional — those are real LLM round trips — but if it's
noisy, set `onCompletion = false` and rely on `onApproval` only.

## When in doubt

- `localcode --version` prints the version.
- `localcode --help` prints every CLI flag.
- `bun run dev` runs from source so you bypass any stale `dist/`
  bundle.
- `bun test` confirms your install matches the test gate (416 pass).
- The `[ToolExecutor]` and `[streamMultiple]` `console.warn` lines are
  *expected* under failure paths; they're caught and logged so your
  session keeps moving. Open an issue if you see them under happy
  paths.
