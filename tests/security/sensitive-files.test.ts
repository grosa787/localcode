/**
 * Sensitive-files loader + matcher tests.
 *
 * Covers:
 *   - Defaults load with no config files on disk.
 *   - Global overlay extends defaults.
 *   - Project-local overlay extends global + defaults; same-pattern
 *     overlay wins on `reason` and upgrades `source`.
 *   - Glob subset: `**`, `*`, `{a,b}`, `?`, leading-dot, basename match.
 *   - Negative cases: ordinary source files don't match.
 *   - Malformed TOML is skipped without throwing; defaults stay active.
 *   - Case-insensitive match works on darwin (the test platform).
 *   - SensitiveMatch carries `pattern`, `reason`, `source`.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_SENSITIVE_PATTERNS,
  globalSensitiveFilesPath,
  isSensitivePath,
  loadSensitiveFiles,
  projectSensitiveFilesPath,
} from '@/security/sensitive-files';

interface Scratch {
  home: string;
  project: string;
}

function mkScratch(): Scratch {
  const root = path.join(os.tmpdir(), `localcode-sensitive-${crypto.randomUUID()}`);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { home, project };
}

function rmScratch(s: Scratch): void {
  // Tear down both home and project — they share a parent.
  const parent = path.dirname(s.home);
  fs.rmSync(parent, { recursive: true, force: true });
}

function writeOverlay(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

let scratch: Scratch;
beforeEach(() => {
  scratch = mkScratch();
});
afterEach(() => {
  rmScratch(scratch);
});

describe('loadSensitiveFiles — defaults', () => {
  test('returns defaults when no overlay files exist', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    expect(cfg.patterns.length).toBe(DEFAULT_SENSITIVE_PATTERNS.length);
    for (const p of cfg.patterns) {
      expect(p.source).toBe('default');
      expect(p.pattern.length).toBeGreaterThan(0);
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });

  test('matches all common default patterns', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const patterns = cfg.patterns.map((p) => p.pattern);
    expect(patterns).toContain('**/.env');
    expect(patterns).toContain('**/.env.*');
    expect(patterns).toContain('**/secrets/**');
    expect(patterns).toContain('**/*.pem');
    expect(patterns).toContain('**/*.key');
    expect(patterns).toContain('**/.aws/**');
    expect(patterns).toContain('**/.ssh/**');
  });
});

describe('loadSensitiveFiles — global overlay', () => {
  test('extends defaults with new patterns', () => {
    writeOverlay(
      globalSensitiveFilesPath(scratch.home),
      `[[sensitive]]\npattern = "**/*.tfvars"\nreason = "Terraform variables may carry secrets"\n`,
    );
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const found = cfg.patterns.find((p) => p.pattern === '**/*.tfvars');
    expect(found).toBeDefined();
    expect(found?.source).toBe('global');
    expect(found?.reason).toBe('Terraform variables may carry secrets');
  });

  test('overrides a default reason when pattern collides; source becomes global', () => {
    writeOverlay(
      globalSensitiveFilesPath(scratch.home),
      `[[sensitive]]\npattern = "**/.env"\nreason = "Custom global reason"\n`,
    );
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const env = cfg.patterns.find((p) => p.pattern === '**/.env');
    expect(env).toBeDefined();
    expect(env?.reason).toBe('Custom global reason');
    expect(env?.source).toBe('global');
  });
});

describe('loadSensitiveFiles — project overlay', () => {
  test('extends defaults + global', () => {
    writeOverlay(
      globalSensitiveFilesPath(scratch.home),
      `[[sensitive]]\npattern = "**/*.tfvars"\n`,
    );
    writeOverlay(
      projectSensitiveFilesPath(scratch.project),
      `[[sensitive]]\npattern = "**/config/prod/**"\nreason = "Production config"\n`,
    );
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const project = cfg.patterns.find((p) => p.pattern === '**/config/prod/**');
    expect(project?.source).toBe('project');
    expect(project?.reason).toBe('Production config');
    const global = cfg.patterns.find((p) => p.pattern === '**/*.tfvars');
    expect(global?.source).toBe('global');
  });

  test('project pattern wins over a colliding global one', () => {
    writeOverlay(
      globalSensitiveFilesPath(scratch.home),
      `[[sensitive]]\npattern = "**/.env"\nreason = "Global reason"\n`,
    );
    writeOverlay(
      projectSensitiveFilesPath(scratch.project),
      `[[sensitive]]\npattern = "**/.env"\nreason = "Project reason"\n`,
    );
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const env = cfg.patterns.find((p) => p.pattern === '**/.env');
    expect(env?.source).toBe('project');
    expect(env?.reason).toBe('Project reason');
  });
});

