/**
 * /secrets — subcommand tests using injected deps.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AppConfig, CommandContext } from '@/types/global';
import { createSecretsCommand } from '@/commands/cmd-secrets';
import { allowlistPath } from '@/security';

function makeProject(): string {
  const root = path.join(os.tmpdir(), `localcode-cmd-secrets-${crypto.randomUUID()}`);
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

describe('/secrets help (default)', () => {
  test('empty args prints usage', async () => {
    const root = makeProject();
    try {
      const sink: string[] = [];
      const cmd = createSecretsCommand();
      await cmd.execute('', makeCtx(root, sink));
      expect(sink.join('\n')).toContain('Usage:');
      expect(sink.join('\n')).toContain('/secrets scan');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/secrets scan', () => {
  test('reports clean diff when none staged', async () => {
    const root = makeProject();
    try {
      const sink: string[] = [];
      const cmd = createSecretsCommand({
        getDiff: () => '',
      });
      await cmd.execute('scan', makeCtx(root, sink));
      expect(sink.join('\n')).toContain('No staged changes');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('flags findings from injected diff source', async () => {
    const root = makeProject();
    try {
      const diff = [
        '+++ b/config.ts',
        '@@ -0,0 +1,1 @@',
        '+const k = "AKIAIOSFODNN7EXAMPLE";',
      ].join('\n');
      const sink: string[] = [];
      const cmd = createSecretsCommand({
        getDiff: () => diff,
      });
      await cmd.execute('scan', makeCtx(root, sink));
      const out = sink.join('\n');
      expect(out).toContain('Found');
      expect(out).toContain('aws-access-key');
      expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/secrets scan-all', () => {
  test('walks injected file list', async () => {
    const root = makeProject();
    try {
      const sink: string[] = [];
      const cmd = createSecretsCommand({
        listFiles: () => ['foo.ts', 'bar.ts'],
        readFile: (abs) =>
          abs.endsWith('foo.ts')
            ? 'const k = "AKIAIOSFODNN7EXAMPLE";'
            : 'export const x = 1;',
      });
      await cmd.execute('scan-all', makeCtx(root, sink));
      const out = sink.join('\n');
      expect(out).toContain('Scanned 2 files');
      expect(out).toContain('aws-access-key');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('prints empty-tracked-files message', async () => {
    const root = makeProject();
    try {
      const sink: string[] = [];
      const cmd = createSecretsCommand({
        listFiles: () => [],
        readFile: () => '',
      });
      await cmd.execute('scan-all', makeCtx(root, sink));
      expect(sink.join('\n')).toContain('No tracked files');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/secrets allow', () => {
  test('no pattern → usage', async () => {
    const root = makeProject();
    try {
      const sink: string[] = [];
      const cmd = createSecretsCommand();
      await cmd.execute('allow', makeCtx(root, sink));
      expect(sink.join('\n')).toContain('Usage: /secrets allow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('appends entry to allowlist file', async () => {
    const root = makeProject();
    try {
      const sink: string[] = [];
      const cmd = createSecretsCommand();
      await cmd.execute('allow AKIAIOSFODNN7EXAMPLE', makeCtx(root, sink));
      const file = allowlistPath(root);
      expect(fs.existsSync(file)).toBe(true);
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toContain('[[allow]]');
      expect(content).toContain('AKIAIOSFODNN7EXAMPLE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses injected appendAllow when provided', async () => {
    const root = makeProject();
    try {
      const sink: string[] = [];
      let called: { pattern: string; reason: string } | null = null;
      const cmd = createSecretsCommand({
        appendAllow: (_root, pattern, reason): string => {
          called = { pattern, reason };
          return '/tmp/fake.toml';
        },
      });
      await cmd.execute('allow MY_PATTERN', makeCtx(root, sink));
      expect(called).not.toBeNull();
      if (called !== null) {
        const cap: { pattern: string; reason: string } = called;
        expect(cap.pattern).toBe('MY_PATTERN');
      }
      expect(sink.join('\n')).toContain('/tmp/fake.toml');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
