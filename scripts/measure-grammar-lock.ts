#!/usr/bin/env bun
/**
 * measure-grammar-lock — KEYSTONE instrument for Wave 16B.
 *
 * Runs the golden-task eval harness over a small slice of tasks TWICE
 * against a LIVE local model:
 *   - once with `inference.grammarLock = 'off'` (legacy behaviour), and
 *   - once with `inference.grammarLock = 'on'` (GBNF tool-call grammar
 *     attached to every request body).
 * It prints pass-rate + total tokens for each run and the delta between
 * them — the evidence that constrained decoding helps (or at minimum does
 * not regress) tool-call reliability on a llama.cpp-class server.
 *
 * Honesty contract: this script NEVER fabricates numbers. When no local
 * model is reachable it runs the suite with a DETERMINISTIC FAKE adapter
 * (proving the runner executes end-to-end) and then tells the user the
 * exact commands to run a real measurement on their own machine. See
 * `docs/INFERENCE.md` for the full procedure.
 *
 * Usage:
 *   bun run scripts/measure-grammar-lock.ts
 *   bun run scripts/measure-grammar-lock.ts --tasks 3
 *   bun run scripts/measure-grammar-lock.ts --base-url http://localhost:1234/v1 --model qwen2.5-coder
 *
 * Exit code is 0 on a clean run (live or fake); non-zero only on an
 * unexpected internal error.
 */

import type { Backend } from '@/types/global';
import type { StreamChatParams, ToolCall } from '@/types/message';

import { LLMAdapter } from '@/llm/adapter';
import type { InferenceControlConfig } from '@/llm/adapter';
import { compileToolGrammar, probeCapabilities } from '@/llm/inference-control';
import { TOOLS_SCHEMA } from '@/llm/tools-schema';
import { GOLDEN_TASKS, runSuite } from '@/eval';
import type { EvalReport, GoldenTask } from '@/eval';
import type { EvalAdapter } from '@/eval/runner';

// ---------- argument parsing ----------

