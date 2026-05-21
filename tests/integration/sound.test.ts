/**
 * R3 — `SoundPlayer` helper.
 *
 * Tests focus on:
 *   - `enabled: false` swallows everything (no spawn, no bell).
 *   - Per-event toggles work independently (`onApproval: false` blocks
 *     approval cues but lets completion cues through).
 *   - When no file is configured (or platform fallback path), the
 *     helper writes the terminal bell `\x07` to stdout.
 *   - Broken `getConfig` thunks degrade to a bell rather than throwing.
 *
 * We do NOT exercise actual audio playback — we observe stdout for
 * the terminal-bell fallback and trust the spawn calls are wired
 * correctly via the platform branch.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SoundPlayer } from '@/integration/sound';
import type { SoundConfig } from '@/types/global';

function defaultSound(overrides?: Partial<SoundConfig>): SoundConfig {
  return {
    enabled: false,
    onCompletion: true,
    onApproval: true,
    onError: true,
    volume: 0.5,
    completionFile: null,
    approvalFile: null,
    errorFile: null,
    ...overrides,
  };
}

// Capture process.stdout.write to detect the bell.
let originalWrite: typeof process.stdout.write;
let writes: string[];

beforeEach(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  writes = [];
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

function bellCount(): number {
  let n = 0;
  for (const w of writes) {
    for (const ch of w) if (ch === '\x07') n += 1;
  }
  return n;
}

describe('SoundPlayer — enabled: false swallows every event', () => {
  test('completion event is silent', () => {
    const player = new SoundPlayer(() => defaultSound({ enabled: false }));
    player.play('completion');
    expect(bellCount()).toBe(0);
  });

  test('approval event is silent', () => {
    const player = new SoundPlayer(() => defaultSound({ enabled: false }));
    player.play('approval');
    expect(bellCount()).toBe(0);
  });

  test('error event is silent', () => {
    const player = new SoundPlayer(() => defaultSound({ enabled: false }));
    player.play('error');
    expect(bellCount()).toBe(0);
  });
});

describe('SoundPlayer — per-event toggles', () => {
  test('onCompletion: true with no file → bell on completion', () => {
    const player = new SoundPlayer(() =>
      defaultSound({ enabled: true, onCompletion: true, completionFile: null }),
    );
    player.play('completion');
    expect(bellCount()).toBe(1);
  });

  test('onCompletion: false → no bell on completion', () => {
    const player = new SoundPlayer(() =>
      defaultSound({ enabled: true, onCompletion: false }),
    );
    player.play('completion');
    expect(bellCount()).toBe(0);
  });

  test('onApproval: false → no bell on approval (but completion still rings)', () => {
    const player = new SoundPlayer(() =>
      defaultSound({
        enabled: true,
        onApproval: false,
        onCompletion: true,
      }),
    );
    player.play('approval');
    expect(bellCount()).toBe(0);

    player.play('completion');
    expect(bellCount()).toBe(1);
  });

  test('onError: false → no bell on error', () => {
    const player = new SoundPlayer(() =>
      defaultSound({ enabled: true, onError: false }),
    );
    player.play('error');
    expect(bellCount()).toBe(0);
  });

  test('all three events independently enabled fire bells', () => {
    const player = new SoundPlayer(() =>
      defaultSound({
        enabled: true,
        onCompletion: true,
        onApproval: true,
        onError: true,
      }),
    );
    player.play('completion');
    player.play('approval');
    player.play('error');
    expect(bellCount()).toBe(3);
  });
});

describe('SoundPlayer — config supplier robustness', () => {
  test('getConfig that throws falls back to a bell instead of crashing', () => {
    const player = new SoundPlayer(() => {
      throw new Error('config supplier exploded');
    });
    let threw = false;
    try {
      player.play('completion');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Defensive bell when config can't be read.
    expect(bellCount()).toBe(1);
  });

  test('getConfig is called fresh on every play() call', () => {
    let calls = 0;
    const player = new SoundPlayer(() => {
      calls += 1;
      return defaultSound({ enabled: false });
    });
    player.play('completion');
    player.play('approval');
    player.play('error');
    expect(calls).toBe(3);
  });

  test('config can flip mid-session — second call sees new value', () => {
    let enabled = false;
    const player = new SoundPlayer(() => defaultSound({ enabled }));
    player.play('completion');
    expect(bellCount()).toBe(0);
    enabled = true;
    player.play('completion');
    expect(bellCount()).toBe(1);
  });
});

describe('SoundPlayer — fire-and-forget contract', () => {
  test('play() returns synchronously (void) and never throws', () => {
    const player = new SoundPlayer(() =>
      defaultSound({ enabled: true, onCompletion: true }),
    );
    let returned: unknown = 'not-set';
    let threw = false;
    try {
      returned = player.play('completion');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(returned).toBeUndefined();
  });
});
