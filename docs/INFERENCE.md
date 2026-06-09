# Inference control (local-first constrained decoding)

Wave 16B adds a **local-first moat**: llama.cpp-class servers (LM Studio,
Ollama, llama-server, vLLM-with-grammar) expose constrained-decoding knobs
that cloud APIs (OpenAI / Anthropic) do not — a GBNF `grammar`, a raw
`logit_bias` map, and llama.cpp's `cache_prompt`. LocalCode probes which
knobs a given local server honours and attaches them to the **per-request
body** (never the byte-stable system prompt — that would defeat the prefix
cache).

The headline feature is **grammar lock**: a GBNF grammar compiled from the
tool schemas that forces the model to emit syntactically valid tool calls
naming only tools that actually exist. This kills the most common local-model
failure — "calls a non-existent tool" / "emits malformed tool-call JSON".

## Configuration

`~/.localcode/config.toml`:

```toml
[inference]
grammarLock = "auto"    # "auto" | "on" | "off"   (default "auto")
logitBanlist = "auto"   # "auto" | "on" | "off"   (default "auto")
```

- `"auto"` — attach the knob when the live capability probe confirms the
  server supports it AND the backend is local.
- `"on"` — same as `"auto"` (the probe still gates on actual support; we
  never send a `grammar` field to a server that 400s on it).
- `"off"` — never attach the knob. This is the **baseline** for A/B testing.

Both knobs are **automatically disabled** for cloud backends (`openai`,
`openrouter`, `google`, `anthropic`) — the probe short-circuits to all-false
without a network round-trip, and the adapter omits the fields.

> `logitBanlist` symbol-boosting needs a server `/tokenize` round-trip that
> the TUI does not currently wire, so today only **grammar lock** ships live.
> The config knob and adapter plumbing for `logit_bias` are in place for a
> follow-up that injects a tokenizer.

## How it is wired (composition root)

`src/app.tsx` (`// INFERENCE-WIRING-SECTION`):

1. On config / model / backend change, an effect checks the backend is local
   and at least one mode is not `"off"`.
2. It runs `probeCapabilities(...)` **asynchronously** (cached to
   `~/.localcode/capabilities.json`, 7-day TTL) — startup is never blocked.
3. When the probe resolves it compiles the grammar once with
   `compileToolGrammar(TOOLS_SCHEMA)` (sync) and stores an
   `InferenceControlConfig` in state.
4. The `llm` adapter memo rebuilds with that `inference` config — the adapter
   **starts without inference and gains it after the probe lands**. The
   feature is purely additive; the first turn before the probe resolves is
   identical to legacy behaviour.

The adapter (`src/llm/adapter.ts`, `// INFERENCE-CONTROL-SECTION`) attaches
`grammar` to the request body **only** when: the backend is local, the
capability report says `grammar: true`, `grammarLock !== 'off'`, and the turn
carries tools. `cache_prompt` attaches whenever the report supports it;
`logit_bias` attaches when supported, enabled, and non-empty.

## Measuring grammar lock (the keystone gate)

The whole point of grammar lock is **measurable task-success improvement**.
The golden-task eval harness (`/eval`, `src/eval/`) runs real autonomous
agent loops in throwaway tmp repos and reports a pass-rate. To prove grammar
lock helps (or at minimum does not regress), run the suite twice — once with
the grammar off, once on — against the SAME local model.

### Option A — the measurement script (recommended)

Start a tool-capable local model in **LM Studio** (or Ollama / llama-server),
then:

```sh
cd localcode
bun run scripts/measure-grammar-lock.ts                 # auto-detects the model
# or point it explicitly:
bun run scripts/measure-grammar-lock.ts --base-url http://localhost:1234/v1 --model qwen2.5-coder
# narrow the slice (faster):
bun run scripts/measure-grammar-lock.ts --tasks 3
```

The script:

1. Detects a reachable local model (Ollama `:11434`, then LM Studio `:1234`).
2. Probes its capabilities (and warns if the server does **not** accept a
   `grammar` field — in that case the "on" run cannot constrain decoding and
   the delta will be ~0; use a llama.cpp-class server for a real test).
3. Runs `runSuite` over the first N golden tasks with `grammarLock: 'off'`,
   then again with `grammarLock: 'on'`.
4. Prints pass-rate + total tokens for each run and the **delta**.

When **no local model is reachable**, the script does NOT fabricate numbers.
It runs the suite once with a deterministic **fake** adapter to prove the
runner executes end-to-end (scaffold → loop → tool-execute → success-check)
and then prints this procedure. In the LocalCode CI / sandbox environment no
local model is available, so the live grammar-lock delta is **pending** —
run the command above on a machine with LM Studio to capture it.

### Option B — two `/eval` runs from inside the TUI

1. Set `[inference] grammarLock = "off"` in `~/.localcode/config.toml`.
2. Launch the TUI against your local model and run `/eval` (or `/eval export`
   to write `~/.localcode/eval-<date>.json`).
3. Set `grammarLock = "on"`, relaunch, run `/eval` again.
4. Diff the two pass-rates (and token totals). `/eval export` makes this a
   clean JSON diff.

`/eval list` shows the task ids; `/eval <task-id>` runs a single task.

## What "good" looks like

On a weak-but-tool-capable local model (Qwen2.5-Coder 7B class), grammar lock
should **raise or hold** the pass-rate and **not inflate** output tokens
(constrained decoding can even reduce wasted retry tokens from malformed tool
calls). A regression in pass-rate with grammar on is a signal the compiled
grammar is too tight for that model's tool-call dialect — investigate the
GBNF in `src/llm/inference-control/grammar.ts`.
