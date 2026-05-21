# Debugging OpenRouter failures

LocalCode talks to OpenRouter via the OpenAI-compatible chat completions
surface. When a paid Qwen / DeepSeek / Gemini Flash session streams
fine for a few turns and then suddenly starts failing with
`400 Provider returned error`, the cause is almost always one of:

- An upstream provider went transient (capacity, model load, timeout).
  Retries usually clear it.
- The request body grew a shape the upstream rejects (oversize message,
  tool result with no matching `tool_call_id`, unsupported field).

This file explains how to capture a sanitized JSON dump of a failed
request so you can share it with maintainers without leaking your API
key.

## 1. Enable failure dumps

Open `~/.localcode/config.toml` and add:

```toml
[diagnostics]
dump_failed_requests = true
```

The flag is off by default. Flip it on **only** while reproducing a
failure — every non-2xx OpenRouter response will write a JSON file to
disk, so leaving it enabled in normal use is wasteful.

## 2. Reproduce the failure

Run LocalCode (`localcode` or `bun run dev`) against the OpenRouter
backend, kick off the conversation, and let it stream until the
`400 Provider returned error` surfaces.

## 3. Find the dump

Files land in:

```
~/.localcode/diagnostics/<timestamp>-openrouter-<status>.json
```

Example filename:

```
~/.localcode/diagnostics/2026-05-06T14-32-19.123Z-openrouter-400.json
```

The most recent file is the one you want.

## 4. Verify the dump is sanitized

Before sharing, confirm the API key isn't in the file:

```sh
grep -i 'authorization\|api_key\|sk-or-' ~/.localcode/diagnostics/<file>.json
```

You should see only `"Authorization": "Bearer ***"` and no `sk-or-...`
substrings. The dumper redacts:

- `Authorization`, `x-api-key`, `api-key`, `x-goog-api-key`,
  `openai-api-key`, `anthropic-api-key` headers → value replaced with
  `Bearer ***`.
- Any body field whose key (case-insensitive) matches `apikey`,
  `api_key`, `authorization`, `auth`, `token`, `access_token`,
  `secret` → value replaced with `***`.

If you see anything that looks like a real key, **do not share the
file** — open an issue against `src/llm/diagnostics.ts` instead.

## 5. What to look for in the dump

The JSON has these top-level fields:

| Field             | Meaning                                                |
|-------------------|--------------------------------------------------------|
| `timestamp`       | ISO timestamp the failure was captured.                |
| `backend`         | Always `openrouter` (no other backends dump).          |
| `model`           | The model id we asked OpenRouter to route to.          |
| `status`          | HTTP status returned (usually 400, 429, 404, 500).     |
| `responseBody`    | Verbatim error body OpenRouter returned.               |
| `responseHeaders` | All response headers (Retry-After, x-ratelimit-*, etc).|
| `requestBody`     | The exact JSON we POSTed (sanitized).                  |
| `requestHeaders`  | The exact headers we sent (sanitized).                 |

Things to check first:

1. **`responseBody`** — does it say `Provider returned error`,
   `No allowed providers`, `Rate limit exceeded`, or something else?
   Each maps to a different remediation in `src/llm/adapter.ts`.
2. **`responseHeaders["retry-after"]`** — if present, our retry loop
   should be honouring it. Check the value.
3. **`requestBody.messages`** — count the `tool` role entries and
   verify each one has a `tool_call_id` that matches a `tool_calls[]`
   entry on a prior `assistant` message. A drift here will 400 every
   subsequent turn.
4. **`requestBody.tools`** — count and sizes. Each `function.description`
   must be ≤ 1024 chars. Each `parameters.type` must be `"object"`.
5. **`requestBody.provider` / `route` / `transforms`** — these top-level
   OpenRouter knobs should match the contract asserted in
   `tests/llm/openrouter-request-shape.test.ts`.

## 6. Disable dumps when done

Set `dump_failed_requests = false` (or remove the section) once you've
captured what you need.
