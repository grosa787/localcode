/**
 * Smoke tests for `SkillsManager.getActiveSkillsContent` (Agent E
 * sanity-check addition for ROADMAP "skills actually applied").
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillsManager } from '@/skills/skills-manager';

let dir = '';
let mgr: SkillsManager;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), `lc-skills-content-${crypto.randomUUID()}`, 'skills');
  await mkdir(dir, { recursive: true });
  mgr = new SkillsManager(dir);
});

afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

describe('SkillsManager.getActiveSkillsContent', () => {
  test('returns empty string when no skills are active', async () => {
    const out = await mgr.getActiveSkillsContent();
    expect(out).toBe('');
  });

  test('concatenates active skills with the canonical separator', async () => {
    await mgr.addFromText(
      'first.md',
      `---\nname: First\ndescription: first\n---\nFirst body content`,
    );
    await mgr.addFromText(
      'second.md',
      `---\nname: Second\ndescription: second\n---\nSecond body content`,
    );
    await mgr.toggle('first');
    await mgr.toggle('second');

    const out = await mgr.getActiveSkillsContent();
    expect(out).toContain('First body content');
    expect(out).toContain('Second body content');
    // The separator is `\n\n---\n\n`.
    expect(out).toContain('\n\n---\n\n');
  });

  test('skips inactive skills', async () => {
    await mgr.addFromText(
      'on.md',
      `---\nname: On\ndescription: x\n---\nactive content`,
    );
    await mgr.addFromText(
      'off.md',
      `---\nname: Off\ndescription: y\n---\ninactive content`,
    );
    await mgr.toggle('on');

    const out = await mgr.getActiveSkillsContent();
    expect(out).toContain('active content');
    expect(out).not.toContain('inactive content');
  });

  test('matches buildSkillsPrompt output exactly', async () => {
    await mgr.addFromText(
      'a.md',
      `---\nname: A\ndescription: a\n---\nA body`,
    );
    await mgr.toggle('a');
    const a = await mgr.buildSkillsPrompt();
    const b = await mgr.getActiveSkillsContent();
    expect(a).toBe(b);
  });
});
