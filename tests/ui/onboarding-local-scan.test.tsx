/**
 * Regression guard for the onboarding scan step.
 *
 * `handleUrlConfirm` used to end its local-provider branch with a bare
 * `setStep('scanning')` plus a comment claiming "our useEffect drives
 * the actual scan". No such effect existed — `runScan` was only ever
 * called from the API-key step, which local providers skip. Ollama and
 * LM Studio (the first two rows of the picker) therefore parked on the
 * spinner forever, and `Scanning` registered no `useInput`, so Esc did
 * nothing and ink is mounted with `exitOnCtrlC:false`. That is the
 * user-reported "onboarding hangs and cannot be skipped".
 *
 * Cancel additionally has to land where a FAILED scan lands
 * (`fallbackStep()`): cloud providers back on the key step, local ones
 * on the URL step. Dropping a cloud user to the URL step made them
 * retype the API key they had just entered.
 *
 * These tests are in-process: OnboardingScreen touches no config, so
 * the HOME redirection problem that forces `first-run-boot.test.tsx`
 * into a child process does not apply here.
 *
 * WHY the CI gating is per-assertion (mirrors first-run-boot.test.tsx):
 * ink checks `is-in-ci` at render time — `ink/build/ink.js:111` skips
 * every non-static write and only flushes the LAST frame on unmount
 * (`ink.js:190`). So under CI a frame can still be read, but only once
 * and only by unmounting (`currentFrame()` below), and intermediate
 * frames are unobservable. Everything that does not depend on painted
 * pixels — that the scan actually fires, that cancel actually
 * invalidates the in-flight scan — runs everywhere.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { render } from 'ink';

import { settleFrame } from './_settle';
import OnboardingScreen from '@/ui/screens/OnboardingScreen';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

const ENTER = '\r';
const ESC = '\x1B';
const DOWN = '\x1B[B';

const inCI = process.env.CI === 'true' || process.env.CI === '1';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll a frame-independent predicate — safe in CI, unlike settleFrame. */
async function waitFor(
  pred: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

interface MountResult {
  readonly read: () => string;
  readonly press: (seq: string) => void;
  /**
   * Drop everything painted so far. `read()` accumulates frames, so a
   * negative assertion ("no longer shows the spinner") would otherwise
   * always match an earlier frame still sitting in the buffer.
   */
  readonly clear: () => void;
  readonly unmount: () => void;
}

interface MountOpts {
  readonly pingBackend: (url: string) => Promise<boolean>;
  readonly fetchModels?: (url: string) => Promise<string[]>;
}

function mountOnboarding(opts: MountOpts): MountResult {
  const stdoutBuf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      stdoutBuf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 200;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  // ink 5.x pulls input via the 'readable' event + stdin.read(), NOT
  // 'data' — emitting 'data' on this stub is silently ignored.
  const pending: string[] = [];
  const stdin: EventEmitter & {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => void;
    setEncoding?: (enc: string) => void;
    resume?: () => void;
    pause?: () => void;
    read?: () => string | null;
    ref?: () => void;
    unref?: () => void;
  } = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.setEncoding = () => undefined;
  stdin.resume = () => undefined;
  stdin.pause = () => undefined;
  stdin.read = () => pending.shift() ?? null;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;

  const instance = render(
    React.createElement(OnboardingScreen, {
      onComplete: () => undefined,
      pingBackend: opts.pingBackend,
      fetchModels: opts.fetchModels ?? (async (): Promise<string[]> => []),
    }),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: stdout as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdin: stdin as any,
      debug: false,
      exitOnCtrlC: false,
    },
  );

  return {
    read: () => stripAnsi(Buffer.concat(stdoutBuf).toString('utf8')),
    press: (seq: string) => {
      pending.push(seq);
      stdin.emit('readable');
    },
    clear: () => {
      stdoutBuf.length = 0;
    },
    unmount: () => instance.unmount(),
  };
}

