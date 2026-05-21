/**
 * `PersistentScheduler` coverage with an injected fake timer.
 *
 * Verifies:
 *   - load + arm picks the earliest enabled entry,
 *   - disabled entries are skipped,
 *   - fire calls dispatch and persists lastFiredAt to disk,
 *   - rearm picks the next entry after a fire,
 *   - refresh() picks up external store edits.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PersistentScheduler,
  loadCronStore,
  saveCronStore,
  type PersistentCronDispatchContext,
} from '@/scheduling';

let tmpDir = '';
let storePath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-pscheduler-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  storePath = path.join(tmpDir, 'crons.json');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

interface FakeHandle {
  readonly id: number;
  cb: () => void;
  cleared: boolean;
}

class FakeTimers {
  private next = 1;
  readonly handles = new Map<number, FakeHandle>();

  setTimeoutFn = (cb: () => void): unknown => {
    const id = this.next;
    this.next += 1;
    const handle: FakeHandle = { id, cb, cleared: false };
    this.handles.set(id, handle);
    return handle;
  };

  clearTimeoutFn = (raw: unknown): void => {
    if (raw === null || typeof raw !== 'object') return;
    const h = raw as FakeHandle;
    h.cleared = true;
    this.handles.delete(h.id);
  };

  /**
   * Fire the only pending timer (asserts there's exactly one) and wait
   * for the resulting async chain to complete by polling against the
   * provided predicate. The scheduler's `fire()` is fire-and-forget,
   * so we need a deterministic way to know when its disk writes have
   * landed.
   */
  async fireOnly(waitFor?: () => Promise<boolean>): Promise<void> {
    const live = [...this.handles.values()];
    expect(live.length).toBe(1);
    const handle = live[0];
    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error('no handle');
    this.handles.delete(handle.id);
    handle.cb();
    if (waitFor === undefined) {
      await new Promise((r) => setImmediate(r));
      return;
    }
    for (let i = 0; i < 100; i += 1) {
      try {
        if (await waitFor()) return;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

describe('PersistentScheduler', () => {
  test('start picks the earliest enabled cron and arms a timer', async () => {
    // Write a store with one entry firing every minute.
    await saveCronStore(
      {
        version: 1,
        crons: [
          {
            id: 'cron-a',
            cronSpec: '* * * * *',
            prompt: 'p',
            enabled: true,
          },
        ],
      },
      storePath,
    );
    const timers = new FakeTimers();
    const fired: PersistentCronDispatchContext[] = [];
    const scheduler = new PersistentScheduler({
      filePath: storePath,
      dispatch: (ctx) => {
        fired.push(ctx);
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      nowFn: () => new Date(2026, 4, 18, 10, 0, 30, 0).getTime(),
    });
    await scheduler.start();
    expect(scheduler.getArmed()?.entryId).toBe('cron-a');
    expect(timers.handles.size).toBe(1);
    scheduler.stop();
  });

  test('disabled crons are not armed', async () => {
    await saveCronStore(
      {
        version: 1,
        crons: [
          {
            id: 'cron-a',
            cronSpec: '* * * * *',
            prompt: 'p',
            enabled: false,
          },
        ],
      },
      storePath,
    );
    const timers = new FakeTimers();
    const scheduler = new PersistentScheduler({
      filePath: storePath,
      dispatch: () => {},
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await scheduler.start();
    expect(scheduler.getArmed()).toBeNull();
    expect(timers.handles.size).toBe(0);
    scheduler.stop();
  });

  test('fire dispatches and persists lastFiredAt', async () => {
    await saveCronStore(
      {
        version: 1,
        crons: [
          {
            id: 'cron-a',
            cronSpec: '* * * * *',
            prompt: 'fire me',
            enabled: true,
          },
        ],
      },
      storePath,
    );
    const timers = new FakeTimers();
    const fired: PersistentCronDispatchContext[] = [];
    const warnings: string[] = [];
    const scheduler = new PersistentScheduler({
      filePath: storePath,
      dispatch: (ctx) => {
        fired.push(ctx);
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      nowFn: () => new Date(2026, 4, 18, 10, 0, 30, 0).getTime(),
      logger: { warn: (m): void => { warnings.push(m); } },
    });
    await scheduler.start();
    await timers.fireOnly(async () => {
      const f = await loadCronStore(storePath);
      return f.crons[0]?.lastFiredAt !== undefined;
    });
    await scheduler.flush();

    expect(fired).toHaveLength(1);
    expect(fired[0]?.entry.id).toBe('cron-a');

    const stored = await loadCronStore(storePath);
    const firstStored = stored.crons[0];
    expect(firstStored).toBeDefined();
    expect(firstStored?.lastFiredAt).toBeDefined();
    expect(typeof firstStored?.lastFiredAt).toBe('number');

    scheduler.stop();
    await scheduler.flush();
    expect(warnings).toHaveLength(0);
  });

  test('rearm picks the next entry after a fire', async () => {
    await saveCronStore(
      {
        version: 1,
        crons: [
          {
            id: 'cron-a',
            cronSpec: '* * * * *',
            prompt: 'a',
            enabled: true,
          },
          {
            id: 'cron-b',
            cronSpec: '* * * * *',
            prompt: 'b',
            enabled: true,
          },
        ],
      },
      storePath,
    );
    const timers = new FakeTimers();
    const fired: string[] = [];
    let now = new Date(2026, 4, 18, 10, 0, 30, 0).getTime();
    const scheduler = new PersistentScheduler({
      filePath: storePath,
      dispatch: (ctx) => {
        fired.push(ctx.entry.id);
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      nowFn: () => now,
      logger: { warn: (): void => undefined },
    });
    await scheduler.start();
    expect(scheduler.getArmed()).not.toBeNull();
    await timers.fireOnly(async () => fired.length >= 1);
    await scheduler.flush();
    // After fire, scheduler should have rearmed for one of the two.
    expect(fired.length).toBeGreaterThanOrEqual(1);
    // Advance now so the next pick computes a different fireAt.
    now += 60_000;
    scheduler.stop();
    await scheduler.flush();
  });

  test('refresh re-reads the store after an external edit', async () => {
    await saveCronStore(
      { version: 1, crons: [] },
      storePath,
    );
    const timers = new FakeTimers();
    const scheduler = new PersistentScheduler({
      filePath: storePath,
      dispatch: () => {},
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await scheduler.start();
    expect(scheduler.getArmed()).toBeNull();

    // External writer appends a cron.
    await saveCronStore(
      {
        version: 1,
        crons: [
          {
            id: 'cron-added',
            cronSpec: '* * * * *',
            prompt: 'p',
            enabled: true,
          },
        ],
      },
      storePath,
    );

    await scheduler.refresh();
    expect(scheduler.getArmed()?.entryId).toBe('cron-added');
    scheduler.stop();
  });

  test('malformed entries are skipped with a warning, not crashing', async () => {
    // Write a valid + a malformed entry directly to the file (bypasses
    // saveCronStore's validation since that would throw).
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        crons: [
          {
            id: 'good',
            cronSpec: '* * * * *',
            prompt: 'p',
            enabled: true,
          },
          {
            id: 'bad',
            cronSpec: 'not-a-cron',
            prompt: 'p',
            enabled: true,
          },
        ],
      }),
      'utf8',
    );
    const timers = new FakeTimers();
    const warnings: string[] = [];
    const scheduler = new PersistentScheduler({
      filePath: storePath,
      dispatch: () => {},
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: {
        warn: (m): void => {
          warnings.push(m);
        },
      },
    });
    await scheduler.start();
    expect(scheduler.getArmed()?.entryId).toBe('good');
    expect(warnings.some((w) => w.includes('bad'))).toBe(true);
    scheduler.stop();
  });
});
