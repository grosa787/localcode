/**
 * /cron slash-command coverage.
 *
 * Uses an isolated temp-dir store path so the tests never touch the
 * real ~/.localcode/crons.json. Verifies:
 *   - /cron list on an empty store,
 *   - /cron add validates the spec + persists,
 *   - /cron remove drops the entry,
 *   - /cron enable / disable flips the flag,
 *   - parseCronAddArgs splits the 5-field spec from the prompt body.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCronCommand, parseCronAddArgs } from '@/commands/cmd-cron';
import { loadCronStore } from '@/scheduling';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

let tmpDir = '';
let storePath = '';
const projectRoot = '/tmp/lc-cron-test';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-cron-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  storePath = path.join(tmpDir, 'crons.json');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function buildCtx(): { ctx: CommandContext; out: string[] } {
  const out: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  config.model.current = 'm1';
  config.onboarding.completed = true;
  const ctx: CommandContext = {
    projectRoot,
    sessionId: 'sess-1',
    config,
    print: (t: string): void => {
      out.push(t);
    },
    setScreen: (): void => {
      /* no-op */
    },
  };
  return { ctx, out };
}

describe('parseCronAddArgs', () => {
  test('splits 5-field spec from the prompt body', () => {
    const r = parseCronAddArgs('0 9 * * * run the daily summary');
    expect(r).toEqual({ spec: '0 9 * * *', prompt: 'run the daily summary' });
  });

  test('preserves whitespace in the prompt body', () => {
    const r = parseCronAddArgs('* * * * * hello    world');
    if ('error' in r) throw new Error('unexpected error: ' + r.error);
    expect(r.prompt).toBe('hello    world');
  });

  test('errors when prompt missing', () => {
    const r = parseCronAddArgs('* * * * *');
    expect('error' in r).toBe(true);
  });

  test('errors when fewer than 5 fields', () => {
    const r = parseCronAddArgs('* * * * hello');
    if ('error' in r) {
      // happens when the 5th field is "hello" (invalid) — but parseCronAddArgs
      // doesn't validate field values, only count. The 5-field gate
      // passes here so check elsewhere…
      // For fewer-than-5 case, supply explicit short input.
    }
    const r2 = parseCronAddArgs('* * *');
    expect('error' in r2).toBe(true);
  });
});

describe('/cron list', () => {
  test('reports an empty store', async () => {
    const cmd = createCronCommand({ filePath: storePath });
    const { ctx, out } = buildCtx();
    await cmd.execute('list', ctx);
    expect(out.join('\n')).toContain('No cron entries');
  });
});

describe('/cron add', () => {
  test('persists a new entry to disk', async () => {
    const cmd = createCronCommand({ filePath: storePath });
    const { ctx, out } = buildCtx();
    await cmd.execute('add 0 9 * * * morning summary', ctx);
    expect(out.join('\n')).toContain('Added cron');

    const file = await loadCronStore(storePath);
    expect(file.crons).toHaveLength(1);
    const first = file.crons[0];
    expect(first).toBeDefined();
    expect(first?.cronSpec).toBe('0 9 * * *');
    expect(first?.prompt).toBe('morning summary');
    expect(first?.enabled).toBe(true);
    expect(first?.model).toBe('m1');
    expect(first?.projectRoot).toBe(projectRoot);
  });

  test('rejects an invalid cron spec', async () => {
    const cmd = createCronCommand({ filePath: storePath });
    const { ctx, out } = buildCtx();
    await cmd.execute('add 99 99 * * * bad', ctx);
    expect(out.join('\n')).toContain('Invalid cron spec');
    const file = await loadCronStore(storePath);
    expect(file.crons).toHaveLength(0);
  });

  test('invokes onChange after a successful add', async () => {
    let changes = 0;
    const cmd = createCronCommand({
      filePath: storePath,
      onChange: () => {
        changes += 1;
      },
    });
    const { ctx } = buildCtx();
    await cmd.execute('add * * * * * x', ctx);
    expect(changes).toBe(1);
  });
});

describe('/cron remove + enable/disable', () => {
  test('remove drops the entry by id', async () => {
    const cmd = createCronCommand({ filePath: storePath });
    const { ctx, out } = buildCtx();
    await cmd.execute('add * * * * * test', ctx);
    const file = await loadCronStore(storePath);
    const first = file.crons[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    out.length = 0;
    await cmd.execute(`remove ${first.id}`, ctx);
    expect(out.join('\n')).toContain('Removed cron');
    const after = await loadCronStore(storePath);
    expect(after.crons).toHaveLength(0);
  });

  test('remove accepts an id prefix', async () => {
    const cmd = createCronCommand({ filePath: storePath });
    const { ctx } = buildCtx();
    await cmd.execute('add * * * * * test', ctx);
    const file = await loadCronStore(storePath);
    const first = file.crons[0];
    if (first === undefined) throw new Error('no entry');
    const prefix = first.id.slice(0, 8);
    await cmd.execute(`remove ${prefix}`, ctx);
    const after = await loadCronStore(storePath);
    expect(after.crons).toHaveLength(0);
  });

  test('disable flips the enabled flag false', async () => {
    const cmd = createCronCommand({ filePath: storePath });
    const { ctx } = buildCtx();
    await cmd.execute('add * * * * * test', ctx);
    const file = await loadCronStore(storePath);
    const first = file.crons[0];
    if (first === undefined) throw new Error('no entry');
    await cmd.execute(`disable ${first.id}`, ctx);
    const after = await loadCronStore(storePath);
    const afterFirst = after.crons[0];
    expect(afterFirst?.enabled).toBe(false);
  });

  test('enable flips the enabled flag true', async () => {
    const cmd = createCronCommand({ filePath: storePath });
    const { ctx } = buildCtx();
    await cmd.execute('add * * * * * test', ctx);
    const file = await loadCronStore(storePath);
    const first = file.crons[0];
    if (first === undefined) throw new Error('no entry');
    await cmd.execute(`disable ${first.id}`, ctx);
    await cmd.execute(`enable ${first.id}`, ctx);
    const after = await loadCronStore(storePath);
    expect(after.crons[0]?.enabled).toBe(true);
  });

  test('remove with unknown id prints error', async () => {
    const cmd = createCronCommand({ filePath: storePath });
    const { ctx, out } = buildCtx();
    await cmd.execute('remove cron-missing', ctx);
    expect(out.join('\n')).toContain('No cron matches');
  });
});
