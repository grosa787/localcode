/**
 * R2 additions to SkillsManager:
 *   - Two-source loader (project-local + global) with project-local priority.
 *   - `source: 'project'|'global'` tag on every returned Skill.
 *   - `addFromText(filename, content, { scope })` writes to the right dir.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillsManager } from '@/skills/skills-manager';

let scratchRoot = '';
let projectRoot = '';
let globalDir = '';

beforeEach(async () => {
  scratchRoot = path.join(os.tmpdir(), `lc-skills-r2-${crypto.randomUUID()}`);
  projectRoot = path.join(scratchRoot, 'proj');
  globalDir = path.join(scratchRoot, 'global-home', 'skills');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(globalDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

function skillMarkdown(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: d\n---\n${body}`;
}

describe('SkillsManager — two-source loader + source tag', () => {
  test('only global present: list reports source=global', async () => {
    // Seed a skill in the global dir.
    await fsWriteFile(
      path.join(globalDir, 'g-only.md'),
      skillMarkdown('G-Only', 'body-g'),
      'utf8',
    );

    const mgr = new SkillsManager({ projectRoot, globalDir });
    const list = await mgr.list();
    expect(list.map((s) => s.id)).toContain('g-only');
    const skill = list.find((s) => s.id === 'g-only');
    expect(skill?.source).toBe('global');
  });

  test('same id in both dirs: project-local wins and source=project', async () => {
    // Seed SAME id in both directories with different bodies.
    await fsWriteFile(
      path.join(globalDir, 'dual.md'),
      skillMarkdown('Dual', 'FROM-GLOBAL'),
      'utf8',
    );
    const projectSkillsDir = path.join(projectRoot, '.localcode', 'skills');
    await mkdir(projectSkillsDir, { recursive: true });
    await fsWriteFile(
      path.join(projectSkillsDir, 'dual.md'),
      skillMarkdown('Dual', 'FROM-PROJECT'),
      'utf8',
    );

    const mgr = new SkillsManager({ projectRoot, globalDir });
    const list = await mgr.list();
    const dual = list.find((s) => s.id === 'dual');
    expect(dual?.source).toBe('project');
    expect(dual?.content).toContain('FROM-PROJECT');
    expect(dual?.content).not.toContain('FROM-GLOBAL');
  });

  test('skills unique to each dir all surface', async () => {
    const projectSkillsDir = path.join(projectRoot, '.localcode', 'skills');
    await mkdir(projectSkillsDir, { recursive: true });
    await fsWriteFile(
      path.join(projectSkillsDir, 'only-p.md'),
      skillMarkdown('Only-P', 'X'),
      'utf8',
    );
    await fsWriteFile(
      path.join(globalDir, 'only-g.md'),
      skillMarkdown('Only-G', 'Y'),
      'utf8',
    );

    const mgr = new SkillsManager({ projectRoot, globalDir });
    const list = await mgr.list();
    const ids = list.map((s) => s.id);
    expect(ids).toContain('only-p');
    expect(ids).toContain('only-g');
    expect(list.find((s) => s.id === 'only-p')?.source).toBe('project');
    expect(list.find((s) => s.id === 'only-g')?.source).toBe('global');
  });
});

describe('SkillsManager.addFromText — scope routing', () => {
  test('default scope writes to project-local when projectRoot is configured', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    const skill = await mgr.addFromText('x.md', 'body-x');
    expect(skill.source).toBe('project');
    expect(skill.path.startsWith(path.join(projectRoot, '.localcode', 'skills'))).toBe(true);

    // File exists at the project location.
    const projectFile = path.join(projectRoot, '.localcode', 'skills', 'x.md');
    expect(existsSync(projectFile)).toBe(true);
    // And NOT at the global location.
    expect(existsSync(path.join(globalDir, 'x.md'))).toBe(false);

    // Round-trip on disk.
    const onDisk = await fsReadFile(projectFile, 'utf8');
    expect(onDisk).toContain('body-x');
  });

  test('explicit scope="global" writes to global dir', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    const skill = await mgr.addFromText('g.md', 'body-g', { scope: 'global' });
    expect(skill.source).toBe('global');
    expect(existsSync(path.join(globalDir, 'g.md'))).toBe(true);
    expect(existsSync(path.join(projectRoot, '.localcode', 'skills', 'g.md'))).toBe(
      false,
    );
  });

  test('explicit scope="project" writes to project dir', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    const skill = await mgr.addFromText('p.md', 'body-p', { scope: 'project' });
    expect(skill.source).toBe('project');
    const projFile = path.join(projectRoot, '.localcode', 'skills', 'p.md');
    expect(existsSync(projFile)).toBe(true);
  });

  test('addFromText also accepts a name without .md extension', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    const skill = await mgr.addFromText('no-ext', 'body');
    expect(skill.id).toBe('no-ext');
    expect(skill.path.endsWith('.md')).toBe(true);
  });

  test('global-only mode (no projectRoot): default scope is global', async () => {
    const mgr = new SkillsManager({ globalDir });
    const skill = await mgr.addFromText('only.md', 'body');
    expect(skill.source).toBe('global');
    expect(existsSync(path.join(globalDir, 'only.md'))).toBe(true);
  });

  test('refuses to overwrite an existing skill file', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await mgr.addFromText('dup.md', 'one');
    await expect(mgr.addFromText('dup.md', 'two')).rejects.toThrow();
  });

  test('asking for project scope without projectRoot throws', async () => {
    const mgr = new SkillsManager({ globalDir });
    await expect(
      mgr.addFromText('x.md', 'body', { scope: 'project' }),
    ).rejects.toThrow();
  });
});

describe('SkillsManager — directory accessors', () => {
  test('projectDirectory + globalDirectory expose both paths', () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    const projDir = mgr.projectDirectory;
    expect(projDir).toBe(path.join(projectRoot, '.localcode', 'skills'));
    expect(mgr.globalDirectory).toBe(globalDir);
    // `directory` prefers project when set.
    expect(projDir).not.toBeNull();
    if (projDir !== null) {
      expect(mgr.directory).toBe(projDir);
    }
  });

  test('no projectRoot => projectDirectory is null and directory == globalDirectory', () => {
    const mgr = new SkillsManager({ globalDir });
    expect(mgr.projectDirectory).toBeNull();
    expect(mgr.directory).toBe(mgr.globalDirectory);
  });
});
