/**
 * Dry-run smoke test for install.sh.
 *
 * We stub `bun`, `git`, and `curl` on PATH so the script can run end-to-end
 * inside a sandbox directory without touching the real network or the user's
 * environment. The stubs:
 *   - `bun` returns a high-enough version and pretends `bun install` /
 *     `bun run build` succeed (and creates `dist/cli.js` so the script's
 *     existence check passes).
 *   - `git` no-ops every subcommand and creates an empty `.git/` so the
 *     "existing clone" branch is taken on re-run.
 *   - `curl` is shadowed so any accidental network call would fail loudly.
 *
 * The goal is to verify the control flow — argument parsing, fetch branch
 * selection, symlink placement — not to exercise a real install.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, existsSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const installSh = join(repoRoot, 'install.sh');

function makeStubBin(dir: string): string {
  const bin = join(dir, 'stub-bin');
  mkdirSync(bin, { recursive: true });

  // bun stub: prints version on --version; on `install` / `run build` it
  // creates the expected dist artefact so the script's post-build check passes.
  const bun = `#!/usr/bin/env bash
case "$1" in
  --version) echo "1.2.0"; exit 0 ;;
  install) exit 0 ;;
  run)
    case "$2" in
      build|build:cli|build:web|embed-web)
        mkdir -p "$(pwd)/dist"
        printf '#!/usr/bin/env bun\nconsole.log("stub");\n' > "$(pwd)/dist/cli.js"
        chmod +x "$(pwd)/dist/cli.js"
        exit 0
        ;;
      *) exit 0 ;;
    esac
    ;;
esac
exit 0
`;
  writeFileSync(join(bin, 'bun'), bun);
  chmodSync(join(bin, 'bun'), 0o755);

  // git stub: implement just enough — `clone` makes the target dir + a fake
  // .git; all other subcommands no-op.
  const git = `#!/usr/bin/env bash
case "$1" in
  clone)
    # Last arg is the target directory.
    target="\${@: -1}"
    mkdir -p "$target/.git"
    # mirror a buildable layout
    mkdir -p "$target/src"
    cp -R "${repoRoot}/package.json" "$target/" 2>/dev/null || true
    exit 0
    ;;
  fetch|checkout|reset|pull) exit 0 ;;
esac
exit 0
`;
  writeFileSync(join(bin, 'git'), git);
  chmodSync(join(bin, 'git'), 0o755);

  // curl stub: refuse network. We do NOT install bun via curl in this test
  // because the bun stub answers --version successfully on the very first
  // call.
  const curl = `#!/usr/bin/env bash
echo "stub-curl called with: $*" >&2
exit 99
`;
  writeFileSync(join(bin, 'curl'), curl);
  chmodSync(join(bin, 'curl'), 0o755);

  // tar/uname/awk/sed/mkdir/etc. inherit from the real PATH — we just
  // *prepend* this stub directory.
  return bin;
}

describe('install.sh dryrun', () => {
  test('runs end-to-end with stubbed bun/git and symlinks into LOCALCODE_BIN_DIR', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'lc-install-'));
    try {
      const stubBin = makeStubBin(sandbox);
      const home = join(sandbox, 'home');
      const lcHome = join(home, '.local', 'share', 'localcode');
      const lcBin = join(home, '.local', 'bin');
      mkdirSync(home, { recursive: true });

      const env = {
        ...process.env,
        HOME: home,
        PATH: `${stubBin}:${process.env['PATH'] ?? ''}`,
        LOCALCODE_HOME: lcHome,
        LOCALCODE_BIN_DIR: lcBin,
      };

      const r = spawnSync('bash', [installSh], {
        encoding: 'utf8',
        timeout: 30_000,
        env,
      });

      if (r.status !== 0) {
        // surface diagnostic on failure
        console.error('STDOUT:', r.stdout);
        console.error('STDERR:', r.stderr);
      }
      expect(r.status).toBe(0);

      // dist/cli.js was created by stub bun
      expect(existsSync(join(lcHome, 'dist', 'cli.js'))).toBe(true);

      // symlink lives in ~/.local/bin
      const link = join(lcBin, 'localcode');
      expect(existsSync(link)).toBe(true);
      const target = readlinkSync(link);
      expect(target).toBe(join(lcHome, 'dist', 'cli.js'));

      // success line printed
      expect(r.stdout).toContain('LocalCode installed at');
      expect(r.stdout).toContain('Run: localcode');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('--uninstall removes symlink and install dir', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'lc-uninstall-'));
    try {
      const stubBin = makeStubBin(sandbox);
      const home = join(sandbox, 'home');
      const lcHome = join(home, '.local', 'share', 'localcode');
      const lcBin = join(home, '.local', 'bin');
      mkdirSync(lcHome, { recursive: true });
      mkdirSync(join(lcHome, 'dist'), { recursive: true });
      writeFileSync(join(lcHome, 'dist', 'cli.js'), '#!/usr/bin/env bun\n');
      mkdirSync(lcBin, { recursive: true });
      // create symlink the installer would have made
      const link = join(lcBin, 'localcode');
      const { symlinkSync } = require('node:fs') as typeof import('node:fs');
      symlinkSync(join(lcHome, 'dist', 'cli.js'), link);

      const env = {
        ...process.env,
        HOME: home,
        PATH: `${stubBin}:${process.env['PATH'] ?? ''}`,
        LOCALCODE_HOME: lcHome,
        LOCALCODE_BIN_DIR: lcBin,
      };

      const r = spawnSync('bash', [installSh, '--uninstall'], {
        encoding: 'utf8',
        timeout: 15_000,
        env,
      });
      expect(r.status).toBe(0);
      expect(existsSync(link)).toBe(false);
      expect(existsSync(lcHome)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
