/**
 * R8 — system prompt "Self-configuration" section is now a structured
 * spec rather than a one-paragraph pointer.
 *
 * Agent 2 R8 strengthened the section so the model knows:
 *   - Both config files (global TOML + per-project JSON) and their
 *     precedence.
 *   - The 5-step procedure (read → identify → edit → diff approval →
 *     confirm + take-effect note).
 *   - When each setting takes effect (per field).
 *   - Concrete worked scenarios for common requests.
 *   - TOML / JSON syntax cautions, snake_case vs camelCase, tilde
 *     expansion.
 *
 * The structure of the section is what we verify — not its exact
 * wording. The Agent 2 R8 contract is: any future tweak that breaks
 * these assertions has likely also broken the model's ability to
 * self-modify config correctly.
 */
import { describe, test, expect } from 'bun:test';
import { ContextManager } from '@/llm/context-manager';

describe('ContextManager.buildSystemPrompt — Self-configuration section (R8)', () => {
  test('contains the "## Self-configuration" header', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('## Self-configuration');
  });

  test('mentions the global config file path `~/.localcode/config.toml`', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('~/.localcode/config.toml');
  });

  test('mentions the per-project settings path `<projectRoot>/.localcode/settings.json`', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('.localcode/settings.json');
  });

  test('explicitly states per-project takes priority over global', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/per-project|priority|over global/);
  });

  test('mentions the `edit_file` flow as the way to make changes', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('edit_file');
  });

  test('mentions reading the config first (read_file)', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('read_file');
  });

  test('mentions the diff-approval safety boundary', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/diff|approve|approval|reject/);
  });

  test('mentions never bypassing approval (even with --dangerously-allow-all)', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    // Agent 2 R8 deliberately reminds the model to always get approval
    // even with the dangerously-allow-all flag.
    expect(prompt.toLowerCase()).toMatch(/dangerously|never bypass/);
  });

  test('lists concrete take-effect cases for setting fields', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    // Specific fields the take-effect table covers.
    expect(prompt).toContain('context.maxTokens');
    expect(prompt).toContain('permissions.autoApprove');
  });

  test('mentions backend type/baseUrl rebuild trigger', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/backend\.type|backend\.baseurl|adapter rebuild/);
  });

  test('mentions sound config field', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('sound');
  });

  test('section is sandwiched after Tool approval and before Images', () => {
    // Section ordering check — Self-configuration sits AFTER Tool
    // approval and BEFORE Images.
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    const toolApprovalIdx = prompt.indexOf('## Tool approval');
    const selfCfgIdx = prompt.indexOf('## Self-configuration');
    const imagesIdx = prompt.indexOf('## Images');
    expect(toolApprovalIdx).toBeGreaterThan(-1);
    expect(selfCfgIdx).toBeGreaterThan(toolApprovalIdx);
    expect(imagesIdx).toBeGreaterThan(selfCfgIdx);
  });

  test('worked scenarios — "Use 80K context" example present', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    // The R8 spec adds concrete recipes the model can imitate.
    expect(prompt).toMatch(/80K|80000|context.maxTokens/);
  });

  test('worked scenarios — temperature example present', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toContain('temperature');
  });

  test('TOML caution / syntax hint is present', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toMatch(/TOML/);
  });

  test('JSON caution mentions snake_case', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('snake_case');
  });

  test('tilde expansion note is present', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.toLowerCase()).toMatch(/tilde|home|expand|~/);
  });
});

describe('ContextManager.buildSystemPrompt — backward-compat: legacy callers see new section', () => {
  test('positional (md, skills) form also includes Self-configuration', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt('# Project README', []);
    expect(prompt).toContain('## Self-configuration');
    expect(prompt).toContain('~/.localcode/config.toml');
  });

  test('null md form also includes Self-configuration', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt(null);
    expect(prompt).toContain('## Self-configuration');
  });
});
