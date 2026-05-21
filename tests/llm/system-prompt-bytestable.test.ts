/**
 * Regression guard for the prefix-cache invariant: calling
 * `ContextManager.buildSystemPrompt` twice with identical inputs
 * MUST return byte-identical strings.
 *
 * Why: providers fronted by OpenRouter (Anthropic, OpenAI, DeepInfra)
 * — and llama.cpp's local prefix cache in LM Studio / Ollama —
 * cache on a stable BYTE prefix. If the prompt drifts (e.g. skills
 * resorted, user-message smuggled into the prompt, timestamp
 * appended), every turn pays full process-prompt cost. Several
 * minutes of latency on local models with long histories.
 *
 * If you intentionally change the prompt, update the snapshot — but
 * make sure the change is deterministic (no `Date.now()`, no
 * iteration-order dependency on a Map).
 */
import { describe, test, expect } from 'bun:test';
import { ContextManager } from '@/llm/context-manager';
import type { Skill } from '@/types/global';

function mkSkill(id: string, body: string, active = true): Skill {
  return {
    id,
    name: id,
    description: `desc-${id}`,
    content: body,
    active,
    path: `/tmp/skills/${id}.md`,
  };
}

describe('buildSystemPrompt — byte-stable across identical inputs', () => {
  test('same inputs → identical output (no inputs)', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({});
    const b = cm.buildSystemPrompt({});
    expect(a).toBe(b);
  });

  test('same inputs → identical output (with skills + LOCALCODE.md)', () => {
    const cm = new ContextManager();
    const skills: Skill[] = [
      mkSkill('z-skill', 'BODY-Z'),
      mkSkill('a-skill', 'BODY-A'),
      mkSkill('m-skill', 'BODY-M'),
    ];
    const md = '# Project\n\nSome description.\n';
    const a = cm.buildSystemPrompt({ localcodeMd: md, skills });
    const b = cm.buildSystemPrompt({ localcodeMd: md, skills });
    expect(a).toBe(b);
  });

  test('skill input order does not perturb output (sort-by-id invariant)', () => {
    const cm = new ContextManager();
    const skillsA: Skill[] = [
      mkSkill('a-skill', 'BODY-A'),
      mkSkill('m-skill', 'BODY-M'),
      mkSkill('z-skill', 'BODY-Z'),
    ];
    const skillsB: Skill[] = [
      mkSkill('z-skill', 'BODY-Z'),
      mkSkill('m-skill', 'BODY-M'),
      mkSkill('a-skill', 'BODY-A'),
    ];
    const a = cm.buildSystemPrompt({ skills: skillsA });
    const b = cm.buildSystemPrompt({ skills: skillsB });
    expect(a).toBe(b);
  });

  test('summary input round-trips deterministically', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({ summary: 'prior session: refactored auth' });
    const b = cm.buildSystemPrompt({ summary: 'prior session: refactored auth' });
    expect(a).toBe(b);
  });

  test('userLatestSnippet is ignored (prefix-cache invariant)', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({ userLatestSnippet: 'hello' });
    const b = cm.buildSystemPrompt({ userLatestSnippet: 'goodbye' });
    expect(a).toBe(b);
  });
});

describe('buildSystemPrompt — outputStyle byte-stability', () => {
  test('same outputStyle → identical output across two calls', () => {
    const cm = new ContextManager();
    for (const style of ['concise', 'explanatory', 'verbose'] as const) {
      const a = cm.buildSystemPrompt({ outputStyle: style });
      const b = cm.buildSystemPrompt({ outputStyle: style });
      expect(a).toBe(b);
    }
  });

  test('absent vs undefined outputStyle are byte-identical (no preamble)', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({});
    const b = cm.buildSystemPrompt({ outputStyle: undefined });
    expect(a).toBe(b);
    expect(a).not.toContain('Response style:');
  });

  test('different outputStyles produce different prompts', () => {
    const cm = new ContextManager();
    const concise = cm.buildSystemPrompt({ outputStyle: 'concise' });
    const verbose = cm.buildSystemPrompt({ outputStyle: 'verbose' });
    expect(concise).not.toBe(verbose);
  });

  test('outputStyle combined with skills + LOCALCODE.md — deterministic', () => {
    const cm = new ContextManager();
    const skills: Skill[] = [
      mkSkill('z-skill', 'BODY-Z'),
      mkSkill('a-skill', 'BODY-A'),
    ];
    const opts = {
      localcodeMd: '# Project\n\nSome description.\n',
      skills,
      outputStyle: 'explanatory' as const,
    };
    const a = cm.buildSystemPrompt(opts);
    const b = cm.buildSystemPrompt(opts);
    expect(a).toBe(b);
  });
});

describe('buildSystemPrompt — memory section byte-stability', () => {
  test('with memory section — same inputs → identical output', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({ memorySection: 'user: prefers verbose explanations' });
    const b = cm.buildSystemPrompt({ memorySection: 'user: prefers verbose explanations' });
    expect(a).toBe(b);
  });

  test('absent vs null memory section are byte-identical (no empty heading)', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({});
    const b = cm.buildSystemPrompt({ memorySection: null });
    expect(a).toBe(b);
  });

  test('empty memory section is byte-identical to absent (no empty heading)', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({});
    const b = cm.buildSystemPrompt({ memorySection: '' });
    expect(a).toBe(b);
  });

  test('memory section combined with skills + LOCALCODE.md — deterministic', () => {
    const cm = new ContextManager();
    const skills: Skill[] = [
      mkSkill('z-skill', 'BODY-Z'),
      mkSkill('a-skill', 'BODY-A'),
    ];
    const opts = {
      localcodeMd: '# Project\n\nSome description.\n',
      skills,
      memorySection: 'project: uses bun, not node',
    };
    const a = cm.buildSystemPrompt(opts);
    const b = cm.buildSystemPrompt(opts);
    expect(a).toBe(b);
  });
});
