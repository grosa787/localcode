/**
 * Verifies that ContextManager.buildSystemPrompt:
 *   - omits the lead-orchestration section when agentsExposed=false,
 *   - includes it when agentsExposed=true,
 *   - is byte-stable across calls with identical inputs (preserves the
 *     local-model prompt-cache prefix invariant).
 */

import { describe, expect, test } from 'bun:test';

import { ContextManager } from '@/llm/context-manager';

describe('ContextManager.buildSystemPrompt — agentsExposed', () => {
  test('omits multi-agent section when agentsExposed is absent or false', () => {
    const cm = new ContextManager();
    const out = cm.buildSystemPrompt({});
    expect(out).not.toContain('## Multi-agent orchestration');
  });

  test('includes multi-agent section when agentsExposed=true', () => {
    const cm = new ContextManager();
    const out = cm.buildSystemPrompt({
      agentsExposed: true,
      agentTools: ['agent_status', 'await_agent', 'spawn_agent', 'team_read', 'team_send'],
    });
    expect(out).toContain('## Multi-agent orchestration');
    expect(out).toContain('spawn_agent');
  });

  test('is byte-stable across two identical calls', () => {
    const cm1 = new ContextManager();
    const cm2 = new ContextManager();
    const opts = {
      agentsExposed: true,
      agentTools: [
        'agent_status',
        'await_agent',
        'spawn_agent',
        'team_read',
        'team_send',
      ] as const,
      modelName: 'gemma3-27b',
      localcodeMd: 'project notes\n',
    };
    const a = cm1.buildSystemPrompt({ ...opts, agentTools: [...opts.agentTools] });
    const b = cm2.buildSystemPrompt({ ...opts, agentTools: [...opts.agentTools] });
    expect(a).toBe(b);
  });

  test('off-on switch differs only by the appended section', () => {
    const cm = new ContextManager();
    const off = cm.buildSystemPrompt({});
    const on = cm.buildSystemPrompt({
      agentsExposed: true,
      agentTools: ['spawn_agent'],
    });
    expect(on.startsWith(off)).toBe(true);
    expect(on.length).toBeGreaterThan(off.length);
  });
});
