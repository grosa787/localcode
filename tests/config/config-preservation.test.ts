/**
 * Config preservation tests for the lost-section bug.
 *
 * Symptom (user-reported): after a routine session, `~/.localcode/
 * config.toml` lost its `[agents]` block AND `[backend].apiKey`.
 *
 * Root cause: `update(partial)` round-tripped through `read() ->
 * Zod -> deepMerge -> write()`. Zod's default `strip` mode dropped
 * any TOML key it didn't recognise — so user-added blocks
 * (`[my-custom]`, future `[experimental]`) silently disappeared.
 * Same risk for forward-compat fields nested inside known sections.
 *
 * Fix audited here:
 *   - `update(partial)` now reads the raw TOML once, merges the
 *     patch into the raw object, and writes the raw object back —
 *     unknown top-level keys survive verbatim.
 *   - `write(config)` overlays the validated payload on top of the
 *     raw existing file (best-effort) so callers that go through the
 *     full-write path also preserve unknowns.
 *   - `read()` / `update()` refuse to silently reset on parse
 *     failure — a corrupt TOML file throws `ConfigReadError` rather
 *     than getting overwritten with defaults.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  ConfigManager,
  ConfigReadError,
} from '@/config/config-manager';

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-config-preserve-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Realistic TOML covering: complete required fields, an `apiKey` on
 * the backend, an `[agents]` block with `workerSlots`, the
 * `[diagnostics]` block, and a user-added `[arbitrary-future-thing]`
 * section that the schema doesn't know about.
 */
const FULL_TOML = `
[backend]
type = "openrouter"
baseUrl = "https://openrouter.ai/api/v1"
apiKey = "sk-or-secret-token-1234"

[backend.customHeaders]
"HTTP-Referer" = "https://example.com"

[model]
current = "deepseek/deepseek-coder"
available = ["deepseek/deepseek-coder", "qwen/qwen3-max"]

[onboarding]
completed = true

[permissions]
autoApprove = ["read_file"]

[context]
maxTokens = 32768
keepAliveSeconds = 1800
responseTimeoutSeconds = 300
trimToolResultsAfter = 3
autoCompressPercent = 0.8
maxRecentMessages = 20

[sound]
enabled = false
onCompletion = true
onApproval = true
onError = true
volume = 0.5

[generation]
temperature = 0.2
topP = 0.9
repeatPenalty = 1.1
maxTokens = 4096

[diagnostics]
dumpFailedRequests = true

[agents]
workerModel = "deepseek/deepseek-coder"
maxConcurrent = 3
isolation = "worktree"
approval = "auto"
defaultTimeoutSec = 600

[[agents.workerSlots]]
model = "deepseek/deepseek-coder"
skills = ["typescript"]

[[agents.workerSlots]]
model = "qwen/qwen3-max"

[arbitrary-future-thing]
hello = "world"
count = 42
nested = { foo = "bar" }
`;

