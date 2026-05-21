/**
 * Cross-platform browser launcher used by the `--web` mode startup banner.
 *
 * The strategy is intentionally minimal — every supported platform has
 * exactly one canonical "open this URL in the user's default browser"
 * command. We never try to detect / prefer a specific browser; we hand
 * the URL to the OS and let it decide.
 *
 * Failure modes are deliberately swallowed: a missing `xdg-open` on a
 * headless Linux box, a sandbox that forbids `Process.spawn`, or a
 * non-zero exit from `cmd /c start` should NOT crash the server. We log
 * a "open this URL manually" line and continue.
 */

import { execa } from 'execa';

/**
 * Open the given URL in the user's default browser.
 *
 * Platform commands:
 *   - macOS:   `open <url>`
 *   - Windows: `cmd /c start "" <url>` (the empty `""` arg is required by
 *              `start` to avoid treating the URL as a window title).
 *   - Linux/other: `xdg-open <url>`
 *
 * We use `detached: true` + `stdio: 'ignore'` so the spawned process does
 * not inherit our terminal and does not keep the parent alive on its own.
 * Any error (binary not found, non-zero exit) is reported via stdout and
 * does not propagate.
 */
export async function openBrowser(url: string): Promise<void> {
  const { platform } = process;
  const [command, ...commandArgs] =
    platform === 'darwin'
      ? (['open', url] as const)
      : platform === 'win32'
        ? (['cmd', '/c', 'start', '""', url] as const)
        : (['xdg-open', url] as const);

  try {
    await execa(command, [...commandArgs], {
      detached: true,
      stdio: 'ignore',
    });
  } catch {
    process.stdout.write(`Open ${url} in your browser.\n`);
  }
}
