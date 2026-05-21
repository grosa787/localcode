/**
 * /sensitive — subcommand tests.
 *
 * Covers:
 *   - `/sensitive` (no args) is an alias for `/sensitive list`.
 *   - `/sensitive list` prints defaults + global + project overlays.
 *   - `/sensitive add <pattern>` writes to project-local TOML and is
 *     idempotent on a re-add of the same pattern.
 *   - `/sensitive check <path>` returns SENSITIVE / Not sensitive
 *     verdict with pattern + reason on a match.
 *   - Unknown subcommand prints usage.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AppConfig, CommandContext } from '@/types/global';
import { createSensitiveCommand } from '@/commands/cmd-sensitive';
import { projectSensitiveFilesPath } from '@/security/sensitive-files';

function makeProject(): string {
  const root = path.join(os.tmpdir(), `localcode-cmd-sensitive-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function fakeConfig(): AppConfig {
  return {
    backend: { type: 'ollama', baseUrl: 'http://localhost:11434' },
    model: { current: 'llama3.1', available: [] },
    onboarding: { completed: true },
    permissions: { autoApprove: [], profile: 'default' },
    context: {
      maxTokens: 8192,
      keepAliveSeconds: 1800,
      responseTimeoutSeconds: 300,
      trimToolResultsAfter: 3,
      autoCompressPercent: 0.8,
      maxRecentMessages: 20,
    },
    sound: {
      enabled: false,
      onCompletion: true,
      onApproval: true,
      onError: true,
      volume: 0.5,
      completionFile: null,
      approvalFile: null,
      errorFile: null,
    },
    generation: {
      temperature: 0.2,
      topP: 0.9,
      repeatPenalty: 1.1,
      maxTokens: 4096,
    },
    outputStyle: 'concise',
  };
}

function makeCtx(projectRoot: string, sink: string[]): CommandContext {
  return {
    projectRoot,
    sessionId: 'test-session',
    config: fakeConfig(),
    print: (s): void => {
      sink.push(s);
    },
    setScreen: (): void => {
      // no-op
    },
  };
}

let project: string;
beforeEach(() => {
  project = makeProject();
});
afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('/sensitive list', () => {
  test('default invocation (no args) aliases to list', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('', makeCtx(project, sink));
    const out = sink.join('\n');
    expect(out).toContain('Effective sensitive patterns:');
    expect(out).toContain('[default]');
  });

  test('explicit list prints every default pattern with source label', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('list', makeCtx(project, sink));
    const out = sink.join('\n');
    expect(out).toContain('**/.env');
    expect(out).toContain('**/secrets/**');
    expect(out).toContain('[default]');
  });

  test('project overlay entries appear with [project] tag', async () => {
    fs.mkdirSync(path.join(project, '.localcode'), { recursive: true });
    fs.writeFileSync(
      projectSensitiveFilesPath(project),
      `[[sensitive]]\npattern = "**/very-secret/**"\nreason = "Project-specific"\n`,
      'utf8',
    );
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('list', makeCtx(project, sink));
    const out = sink.join('\n');
    expect(out).toContain('[project] **/very-secret/**');
    expect(out).toContain('Project-specific');
  });
});

describe('/sensitive add', () => {
  test('add <pattern> writes a new TOML entry', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('add **/*.token', makeCtx(project, sink));
    const out = sink.join('\n');
    expect(out).toContain('Added project sensitive pattern: **/*.token');

    const target = projectSensitiveFilesPath(project);
    expect(fs.existsSync(target)).toBe(true);
    const written = fs.readFileSync(target, 'utf8');
    expect(written).toContain('[[sensitive]]');
    expect(written).toContain('pattern = "**/*.token"');
  });

  test('add is idempotent — same pattern twice does NOT append a duplicate', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('add **/*.token', makeCtx(project, sink));
    sink.length = 0;
    await cmd.execute('add **/*.token', makeCtx(project, sink));
    const out = sink.join('\n');
    expect(out).toContain('already present');

    const target = projectSensitiveFilesPath(project);
    const written = fs.readFileSync(target, 'utf8');
    const occurrences = written.split('pattern = "**/*.token"').length - 1;
    expect(occurrences).toBe(1);
  });

  test('add with no pattern prints usage', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('add', makeCtx(project, sink));
    expect(sink.join('\n')).toContain('Usage:');
    expect(sink.join('\n')).toContain('/sensitive add');
  });

  test('newly added pattern is honoured by list on the next invocation', async () => {
    const cmd = createSensitiveCommand();
    const addSink: string[] = [];
    await cmd.execute('add **/*.token', makeCtx(project, addSink));
    const listSink: string[] = [];
    await cmd.execute('list', makeCtx(project, listSink));
    const listOut = listSink.join('\n');
    expect(listOut).toContain('[project] **/*.token');
  });
});

describe('/sensitive check', () => {
  test('a default-pattern match reports SENSITIVE with pattern + reason', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute(`check ${path.join(project, '.env')}`, makeCtx(project, sink));
    const out = sink.join('\n');
    expect(out).toContain('SENSITIVE');
    expect(out).toContain('pattern:');
    expect(out).toContain('reason:');
    expect(out).toContain('source:');
  });

  test('an ordinary file is reported as Not sensitive', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute(`check ${path.join(project, 'README.md')}`, makeCtx(project, sink));
    expect(sink.join('\n')).toContain('Not sensitive');
  });

  test('check with no path prints usage', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('check', makeCtx(project, sink));
    expect(sink.join('\n')).toContain('Usage:');
  });

  test('relative paths resolve under projectRoot', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('check .env', makeCtx(project, sink));
    expect(sink.join('\n')).toContain('SENSITIVE');
  });
});

describe('/sensitive unknown subcommand', () => {
  test('prints the usage line', async () => {
    const sink: string[] = [];
    const cmd = createSensitiveCommand();
    await cmd.execute('frobnicate', makeCtx(project, sink));
    const out = sink.join('\n');
    expect(out).toContain('Unknown /sensitive subcommand');
    expect(out).toContain('/sensitive');
  });
});
