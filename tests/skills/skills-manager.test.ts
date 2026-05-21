import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillsManager } from '@/skills/skills-manager';

let skillsDir = '';
let mgr: SkillsManager;

beforeEach(async () => {
  skillsDir = path.join(os.tmpdir(), `lc-skills-${crypto.randomUUID()}`, 'skills');
  await mkdir(skillsDir, { recursive: true });
  mgr = new SkillsManager(skillsDir);
});

afterEach(async () => {
  // Remove the parent directory so the sidecar JSON is also cleaned up.
  await rm(path.dirname(skillsDir), { recursive: true, force: true });
});

describe('SkillsManager.addFromText', () => {
  test('creates the skill file and returns Skill metadata', async () => {
    const skill = await mgr.addFromText(
      'hello.md',
      `---\nname: Hello\ndescription: greets\n---\nBody`,
    );
    expect(skill.id).toBe('hello');
    expect(skill.name).toBe('Hello');
    expect(skill.description).toBe('greets');
    expect(skill.content).toContain('Body');
    expect(skill.active).toBe(false);
  });

  test('appends .md when filename lacks the extension', async () => {
    const skill = await mgr.addFromText(
      'noext',
      `Just the body`,
    );
    expect(skill.id).toBe('noext');
    expect(skill.path.endsWith('.md')).toBe(true);
  });
});

describe('SkillsManager.list', () => {
  test('returns all skills, sorted by id', async () => {
    await mgr.addFromText('b.md', 'b body');
    await mgr.addFromText('a.md', 'a body');
    const list = await mgr.list();
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('SkillsManager.toggle and getActiveSkills', () => {
  test('toggle flips active and persists', async () => {
    await mgr.addFromText('x.md', 'x body');
    await mgr.toggle('x');
    const afterOn = await mgr.getActiveSkills();
    expect(afterOn).toHaveLength(1);

    await mgr.toggle('x');
    const afterOff = await mgr.getActiveSkills();
    expect(afterOff).toHaveLength(0);
  });

  test('active state survives manager reinstantiation', async () => {
    await mgr.addFromText('persist.md', 'body');
    await mgr.toggle('persist');

    const reopened = new SkillsManager(skillsDir);
    const active = await reopened.getActiveSkills();
    expect(active.map((s) => s.id)).toEqual(['persist']);
  });

  test('toggling unknown skill throws', async () => {
    await expect(mgr.toggle('nope')).rejects.toThrow();
  });
});

describe('SkillsManager.buildSkillsPrompt', () => {
  test('concatenates active skills content with the --- joiner', async () => {
    await mgr.addFromText(
      'one.md',
      `---\nname: One\ndescription: d\n---\nCONTENT-ONE`,
    );
    await mgr.addFromText(
      'two.md',
      `---\nname: Two\ndescription: d\n---\nCONTENT-TWO`,
    );
    await mgr.toggle('one');
    await mgr.toggle('two');

    const prompt = await mgr.buildSkillsPrompt();
    expect(prompt).toContain('CONTENT-ONE');
    expect(prompt).toContain('CONTENT-TWO');
    expect(prompt).toContain('---');
  });

  test('inactive skills are not included', async () => {
    await mgr.addFromText('a.md', `CONTENT-A`);
    await mgr.addFromText('b.md', `CONTENT-B`);
    await mgr.toggle('a');
    const prompt = await mgr.buildSkillsPrompt();
    expect(prompt).toContain('CONTENT-A');
    expect(prompt).not.toContain('CONTENT-B');
  });
});

describe('SkillsManager.delete', () => {
  test('removes the file and drops active state', async () => {
    await mgr.addFromText('doomed.md', 'bye');
    await mgr.toggle('doomed');
    await mgr.delete('doomed');
    const list = await mgr.list();
    expect(list.map((s) => s.id)).not.toContain('doomed');
  });

  test('throws when skill is missing', async () => {
    await expect(mgr.delete('ghost')).rejects.toThrow();
  });
});
