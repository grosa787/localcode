# Cloud Providers Setup

## Overview

LocalCode supports multiple cloud providers in addition to local models
(Ollama, LM Studio):

- **OpenAI** — GPT-4o, o1, etc. Reliable, but US-based.
- **Anthropic** — Claude 4.7 Opus, 4.6 Sonnet, etc. Best for complex
  reasoning + tool use.
- **OpenRouter** — Aggregator: 200+ models from many vendors. Single
  key.
- **Google Gemini** — Gemini 1.5/2.0 Pro / Flash. (Coming soon)
- **Custom** — Any OpenAI-compatible URL (Groq, Together, Fireworks,
  Mistral, etc.)

## API Keys

### Configuration

Set keys via the `/provider` overlay OR environment variables:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`

Env vars take effect when no key is set in `~/.localcode/config.toml`.
The explicit config key wins over the env var when both are present.

### Where to get keys

- OpenAI: https://platform.openai.com/api-keys
- Anthropic: https://console.anthropic.com
- OpenRouter: https://openrouter.ai/keys
- Google: https://aistudio.google.com/apikey
- Groq: https://console.groq.com/keys
- Together: https://api.together.xyz/settings/api-keys
- Fireworks: https://fireworks.ai/account/api-keys
- Mistral: https://console.mistral.ai/api-keys

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
