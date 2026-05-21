import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseFrontmatter,
  parseSkillFile,
  splitFrontmatter,
} from '@/skills/skill-parser';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-skill-parser-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('splitFrontmatter', () => {
  test('splits a well-formed frontmatter block', () => {
    const raw = `---\nname: Test\ndescription: hi\n---\nBody here\n`;
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toContain('name: Test');
    expect(body.trim()).toBe('Body here');
  });

  test('treats file without frontmatter as body only', () => {
    const raw = '# Heading\nText';
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBeNull();
    expect(body).toBe(raw);
  });

  test('treats unterminated frontmatter as body only', () => {
    const raw = `---\nname: Test\nno closing fence\n`;
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBeNull();
    expect(body).toBe(raw);
  });
});

describe('parseFrontmatter', () => {
  test('parses key: value pairs', () => {
    const fields = parseFrontmatter('name: Hello\ndescription: World');
    expect(fields['name']).toBe('Hello');
    expect(fields['description']).toBe('World');
  });

  test('strips surrounding quotes', () => {
    const fields = parseFrontmatter(`name: "Hello"\ndescription: 'World'`);
    expect(fields['name']).toBe('Hello');
    expect(fields['description']).toBe('World');
  });

  test('skips comments and malformed lines', () => {
    const fields = parseFrontmatter('# comment\nname: ok\nbad-line-no-colon\n');
    expect(fields['name']).toBe('ok');
    expect(fields['bad-line-no-colon']).toBeUndefined();
  });
});

describe('parseSkillFile', () => {
  test('returns Skill with frontmatter-derived metadata and body content', async () => {
    const file = path.join(tmpDir, 'hello.md');
    await fsWriteFile(
      file,
      `---\nname: Hello\ndescription: A test skill\n---\nBody text`,
      'utf8',
    );
    const skill = await parseSkillFile(file);
    expect(skill.id).toBe('hello');
    expect(skill.name).toBe('Hello');
    expect(skill.description).toBe('A test skill');
    expect(skill.content.trim()).toBe('Body text');
    expect(skill.active).toBe(false);
    expect(skill.path).toBe(file);
  });

  test('falls back to filename stem when frontmatter absent', async () => {
    const file = path.join(tmpDir, 'naked.md');
    await fsWriteFile(file, '# Naked\nJust body\n', 'utf8');
    const skill = await parseSkillFile(file);
    expect(skill.id).toBe('naked');
    expect(skill.name).toBe('naked');
    expect(skill.description).toBe('');
    expect(skill.content).toContain('Just body');
  });
});
