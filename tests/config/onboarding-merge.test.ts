import { test, expect } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { mergeOnboardingResult } from '@/config/onboarding-merge';
import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import type { Config } from '@/config/types';

/**
 * Exactly what `OnboardingScreen.handleConfirm` emits: a full Config
 * where only backend / model / onboarding carry user intent and every
 * other section is schema-default filler.
 */
function onboardingResult(): Config {
  return {
    backend: { type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    model: { current: 'acme/model', available: ['acme/model'] },
    onboarding: { completed: true },
    permissions: { autoApprove: [], profile: 'default' },
    outputStyle: 'concise',
    context: {
      maxTokens: 8192,
      keepAliveSeconds: 1800,
      responseTimeoutSeconds: 300,
      trimToolResultsAfter: 5,
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
  };
}

function customisedConfig(): Config {
  return {
    ...getDefaultConfig('ollama'),
    permissions: {
      autoApprove: ['run_command', 'write_file'],
      profile: 'plan',
      batchApprovalThreshold: 3,
    },
    generation: {
      temperature: 0.9,
      topP: 0.5,
      repeatPenalty: 1.3,
      maxTokens: 8192,
    },
    context: {
      maxTokens: 65536,
      keepAliveSeconds: 900,
      responseTimeoutSeconds: 600,
      trimToolResultsAfter: 20,
      autoCompressPercent: 0.6,
      maxRecentMessages: 40,
    },
    sound: {
      enabled: true,
      onCompletion: true,
      onApproval: true,
      onError: true,
      volume: 0.9,
      completionFile: null,
      approvalFile: null,
      errorFile: null,
    },
    outputStyle: 'verbose',
    locale: 'ru',
  };
}

test('mergeOnboardingResult adopts the onboarding-owned sections', () => {
  const merged = mergeOnboardingResult(customisedConfig(), onboardingResult());
  expect(merged.backend.type).toBe('openrouter');
  expect(merged.model.current).toBe('acme/model');
  expect(merged.onboarding.completed).toBe(true);
});

test('mergeOnboardingResult preserves every section onboarding does not own', () => {
  const merged = mergeOnboardingResult(customisedConfig(), onboardingResult());
  expect(merged.permissions.profile).toBe('plan');
  expect(merged.permissions.autoApprove).toEqual(['run_command', 'write_file']);
  expect(merged.permissions.batchApprovalThreshold).toBe(3);
  expect(merged.generation.temperature).toBe(0.9);
  expect(merged.generation.maxTokens).toBe(8192);
  expect(merged.context.maxTokens).toBe(65536);
  expect(merged.context.trimToolResultsAfter).toBe(20);
  expect(merged.sound.enabled).toBe(true);
  expect(merged.outputStyle).toBe('verbose');
  expect(merged.locale).toBe('ru');
});

test('mergeOnboardingResult passes the result through on a genuine first run', () => {
  const onboarded = onboardingResult();
  expect(mergeOnboardingResult(null, onboarded)).toEqual(onboarded);
});

// Round-trip through ConfigManager: `write` only preserves keys ABSENT
// from the payload, so the merge is what actually keeps the settings.
test('--reconfigure round-trip does not reset persisted settings on disk', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `lc-reconf-${crypto.randomUUID()}-`));
  try {
    const cm = new ConfigManager(path.join(dir, 'config.toml'));
    cm.write(customisedConfig());

    // What app.tsx's onOnboardComplete now does.
    cm.write(mergeOnboardingResult(cm.read(), onboardingResult()));

    const after = cm.read();
    expect(after.backend.type).toBe('openrouter');
    expect(after.model.current).toBe('acme/model');
    expect(after.permissions.profile).toBe('plan');
    expect(after.permissions.autoApprove).toEqual(['run_command', 'write_file']);
    expect(after.permissions.batchApprovalThreshold).toBe(3);
    expect(after.generation.temperature).toBe(0.9);
    expect(after.context.maxTokens).toBe(65536);
    expect(after.outputStyle).toBe('verbose');
    expect(after.locale).toBe('ru');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