/**
 * Let ink commit the pending state change before the next keypress.
 * Load-bearing: every step owns its own `useInput`, so a key delivered
 * before the commit is handled by the step the user has already left
 * (e.g. Esc hitting ApiKeyInput's onBack instead of Scanning's cancel).
 * Outside CI we watch the frames settle and hand the frame back; inside
 * CI nothing is painted until unmount, so a macrotask pause is all we
 * get and the returned frame is empty.
 */
async function advance(view: MountResult): Promise<string> {
  if (inCI) {
    await sleep(150);
    return '';
  }
  return settleFrame(view.read);
}

/**
 * The frame the user is looking at right now.
 *
 * TERMINAL — in CI this has to unmount to make ink flush `lastOutput`,
 * so nothing may be pressed afterwards. Call it once, last. Pair it
 * with `view.clear()` before the action under test so the returned text
 * contains only frames painted after that action (outside CI `read()`
 * accumulates every frame ever painted).
 */
async function currentFrame(view: MountResult): Promise<string> {
  if (!inCI) return settleFrame(view.read);
  await sleep(200);
  view.clear();
  view.unmount();
  return view.read();
}

// The cloud-cancel case needs a key on the API-key step; with an env key
// present an empty submit is accepted as "use the env fallback", so the
// test never has to simulate typing a secret into <TextInput>.
const savedOpenAiKey = process.env['OPENAI_API_KEY'];

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
  process.env['OPENAI_API_KEY'] = 'sk-test-onboarding';
});

afterAll(() => {
  if (savedOpenAiKey === undefined) delete process.env['OPENAI_API_KEY'];
  else process.env['OPENAI_API_KEY'] = savedOpenAiKey;
});

