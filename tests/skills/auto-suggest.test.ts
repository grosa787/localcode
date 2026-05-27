/**
 * Tests for `suggestSkillsForInput` — the auto-skill suggestion
 * heuristic surfaced as a toast above the chat composer.
 *
 * We exercise:
 *   - simple regex matches surface as suggestions,
 *   - multiple matching skills all surface (ordered by specificity),
 *   - already-active skills are skipped (the toast is for opt-in),
 *   - bad regex patterns in a skill's frontmatter degrade quietly
 *     (suggester never throws),
 *   - results are capped at MAX_SUGGESTIONS (3),
 *   - empty triggers + missing-file inputs return [].
 *
 * The compile cache is cleared between every test so a stale entry
 * from an earlier case cannot shadow a freshly-authored skill file.
 */
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Skill } from '@/types/global';
import {
  MAX_SUGGESTIONS,
  clearCompileCacheForTests,
  extractTriggersFromMarkdown,
  suggestSkillsForInput,
} from '@/skills/auto-suggest';

// ---------- helpers ----------

let tmpDir = '';

function makeSkillFile(opts: {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly triggers?: readonly string[];
  readonly body?: string;
}): Skill {
  const name = opts.name ?? opts.id;
  const description = opts.description ?? '';
  const fmLines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
  ];
  if (opts.triggers !== undefined) {
    fmLines.push(`triggers: ${JSON.stringify(opts.triggers)}`);
  }
  fmLines.push('---');
  const content = `${fmLines.join('\n')}\n\n${opts.body ?? `# ${name}\n\nBody.`}\n`;
  const filePath = path.join(tmpDir, `${opts.id}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    id: opts.id,
    name,
    description,
    content,
    active: false,
    path: filePath,
  };
}

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `lc-auto-suggest-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  clearCompileCacheForTests();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  clearCompileCacheForTests();
});

// ---------- tests ----------

describe('suggestSkillsForInput', () => {
  test('surfaces a single match for a simple regex trigger', () => {
    const skill = makeSkillFile({
      id: 'react',
      name: 'React Specialist',
      triggers: ['\\breact\\b'],
    });
    const out = suggestSkillsForInput(
      'I have a React hook bug',
      [skill],
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.skillId).toBe('react');
    expect(out[0]?.skillName).toBe('React Specialist');
    expect(out[0]?.reason.toLowerCase()).toContain('react');
  });

  test('surfaces multiple matching skills sorted by match specificity', () => {
    const a = makeSkillFile({
      id: 'sql',
      name: 'SQL',
      triggers: ['\\bsql\\b'],
    });
    const b = makeSkillFile({
      id: 'postgres',
      name: 'Postgres',
      triggers: ['\\bpostgres(ql)?\\b'],
    });
    const out = suggestSkillsForInput(
      'Help me tune this Postgres SQL query',
      [a, b],
      new Set(),
    );
    expect(out).toHaveLength(2);
    // Postgres has a longer match ("Postgres" = 8 chars) than the
    // bare "SQL" (3 chars), so it should sort first.
    expect(out[0]?.skillId).toBe('postgres');
    expect(out[1]?.skillId).toBe('sql');
  });

  test('skips skills already in the active set', () => {
    const react = makeSkillFile({
      id: 'react',
      triggers: ['\\breact\\b'],
    });
    const vue = makeSkillFile({
      id: 'vue',
      triggers: ['\\bvue\\b'],
    });
    const out = suggestSkillsForInput(
      'react and vue components',
      [react, vue],
      new Set(['react']),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.skillId).toBe('vue');
  });

  test('bad regex pattern in frontmatter is skipped, does not crash', () => {
    const broken = makeSkillFile({
      id: 'broken',
      triggers: ['['], // intentionally malformed
    });
    const good = makeSkillFile({
      id: 'good',
      triggers: ['\\bworking\\b'],
    });
    // Should not throw.
    const out = suggestSkillsForInput(
      'this is working code',
      [broken, good],
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.skillId).toBe('good');
  });

  test('caps results at MAX_SUGGESTIONS', () => {
    const skills: Skill[] = [];
    for (let i = 0; i < MAX_SUGGESTIONS + 2; i += 1) {
      skills.push(
        makeSkillFile({
          id: `s${i}`,
          name: `Skill${i}`,
          // Each matches the same word but with progressively shorter
          // trigger so the cap kicks in deterministically.
          triggers: [`(?:keyword)`],
        }),
      );
    }
    const out = suggestSkillsForInput('keyword keyword', skills, new Set());
    expect(out.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    expect(out).toHaveLength(MAX_SUGGESTIONS);
  });

  test('empty trigger list yields no suggestions', () => {
    const skill = makeSkillFile({
      id: 'no-triggers',
      // Triggers field absent entirely.
    });
    const out = suggestSkillsForInput(
      'anything goes here',
      [skill],
      new Set(),
    );
    expect(out).toHaveLength(0);
  });

  test('empty / whitespace input returns []', () => {
    const skill = makeSkillFile({
      id: 'react',
      triggers: ['\\breact\\b'],
    });
    expect(suggestSkillsForInput('', [skill], new Set())).toEqual([]);
    expect(suggestSkillsForInput('   \n\t', [skill], new Set())).toEqual([]);
  });

  test('no skills array returns []', () => {
    expect(
      suggestSkillsForInput('react hooks bug', [], new Set()),
    ).toEqual([]);
  });
});

describe('extractTriggersFromMarkdown', () => {
  test('parses inline JSON array', () => {
    const raw = `---\nname: X\ntriggers: ["\\\\breact\\\\b", "vue"]\n---\nbody`;
    const out = extractTriggersFromMarkdown(raw);
    expect(out).toBeDefined();
    expect(out).toEqual(['\\breact\\b', 'vue']);
  });

  test('returns undefined when no frontmatter', () => {
    expect(extractTriggersFromMarkdown('just markdown body')).toBeUndefined();
  });

  test('returns undefined when triggers key absent', () => {
    const raw = `---\nname: X\ndescription: y\n---\nbody`;
    expect(extractTriggersFromMarkdown(raw)).toBeUndefined();
  });
});
