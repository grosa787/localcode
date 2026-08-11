/**
 * Regression guard for the first-run boot path.
 *
 * v0.25.0 shipped a tree where EVERY fresh install died on launch: the
 * WORKTREE-GC-STARTUP-SECTION effect in `src/app.tsx` called
 * `getAgentOrchestrator()` on mount with no guard, and its first line
 * reads `configManager.read()` — which throws `ConfigReadError` when
 * `~/.localcode/config.toml` does not exist yet. Thrown from inside a
 * passive-effect commit, that rejects `waitUntilExit()` and `cli.tsx`
 * exits 1. config.toml was therefore never written, so every relaunch
 * replayed splash → crash.
 *
 * WHY these tests spawn a child process: under Bun 1.3.x `os.homedir()`
 * ignores a runtime mutation of `process.env.HOME` but honours `HOME`
 * set at process start. `App` builds `new ConfigManager()` with no path
 * override, so an in-process `render(<App/>)` reads the DEVELOPER's real
 * config and passes against a broken tree. Only `HOME` pre-set on a
 * spawned child exercises a genuinely fresh machine. The mount itself
 * lives in `tests/ui/_first-run-harness.tsx`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ConfigManager } from '@/config/config-manager';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const HARNESS = 'tests/ui/_first-run-harness.tsx';

// Terminal-frame assertions need a TTY that ink can't drive on a
// headless CI runner (see tests/ui/onboarding-locale.test.tsx). The
// `crash` field does not depend on painted frames, so it is asserted
// everywhere and only the frame-content checks are CI-gated.
const inCI = process.env.CI === 'true' || process.env.CI === '1';

interface HarnessResult {
  readonly crash: string;
  readonly configExists: boolean;
  readonly tail: string;
  readonly exited: boolean;
}

async function boot(
  homeDir: string,
  projectRoot: string,
  startScreen: 'splash' | 'onboarding' | 'chat',
  waitMs: number,
  keys?: string,
): Promise<HarnessResult> {
  const proc = Bun.spawn(
    [
      'bun',
      HARNESS,
      projectRoot,
      startScreen,
      String(waitMs),
      ...(keys !== undefined ? [keys] : []),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: homeDir, NO_COLOR: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  // The harness prints one JSON line; ink escape noise may precede it.
  const line = out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop();
  if (line === undefined) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`harness produced no JSON. stdout=${out}\nstderr=${err}`);
  }
  return JSON.parse(line) as HarnessResult;
}

let homeDir = '';
let projDir = '';

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), 'lc-firstrun-home-'));
  projDir = mkdtempSync(path.join(tmpdir(), 'lc-firstrun-proj-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

/** Seed a completed onboarding into the temp HOME. */
function seedCompletedConfig(opts: { tutorialShown: boolean }): void {
  mkdirSync(path.join(homeDir, '.localcode'), { recursive: true });
  const cm = new ConfigManager(path.join(homeDir, '.localcode', 'config.toml'));
  cm.readOrCreate();
  cm.update({
    locale: 'en',
    onboarding: { completed: true },
    model: { current: 'qwen2.5-coder' },
    ...(opts.tutorialShown ? { firstRun: { tutorialShown: true } } : {}),
  });
}

describe('first-run boot', () => {
  test('fresh HOME + splash boots to the language picker without a config read', async () => {
    // SplashScreen auto-advances after AUTO_ADVANCE_MS (3000).
    const res = await boot(homeDir, projDir, 'splash', 6000);

    expect(res.crash).toBe('');
    expect(res.tail).not.toContain('Failed to read config');
    expect(res.tail).not.toContain('config-manager.ts:216');
    // Load-bearing: fails any "fix" that swaps app.tsx's read() for
    // readOrCreate(), which would write config.toml during splash and
    // permanently disarm the first-run routing in src/cli.tsx.
    expect(res.configExists).toBe(false);
    if (!inCI) expect(res.tail).toContain('Choose your language');
  }, 60000);

  test("fresh HOME + startScreen 'onboarding' (--reconfigure) does not crash", async () => {
    // The trap case: --reconfigure skips splash entirely, so a guard
    // written as `screen === 'splash'` passes the test above and fails
    // here. The guard must key off `config === null`.
    const res = await boot(homeDir, projDir, 'onboarding', 3000);

    expect(res.crash).toBe('');
    expect(res.tail).not.toContain('Failed to read config');
  }, 60000);

  // `--reconfigure` is the ONLY boot path that mounts `onboarding` with
  // a config already on disk, and the config-load effect deliberately
  // returns early on that screen — so `config` stays null for the whole
  // flow and `activeLocale` used to fall back to 'en'. A Russian user
  // read the entire re-onboarding in English.
  test.skipIf(inCI)('--reconfigure paints onboarding in the persisted locale', async () => {
    mkdirSync(path.join(homeDir, '.localcode'), { recursive: true });
    const cm = new ConfigManager(
      path.join(homeDir, '.localcode', 'config.toml'),
    );
    cm.readOrCreate();
    cm.update({ locale: 'ru', onboarding: { completed: true } });

    const res = await boot(homeDir, projDir, 'onboarding', 3000);

    expect(res.crash).toBe('');
    expect(res.tail).toContain('Выберите LLM-бэкенд');
    expect(res.tail).not.toContain('Pick the LLM backend');
  }, 60000);

  // The startup-error splash short-circuits the render before any screen
  // mounts, so it carries no key handling of its own, and cli.tsx mounts
  // ink with `exitOnCtrlC: false` — raw-mode stdin swallows ^C and no
  // SIGINT is raised. Without an explicit handler the splash is an
  // unexitable dead end (kill from another terminal is the only way out).
  test.skipIf(inCI)('the startup-error splash can be dismissed with Esc', async () => {
    mkdirSync(path.join(homeDir, '.localcode'), { recursive: true });
    // Unparseable TOML → the config-load effect latches configLoadError.
    writeFileSync(
      path.join(homeDir, '.localcode', 'config.toml'),
      '[backend\nthis is not toml',
      'utf8',
    );

    const res = await boot(homeDir, projDir, 'chat', 4000, '\x1b');

    expect(res.tail).toContain('Failed to load config.');
    expect(res.tail).toContain('Press Esc, q or Ctrl+C to quit.');
    expect(res.exited).toBe(true);
  }, 60000);

  test('second launch skips onboarding and the tutorial', async () => {
    seedCompletedConfig({ tutorialShown: true });
    const res = await boot(homeDir, projDir, 'chat', 4000);

    expect(res.crash).toBe('');
    if (!inCI) {
      // `onboarding.welcome` — proves we did not bounce back to setup.
      expect(res.tail).not.toContain('Pick the LLM backend');
      expect(res.tail).not.toContain('Welcome tour');
    }
  }, 60000);

  // Positive control for the case above: without the persisted flag the
  // tutorial MUST appear, otherwise that test could pass vacuously.
  test.skipIf(inCI)('the tutorial shows when tutorialShown is unset', async () => {
    seedCompletedConfig({ tutorialShown: false });
    const res = await boot(homeDir, projDir, 'chat', 4000);

    expect(res.crash).toBe('');
    expect(res.tail).toContain('Welcome tour');
  }, 60000);
});