interface CliArgs {
  taskCount: number;
  baseUrlOverride?: string;
  modelOverride?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { taskCount: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tasks' && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.taskCount = Math.floor(n);
      i += 1;
    } else if (a === '--base-url' && i + 1 < argv.length) {
      out.baseUrlOverride = argv[i + 1];
      i += 1;
    } else if (a === '--model' && i + 1 < argv.length) {
      out.modelOverride = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

// ---------- local-model detection ----------

interface DetectedModel {
  backend: Backend;
  baseUrl: string;
  model: string;
}

const OLLAMA_TAGS = 'http://localhost:11434/api/tags';
const OLLAMA_BASE = 'http://localhost:11434/v1';
const LMSTUDIO_MODELS = 'http://localhost:1234/v1/models';
const LMSTUDIO_BASE = 'http://localhost:1234/v1';

async function fetchJson(url: string, timeoutMs = 3000): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Detect a reachable local model on Ollama, then LM Studio. */
async function detectLocalModel(): Promise<DetectedModel | null> {
  // Ollama — { models: [{ name: 'qwen2.5:7b', ... }] }
  const ollama = await fetchJson(OLLAMA_TAGS);
  if (ollama !== null && typeof ollama === 'object' && 'models' in ollama) {
    const models = (ollama as { models?: unknown }).models;
    if (Array.isArray(models) && models.length > 0) {
      const first = models[0];
      const name =
        first && typeof first === 'object' && 'name' in first
          ? (first as { name?: unknown }).name
          : undefined;
      if (typeof name === 'string' && name.length > 0) {
        return { backend: 'ollama', baseUrl: OLLAMA_BASE, model: name };
      }
    }
  }

  // LM Studio — OpenAI shape { data: [{ id: 'qwen2.5-coder', ... }] }
  const lmstudio = await fetchJson(LMSTUDIO_MODELS);
  if (lmstudio !== null && typeof lmstudio === 'object' && 'data' in lmstudio) {
    const data = (lmstudio as { data?: unknown }).data;
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      const id =
        first && typeof first === 'object' && 'id' in first
          ? (first as { id?: unknown }).id
          : undefined;
      if (typeof id === 'string' && id.length > 0) {
        return { backend: 'lmstudio', baseUrl: LMSTUDIO_BASE, model: id };
      }
    }
  }

  return null;
}

// ---------- live measurement ----------

/**
 * Build the `inference` config for one grammar-lock mode. Reuses the live
 * capability report so we never claim support the server doesn't have —
 * if `report.grammar` is false, the adapter omits the grammar regardless
 * of the mode (this is the honest, conservative path).
 */
function inferenceFor(
  report: Awaited<ReturnType<typeof probeCapabilities>>,
  grammarLock: 'on' | 'off',
): InferenceControlConfig {
  const toolGrammar =
    grammarLock === 'on' ? compileToolGrammar(TOOLS_SCHEMA).gbnf : undefined;
  return {
    report,
    grammarLock,
    logitBanlist: 'off',
    ...(toolGrammar !== undefined ? { toolGrammar } : {}),
  };
}

async function runWithGrammar(
  detected: DetectedModel,
  report: Awaited<ReturnType<typeof probeCapabilities>>,
  tasks: readonly GoldenTask[],
  grammarLock: 'on' | 'off',
): Promise<EvalReport> {
  const adapter = new LLMAdapter({
    baseUrl: detected.baseUrl,
    model: detected.model,
    backend: detected.backend,
    inference: inferenceFor(report, grammarLock),
  });
  return runSuite(tasks, {
    adapter: { streamChat: (p: StreamChatParams) => adapter.streamChat(p) },
    model: detected.model,
    backend: detected.backend,
    onTaskComplete: (r, idx) => {
      process.stdout.write(
        `    [${idx + 1}/${tasks.length}] ${r.taskId}: ${r.passed ? 'PASS' : 'FAIL'}` +
          `${r.error !== undefined ? ` (${r.error})` : ''}\n`,
      );
    },
  });
}

function summarise(label: string, report: EvalReport): void {
  const pct = (report.passRate * 100).toFixed(1);
  const passes = report.results.filter((r) => r.passed).length;
  process.stdout.write(
    `  ${label}: pass-rate ${pct}% (${passes}/${report.results.length})  ` +
      `tokens in=${report.totalTokensIn} out=${report.totalTokensOut}  ` +
      `wall=${report.totalWallMs}ms\n`,
  );
}

// ---------- fake-adapter fallback (no local model) ----------

/**
 * A deterministic fake that solves the first golden task by writing the
 * expected file, then `<DONE>`s. Proves the end-to-end runner executes
 * (scaffold → loop → tool-execute → success-check) WITHOUT a network.
 * It is NOT a grammar-lock measurement and is labelled as such.
 */
function fakeSolverAdapter(): EvalAdapter {
  // Solve `add-function-sum` (the first golden task): implement + export
  // a CommonJS `sum(a, b)` in sum.js so the scaffolded `node test.js`
  // success check exits 0.
  const call: ToolCall = {
    id: 'fake-1',
    name: 'write_file',
    arguments: {
      path: 'sum.js',
      content:
        'function sum(a, b) {\n  return a + b;\n}\nmodule.exports = { sum };\n',
    },
  };
  let turn = 0;
  return {
    streamChat: async (params: StreamChatParams): Promise<void> => {
      turn += 1;
      if (turn === 1) {
        params.onChunk?.('Writing the function.');
        params.onToolCalls?.([call]);
        params.onDone?.({
          finishReason: 'tool_calls',
          usage: { promptTokens: 80, completionTokens: 24 },
        });
        return;
      }
      params.onChunk?.('Done. <DONE>');
      params.onDone?.({
        finishReason: 'stop',
        usage: { promptTokens: 90, completionTokens: 6 },
      });
    },
  };
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = GOLDEN_TASKS.slice(0, args.taskCount);

  process.stdout.write('\n=== Grammar-lock measurement (Wave 16B keystone) ===\n');
  process.stdout.write(`Tasks: ${tasks.map((t) => t.id).join(', ')}\n\n`);

  // Allow an explicit override (user points at a known endpoint/model).
  let detected: DetectedModel | null = null;
  if (args.baseUrlOverride !== undefined && args.modelOverride !== undefined) {
    const backend: Backend = args.baseUrlOverride.includes('11434')
      ? 'ollama'
      : 'lmstudio';
    detected = {
      backend,
      baseUrl: args.baseUrlOverride,
      model: args.modelOverride,
    };
  } else {
    detected = await detectLocalModel();
  }

  if (detected === null) {
    process.stdout.write(
      'No local model reachable (tried Ollama :11434 and LM Studio :1234).\n\n' +
        'Running the harness with a DETERMINISTIC FAKE adapter to prove the\n' +
        'end-to-end runner executes (scaffold → loop → tool-execute → check).\n' +
        'This is NOT a grammar-lock measurement — see the note below.\n\n',
    );

    const fakeReport = await runSuite([tasks[0] as GoldenTask], {
      adapter: fakeSolverAdapter(),
      model: 'fake-deterministic',
      backend: 'lmstudio',
    });
    summarise('FAKE adapter (runner self-test)', fakeReport);

    process.stdout.write(
      '\n--- LIVE measurement is PENDING a running local model ---\n' +
        'To measure grammar-lock for real, start LM Studio (or Ollama) with a\n' +
        'tool-capable model, then run ONE of:\n\n' +
        '  bun run scripts/measure-grammar-lock.ts\n' +
        '  bun run scripts/measure-grammar-lock.ts --base-url http://localhost:1234/v1 --model <id>\n\n' +
        'Or, inside the TUI, compare two /eval runs:\n' +
        '  1. set [inference] grammarLock = "off" in ~/.localcode/config.toml, run /eval\n' +
        '  2. set grammarLock = "on", restart, run /eval again, diff the pass-rates\n' +
        'Full procedure: docs/INFERENCE.md\n',
    );
    return;
  }

  process.stdout.write(
    `Detected local model: ${detected.model} @ ${detected.backend} (${detected.baseUrl})\n`,
  );

  // Probe once; both runs share the same honest capability report.
  const report = await probeCapabilities({
    baseUrl: detected.baseUrl,
    backend: detected.backend,
    model: detected.model,
    noCache: true,
  });
  process.stdout.write(
    `Capabilities: grammar=${report.grammar} logitBias=${report.logitBias} ` +
      `cachePrompt=${report.cachePrompt}\n`,
  );
  if (!report.grammar) {
    process.stdout.write(
      '\nWARNING: this server does NOT accept a `grammar` field, so the\n' +
        '"on" run cannot actually constrain decoding — the delta will be ~0.\n' +
        'Use a llama.cpp-class server (LM Studio / llama-server) for a real test.\n',
    );
  }

  process.stdout.write('\n[1/2] grammarLock = OFF\n');
  const off = await runWithGrammar(detected, report, tasks, 'off');
  process.stdout.write('\n[2/2] grammarLock = ON\n');
  const on = await runWithGrammar(detected, report, tasks, 'on');

  process.stdout.write('\n=== Results ===\n');
  summarise('OFF', off);
  summarise('ON ', on);

  const deltaPass = (on.passRate - off.passRate) * 100;
  const deltaTokens =
    on.totalTokensIn + on.totalTokensOut - (off.totalTokensIn + off.totalTokensOut);
  process.stdout.write(
    `\nDelta (ON − OFF): pass-rate ${deltaPass >= 0 ? '+' : ''}${deltaPass.toFixed(1)}%  ` +
      `total-tokens ${deltaTokens >= 0 ? '+' : ''}${deltaTokens}\n`,
  );
  process.stdout.write(
    deltaPass >= 0
      ? 'Grammar lock did not regress pass-rate. ✓\n'
      : 'Grammar lock REGRESSED pass-rate on this model — investigate.\n',
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`measure-grammar-lock failed: ${msg}\n`);
  process.exit(1);
});
