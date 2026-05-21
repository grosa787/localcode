/**
 * Secret scanner — positive + negative cases for every pattern in
 * the catalog. Each test pair flags a realistic-looking fake and
 * confirms a similar-shaped non-secret stays clean.
 */

import { describe, expect, test } from 'bun:test';

import {
  formatFinding,
  redact,
  scanCommitDiff,
  scanText,
} from '@/security';

describe('scanText — pattern catalog', () => {
  test('AWS access key (positive)', () => {
    const findings = scanText('const k = "AKIAIOSFODNN7EXAMPLE";');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.kind === 'aws-access-key')).toBe(true);
  });

  test('AWS access key (negative — too short / wrong prefix)', () => {
    expect(scanText('const k = "AKIASHORT";').length).toBe(0);
    expect(scanText('const k = "PREFIX_AKIAIOSFODNN7";').length).toBe(0);
  });

  test('AWS secret access key (positive, with context)', () => {
    const text = 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const findings = scanText(text);
    expect(findings.some((f) => f.kind === 'aws-secret-access-key')).toBe(true);
  });

  test('AWS secret access key (negative — no context word)', () => {
    const text = 'random base64 wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    expect(
      scanText(text).some((f) => f.kind === 'aws-secret-access-key'),
    ).toBe(false);
  });

  test('GitHub PAT (ghp_) positive', () => {
    // Intentionally low-entropy placeholder ("FAKE" repeated 9x = 36 chars).
    // Matches our regex without tripping GitHub's secret-scanning push protection.
    const t = 'TOKEN=ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
    expect(scanText(t).some((f) => f.kind === 'github-pat')).toBe(true);
  });

  test('GitHub PAT (negative — wrong prefix)', () => {
    const t = 'TOKEN=xxx_1234567890abcdefghijklmnopqrstuvwxyz';
    expect(scanText(t).some((f) => f.kind === 'github-pat')).toBe(false);
  });

  test('OpenAI sk- key (positive)', () => {
    const t = 'OPENAI=sk-ABCDEFGHIJKLMNOPQRSTUVWX';
    const findings = scanText(t);
    expect(findings.some((f) => f.kind === 'openai-api-key')).toBe(true);
  });

  test('OpenAI proj key (positive — distinct kind)', () => {
    // Intentionally fake placeholder; matches our regex without tripping
    // GitHub's secret-scanning push protection.
    const t =
      'OPENAI=sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
    expect(scanText(t).some((f) => f.kind === 'openai-project-key')).toBe(true);
  });

  test('OpenAI sk- key (negative — too short)', () => {
    expect(scanText('VAR=sk-short').length).toBe(0);
  });

  test('Anthropic api03 (positive)', () => {
    const t =
      'ANTHROPIC=sk-ant-api03-' + 'a'.repeat(95);
    expect(scanText(t).some((f) => f.kind === 'anthropic-api-key')).toBe(true);
  });

  test('Anthropic api03 (negative — short suffix)', () => {
    const t = 'ANTHROPIC=sk-ant-api03-' + 'a'.repeat(10);
    expect(
      scanText(t).some((f) => f.kind === 'anthropic-api-key'),
    ).toBe(false);
  });

  test('Google API key (positive)', () => {
    const t = 'GOOGLE=AIza' + 'b'.repeat(35);
    expect(scanText(t).some((f) => f.kind === 'google-api-key')).toBe(true);
  });

  test('Google API key (negative — wrong shape)', () => {
    expect(scanText('GOOGLE=AIza-too-short').length).toBe(0);
  });

  test('Google service account key (positive)', () => {
    const t = '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE..."';
    expect(
      scanText(t).some((f) => f.kind === 'google-service-account-key'),
    ).toBe(true);
  });

  test('Slack token (positive)', () => {
    // Low-entropy placeholder; matches our regex without tripping GitHub's
    // secret-scanning push protection.
    const t = 'SLACK=xoxb-0-0-FAKEFAKEFAKEFAKEFAKEFAKEFAKE';
    expect(scanText(t).some((f) => f.kind === 'slack-token')).toBe(true);
  });

  test('Slack token (negative — wrong middle char)', () => {
    expect(scanText('SLACK=xoxX-1234-5678-aaa').length).toBe(0);
  });

  test('Stripe sk_live (positive)', () => {
    const t = 'STRIPE=sk_live_' + 'a'.repeat(24);
    expect(
      scanText(t).some((f) => f.kind === 'stripe-secret-key'),
    ).toBe(true);
  });

  test('Stripe sk_live (negative — test key prefix)', () => {
    expect(
      scanText('STRIPE=sk_test_' + 'a'.repeat(24)).some(
        (f) => f.kind === 'stripe-secret-key',
      ),
    ).toBe(false);
  });

  test('Stripe pk_live (positive — lower severity)', () => {
    const t = 'STRIPE=pk_live_' + 'a'.repeat(24);
    const findings = scanText(t);
    expect(
      findings.some((f) => f.kind === 'stripe-publishable-key'),
    ).toBe(true);
  });

  test('Private key PEM (positive — multiple variants)', () => {
    for (const algo of ['', 'RSA ', 'EC ', 'OPENSSH ', 'DSA ', 'PGP ']) {
      const text = `-----BEGIN ${algo}PRIVATE KEY-----\nAAAA\n-----END ${algo}PRIVATE KEY-----`;
      expect(
        scanText(text).some((f) => f.kind === 'private-key'),
      ).toBe(true);
    }
  });

  test('Private key PEM (negative — PUBLIC key)', () => {
    const text = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----';
    expect(scanText(text).some((f) => f.kind === 'private-key')).toBe(false);
  });

  test('JWT triple (positive — base64 segments)', () => {
    const t =
      'token = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(scanText(t).some((f) => f.kind === 'jwt')).toBe(true);
  });

  test('JWT triple (negative — only one dot)', () => {
    expect(scanText('x = eyJhbGciOi.eyJzdW').length).toBe(0);
  });

  test('high-entropy assignment (positive)', () => {
    // Synthetic high-entropy value (alphabet shuffle + digits).
    const t = 'api_key = "QwErTyUiOpAsDfGhJkLzXcVbNm0123456789aBcDeFgH"';
    expect(
      scanText(t).some((f) => f.kind === 'high-entropy-assignment'),
    ).toBe(true);
  });

  test('high-entropy assignment (negative — placeholder)', () => {
    expect(
      scanText('api_key = "your-key-here"').some(
        (f) => f.kind === 'high-entropy-assignment',
      ),
    ).toBe(false);
  });
});

