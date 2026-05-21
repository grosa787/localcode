/**
 * Allowlist tests — string + regex matching, malformed TOML rejection.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyAllowlist,
  allowlistPath,
  isAllowed,
  loadAllowlist,
  type Finding,
} from '@/security';

function makeProject(): string {
  const root = path.join(os.tmpdir(), `localcode-allowlist-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, '.localcode'), { recursive: true });
  return root;
}

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    kind: 'aws-access-key',
    severity: 'critical',
    confidence: 1.0,
    match: 'AKIAIOSFODNN7EXAMPLE',
    redactedMatch: 'AKIA**********PLE',
    line: 1,
    ...over,
  };
}

describe('loadAllowlist — file resolution', () => {
  test('missing file → empty entries, no errors', () => {
    const root = makeProject();
    try {
      const out = loadAllowlist(root);
      expect(out.entries.length).toBe(0);
      expect(out.errors.length).toBe(0);
      expect(out.filePath).toBe(allowlistPath(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('parses literal patterns + regex entries', () => {
    const root = makeProject();
    try {
      const toml = [
        '[[allow]]',
        'pattern = "AKIAIOSFODNN7EXAMPLE"',
        'reason  = "demo string"',
        '',
        '[[allow]]',
        'regex   = "^EXAMPLE_KEY_"',
        'reason  = "fixtures"',
      ].join('\n');
      fs.writeFileSync(allowlistPath(root), toml, 'utf8');
      const out = loadAllowlist(root);
      expect(out.errors.length).toBe(0);
      expect(out.entries.length).toBe(2);
      expect(out.entries[0]?.pattern).toBe('AKIAIOSFODNN7EXAMPLE');
      expect(out.entries[1]?.regex?.source).toBe('^EXAMPLE_KEY_');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects malformed TOML with descriptive error', () => {
    const root = makeProject();
    try {
      fs.writeFileSync(allowlistPath(root), '[[allow', 'utf8');
      const out = loadAllowlist(root);
      expect(out.entries.length).toBe(0);
      expect(out.errors.length).toBeGreaterThan(0);
      expect(out.errors.join('\n').toLowerCase()).toContain('parse');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects entry with neither pattern nor regex', () => {
    const root = makeProject();
    try {
      fs.writeFileSync(
        allowlistPath(root),
        '[[allow]]\nreason = "incomplete"\n',
        'utf8',
      );
      const out = loadAllowlist(root);
      expect(out.entries.length).toBe(0);
      expect(out.errors.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects entry with both pattern and regex', () => {
    const root = makeProject();
    try {
      fs.writeFileSync(
        allowlistPath(root),
        '[[allow]]\npattern = "foo"\nregex = "bar"\n',
        'utf8',
      );
      const out = loadAllowlist(root);
      expect(out.errors.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('captures invalid regex compile errors', () => {
    const root = makeProject();
    try {
      fs.writeFileSync(
        allowlistPath(root),
        '[[allow]]\nregex = "([unclosed"\n',
        'utf8',
      );
      const out = loadAllowlist(root);
      // Validates: malformed regex → empty entry + error
      expect(out.errors.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isAllowed / applyAllowlist', () => {
  test('empty allowlist allows nothing', () => {
    expect(isAllowed(makeFinding(), [])).toBe(false);
  });

  test('literal pattern matches exactly', () => {
    const entries = [
      { raw: { pattern: 'AKIAIOSFODNN7EXAMPLE' }, pattern: 'AKIAIOSFODNN7EXAMPLE' },
    ];
    expect(isAllowed(makeFinding(), entries)).toBe(true);
    expect(isAllowed(makeFinding({ match: 'OTHER' }), entries)).toBe(false);
  });

  test('regex pattern matches via test()', () => {
    const entries = [
      { raw: { regex: '^AKIA' }, regex: /^AKIA/ },
    ];
    expect(isAllowed(makeFinding(), entries)).toBe(true);
    expect(isAllowed(makeFinding({ match: 'XKIAIOSFODNN' }), entries)).toBe(false);
  });

  test('applyAllowlist filters out matched findings', () => {
    const entries = [
      { raw: { pattern: 'KEEP_ME' }, pattern: 'KEEP_ME' },
    ];
    const findings = [
      makeFinding({ match: 'KEEP_ME' }),
      makeFinding({ match: 'BLOCKED' }),
    ];
    const out = applyAllowlist(findings, entries);
    expect(out.length).toBe(1);
    expect(out[0]?.match).toBe('BLOCKED');
  });
});
