/**
 * /record slash-command coverage.
 *
 * Uses an in-memory recorder + injected save/list functions so the
 * tests never touch real disk. Verifies:
 *   - /record start begins capture, idempotent,
 *   - /record stop saves to the default path,
 *   - /record save <file> writes to an explicit path without stopping,
 *   - /record list calls the listFn against the project dir,
 *   - bad subcommands print usage.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import path from 'node:path';
import { Recorder, type Recording } from '@/recordings';
import { createRecordCommand } from '@/commands/cmd-record';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

const projectRoot = '/tmp/lc-record-test';

interface Ctx {
  out: string[];
  ctx: CommandContext;
}

function buildCtx(sessionId: string | null = 'sess-1'): Ctx {
  const out: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  config.onboarding.completed = true;
  const ctx: CommandContext = {
    projectRoot,
    sessionId,
    config,
    print: (t: string) => out.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { out, ctx };
}

let savedTo: string[] = [];
let saved: Recording[] = [];

beforeEach(() => {
  savedTo = [];
  saved = [];
});

const fakeSave = async (rec: Recording, target: string): Promise<void> => {
  saved.push(rec);
  savedTo.push(target);
};

const fakeList = async (_dir: string): Promise<string[]> => [
  path.join(projectRoot, '.localcode', 'recordings', 'rec-a.lcrec'),
  path.join(projectRoot, '.localcode', 'recordings', 'rec-b.lcrec'),
];

describe('/record', () => {
  test('start begins capture and is idempotent on a second call', async () => {
    const recorder = new Recorder({ randomIdFn: () => 'abc' });
    const cmd = createRecordCommand({
      recorder,
      projectRoot,
      saveFn: fakeSave,
      listFn: fakeList,
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('start', ctx);
    expect(recorder.isRecording).toBe(true);
    expect(out.join('\n')).toContain('Recording started');

    out.length = 0;
    await cmd.execute('start', ctx);
    expect(out.join('\n')).toContain('Already recording');
  });

  test('stop saves to the default project path with entry count', async () => {
    const recorder = new Recorder({ randomIdFn: () => 'abc' });
    const cmd = createRecordCommand({
      recorder,
      projectRoot,
      saveFn: fakeSave,
      listFn: fakeList,
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('start', ctx);
    recorder.appendUser('hi');
    recorder.appendAssistant('there');

    await cmd.execute('stop', ctx);
    expect(recorder.isRecording).toBe(false);
    expect(saved.length).toBe(1);
    expect(savedTo[0]).toContain('rec-abc.lcrec');
    expect(out.join('\n')).toContain('2 entries');
  });

  test('stop when no active recording prints a friendly message', async () => {
    const recorder = new Recorder();
    const cmd = createRecordCommand({
      recorder,
      projectRoot,
      saveFn: fakeSave,
      listFn: fakeList,
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('stop', ctx);
    expect(out.join('\n')).toContain('No active recording');
    expect(saved.length).toBe(0);
  });

  test('save <file> writes to an explicit path without stopping', async () => {
    const recorder = new Recorder({ randomIdFn: () => 'abc' });
    const cmd = createRecordCommand({
      recorder,
      projectRoot,
      saveFn: fakeSave,
      listFn: fakeList,
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('start', ctx);
    recorder.appendUser('keep going');
    await cmd.execute('save demos/first.lcrec', ctx);
    expect(recorder.isRecording).toBe(true);
    expect(saved.length).toBe(1);
    expect(savedTo[0]).toBe(path.resolve(projectRoot, 'demos/first.lcrec'));
    expect(out.join('\n')).toContain('still active');
  });

  test('save with no active recording prints message', async () => {
    const recorder = new Recorder();
    const cmd = createRecordCommand({
      recorder,
      projectRoot,
      saveFn: fakeSave,
      listFn: fakeList,
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('save out.lcrec', ctx);
    expect(out.join('\n')).toContain('No active recording');
    expect(saved.length).toBe(0);
  });

  test('list calls the injected listFn and prints results', async () => {
    const recorder = new Recorder();
    const cmd = createRecordCommand({
      recorder,
      projectRoot,
      saveFn: fakeSave,
      listFn: fakeList,
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('list', ctx);
    const joined = out.join('\n');
    expect(joined).toContain('Recordings (2)');
    expect(joined).toContain('rec-a.lcrec');
    expect(joined).toContain('rec-b.lcrec');
  });

  test('unknown subcommand prints usage', async () => {
    const recorder = new Recorder();
    const cmd = createRecordCommand({
      recorder,
      projectRoot,
      saveFn: fakeSave,
      listFn: fakeList,
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('bogus', ctx);
    expect(out.join('\n')).toContain('Unknown subcommand');
  });
});
