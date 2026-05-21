/**
 * R26 (Agent A) — ROADMAP batch 2+3 LLM-layer additions:
 *   - `trimOldToolResults(messages, keepLast)` — pure helper that
 *     collapses old tool-role messages so only the last N survive
 *     verbatim in the wire payload (#5).
 *   - Senior-engineer system prompt + model-specific Identity preset
 *     selection via `buildSystemPrompt({ modelName, preset })` (#14, #15).
 *
 * The adapter-side wiring (chunk batching, JSON mode, adaptive
 * temperature) is exercised in `adapter-r26.test.ts`.
 */

import { describe, test, expect } from 'bun:test';
import {
  ContextManager,
  DEFAULT_TRIM_TOOL_RESULTS_AFTER,
  trimOldToolResults,
} from '@/llm/context-manager';
import {
  buildPersonaForPreset,
  detectModelPreset,
  type ModelPresetName,
} from '@/llm/prompt-presets';
import type { Message } from '@/types/global';

function mkMessage(
  role: Message['role'],
  content: string,
  id?: string,
  toolName?: string,
  toolCallId?: string,
): Message {
  const m: Message = {
    id: id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    role,
    content,
    createdAt: 0,
  };
  if (toolName !== undefined) m.toolName = toolName;
  if (toolCallId !== undefined) m.toolCallId = toolCallId;
  return m;
}

// ---------- trimOldToolResults ----------

describe('trimOldToolResults — pure helper (R26 / ROADMAP #5)', () => {
  test('returns an empty array for empty input', () => {
    expect(trimOldToolResults([], 5)).toEqual([]);
  });

  test('does not mutate the input array', () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 8; i += 1) {
      msgs.push(
        mkMessage('tool', 'x'.repeat(50), `t-${i}`, 'read_file', `call-${i}`),
      );
    }
    const before = msgs.map((m) => m.content);
    trimOldToolResults(msgs, 3);
    const after = msgs.map((m) => m.content);
    expect(after).toEqual(before);
  });

  test('keeps the last N tool messages verbatim and collapses the rest', () => {
    const msgs: Message[] = [
      mkMessage('user', 'go'),
      mkMessage('assistant', 'sure'),
      mkMessage('tool', 'A'.repeat(200), 't-0', 'read_file', 'c-0'),
      mkMessage('tool', 'B'.repeat(200), 't-1', 'read_file', 'c-1'),
      mkMessage('tool', 'C'.repeat(200), 't-2', 'read_file', 'c-2'),
      mkMessage('tool', 'D'.repeat(200), 't-3', 'read_file', 'c-3'),
    ];
    const out = trimOldToolResults(msgs, 2);
    // Same length.
    expect(out).toHaveLength(msgs.length);
    // First two tool messages are collapsed; last two are verbatim.
    expect(out[2]?.content.startsWith('[tool: read_file(c-0)')).toBe(true);
    expect(out[3]?.content.startsWith('[tool: read_file(c-1)')).toBe(true);
    expect(out[4]?.content).toBe('C'.repeat(200));
    expect(out[5]?.content).toBe('D'.repeat(200));
    // Stub format must include the original byte length.
    expect(out[2]?.content).toContain('200 bytes collapsed');
  });

  test('keepLast >= total tool messages → no collapse, all verbatim', () => {
    const msgs: Message[] = [
      mkMessage('tool', 'A', 't-0', 'read_file', 'c-0'),
      mkMessage('tool', 'B', 't-1', 'read_file', 'c-1'),
    ];
    const out = trimOldToolResults(msgs, 5);
    expect(out.map((m) => m.content)).toEqual(['A', 'B']);
  });

  test('keepLast = 0 collapses every tool message', () => {
    const msgs: Message[] = [
      mkMessage('tool', 'A'.repeat(100), 't-0', 'read_file', 'c-0'),
      mkMessage('tool', 'B'.repeat(100), 't-1', 'read_file', 'c-1'),
    ];
    const out = trimOldToolResults(msgs, 0);
    expect(out[0]?.content).toContain('100 bytes collapsed');
    expect(out[1]?.content).toContain('100 bytes collapsed');
  });

  test('non-tool messages pass through unchanged', () => {
    const msgs: Message[] = [
      mkMessage('user', 'hi'),
      mkMessage('assistant', 'hello'),
      mkMessage('system', 'sys'),
      mkMessage('tool', 'X', 't-0', 'read_file', 'c-0'),
    ];
    const out = trimOldToolResults(msgs, 0);
    expect(out[0]).toEqual(msgs[0]!);
    expect(out[1]).toEqual(msgs[1]!);
    expect(out[2]).toEqual(msgs[2]!);
    // Tool message collapsed.
    expect(out[3]?.content).toContain('bytes collapsed');
  });

  test('preserves toolName and toolCallId on the collapsed stub', () => {
    const msgs: Message[] = [
      mkMessage('tool', 'X'.repeat(50), 't-0', 'run_command', 'c-abc'),
    ];
    const out = trimOldToolResults(msgs, 0);
    expect(out[0]?.toolName).toBe('run_command');
    expect(out[0]?.toolCallId).toBe('c-abc');
    expect(out[0]?.content).toContain('run_command');
    expect(out[0]?.content).toContain('c-abc');
  });

  test('default keepLast is 3 (matches DEFAULT_TRIM_TOOL_RESULTS_AFTER)', () => {
    expect(DEFAULT_TRIM_TOOL_RESULTS_AFTER).toBe(3);
    // Build 7 tool messages; default keep=3 → first 4 collapsed.
    const msgs: Message[] = [];
    for (let i = 0; i < 7; i += 1) {
      msgs.push(
        mkMessage('tool', `body-${i}`, `t-${i}`, 'read_file', `c-${i}`),
      );
    }
    const out = trimOldToolResults(msgs);
    expect(out[0]?.content).toContain('bytes collapsed');
    expect(out[3]?.content).toContain('bytes collapsed');
    expect(out[4]?.content).toBe('body-4');
    expect(out[6]?.content).toBe('body-6');
  });

  test('handles tool messages with no toolCallId / no toolName', () => {
    const msgs: Message[] = [
      mkMessage('tool', 'X'.repeat(20), 't-0'), // no toolName/toolCallId
      mkMessage('tool', 'Y'.repeat(20), 't-1'),
      mkMessage('tool', 'Z'.repeat(20), 't-2', 'read_file', 'c-2'),
    ];
    const out = trimOldToolResults(msgs, 1);
    expect(out[0]?.content).toContain('unknown(?)');
    expect(out[0]?.content).toContain('20 bytes');
    expect(out[1]?.content).toContain('unknown(?)');
    expect(out[2]?.content).toBe('Z'.repeat(20));
  });

  test('result is a fresh array (caller may mutate without affecting input)', () => {
    const msgs: Message[] = [
      mkMessage('tool', 'A', 't-0', 'read_file', 'c-0'),
      mkMessage('tool', 'B', 't-1', 'read_file', 'c-1'),
    ];
    const out = trimOldToolResults(msgs, 5);
    expect(out).not.toBe(msgs);
  });
});