describe('scanCommitDiff — only +-additions matter', () => {
  test('flags a secret added on a + line', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' const x = 1;',
      '+const k = "AKIAIOSFODNN7EXAMPLE";',
    ].join('\n');
    const f = scanCommitDiff(diff);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]?.file).toBe('foo.ts');
  });

  test('ignores secrets present on - lines (removals)', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,1 @@',
      '-const k = "AKIAIOSFODNN7EXAMPLE";',
      ' const x = 1;',
    ].join('\n');
    expect(scanCommitDiff(diff).length).toBe(0);
  });

  test('ignores secrets in context lines (no leading + or -)', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,2 @@',
      ' const k = "AKIAIOSFODNN7EXAMPLE";',
      '+const x = 1;',
    ].join('\n');
    expect(scanCommitDiff(diff).length).toBe(0);
  });

  test('redaction never echoes the full secret', () => {
    const diff = [
      '+++ b/secrets.ts',
      '@@ -0,0 +1,1 @@',
      '+const k = "AKIAIOSFODNN7EXAMPLE";',
    ].join('\n');
    const findings = scanCommitDiff(diff);
    expect(findings.length).toBe(1);
    const f = findings[0];
    if (f === undefined) throw new Error('expected finding');
    expect(f.redactedMatch).not.toBe(f.match);
    expect(f.redactedMatch).toContain('*');
    const line = formatFinding(f);
    expect(line).not.toContain(f.match);
  });
});

describe('redact', () => {
  test('full mask for short strings', () => {
    expect(redact('short')).toBe('*****');
  });
  test('keeps a head + tail for long values', () => {
    const out = redact('AKIAIOSFODNN7EXAMPLE');
    expect(out.startsWith('AKIA')).toBe(true);
    expect(out.endsWith('LE')).toBe(true);
    expect(out).not.toBe('AKIAIOSFODNN7EXAMPLE');
  });
});