describe('ConfigManager.update — unknown-section preservation', () => {
  test('simple update of model.current preserves [agents], [diagnostics], [arbitrary-future-thing], and apiKey', async () => {
    await fsWriteFile(configPath, FULL_TOML, 'utf8');
    const mgr = new ConfigManager(configPath);

    mgr.update({ model: { current: 'qwen/qwen3-max' } });

    // Re-read raw TOML from disk and assert every section survived.
    const onDisk = await readFile(configPath, 'utf8');
    const parsed = parseToml(onDisk) as Record<string, unknown>;

    // Touched field is updated.
    expect((parsed.model as Record<string, unknown>).current).toBe(
      'qwen/qwen3-max',
    );

    // apiKey + customHeaders survive.
    const backend = parsed.backend as Record<string, unknown>;
    expect(backend.apiKey).toBe('sk-or-secret-token-1234');
    expect(backend.customHeaders).toEqual({
      'HTTP-Referer': 'https://example.com',
    });

    // [agents] block survives with workerSlots.
    const agents = parsed.agents as Record<string, unknown>;
    expect(agents.workerModel).toBe('deepseek/deepseek-coder');
    expect(agents.maxConcurrent).toBe(3);
    expect(Array.isArray(agents.workerSlots)).toBe(true);
    const slots = agents.workerSlots as Array<Record<string, unknown>>;
    expect(slots).toHaveLength(2);
    expect(slots[0]?.model).toBe('deepseek/deepseek-coder');
    expect(slots[0]?.skills).toEqual(['typescript']);
    expect(slots[1]?.model).toBe('qwen/qwen3-max');

    // [diagnostics] survives with the user's flipped flag.
    const diagnostics = parsed.diagnostics as Record<string, unknown>;
    expect(diagnostics.dumpFailedRequests).toBe(true);

    // Completely-unknown user section survives verbatim.
    const arb = parsed['arbitrary-future-thing'] as Record<string, unknown>;
    expect(arb).toBeDefined();
    expect(arb.hello).toBe('world');
    expect(arb.count).toBe(42);
    expect(arb.nested).toEqual({ foo: 'bar' });
  });

  test('deeply nested update inside [backend] preserves apiKey + customHeaders', async () => {
    await fsWriteFile(configPath, FULL_TOML, 'utf8');
    const mgr = new ConfigManager(configPath);

    // Touch only baseUrl — apiKey and customHeaders must survive.
    mgr.update({ backend: { baseUrl: 'https://proxy.example.com/v1' } });

    const onDisk = await readFile(configPath, 'utf8');
    const parsed = parseToml(onDisk) as Record<string, unknown>;
    const backend = parsed.backend as Record<string, unknown>;
    expect(backend.baseUrl).toBe('https://proxy.example.com/v1');
    expect(backend.apiKey).toBe('sk-or-secret-token-1234');
    expect(backend.customHeaders).toEqual({
      'HTTP-Referer': 'https://example.com',
    });
  });

  test('addition of a new section is persisted and other sections are untouched', async () => {
    await fsWriteFile(configPath, FULL_TOML, 'utf8');
    const mgr = new ConfigManager(configPath);

    mgr.update({
      permissions: { autoApprove: ['write_file', 'run_command'] },
    });

    const reread = mgr.read();
    expect(reread.permissions.autoApprove).toEqual([
      'write_file',
      'run_command',
    ]);

    // Spot-check unknown section + apiKey still on disk.
    const onDisk = await readFile(configPath, 'utf8');
    const parsed = parseToml(onDisk) as Record<string, unknown>;
    expect(
      (parsed['arbitrary-future-thing'] as Record<string, unknown>).hello,
    ).toBe('world');
    expect((parsed.backend as Record<string, unknown>).apiKey).toBe(
      'sk-or-secret-token-1234',
    );
    expect(
      (parsed.agents as Record<string, unknown>).workerSlots,
    ).toBeDefined();
  });

  test('parse-fail on corrupt TOML raises ConfigReadError without overwriting the file', async () => {
    const corrupt = '!!! this is not valid toml !!!\nfoo = bar = baz';
    await fsWriteFile(configPath, corrupt, 'utf8');
    const mgr = new ConfigManager(configPath);

    // update() must refuse — surfacing the error rather than silently
    // resetting to defaults. The on-disk file must still be the
    // corrupt one, so the user can manually repair without losing
    // data.
    let caught: unknown = null;
    try {
      mgr.update({ model: { current: 'foo' } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigReadError);

    const onDisk = await readFile(configPath, 'utf8');
    expect(onDisk).toBe(corrupt);
  });

  test('multiple sequential updates compound while preserving unknowns', async () => {
    await fsWriteFile(configPath, FULL_TOML, 'utf8');
    const mgr = new ConfigManager(configPath);

    mgr.update({ model: { current: 'qwen/qwen3-max' } });
    mgr.update({ context: { maxTokens: 65536 } });
    mgr.update({ permissions: { autoApprove: ['read_file', 'list_dir'] } });

    const reread = mgr.read();
    expect(reread.model.current).toBe('qwen/qwen3-max');
    expect(reread.context.maxTokens).toBe(65536);
    expect(reread.permissions.autoApprove).toEqual(['read_file', 'list_dir']);

    const onDisk = await readFile(configPath, 'utf8');
    const parsed = parseToml(onDisk) as Record<string, unknown>;
    expect((parsed.backend as Record<string, unknown>).apiKey).toBe(
      'sk-or-secret-token-1234',
    );
    expect(
      (parsed['arbitrary-future-thing'] as Record<string, unknown>).hello,
    ).toBe('world');
    expect(
      (parsed.agents as Record<string, unknown>).workerSlots,
    ).toBeDefined();
    expect((parsed.diagnostics as Record<string, unknown>).dumpFailedRequests).toBe(
      true,
    );
  });

  test('write(fullConfig) on top of an existing file preserves unknown sections', async () => {
    await fsWriteFile(configPath, FULL_TOML, 'utf8');
    const mgr = new ConfigManager(configPath);

    // Read, mutate the typed view, write fully — mirrors the
    // /api/config/agents POST handler's behaviour. The arbitrary
    // unknown section must NOT be dropped.
    const cfg = mgr.read();
    cfg.model.current = 'rewritten/model';
    mgr.write(cfg);

    const onDisk = await readFile(configPath, 'utf8');
    const parsed = parseToml(onDisk) as Record<string, unknown>;
    expect((parsed.model as Record<string, unknown>).current).toBe(
      'rewritten/model',
    );
    expect(
      (parsed['arbitrary-future-thing'] as Record<string, unknown>).hello,
    ).toBe('world');
    expect((parsed.backend as Record<string, unknown>).apiKey).toBe(
      'sk-or-secret-token-1234',
    );
  });
});
