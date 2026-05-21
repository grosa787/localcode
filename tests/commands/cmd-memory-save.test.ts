/**
 * /memory-save command tests.
 *
 * Covers:
 *   - Happy path: staged proposal → consume → write through MemoryStore.
 *   - Unknown id: prints helpful message, no write.
 *   - Missing args.
 *   - `latest` resolver wiring.
 *   - Re-stages on write failure so user can retry.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemorySaveCommand } from '@/commands/cmd-memory-save';
import {
  AutoFeedbackDetector,
  FeedbackStagingArea,
  type FeedbackProposal,
} from '@/memory/auto-feedback';
import { MemoryStore } from '@/memory/store';
import type { MemoryEntry } from '@/memory/types';
import type { AppConfig, CommandContext } from '@/types/global';
import { getDefaultConfig } from '@/config/defaults';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-memsave-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function buildCtx(projectRoot: string): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  config.model.current = 'm';
  config.model.available = ['m'];
  config.onboarding.completed = true;
  const ctx: CommandContext = {
    projectRoot,
    sessionId: null,
    config,
    print: (text: string) => output.push(text),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, output };
}

function makeProposal(): FeedbackProposal {
  const det = new AutoFeedbackDetector();
  const result = det.observe('From now on, always use 2-space indentation', 'context');
  if (result.suggestedProposal === undefined) {
    throw new Error('expected detector to produce a proposal');
  }
  return result.suggestedProposal;
}

describe('/memory-save — happy path', () => {
  test('consumes a staged proposal and writes the entry to disk', async () => {
    const staging = new FeedbackStagingArea();
    const proposal = makeProposal();
    staging.stage(proposal);

    const cmd = createMemorySaveCommand({ projectRoot: tempDir, staging });
    const { ctx, output } = buildCtx(tempDir);
    await cmd.execute(proposal.id, ctx);

    expect(output.join('\n')).toContain('Saved feedback memory');
    expect(staging.size()).toBe(0);

    // The file should exist under .localcode/memory/.
    const expectedPath = join(
      tempDir,
      '.localcode',
      'memory',
      `${proposal.suggestedEntry.name}.md`,
    );
    expect(existsSync(expectedPath)).toBe(true);
    const content = readFileSync(expectedPath, 'utf8');
    expect(content).toContain('type: feedback');
    expect(content).toContain('From now on, always use 2-space indentation');
  });

  test('rebuilds the index after writing', async () => {
    const staging = new FeedbackStagingArea();
    const proposal = makeProposal();
    staging.stage(proposal);

    const cmd = createMemorySaveCommand({ projectRoot: tempDir, staging });
    const { ctx } = buildCtx(tempDir);
    await cmd.execute(proposal.id, ctx);

    // MemoryStore.write rebuilds MEMORY.md, verify via list().
    const store = new MemoryStore(tempDir);
    const entries = await store.list();
    expect(entries.length).toBe(1);
    expect(entries[0]?.name).toBe(proposal.suggestedEntry.name);
  });
});

describe('/memory-save — error paths', () => {
  test('prints help when no id is given', async () => {
    const staging = new FeedbackStagingArea();
    const cmd = createMemorySaveCommand({ projectRoot: tempDir, staging });
    const { ctx, output } = buildCtx(tempDir);
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('Missing id');
  });

  test('prints "no staged proposal" when id is unknown', async () => {
    const staging = new FeedbackStagingArea();
    const cmd = createMemorySaveCommand({ projectRoot: tempDir, staging });
    const { ctx, output } = buildCtx(tempDir);
    await cmd.execute('nonexistent-id', ctx);
    expect(output.join('\n')).toContain('No staged feedback proposal');
  });

  test('re-stages on write failure so user can retry', async () => {
    const staging = new FeedbackStagingArea();
    const proposal = makeProposal();
    staging.stage(proposal);

    // Force the store factory to throw on write.
    const cmd = createMemorySaveCommand({
      projectRoot: tempDir,
      staging,
      storeFactory: () => ({
        write: async (_entry: MemoryEntry) => {
          throw new Error('disk full');
        },
      }),
    });
    const { ctx, output } = buildCtx(tempDir);
    await cmd.execute(proposal.id, ctx);

    expect(output.join('\n')).toContain('Failed to save feedback memory');
    // The proposal should be re-staged so the user can retry.
    expect(staging.size()).toBe(1);
  });
});

describe('/memory-save — `latest` resolver', () => {
  test('resolves `latest` via the resolveLatest hook', async () => {
    const staging = new FeedbackStagingArea();
    const proposal = makeProposal();
    staging.stage(proposal);

    const cmd = createMemorySaveCommand({
      projectRoot: tempDir,
      staging,
      resolveLatest: () => proposal.id,
    });
    const { ctx, output } = buildCtx(tempDir);
    await cmd.execute('latest', ctx);
    expect(output.join('\n')).toContain('Saved feedback memory');
  });

  test('reports no staged proposals when latest resolver returns null', async () => {
    const staging = new FeedbackStagingArea();
    const cmd = createMemorySaveCommand({
      projectRoot: tempDir,
      staging,
      resolveLatest: () => null,
    });
    const { ctx, output } = buildCtx(tempDir);
    await cmd.execute('latest', ctx);
    expect(output.join('\n')).toContain('No staged proposals');
  });

  test('falls back gracefully when resolveLatest hook is not provided', async () => {
    const staging = new FeedbackStagingArea();
    const cmd = createMemorySaveCommand({ projectRoot: tempDir, staging });
    const { ctx, output } = buildCtx(tempDir);
    await cmd.execute('latest', ctx);
    expect(output.join('\n')).toContain('No staged proposals');
  });
});

describe('/memory-save — command shape', () => {
  test('exposes name + description + usage', () => {
    const staging = new FeedbackStagingArea();
    const cmd = createMemorySaveCommand({ projectRoot: tempDir, staging });
    expect(cmd.name).toBe('memory-save');
    expect(cmd.description.length).toBeGreaterThan(0);
    expect(cmd.usage).toBeDefined();
  });
});
