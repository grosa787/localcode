# Providers Setup

## Overview

LocalCode supports multiple cloud providers in addition to local models
(Ollama, LM Studio, Unsloth Studio):

- **OpenAI** — GPT-4o, o1, etc. Reliable, but US-based.
- **Anthropic** — Claude 4.7 Opus, 4.6 Sonnet, etc. Best for complex
  reasoning + tool use.
- **OpenRouter** — Aggregator: 200+ models from many vendors. Single
  key.
- **Google Gemini** — Gemini 1.5/2.0 Pro / Flash. (Coming soon)
- **Unsloth Studio (local)** — local GGUF/MLX inference server. Runs on
  your machine but **still requires an API key**. See
  [Unsloth Studio (local)](#unsloth-studio-local) — and note the
  mandatory `--disable-tools` launch flag.
- **Custom** — Any OpenAI-compatible URL (Groq, Together, Fireworks,
  Mistral, etc.)

## API Keys

### Configuration

Set keys via the `/provider` overlay OR environment variables:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`
- `UNSLOTH_API_KEY` (canonical) — alias: `UNSLOTH_STUDIO_AUTH_TOKEN`

Env vars take effect when no key is set in `~/.localcode/config.toml`.
The explicit config key wins over the env var when both are present.

"Runs locally" is **not** the same as "needs no key". Ollama and LM
Studio take no key; Unsloth Studio does. Don't infer one from the other.

### Where to get keys

- OpenAI: https://platform.openai.com/api-keys
- Anthropic: https://console.anthropic.com
- OpenRouter: https://openrouter.ai/keys
- Google: https://aistudio.google.com/apikey
- Groq: https://console.groq.com/keys
- Together: https://api.together.xyz/settings/api-keys
- Fireworks: https://fireworks.ai/account/api-keys
- Mistral: https://console.mistral.ai/api-keys
- Unsloth Studio: **Settings → API** inside Unsloth Studio. The key is
  also printed by `unsloth run` when the server starts. It looks like
  `sk-unsloth-...`.

## Unsloth Studio (local)

Unsloth Studio is Unsloth's local UI + inference server (llama.cpp for
GGUF, MLX on Apple Silicon). It exposes an OpenAI-compatible API on
`http://localhost:8888/v1`, so LocalCode talks to it through the normal
OpenAI-compatible adapter — no special wire format.

### Install

```sh
curl -fsSL https://unsloth.ai/install.sh | sh
```

### Launch (this is the line that matters)

```sh
unsloth run --model unsloth/gemma-4-26B-A4B-it-GGUF --disable-tools -p 8888
```

> ### `--disable-tools` is MANDATORY for LocalCode
>
> Without it, Unsloth's server runs **its own** server-side tool loop and
> intercepts tool calls instead of returning them to the client.
> LocalCode drives everything — reading files, editing, running commands —
> through tool calls, so when the server swallows them the agent appears
> to do nothing at all.
>
> **This fails silently. There is no error message, no 4xx, no warning
> in the logs.** You just get a model that replies with prose (or with
> nothing) and never touches your files. If Unsloth "works" but LocalCode
> never edits anything, this flag is the first thing to check.

`unsloth studio -p 8888` starts the full Studio UI on the same port; the
same `--disable-tools` requirement applies to the server it runs.

### Ports

The default is **8888**, and that is what LocalCode pre-fills. One page
of the Unsloth docs shows **8000** instead — if you started the server
without `-p` and `:8888` refuses the connection, try
`http://localhost:8000/v1` before assuming anything is broken. Whatever
port you actually launched with is the one to put in `baseUrl`.

### API key

Unsloth requires `Authorization: Bearer sk-unsloth-...` on **every**
request, including on localhost. This is the one way it differs from
Ollama and LM Studio, which take no key at all — LocalCode classifies
Unsloth with the bearer-auth providers for exactly this reason. Miss the
key and every request 401s.

Get it from **Settings → API** in Unsloth Studio; `unsloth run` also
prints it on startup. Supply it via the `/provider` overlay, via
`apiKey` in `~/.localcode/config.toml`, or via either env var:

- `UNSLOTH_API_KEY` — canonical, and the name shown throughout the UI.
- `UNSLOTH_STUDIO_AUTH_TOKEN` — accepted as an alias, so a shell that
  already exports Unsloth's own variable works untouched. Consulted only
  after `UNSLOTH_API_KEY` misses.

### Config

```toml
[backend]
type = "unsloth"
baseUrl = "http://localhost:8888/v1"
apiKey = "sk-unsloth-..."

[model]
current = "unsloth/gemma-4-26B-A4B-it-GGUF"
available = []   # populated from GET /v1/models
```

Model ids are whatever GGUF repo you pulled, e.g.
`unsloth/qwen3-coder-30B-A3B-Instruct-GGUF`. LocalCode ships no default
model for Unsloth — guessing one would pre-select a model your server
cannot serve.

### Platform support

- **macOS (Apple Silicon): supported.** macOS 12+, Python >=3.11 <3.14.
  No CUDA, no NVIDIA GPU, no discrete GPU of any kind required.
- **Windows / Linux:** Unsloth's own prerequisites require an NVIDIA GPU
  with CUDA. This is Unsloth's constraint, not LocalCode's.

### What LocalCode sends (and deliberately doesn't)

Unsloth serves three APIs on the same port: OpenAI-style
`/v1/chat/completions`, Anthropic-style `/v1/messages`, and
`/v1/responses`. **LocalCode uses the plain OpenAI
`/v1/chat/completions` surface only** — it never calls `/v1/messages` or
`/v1/responses`, so the `/v1` suffix in `baseUrl` is all the routing
that is needed.

Unsloth also accepts proprietary body fields — `enable_thinking`,
`enable_tools`, `enabled_tools`, `session_id`. **LocalCode never sends
any of them.** The request body is plain OpenAI, identical to what any
other OpenAI-compatible backend receives. Tool calling uses the standard
OpenAI `tools` / `tool_choice` schema, and streaming is standard SSE
(`data: {...}` terminated by `data: [DONE]`).

Per-request identifying headers are **not** attached for this backend
either. Unsloth documents that a per-request attribution header
invalidates the KV cache and makes local inference roughly 90% slower —
the same prefix-cache logic that keeps LocalCode's system prompt
byte-stable applies to headers here.

### llama.cpp runtime flags

`unsloth run` forwards most llama-server flags, so the usual tuning
knobs work: `-c` / `--ctx-size`, `--threads`, `-H`, `-p`, `--temp`,
`--top-p`, `--top-k`, `--min-p`, `--repeat-penalty`, `--seed`.

### What we could not verify

Everything above comes from Unsloth's own documentation. The following
does **not**, and we would rather say so than document behaviour nobody
confirmed:

- **Token accounting.** We do not know whether Unsloth returns a `usage`
  object on `/v1/chat/completions` at all. LocalCode treats it as
  optional — a stream that ends without one is parsed normally and the
  turn simply reports no token counts. `tests/llm/unsloth-streaming.test.ts`
  pins that degradation path so a missing `usage` can never become a
  parse error.
- **Cached-token counts.** Unrelated to whether `usage` exists at all:
  we have not confirmed that Unsloth reports
  `prompt_tokens_details.cached_tokens`. If it does, the existing
  OpenAI-shaped reader picks it up with no extra work and the `(N cached)`
  annotation appears; if it doesn't, the annotation is simply absent.
  Neither case is an error.
- **Concurrency / parallel slots.** A `--parallel` / `-np` flag is
  mentioned by third-party write-ups, not by Unsloth's docs, and we have
  not confirmed the flag name or its default. Assume a single slot until
  you have verified otherwise on your own install.
- **Timeouts and model load time.** First request after `unsloth run`
  may block while the model loads, and we have no documented figure for
  how long. If you get a client-side timeout on the very first turn,
  retry once before treating it as a fault; a large GGUF on a cold page
  cache can take minutes.

None of these are blockers — they are simply the boundary of what the
docs state, and LocalCode is written to survive either answer.

## OpenRouter from Russia

OpenRouter (openrouter.ai) is geo-blocked in Russia as of 2025. Three
workarounds:

### Option 1: VPN

- **Cloudflare WARP** — free, reliable. https://1.1.1.1/
- **Outline VPN** — needs server in non-blocked country.
- **AmneziaVPN** — open-source, OpenVPN-compatible.

After VPN: localcode just works as normal. URL stays
`https://openrouter.ai/api/v1`.

### Option 2: Proxy via custom URL

If you have a personal HTTP proxy or Cloudflare Worker forwarding to
OpenRouter:

1. Set up the proxy (out of scope here).
2. In the `/provider` overlay, choose **Custom**.
3. Set URL to your proxy: `https://my-proxy.example.com/openrouter/v1`.
4. Set API key (proxy forwards it).

### Option 3: Use providers that aren't blocked

Some providers work without VPN from Russia:

- **OpenAI** (sometimes works directly, sometimes blocked — check)
- **Mistral** (EU-based, usually works)
- **Together** (varies)
- **Anthropic** (USA — sometimes blocked — check)

When in doubt, try VPN.

## Configuration examples

### `~/.localcode/config.toml` for OpenAI

```toml
[backend]
type = "openai"
baseUrl = "https://api.openai.com/v1"
apiKey = "sk-..."

[model]
current = "gpt-4o"
available = []  # auto-populated on first run
```

### Anthropic

```toml
[backend]
type = "anthropic"
baseUrl = "https://api.anthropic.com/v1"
apiKey = "sk-ant-..."

[model]
current = "claude-3-5-sonnet-20241022"
```

Anthropic models are surfaced from a hand-curated list because the
Anthropic API has no public `/models` endpoint. You can always type any
model id (e.g. `claude-opus-4-7-20250101`) into `/model <id>` and it
will be forwarded verbatim.

### OpenRouter

```toml
[backend]
type = "openrouter"
baseUrl = "https://openrouter.ai/api/v1"
apiKey = "sk-or-..."

[model]
current = "anthropic/claude-3.5-sonnet"
```

OpenRouter exposes 200+ models — pick one with a vendor prefix
(`anthropic/...`, `openai/...`, `google/...`, etc.).

## OpenRouter — reliability notes

### `:free` models are unreliable

OpenRouter's `:free` models route through free-tier providers (Together, Hugging Face, etc.) with hard capacity caps. When all free providers are saturated, requests fail with `404 No allowed providers are available`. This isn't a bug — it's OpenRouter's design.

**Mitigation:**
- Use the same model **without** the `:free` suffix (paid). $5 deposit unlocks them and per-token cost is usually cents.
- Or pick a different free model that's less popular at the moment.
- LocalCode now sorts `:free` models to the bottom of the model picker for this reason.

### "No allowed providers" 404 — cheat sheet

If you see this error consistently:

1. **Check your OpenRouter account permissions** — anonymous and unverified accounts have limited model access. Visit https://openrouter.ai/account.
2. **Add a small balance** ($5 unlocks paid tier).
3. **Check region restrictions** — some models block specific countries (Russia among them for several US-hosted models). Use a VPN exit in EU/US.
4. **Try a different model** via `/model <query>` to pick from your available set.

LocalCode automatically sets `provider.allow_fallbacks: true` and `provider.sort: throughput` to maximize the chance OpenRouter finds a working provider.

### Custom (Groq)

```toml
[backend]
type = "custom"
baseUrl = "https://api.groq.com/openai/v1"
apiKey = "gsk_..."

[model]
current = "llama-3.3-70b-versatile"
```

### Custom (Together)

```toml
[backend]
type = "custom"
baseUrl = "https://api.together.xyz/v1"
apiKey = "..."

[model]
current = "meta-llama/Llama-3.3-70B-Instruct-Turbo"
```

### Custom (Mistral)

```toml
[backend]
type = "custom"
baseUrl = "https://api.mistral.ai/v1"
apiKey = "..."

[model]
current = "codestral-latest"
```

## Cost considerations

Cloud providers cost money per token. LocalCode shows token usage per
request in the `/usage` view (under each assistant reply).

Local backends — Ollama, LM Studio, and Unsloth Studio — resolve to no
price at all (`—` rather than `$0.00`), so a local session never inflates
the cost dashboard. Unsloth is local despite needing an API key; the key
authenticates you to your own server, it does not bill you.

Cheap-but-good models for daily coding:

- OpenRouter: `anthropic/claude-3.5-haiku` (~$1/M tokens)
- OpenAI: `gpt-4o-mini` (~$0.15/M input, $0.6/M output)
- Groq: `llama-3.3-70b` (free tier with rate limits)
- Mistral: `codestral-latest` (cheap, code-focused)

For complex tasks, switch to:

- OpenAI: `gpt-4o`
- Anthropic: `claude-3-5-sonnet-20241022`
- OpenRouter: `anthropic/claude-3.5-sonnet`

Use the per-message token counts to track spending — every assistant
reply prints input/output tokens and ms latency.

## Custom headers

`BackendConfig.customHeaders` is a `Record<string, string>` forwarded
verbatim on every outbound request. Useful for:

- OpenRouter `HTTP-Referer` / `X-Title` site/app tagging.
- Personal proxies that need a shared secret header.
- Aggregators that require a tenant id alongside the bearer key.

```toml
[backend]
type = "openrouter"
baseUrl = "https://openrouter.ai/api/v1"
apiKey = "sk-or-..."

[backend.customHeaders]
"HTTP-Referer" = "https://github.com/me/my-localcode-fork"
"X-Title"      = "my-localcode-fork"
```

Header keys are case-insensitive on the wire; the values you supply
override the canonical `Authorization` / `x-api-key` only if you
explicitly set those keys. Avoid that unless you know what you're doing.
