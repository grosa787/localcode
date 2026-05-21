/**
 * Tests for the sub-agent template catalog. Verifies the curated 10
 * entries meet the structural and content requirements documented in
 * `src/agents/catalog/templates.ts`.
 */

import { describe, test, expect } from 'bun:test';

import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATES_BY_ID,
  AGENT_TEMPLATE_IDS,
  findAgentTemplate,
} from '@/agents/catalog';
import type { AgentTemplate } from '@/agents/catalog';

const REQUIRED_IDS = [
  'architect',
  'debugger',
  'security-reviewer',
  'typescript-reviewer',
  'python-reviewer',
  'rust-reviewer',
  'go-reviewer',
  'test-engineer',
  'performance-optimizer',
  'doc-writer',
] as const;

describe('AGENT_TEMPLATES — shape', () => {
  test('exposes exactly 10 templates', () => {
    expect(AGENT_TEMPLATES.length).toBe(10);
  });

  test('every template has the required fields populated', () => {
    for (const t of AGENT_TEMPLATES) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.tagline).toBe('string');
      expect(t.tagline.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.systemPrompt).toBe('string');
      expect(t.systemPrompt.length).toBeGreaterThan(0);
      expect(typeof t.recommendedModel).toBe('string');
      expect(Array.isArray(t.tools)).toBe(true);
      expect(['default', 'readOnly', 'acceptEdits']).toContain(
        t.approvalProfile,
      );
    }
  });

  test('ids are unique and kebab-case', () => {
    const seen = new Set<string>();
    for (const t of AGENT_TEMPLATES) {
      expect(seen.has(t.id)).toBe(false);
      seen.add(t.id);
      expect(/^[a-z][a-z0-9-]*$/.test(t.id)).toBe(true);
    }
    expect(seen.size).toBe(AGENT_TEMPLATES.length);
  });

  test('names are unique (no duplicates)', () => {
    const names = AGENT_TEMPLATES.map((t) => t.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  test('all 10 required ids are present', () => {
    for (const id of REQUIRED_IDS) {
      const t = findAgentTemplate(id);
      expect(t).toBeDefined();
      expect((t as AgentTemplate).id).toBe(id);
    }
  });
});

describe('AGENT_TEMPLATES — content constraints', () => {
  test('system prompts are ≤ 150 words each', () => {
    for (const t of AGENT_TEMPLATES) {
      const wordCount = t.systemPrompt
        .split(/\s+/)
        .filter((w) => w.length > 0).length;
      // Sanity: a non-empty prompt has at least a few words.
      expect(wordCount).toBeGreaterThan(5);
      expect(wordCount).toBeLessThanOrEqual(150);
    }
  });

  test('system prompts mention either role or task constraints (not boilerplate)', () => {
    for (const t of AGENT_TEMPLATES) {
      const body = t.systemPrompt.toLowerCase();
      // At minimum the prompt should call out the role or expected output.
      expect(
        body.includes('output') ||
          body.includes('you ') ||
          body.includes('review') ||
          body.includes('audit') ||
          body.includes('debug') ||
          body.includes('write'),
      ).toBe(true);
    }
  });

  test('reviewer templates default to readOnly approval profile', () => {
    const reviewers = AGENT_TEMPLATES.filter(
      (t) => t.id.endsWith('-reviewer') || t.id === 'security-reviewer',
    );
    expect(reviewers.length).toBeGreaterThan(0);
    for (const r of reviewers) {
      expect(r.approvalProfile).toBe('readOnly');
    }
  });

  test('doc-writer uses acceptEdits profile (auto-approve doc writes)', () => {
    const t = findAgentTemplate('doc-writer');
    expect(t).toBeDefined();
    expect((t as AgentTemplate).approvalProfile).toBe('acceptEdits');
  });

  test('debugger has run_command in tools allow-list (needed for repros)', () => {
    const t = findAgentTemplate('debugger');
    expect(t).toBeDefined();
    expect((t as AgentTemplate).tools).toContain('run_command');
  });

  test('read-only templates do NOT include mutating tools', () => {
    const mutating = new Set(['write_file', 'edit_file', 'multi_edit']);
    for (const t of AGENT_TEMPLATES) {
      if (t.approvalProfile === 'readOnly') {
        for (const tool of t.tools) {
          expect(mutating.has(tool)).toBe(false);
        }
      }
    }
  });
});

describe('AGENT_TEMPLATES — lookup helpers', () => {
  test('AGENT_TEMPLATES_BY_ID returns same template as findAgentTemplate', () => {
    for (const t of AGENT_TEMPLATES) {
      expect(AGENT_TEMPLATES_BY_ID[t.id]).toBe(t);
      expect(findAgentTemplate(t.id)).toBe(t);
    }
  });

  test('findAgentTemplate returns undefined for unknown ids', () => {
    expect(findAgentTemplate('does-not-exist')).toBeUndefined();
    expect(findAgentTemplate('')).toBeUndefined();
  });

  test('AGENT_TEMPLATE_IDS lists every catalog entry exactly once', () => {
    expect(AGENT_TEMPLATE_IDS.length).toBe(AGENT_TEMPLATES.length);
    for (const t of AGENT_TEMPLATES) {
      expect(AGENT_TEMPLATE_IDS).toContain(t.id);
    }
  });
});