// ---------- prompt-presets ----------

describe('detectModelPreset (R26 / ROADMAP #14)', () => {
  test.each([
    ['qwen2.5-coder:32b', 'qwen'],
    ['Qwen3-7B-Instruct', 'qwen'],
    ['gemma-2-27b-it-GGUF', 'gemma'],
    ['google/gemma-3', 'gemma'],
    ['llama3:latest', 'llama'],
    ['Meta-Llama-3.1-70B', 'llama'],
    ['deepseek-coder:33b', 'deepseek'],
    ['DeepSeek-R1-Distill', 'deepseek'],
    ['mistral-7b-instruct', 'generic'],
    ['codellama:34b', 'generic'],
    ['phi-3', 'default'],
    ['', 'default'],
  ] as ReadonlyArray<readonly [string, ModelPresetName]>)(
    'maps %s → %s',
    (input, expected) => {
      expect(detectModelPreset(input)).toBe(expected);
    },
  );

  test('non-string input returns default', () => {
    // @ts-expect-error - intentional misuse to verify defensive behaviour
    expect(detectModelPreset(undefined)).toBe('default');
  });
});

describe('buildPersonaForPreset (R26 / ROADMAP #14)', () => {
  test('every preset returns a non-empty string', () => {
    const all: ModelPresetName[] = [
      'qwen',
      'gemma',
      'llama',
      'deepseek',
      'generic',
      'default',
    ];
    for (const p of all) {
      const body = buildPersonaForPreset(p);
      expect(body.length).toBeGreaterThan(50);
    }
  });

  test('Gemma preset uses structured `## Step N` headers', () => {
    const body = buildPersonaForPreset('gemma');
    expect(body).toContain('## Step 1');
    expect(body).toContain('## Step 5');
  });

  test('DeepSeek preset uses spec-first structure', () => {
    const body = buildPersonaForPreset('deepseek');
    expect(body).toContain('IDENTITY SPEC');
    expect(body).toContain('expertise:');
  });

  test('Qwen preset includes a worked example', () => {
    const body = buildPersonaForPreset('qwen');
    expect(body.toLowerCase()).toContain('worked example');
  });

  test('Llama preset uses prose voice (no leading `## Step`)', () => {
    const body = buildPersonaForPreset('llama');
    expect(body).not.toContain('## Step 1');
    expect(body.toLowerCase()).toContain("you're a senior software engineer");
  });

  test('Default preset retains the legacy senior-engineer text', () => {
    const body = buildPersonaForPreset('default');
    // Sanity: mentions the language list and tools.
    expect(body).toContain('TypeScript');
    expect(body).toContain('write_file');
    expect(body).toContain('edit_file');
  });

  test('Generic preset adds a tone reminder on top of default', () => {
    const def = buildPersonaForPreset('default');
    const generic = buildPersonaForPreset('generic');
    // Generic body is strictly longer than default.
    expect(generic.length).toBeGreaterThan(def.length);
    expect(generic.toLowerCase()).toContain('senior, opinionated');
  });
});

