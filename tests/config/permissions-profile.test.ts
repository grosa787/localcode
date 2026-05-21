/**
 * Zod schema regression for the permission-profile field.
 *
 * Verifies:
 *   - every valid profile name parses cleanly,
 *   - the default profile is `'default'` (back-compat for old configs),
 *   - invalid values are rejected,
 *   - omitting the `profile` field falls through to `'default'`,
 *   - omitting the whole `permissions` block fills in the schema's
 *     default `{ autoApprove: [], profile: 'default' }`.
 */

import { describe, expect, test } from 'bun:test';

import {
  ConfigSchema,
  PermissionProfileSchema,
  PermissionsSchema,
} from '@/config/types';
import { getDefaultConfig } from '@/config/defaults';

describe('PermissionProfileSchema', () => {
  test('accepts every documented profile name', () => {
    const names = [
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ] as const;
    for (const name of names) {
      const parsed = PermissionProfileSchema.safeParse(name);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toBe(name);
    }
  });

  test('rejects unknown values', () => {
    for (const bad of [
      'allowAll',
      'block',
      '',
      ' default',
      'DEFAULT',
      null,
      0,
      undefined,
    ] as unknown[]) {
      const parsed = PermissionProfileSchema.safeParse(bad);
      expect(parsed.success).toBe(false);
    }
  });
});

describe('PermissionsSchema', () => {
  test('default is { autoApprove: [], profile: "default" }', () => {
    const parsed = PermissionsSchema.parse(undefined);
    expect(parsed.autoApprove).toEqual([]);
    expect(parsed.profile).toBe('default');
  });

  test('omitting `profile` field fills in the default', () => {
    const parsed = PermissionsSchema.parse({ autoApprove: ['write_file'] });
    expect(parsed.profile).toBe('default');
    expect(parsed.autoApprove).toEqual(['write_file']);
  });

  test('explicit profile round-trips', () => {
    const parsed = PermissionsSchema.parse({
      autoApprove: [],
      profile: 'plan',
    });
    expect(parsed.profile).toBe('plan');
  });

  test('invalid profile rejected', () => {
    const parsed = PermissionsSchema.safeParse({
      autoApprove: [],
      profile: 'allowEverything',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ConfigSchema integration', () => {
  test('omitting `permissions` block parses with the default profile', () => {
    const cfg = getDefaultConfig('ollama');
    // Strip the permissions field entirely.
    const raw = { ...cfg } as Record<string, unknown>;
    delete raw['permissions'];
    const parsed = ConfigSchema.parse(raw);
    expect(parsed.permissions.profile).toBe('default');
  });

  test('full config with profile round-trips', () => {
    const cfg = getDefaultConfig('ollama');
    cfg.permissions = { autoApprove: [], profile: 'acceptEdits' };
    const parsed = ConfigSchema.parse(cfg);
    expect(parsed.permissions.profile).toBe('acceptEdits');
  });
});
