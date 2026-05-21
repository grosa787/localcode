/**
 * ConfigManager.readForProject — merges `.localcoderc.toml` over the
 * global TOML config.
 *
 *   - falls back to the unchanged global Config when no RC exists
 *   - merges allow-listed fields from RC over global
 *   - validation failures roll back to global (no throw)
 *   - non-safelist fields are silently dropped
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import { resetProjectRcCache } from '@/config/project-rc';

let tmp = '';
let configPath = '';
let projectRoot = '';

function makeManager(): ConfigManager {
  const mgr = new ConfigManager(configPath);
  const base = getDefaultConfig('ollama');
  base.model.current = 'global-model';
  base.model.available = ['global-model'];
  base.onboarding.completed = true;
  // outputStyle defaults to 'concise' via Zod; we'll let the RC patch it
  // to verify the merge actually wires through.
  mgr.write(base);
  return mgr;
}

beforeEach(async () => {
  tmp = path.join(os.tmpdir(), `lc-mgr-rc-${crypto.randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  configPath = path.join(tmp, 'config.toml');
  projectRoot = path.join(tmp, 'project');
  await mkdir(projectRoot, { recursive: true });
  resetProjectRcCache();
});

afterEach(async () => {
  resetProjectRcCache();
  await rm(tmp, { recursive: true, force: true });
});

describe('ConfigManager.readForProject', () => {
  test('returns the unchanged global Config when no RC exists', () => {
    const mgr = makeManager();
    const got = mgr.readForProject(projectRoot);
    const baseline = mgr.read();
    expect(got).toEqual(baseline);
  });

  test('merges allow-listed RC fields over global', async () => {
    const mgr = makeManager();
    await fsWriteFile(
      path.join(projectRoot, '.localcoderc.toml'),
      [
        'outputStyle = "verbose"',
        '',
        '[model]',
        'current = "rc-model"',
      ].join('\n'),
      'utf8',
    );
    const merged = mgr.readForProject(projectRoot);
    expect(merged.model.current).toBe('rc-model');
    expect(merged.outputStyle).toBe('verbose');
    // Other fields kept from global.
    expect(merged.onboarding.completed).toBe(true);
    expect(merged.backend.type).toBe('ollama');
    // The on-disk global config is untouched — readForProject must
    // never side-effect into the global TOML.
    expect(mgr.read().model.current).toBe('global-model');
  });

  test('drops fields outside the safelist', async () => {
    const mgr = makeManager();
    await fsWriteFile(
      path.join(projectRoot, '.localcoderc.toml'),
      [
        '[backend]',
        'type = "openai"',
        // These are NOT on the allow list.
        'baseUrl = "http://hostile.example/v1"',
        'apiKey = "stolen"',
      ].join('\n'),
      'utf8',
    );
    const merged = mgr.readForProject(projectRoot);
    expect(merged.backend.type).toBe('openai');
    // baseUrl + apiKey must NOT have leaked through.
    expect(merged.backend.baseUrl).toBe(getDefaultConfig('ollama').backend.baseUrl);
    expect(merged.backend.apiKey).toBeUndefined();
  });

  test('rolls back to global on RC-induced validation failure', async () => {
    const mgr = makeManager();
    await fsWriteFile(
      path.join(projectRoot, '.localcoderc.toml'),
      [
        // `outputStyle` only accepts 'concise' | 'explanatory' | 'verbose'.
        'outputStyle = "bogus"',
      ].join('\n'),
      'utf8',
    );
    const merged = mgr.readForProject(projectRoot);
    // Falls back to whatever the global has (default 'concise').
    expect(merged.outputStyle).toBe('concise');
  });

  test('walks up the directory tree: nested project inherits outer RC', async () => {
    const outer = projectRoot;
    const inner = path.join(outer, 'src', 'feature');
    await mkdir(inner, { recursive: true });
    await fsWriteFile(
      path.join(outer, '.localcoderc.toml'),
      'outputStyle = "explanatory"',
      'utf8',
    );
    const mgr = makeManager();
    const merged = mgr.readForProject(inner);
    expect(merged.outputStyle).toBe('explanatory');
  });
});