describe('isSensitivePath — glob matching', () => {
  test('matches `**/secrets/**` against a nested file', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, 'apps', 'web', 'secrets', 'cookie.txt'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(true);
    if (result.sensitive) {
      expect(result.pattern).toBe('**/secrets/**');
    }
  });

  test('matches `*.pem` via the `**/*.pem` default', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, 'certs', 'ca.pem'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(true);
  });

  test('matches `.env.local` via the `**/.env.*` default', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, '.env.local'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(true);
  });

  test('matches a bare basename — `.env` lives at the project root', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, '.env'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(true);
  });

  test('alternation `{ext1,ext2}` matches both sides', () => {
    writeOverlay(
      projectSensitiveFilesPath(scratch.project),
      `[[sensitive]]\npattern = "**/*.{pfx,p12}"\nreason = "PKCS12 bundles"\n`,
    );
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const left = isSensitivePath(
      path.join(scratch.project, 'a', 'b.pfx'),
      scratch.project,
      cfg,
    );
    const right = isSensitivePath(
      path.join(scratch.project, 'a', 'b.p12'),
      scratch.project,
      cfg,
    );
    expect(left.sensitive).toBe(true);
    expect(right.sensitive).toBe(true);
  });

  test('single-char `?` matches exactly one char within a segment', () => {
    writeOverlay(
      projectSensitiveFilesPath(scratch.project),
      `[[sensitive]]\npattern = "key?.txt"\n`,
    );
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const match = isSensitivePath(
      path.join(scratch.project, 'key1.txt'),
      scratch.project,
      cfg,
    );
    const noMatch = isSensitivePath(
      path.join(scratch.project, 'key12.txt'),
      scratch.project,
      cfg,
    );
    expect(match.sensitive).toBe(true);
    expect(noMatch.sensitive).toBe(false);
  });
});

describe('isSensitivePath — negative cases', () => {
  test('plain source file is not sensitive', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, 'src', 'index.ts'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(false);
  });

  test('README markdown is not sensitive', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, 'README.md'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(false);
  });

  test('empty patterns returns not-sensitive shortcut', () => {
    const result = isSensitivePath(
      path.join(scratch.project, '.env'),
      scratch.project,
      { patterns: [] },
    );
    expect(result.sensitive).toBe(false);
  });
});

describe('loadSensitiveFiles — malformed TOML', () => {
  test('invalid TOML is skipped silently; defaults still apply', () => {
    writeOverlay(
      globalSensitiveFilesPath(scratch.home),
      `this is = not [ valid ::: toml`,
    );
    const originalWarn = console.warn;
    try {
      console.warn = () => {
        // swallow loader warning
      };
      const cfg = loadSensitiveFiles(scratch.project, scratch.home);
      // Defaults still active.
      expect(cfg.patterns.length).toBe(DEFAULT_SENSITIVE_PATTERNS.length);
      const env = cfg.patterns.find((p) => p.pattern === '**/.env');
      expect(env?.source).toBe('default');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('schema violation (non-string pattern) is skipped silently', () => {
    writeOverlay(
      projectSensitiveFilesPath(scratch.project),
      `[[sensitive]]\npattern = 42\n`,
    );
    const originalWarn = console.warn;
    try {
      console.warn = () => {
        // swallow loader warning
      };
      const cfg = loadSensitiveFiles(scratch.project, scratch.home);
      expect(cfg.patterns.length).toBe(DEFAULT_SENSITIVE_PATTERNS.length);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('SensitiveMatch shape', () => {
  test('positive match returns { sensitive, pattern, reason, source }', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, '.env'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(true);
    if (result.sensitive) {
      expect(typeof result.pattern).toBe('string');
      expect(typeof result.reason).toBe('string');
      expect(result.source === 'default' || result.source === 'global' || result.source === 'project').toBe(true);
    }
  });

  test('negative match returns { sensitive: false }', () => {
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, 'package.json'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(false);
  });
});

describe('Case-insensitive matching on darwin/win32', () => {
  test('uppercase `.ENV` still matches `**/.env`', () => {
    // The matcher uses `process.platform` directly; on CI we only
    // assert this path matches when running on darwin (the local test
    // platform per CLAUDE.md). On linux this would correctly return
    // not-sensitive, so we guard the assertion.
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return;
    }
    const cfg = loadSensitiveFiles(scratch.project, scratch.home);
    const result = isSensitivePath(
      path.join(scratch.project, '.ENV'),
      scratch.project,
      cfg,
    );
    expect(result.sensitive).toBe(true);
  });
});
