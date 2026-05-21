/**
 * Memory integration tests — verifies that buildSystemPrompt correctly
 * injects the memorySection and that the injection is byte-stable.
 */

import { describe, test, expect } from 'bun:test';
import { ContextManager } from '@/llm/context-manager';

describe('buildSystemPrompt — memory section integration', () => {
  test('memory section is absent when memorySection is not provided', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).not.toContain('## Memory');
    expect(prompt).not.toContain('[MEMORY]');
  });

  test('memory section is absent when memorySection is null', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({ memorySection: null });
    expect(prompt).not.toContain('## Memory');
  });

  test('memory section is absent when memorySection is empty string', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({ memorySection: '' });
    expect(prompt).not.toContain('## Memory');
  });

  test('memory section is absent when memorySection is whitespace only', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({ memorySection: '   \n  ' });
    expect(prompt).not.toContain('## Memory');
  });

  test('memory section is present when memorySection has content', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({ memorySection: 'User prefers TypeScript strict mode.' });
    expect(prompt).toContain('## Memory');
    expect(prompt).toContain('[MEMORY]');
    expect(prompt).toContain('User prefers TypeScript strict mode.');
  });

  test('memory section appears after project context and before skills', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      localcodeMd: '# My Project',
      memorySection: 'some memory',
      skills: [],
    });
    const projectPos = prompt.indexOf('## Project context');
    const memPos = prompt.indexOf('## Memory');
    const skillsPos = prompt.indexOf('## Active skills');
    expect(projectPos).toBeGreaterThan(-1);
    expect(memPos).toBeGreaterThan(projectPos);
    expect(skillsPos).toBeGreaterThan(memPos);
  });

  test('byte-stable with memory section — same inputs produce identical output', () => {
    const cm = new ContextManager();
    const opts = {
      localcodeMd: '# Project\nSome description.',
      memorySection: 'user prefers short answers\nproject uses bun not node',
    };
    const a = cm.buildSystemPrompt(opts);
    const b = cm.buildSystemPrompt(opts);
    expect(a).toBe(b);
  });

  test('byte-stable without memory section — unaffected by memory feature presence', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({ localcodeMd: '# P' });
    const b = cm.buildSystemPrompt({ localcodeMd: '# P' });
    expect(a).toBe(b);
  });

  test('absent memory section is byte-identical to null memory section', () => {
    const cm = new ContextManager();
    const withNull = cm.buildSystemPrompt({ memorySection: null });
    const withUndefined = cm.buildSystemPrompt({});
    expect(withNull).toBe(withUndefined);
  });
});
