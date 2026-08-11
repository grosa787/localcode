/**
 * Child-process mount harness for the first-run boot path.
 *
 * NOT a test file — the leading underscore and the missing `.test.`
 * segment keep `bun test` from collecting it (same convention as
 * `tests/ui/_settle.ts`). It is spawned by
 * `tests/ui/first-run-boot.test.tsx`.
 *
 * WHY a child process: under Bun 1.3.x `os.homedir()` ignores a runtime
 * mutation of `process.env.HOME` but honours `HOME` set at process
 * start. `App` constructs `new ConfigManager()` / `new SessionManager()`
 * with no path override, both resolving through `homedir()`, so an
 * in-process `render(<App/>)` silently reads the developer's real
 * `~/.localcode/config.toml` and passes against a broken tree. Only a
 * spawned child with `HOME` pre-set actually exercises a fresh machine.
 *
 * Usage:
 *   bun tests/ui/_first-run-harness.tsx <projectRoot> <splash|onboarding|chat> <waitMs> [keys]
 *
 * `keys` is an optional raw string pushed into the fake stdin halfway
 * through the wait, for tests that need to prove a key handler exists
 * (e.g. that the startup-error splash can be dismissed). Use `\x1b` for
 * Esc, `\x03` for Ctrl+C.
 *
 * Prints exactly one line of JSON to stdout:
 *   { crash, configExists, tail, exited }
 */

import React from 'react';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { render } from 'ink';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

const TAIL_CHARS = 4000;

interface HarnessResult {
  readonly crash: string;
  readonly configExists: boolean;
  readonly tail: string;
  /** True when the App unmounted itself before the wait elapsed. */
  readonly exited: boolean;
}

async function main(): Promise<void> {
  const [projectRoot, startScreenArg, waitMsArg, keysArg] =
    process.argv.slice(2);
  if (projectRoot === undefined || startScreenArg === undefined) {
    process.stderr.write('usage: _first-run-harness <projectRoot> <screen> <waitMs>\n');
    process.exit(2);
  }
  const startScreen: 'splash' | 'onboarding' | 'chat' =
    startScreenArg === 'onboarding'
      ? 'onboarding'
      : startScreenArg === 'chat'
        ? 'chat'
        : 'splash';
  const waitMs = Number(waitMsArg ?? '5000');

  // Fake TTY stdout — ink only paints when it believes it has a TTY.
  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      frames.push(Buffer.from(chunk).toString('utf8'));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 120;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  // Ink 5 consumes input by listening for `readable` and draining
  // `stdin.read()` — NOT by subscribing to `data`. Emitting `data` on
  // this fake would be silently ignored, so key injection queues the
  // chunk and fires `readable`.
  const inputQueue: string[] = [];
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
  stdin.read = (): string | null => {
    const next = inputQueue.shift();
    return next === undefined ? null : next;
  };
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;

  const AppModule = await import('@/app');
  const App = AppModule.default;

  const instance = render(
    React.createElement(App, {
      projectRoot,
      dangerouslyAllowAll: false,
      resumeSessionId: null,
      modelOverride: null,
      startScreen,
      noRefreshModels: true,
    }),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: stdout as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdin: stdin as any,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  // Mirrors cli.tsx: a throw inside a passive effect rejects here.
  let crash = '';
  let exited = false;
  void instance
    .waitUntilExit()
    .then(() => {
      exited = true;
    })
    .catch((e: unknown) => {
      crash = e instanceof Error ? e.message : String(e);
    });

  if (keysArg !== undefined && keysArg.length > 0) {
    // Give the tree a chance to mount + settle before typing.
    await new Promise((r) => setTimeout(r, Math.floor(waitMs / 2)));
    inputQueue.push(keysArg);
    stdin.emit('readable');
    await new Promise((r) => setTimeout(r, Math.ceil(waitMs / 2)));
  } else {
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const painted = stripAnsi(frames.join(''));
  const result: HarnessResult = {
    crash,
    configExists: existsSync(path.join(homedir(), '.localcode', 'config.toml')),
    tail: painted.slice(-TAIL_CHARS),
    exited,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);

  try {
    instance.unmount();
  } catch {
    /* already unmounted by the error boundary */
  }
  process.exit(0);
}

void main();