// ---------- buildSystemPrompt — preset-aware Identity ----------

describe('ContextManager.buildSystemPrompt — modelName / preset (R26)', () => {
  test('default behaviour is unchanged when no modelName is passed', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    // Sanity: Identity header still present.
    expect(prompt).toContain('## Identity');
    // The default preset still mentions the standard tool list.
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('edit_file');
  });

  test('explicit Gemma modelName produces a structured Identity', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      modelName: 'gemma-2-27b-it',
    });
    // Structured headers from the Gemma preset must be in the prompt.
    expect(prompt).toContain('## Step 1');
    expect(prompt).toContain('## Step 5');
  });

  test('explicit `preset` overrides model auto-detection', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      modelName: 'qwen2.5',
      preset: 'gemma',
    });
    // The Gemma preset ran (overrode the qwen detection).
    expect(prompt).toContain('## Step 1');
  });

  test('language section still anchored at the top regardless of preset', () => {
    const cm = new ContextManager();
    for (const preset of ['qwen', 'gemma', 'llama', 'deepseek', 'generic', 'default'] as ModelPresetName[]) {
      const prompt = cm.buildSystemPrompt({ preset });
      const langIdx = prompt.indexOf('## Language (CRITICAL)');
      expect(langIdx).toBeGreaterThan(-1);
      // Sanity: still in the first ~3000 chars (presets can lengthen
      // the Identity body, so we relax R7's 1500 to 3000 here).
      expect(langIdx).toBeLessThan(3000);
    }
  });

  test('Self-configuration section is preserved across all presets', () => {
    const cm = new ContextManager();
    for (const preset of ['qwen', 'gemma', 'llama', 'deepseek', 'generic', 'default'] as ModelPresetName[]) {
      const prompt = cm.buildSystemPrompt({ preset });
      expect(prompt).toContain('## Self-configuration');
      expect(prompt).toContain('~/.localcode/config.toml');
    }
  });
});

// ---------- buildSystemPrompt — senior-engineer rewrite ----------

describe('ContextManager.buildSystemPrompt — senior-engineer rewrite (R26 / ROADMAP #15)', () => {
  test('mentions architectural thinking / trade-offs', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/trade-off|trade off|architectural/);
  });

  test('mentions skepticism — pushing back on bad ideas', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/push back|do not flatter|do not flatte|skepti/);
  });

  test('mentions verifying invariants after every change', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/invariant|verify/);
  });

  test('mentions no throwaway code', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/throwaway|production|hack/);
  });

  test('mentions documenting WHY rather than WHAT', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toMatch(/WHY/);
    expect(prompt).toMatch(/WHAT/);
  });

  test('mentions self-review of the diff before write_file', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/self-review|read the diff|mentally read/);
  });

  test('preserves the existing proactivity rule (#1)', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('Be proactive — execute');
  });

  test('preserves the read-before-write rule (#2)', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('Read before you write');
  });

  test('preserves the surgical-edits / write_file rule', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('Prefer surgical edits');
  });

  test('preserves the code-in-files rule (#7)', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('Code goes in FILES, not chat');
  });

  test('SYSTEM_PROMPT_BASE has been reframed around senior pair-programming', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('senior software engineer');
    // The line should no longer use the older "AI coding assistant" framing.
    expect(prompt).not.toContain('AI coding assistant');
  });
});
