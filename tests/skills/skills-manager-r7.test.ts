/**
 * R7 — `SkillsManager.getSkillsForTurn(userMessage)` resolves the
 * skills to attach for a single turn based on `@mention` parsing.
 *
 * Behaviour locked down here:
 *   - 0 mentions → falls back to `getActiveSkills()`.
 *   - 1+ mentions → ONLY the mentioned skills are returned (mentions
 *     override the global active set, even on skills toggled off).
 *   - Unknown mentions land in `unknownMentions`.
 *   - The leading `(?:^|\s)@` anchor prevents email-like false matches
 *     (`user@example.com`).
 *   - Matching is case-insensitive against the skill `id`.
 *   - Mentions can sit at the start of the message or after a newline.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillsManager } from '@/skills/skills-manager';

let scratchRoot = '';
let projectRoot = '';
let globalDir = '';

beforeEach(async () => {
  scratchRoot = path.join(os.tmpdir(), `lc-skills-r7-${crypto.randomUUID()}`);
  projectRoot = path.join(scratchRoot, 'proj');
  globalDir = path.join(scratchRoot, 'global-home', 'skills');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(globalDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

async function seed(mgr: SkillsManager, name: string): Promise<void> {
  await mgr.addFromText(`${name}.md`, `---\nname: ${name}\ndescription: d\n---\nbody-${name}`);
}

describe('SkillsManager.getSkillsForTurn (R7)', () => {
  test('no mentions → returns the currently-active skills (fallback path)', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');
    await seed(mgr, 'backend');
    await mgr.toggle('frontend');

    const result = await mgr.getSkillsForTurn('hello there, just a plain prompt');
    expect(result.mentioned).toEqual([]);
    expect(result.unknownMentions).toEqual([]);
    expect(result.skills.map((s) => s.id)).toEqual(['frontend']);
  });

  test('single mention → only that skill is returned (overrides active set)', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');
    await seed(mgr, 'backend');
    // Activate `backend` so we can prove the mention overrides it.
    await mgr.toggle('backend');

    const result = await mgr.getSkillsForTurn('@frontend please review');
    expect(result.mentioned).toEqual(['frontend']);
    expect(result.unknownMentions).toEqual([]);
    expect(result.skills.map((s) => s.id)).toEqual(['frontend']);
  });

  test('two mentions → both skills returned in mention order', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');
    await seed(mgr, 'backend');

    const result = await mgr.getSkillsForTurn('@backend then @frontend');
    expect(result.mentioned).toEqual(['backend', 'frontend']);
    expect(result.unknownMentions).toEqual([]);
    expect(result.skills.map((s) => s.id)).toEqual(['backend', 'frontend']);
  });

  test('unknown mention → empty skills + name surfaces in unknownMentions', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');

    const result = await mgr.getSkillsForTurn('hello @nope');
    expect(result.skills).toEqual([]);
    expect(result.mentioned).toEqual(['nope']);
    expect(result.unknownMentions).toEqual(['nope']);
  });

  test('mixed known + unknown → only known skill returned, unknown listed separately', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');

    const result = await mgr.getSkillsForTurn('@frontend and @ghost please help');
    expect(result.skills.map((s) => s.id)).toEqual(['frontend']);
    expect(result.mentioned).toEqual(['frontend', 'ghost']);
    expect(result.unknownMentions).toEqual(['ghost']);
  });

  test('email pattern (user@example.com) does NOT match — anchor needs space/start before @', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'example');

    const result = await mgr.getSkillsForTurn('mailto user@example.com please');
    // The `@` is preceded by `r` (letter), so the anchor rejects it.
    // No mentions parsed → falls back to active set (which is empty).
    expect(result.mentioned).toEqual([]);
    expect(result.unknownMentions).toEqual([]);
    expect(result.skills).toEqual([]);
  });

  test('case-insensitive — @Frontend resolves to the `frontend` skill', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');

    const result = await mgr.getSkillsForTurn('@Frontend please');
    expect(result.mentioned).toEqual(['frontend']);
    expect(result.skills.map((s) => s.id)).toEqual(['frontend']);
    expect(result.unknownMentions).toEqual([]);
  });

  test('mention at the very start of the message anchors correctly', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');

    const result = await mgr.getSkillsForTurn('@frontend kick off the audit');
    expect(result.mentioned).toEqual(['frontend']);
    expect(result.skills.map((s) => s.id)).toEqual(['frontend']);
  });

  test('mention after newline anchors correctly (whitespace anchor)', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');

    const result = await mgr.getSkillsForTurn('first line\n@frontend on the next');
    expect(result.mentioned).toEqual(['frontend']);
    expect(result.skills.map((s) => s.id)).toEqual(['frontend']);
  });

  test('repeated mentions are deduplicated in `mentioned`', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');

    const result = await mgr.getSkillsForTurn('@frontend, @frontend, again @Frontend');
    expect(result.mentioned).toEqual(['frontend']);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.id).toBe('frontend');
  });

  test('mentions resolve skills even when toggled OFF in the manager', async () => {
    const mgr = new SkillsManager({ projectRoot, globalDir });
    await seed(mgr, 'frontend');
    // Deliberately do NOT toggle — the skill is inactive in the manager.

    const result = await mgr.getSkillsForTurn('@frontend please');
    expect(result.skills.map((s) => s.id)).toEqual(['frontend']);
  });
});
