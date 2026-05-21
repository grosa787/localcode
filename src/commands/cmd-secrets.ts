/**
 * `/secrets` — inspect the secret scanner from inside a session.
 *
 *   /secrets scan              — scan the current staged diff
 *   /secrets scan-all          — scan every tracked git file (slow!)
 *   /secrets allow <pattern>   — append a literal allowlist entry
 *
 * No subcommand prints usage. All scanning runs in-process; nothing
 * crosses the LLM boundary.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CommandContext, SlashCommand } from '@/types/global';
import {
  allowlistPath,
  applyAllowlist,
  formatFinding,
  loadAllowlist,
  scanCommitDiff,
  scanText,
  type Finding,
} from '@/security';

/**
 * Subcommands are unambiguous tokens — parse with `trimStart().split`
 * rather than a real shell parser to keep the implementation tiny.
 */
type Sub = 'scan' | 'scan-all' | 'allow' | 'help';

function parseSubcommand(args: string): { sub: Sub; rest: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { sub: 'help', rest: '' };
  const space = trimmed.indexOf(' ');
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim();
  if (head === 'scan') return { sub: 'scan', rest };
  if (head === 'scan-all' || head === 'scanall') return { sub: 'scan-all', rest };
  if (head === 'allow') return { sub: 'allow', rest };
  return { sub: 'help', rest };
}

function printUsage(ctx: CommandContext): void {
  ctx.print('Usage:');
  ctx.print('  /secrets scan              — scan staged diff');
  ctx.print('  /secrets scan-all          — scan every tracked file (slow)');
  ctx.print('  /secrets allow <pattern>   — append an allowlist entry');
}

function printFindings(ctx: CommandContext, findings: Finding[]): void {
  if (findings.length === 0) {
    ctx.print('No findings.');
    return;
  }
  ctx.print(`Found ${findings.length} potential secret(s):`);
  for (const f of findings) {
    ctx.print(`  - ${formatFinding(f)} [${f.severity}, confidence ${f.confidence.toFixed(2)}]`);
  }
}

function listTrackedFiles(projectRoot: string): string[] {
  try {
    const raw = execFileSync('git', ['ls-files'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return raw.split(/\r?\n/).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function getStagedDiff(projectRoot: string): string {
  try {
    return execFileSync('git', ['diff', '--cached', '--no-color'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

/**
 * Append a literal-string allow entry to the project allowlist. Creates
 * the file (and `.localcode/` dir) if missing.
 */
function appendAllowEntry(projectRoot: string, pattern: string, reason: string): string {
  const file = allowlistPath(projectRoot);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Escape embedded `"` so the TOML string literal stays valid.
  const escPattern = pattern.replace(/"/g, '\\"');
  const escReason = reason.replace(/"/g, '\\"');
  const block = `\n[[allow]]\npattern = "${escPattern}"\nreason  = "${escReason}"\n`;
  if (fs.existsSync(file)) {
    fs.appendFileSync(file, block, 'utf8');
  } else {
    const header =
      '# LocalCode secret-scanner allowlist. See /secrets help for usage.\n';
    fs.writeFileSync(file, header + block, 'utf8');
  }
  return file;
}

export interface SecretsCommandDeps {
  /** Override the file-reader for tests. */
  readFile?: (abs: string) => string;
  /** Override the tracked-file lister for tests. */
  listFiles?: (projectRoot: string) => string[];
  /** Override the staged-diff source for tests. */
  getDiff?: (projectRoot: string) => string;
  /** Override the allowlist-append helper for tests. */
  appendAllow?: (projectRoot: string, pattern: string, reason: string) => string;
}

export function createSecretsCommand(deps: SecretsCommandDeps = {}): SlashCommand {
  const readFile = deps.readFile ?? ((abs: string): string => {
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return '';
    }
  });
  const listFiles = deps.listFiles ?? listTrackedFiles;
  const getDiff = deps.getDiff ?? getStagedDiff;
  const append = deps.appendAllow ?? appendAllowEntry;

  return {
    name: 'secrets',
    description: 'Scan staged diff (or all tracked files) for secrets.',
    usage: '/secrets <scan|scan-all|allow <pattern>>',
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const { sub, rest } = parseSubcommand(args);
      if (sub === 'help') {
        printUsage(ctx);
        return;
      }

      if (sub === 'allow') {
        if (rest.length === 0) {
          ctx.print('Usage: /secrets allow <pattern>');
          return;
        }
        try {
          const file = append(ctx.projectRoot, rest, 'added via /secrets allow');
          ctx.print(`Added allowlist entry to ${file}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.print(`Failed to append allowlist entry: ${msg}`);
        }
        return;
      }

      const allowlist = loadAllowlist(ctx.projectRoot);
      if (allowlist.errors.length > 0) {
        ctx.print('Warning — allowlist load errors (treating as empty):');
        for (const e of allowlist.errors) ctx.print(`  - ${e}`);
      }

      if (sub === 'scan') {
        const diff = getDiff(ctx.projectRoot);
        if (diff.length === 0) {
          ctx.print('No staged changes (or not a git repo).');
          return;
        }
        const raw = scanCommitDiff(diff);
        const findings = applyAllowlist(raw, allowlist.entries);
        printFindings(ctx, findings);
        return;
      }

      if (sub === 'scan-all') {
        ctx.print('Scanning all tracked files. This may take a while…');
        const files = listFiles(ctx.projectRoot);
        if (files.length === 0) {
          ctx.print('No tracked files found (or not a git repo).');
          return;
        }
        const all: Finding[] = [];
        let scanned = 0;
        for (const rel of files) {
          const abs = path.join(ctx.projectRoot, rel);
          const text = readFile(abs);
          if (text.length === 0) continue;
          scanned += 1;
          const fileFindings = scanText(text, rel);
          for (const f of fileFindings) all.push(f);
        }
        const findings = applyAllowlist(all, allowlist.entries);
        ctx.print(`Scanned ${scanned} files; ${findings.length} finding(s) after allowlist.`);
        printFindings(ctx, findings);
        return;
      }
    },
  };
}
