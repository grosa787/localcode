/**
 * Pairing token + code derivation tests.
 */
import { describe, test, expect } from 'bun:test';

import {
  AES_GCM_NONCE_BYTES,
  counterNonce,
  decryptFrame,
  deriveCode,
  encryptFrame,
  mintPairing,
  PAIRING_CODE_LENGTH,
  PAIRING_TOKEN_BYTES,
  tokenFromHex,
  verifyCode,
  constantTimeEquals,
} from '@/networking';

describe('pairing — code derivation', () => {
  test('deriveCode is deterministic for the same token', () => {
    const token = new Uint8Array(PAIRING_TOKEN_BYTES).fill(7);
    const a = deriveCode(token);
    const b = deriveCode(token);
    expect(a).toBe(b);
    expect(a).toHaveLength(PAIRING_CODE_LENGTH);
    expect(/^\d{6}$/.test(a)).toBe(true);
  });

  test('deriveCode differs across different tokens', () => {
    const t1 = new Uint8Array(PAIRING_TOKEN_BYTES).fill(1);
    const t2 = new Uint8Array(PAIRING_TOKEN_BYTES).fill(2);
    expect(deriveCode(t1)).not.toBe(deriveCode(t2));
  });

  test('mintPairing produces a 64-hex tokenHex and a 6-digit code', () => {
    const a = mintPairing();
    expect(a.tokenHex).toHaveLength(PAIRING_TOKEN_BYTES * 2);
    expect(a.tokenBytes).toHaveLength(PAIRING_TOKEN_BYTES);
    expect(a.code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(a.expiresAt).toBeGreaterThan(a.mintedAt);
  });

  test('tokenFromHex round-trips bytes', () => {
    const a = mintPairing();
    const decoded = tokenFromHex(a.tokenHex);
    expect(decoded).toHaveLength(PAIRING_TOKEN_BYTES);
    expect(Buffer.from(decoded).toString('hex')).toBe(a.tokenHex);
  });

  test('tokenFromHex rejects malformed input', () => {
    expect(() => tokenFromHex('not hex')).toThrow();
    expect(() => tokenFromHex('abcd')).toThrow();
  });
});

describe('pairing — verifyCode', () => {
  test('returns "ok" for matching code within TTL', () => {
    const now = 1_700_000_000_000;
    const a = mintPairing({ now, ttlMs: 60_000 });
    expect(verifyCode(a, a.code, now + 1_000)).toBe('ok');
  });

  test('returns "expired" after TTL', () => {
    const now = 1_700_000_000_000;
    const a = mintPairing({ now, ttlMs: 60_000 });
    expect(verifyCode(a, a.code, now + 60_001)).toBe('expired');
  });

  test('returns "mismatch" for wrong code', () => {
    const a = mintPairing();
    const wrong = a.code === '000000' ? '111111' : '000000';
    expect(verifyCode(a, wrong)).toBe('mismatch');
  });

  test('returns "invalid" for non-6-digit input', () => {
    const a = mintPairing();
    expect(verifyCode(a, 'abc123')).toBe('invalid');
    expect(verifyCode(a, '12345')).toBe('invalid');
  });
});

describe('pairing — AES-GCM roundtrip', () => {
  test('encryptFrame / decryptFrame round-trip with counter nonce', async () => {
    const token = new Uint8Array(PAIRING_TOKEN_BYTES);
    crypto.getRandomValues(token);
    const nonce = counterNonce(42n);
    expect(nonce).toHaveLength(AES_GCM_NONCE_BYTES);
    const plaintext = new TextEncoder().encode('hello sync world');
    const ciphertext = await encryptFrame(token, nonce, plaintext);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length); // tag appended
    const back = await decryptFrame(token, nonce, ciphertext);
    expect(new TextDecoder().decode(back)).toBe('hello sync world');
  });

  test('decryptFrame fails with wrong nonce', async () => {
    const token = new Uint8Array(PAIRING_TOKEN_BYTES).fill(9);
    const plaintext = new TextEncoder().encode('secret');
    const ct = await encryptFrame(token, counterNonce(1n), plaintext);
    await expect(decryptFrame(token, counterNonce(2n), ct)).rejects.toThrow();
  });

  test('decryptFrame fails with wrong key', async () => {
    const t1 = new Uint8Array(PAIRING_TOKEN_BYTES).fill(1);
    const t2 = new Uint8Array(PAIRING_TOKEN_BYTES).fill(2);
    const nonce = counterNonce(0n);
    const ct = await encryptFrame(t1, nonce, new TextEncoder().encode('x'));
    await expect(decryptFrame(t2, nonce, ct)).rejects.toThrow();
  });
});

describe('pairing — constantTimeEquals', () => {
  test('matches equal strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
  });
  test('rejects different lengths', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });
  test('rejects different content of same length', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });
});
