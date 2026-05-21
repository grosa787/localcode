/**
 * /replay slash-command coverage.
 *
 * Uses an injected loadFn so the tests never hit disk. Verifies:
 *   - argument parsing (file, --speed, --instant),
 *   - dispatch order matches the recording order,
 *   - bad flags surface usage,
 *   - load errors surface the underlying message.
 */

import { describe, test, expect } from 'bun:test';
import {
  Player,
  type Recording,
  type RecordingEntry,
  type ReplayDispatch,
} from '@/recordings';
import { createReplayCommand, parseReplayArgs } from '@/commands/cmd-replay';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

const projectRoot = '/tmp/lc-replay-test';

function buildCtx(): { ctx: CommandContext; out: string[] } {
  const out: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
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

function fakeRecording(): Recording {
  return {
    id: 'rec-fake',
    sessionId: 'sess-a',
    startedAt: 1,
    endedAt: 2,
    entries: [
      { kind: 'user', content: 'hi', ts: 1 },
      { kind: 'assistant', content: 'hello', ts: 2 },
    ],
  };
}

function instantPlayer(): Player {
  return new Player({
    setTimeoutFn: (cb: () => void): unknown => {
      queueMicrotask(cb);
      return null;
    },
  });
}

describe('parseReplayArgs', () => {
  test('extracts the file path', () => {
    const r = parseReplayArgs('./demo.lcrec');
    expect(r.filePath).toBe('./demo.lcrec');
    expect(r.error).toBeNull();
  });

  test('--speed accepts a bare number', () => {
    const r = parseReplayArgs('./demo.lcrec --speed 2');
    expect(r.options.speed).toBe(2);
  });

  test('--speed accepts an "x" suffix', () => {
    const r = parseReplayArgs('./demo.lcrec --speed 2x');
    expect(r.options.speed).toBe(2);
  });

  test('--speed accepts fractional values', () => {
    const r = parseReplayArgs('./demo.lcrec --speed 0.5');
    expect(r.options.speed).toBe(0.5);
  });

  test('--instant sets skipDelays', () => {
    const r = parseReplayArgs('./demo.lcrec --instant');
    expect(r.options.skipDelays).toBe(true);
  });

  test('--speed without value errors', () => {
    const r = parseReplayArgs('./demo.lcrec --speed');
    expect(r.error).not.toBeNull();
  });

  test('non-numeric --speed errors', () => {
    const r = parseReplayArgs('./demo.lcrec --speed foo');
    expect(r.error).not.toBeNull();
  });

  test('unknown flag errors', () => {
    const r = parseReplayArgs('./demo.lcrec --bogus');
    expect(r.error).not.toBeNull();
  });
});

describe('/replay execute', () => {
  test('dispatches entries in order', async () => {
    const seen: RecordingEntry[] = [];
    const dispatch: ReplayDispatch = (e) => {
      seen.push(e);
    };
    const cmd = createReplayCommand({
      player: instantPlayer(),
      projectRoot,
      dispatch,
      loadFn: async () => fakeRecording(),
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('./demo.lcrec --instant', ctx);
    expect(seen.map((e) => e.kind)).toEqual(['user', 'assistant']);
    expect(out.join('\n')).toContain('Replay complete');
  });

  test('missing file path prints usage', async () => {
    const cmd = createReplayCommand({
      player: instantPlayer(),
      projectRoot,
      dispatch: () => {},
      loadFn: async () => fakeRecording(),
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('', ctx);
    expect(out.join('\n')).toContain('Usage');
  });

  test('load error surfaces underlying message', async () => {
    const cmd = createReplayCommand({
      player: instantPlayer(),
      projectRoot,
      dispatch: () => {},
      loadFn: async (): Promise<Recording> => {
        throw new Error('file not found');
      },
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('./missing.lcrec', ctx);
    expect(out.join('\n')).toContain('Failed to load recording');
    expect(out.join('\n')).toContain('file not found');
  });

  test('bad flag prints usage and returns', async () => {
    const cmd = createReplayCommand({
      player: instantPlayer(),
      projectRoot,
      dispatch: () => {},
      loadFn: async () => fakeRecording(),
    });
    const { ctx, out } = buildCtx();
    await cmd.execute('./demo.lcrec --bogus', ctx);
    expect(out.join('\n')).toContain('Unknown flag');
  });
});
