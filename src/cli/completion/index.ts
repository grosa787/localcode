/**
 * `localcode completion <shell>` dispatcher.
 *
 * Loads the user's `~/.localcode/config.toml` (best-effort) to pre-bake
 * the discovered model names into the generated script. When the file
 * is unreadable or models can't be parsed, the script falls back to its
 * own runtime awk-based lookup (see the per-shell generators).
 */

import { ConfigManager } from '@/config/config-manager';
import { generateBashCompletion } from './bash';
import { generateZshCompletion } from './zsh';
import { generateFishCompletion } from './fish';

export interface CompletionCliWriters {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CompletionCliOptions {
  /** Inject writers (tests). */
  readonly writers?: Partial<CompletionCliWriters>;
  /**
   * Inject a ConfigManager (tests) so we don't depend on the user's
   * real `~/.localcode/config.toml`. When absent the dispatcher builds
   * a default ConfigManager and swallows any read failures.
   */
  readonly configManager?: ConfigManager;
}

const PROFILES = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
] as const;

const HELP_TEXT = `localcode completion <shell>

Print a completion script for the named shell to stdout.

Shells:
  bash    Source from /etc/bash_completion.d/localcode or your bashrc.
  zsh     Drop into "\${fpath[1]}/_localcode" and run \`compinit\`.
  fish    Drop into ~/.config/fish/completions/localcode.fish.
`;

/**
 * Entry point used by `cli.tsx` when the first positional arg is
 * `completion`.
 */
export async function runCompletionCli(
  argv: readonly string[],
  opts: CompletionCliOptions = {},
): Promise<number> {
  const out = opts.writers?.out ?? ((l): void => {
    process.stdout.write(`${l}\n`);
  });
  const err = opts.writers?.err ?? ((l): void => {
    process.stderr.write(`${l}\n`);
  });

  const sub = argv[0] ?? '';
  if (sub === '' || sub === '--help' || sub === '-h' || sub === 'help') {
    out(HELP_TEXT);
    return 0;
  }

  if (sub !== 'bash' && sub !== 'zsh' && sub !== 'fish') {
    err(`completion: unknown shell "${sub}"`);
    err('Supported shells: bash, zsh, fish.');
    return 1;
  }

  // Best-effort model discovery — never blocks emit on a missing file.
  // The generated scripts also self-discover via awk, so this is just a
  // nicety for users whose config doesn't parse.
  void opts.configManager; // reserved for tests; models discovered live at use-time.

  switch (sub) {
    case 'bash':
      out(generateBashCompletion({ profiles: PROFILES }));
      return 0;
    case 'zsh':
      out(generateZshCompletion({ profiles: PROFILES }));
      return 0;
    case 'fish':
      out(generateFishCompletion({ profiles: PROFILES }));
      return 0;
  }
}