describe('OnboardingScreen scan step', () => {
  test('selecting a local provider actually starts the scan', async () => {
    const pingCalls: string[] = [];
    const fetchCalls: string[] = [];
    const view = mountOnboarding({
      pingBackend: async (url) => {
        pingCalls.push(url);
        return true;
      },
      fetchModels: async (url) => {
        fetchCalls.push(url);
        return ['qwen2.5-coder'];
      },
    });
    try {
      await advance(view);
      // CHOICES[0] is Ollama — first Enter picks it, second accepts the
      // default http://localhost:11434.
      view.press(ENTER);
      await advance(view);
      view.press(ENTER);

      // The assertion that fails on the unfixed tree: nothing ever
      // reached runScan, so the ping never happened. Frame-independent,
      // therefore it runs in CI too.
      await waitFor(() => fetchCalls.length === 1);
      expect(pingCalls).toEqual(['http://localhost:11434']);
      expect(fetchCalls).toEqual(['http://localhost:11434']);

      const frame = await currentFrame(view);
      expect(frame).toContain('Available models');
    } finally {
      view.unmount();
    }
  });

  test('an unreachable local server returns to the URL step', async () => {
    const pingCalls: string[] = [];
    const fetchCalls: string[] = [];
    const view = mountOnboarding({
      pingBackend: async (url) => {
        pingCalls.push(url);
        return false;
      },
      fetchModels: async (url) => {
        fetchCalls.push(url);
        return [];
      },
    });
    try {
      await advance(view);
      view.press(ENTER);
      await advance(view);
      view.press(ENTER);

      await waitFor(() => pingCalls.length === 1);
      // An unreachable ping must short-circuit — never list models.
      await sleep(50);
      expect(fetchCalls).toEqual([]);

      const frame = await currentFrame(view);
      expect(frame).toContain('Could not reach');
      expect(frame).toContain('Server URL:');
    } finally {
      view.unmount();
    }
  });

  test('Esc cancels a hanging scan and invalidates it', async () => {
    const pingCalls: string[] = [];
    const fetchCalls: string[] = [];
    // Never resolves on its own — exactly what an unreachable host looks
    // like before the socket times out. We resolve it by hand AFTER the
    // cancel to prove the stale scan cannot write state anymore.
    let releasePing: ((v: boolean) => void) | undefined;
    const view = mountOnboarding({
      pingBackend: (url) => {
        pingCalls.push(url);
        return new Promise<boolean>((resolve) => {
          releasePing = resolve;
        });
      },
      fetchModels: async (url) => {
        fetchCalls.push(url);
        return ['qwen2.5-coder'];
      },
    });
    try {
      await advance(view);
      view.press(ENTER);
      await advance(view);
      view.press(ENTER);

      // Ping in flight ⇒ we are parked on the scanning step.
      await waitFor(() => pingCalls.length === 1);
      expect(pingCalls.length).toBe(1);
      const scanning = await advance(view);
      if (!inCI) expect(scanning).toContain('Scanning models at');

      view.clear();
      view.press(ESC);
      await sleep(50);

      // Frame-independent proof that Esc reached `handleScanCancel`:
      // only that handler bumps the scan token, and the token guard is
      // what makes the late ping return before touching fetchModels.
      releasePing?.(true);
      await sleep(100);
      expect(fetchCalls).toEqual([]);

      if (!inCI) {
        // Local provider ⇒ fallbackStep() is the URL step.
        const frame = await settleFrame(view.read);
        expect(frame).toContain('Server URL:');
        expect(frame).not.toContain('Scanning models at');
      }

      // Same claim, frame-free (so it also runs in CI): on the URL step
      // Enter re-submits the URL and a local provider scans immediately,
      // so the ping count moves. Nothing else in this flow pings.
      await advance(view);
      view.press(ENTER);
      await waitFor(() => pingCalls.length === 2);
      expect(pingCalls.length).toBe(2);
    } finally {
      view.unmount();
    }
  });

  test('Esc on a cloud scan returns to the API-key step, not the URL step', async () => {
    // Regression: handleScanCancel used to hardcode 'urlInput', so a
    // cloud user who cancelled a slow scan had to retype their key —
    // while every failure path inside runScan already returned them to
    // 'apiKeyInput'.
    const pingCalls: string[] = [];
    const fetchCalls: string[] = [];
    let releasePing: ((v: boolean) => void) | undefined;
    const view = mountOnboarding({
      pingBackend: (url) => {
        pingCalls.push(url);
        return new Promise<boolean>((resolve) => {
          releasePing = resolve;
        });
      },
      fetchModels: async (url) => {
        fetchCalls.push(url);
        return ['gpt-4o'];
      },
    });
    try {
      await advance(view);
      // CHOICES[3] is OpenAI (requiresApiKey) — ollama, lmstudio and
      // unsloth come first in the local-first ordering.
      view.press(DOWN);
      await advance(view);
      view.press(DOWN);
      await advance(view);
      view.press(DOWN);
      await advance(view);
      view.press(ENTER);
      await advance(view);
      // Accept the default base URL → key step.
      view.press(ENTER);
      await advance(view);
      // OPENAI_API_KEY is seeded in beforeAll, so an empty submit is
      // treated as "use the env fallback" and goes straight to the scan.
      view.press(ENTER);

      await waitFor(() => pingCalls.length === 1);
      expect(pingCalls).toEqual(['https://api.openai.com/v1']);
      await advance(view);

      view.clear();
      view.press(ESC);
      await sleep(50);
      // A late ping must not be able to move the screen either. If Esc
      // had missed Scanning's handler the scan would run on and list
      // models — frame-independent, so this one assertion runs in CI.
      releasePing?.(true);
      await sleep(100);
      expect(fetchCalls).toEqual([]);

      if (!inCI) {
        const frame = await settleFrame(view.read);
        expect(frame).toContain('API key:');
        expect(frame).not.toContain('Server URL:');
        expect(frame).not.toContain('Scanning models at');
      }

      // Same claim, frame-free (so it also runs in CI) — and it is the
      // whole point of the fix: from the key step one Enter retries the
      // scan with the key already in hand (env fallback here), so the
      // ping count moves. From the URL step Enter would only walk
      // forward to the key step and ping nothing.
      await advance(view);
      view.press(ENTER);
      await waitFor(() => pingCalls.length === 2);
      expect(pingCalls.length).toBe(2);
    } finally {
      view.unmount();
    }
  });
});
