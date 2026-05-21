/**
 * Pairing handshake — derives a 6-digit OOB code from a 32-byte session
 * token via HMAC-SHA256 truncate-to-6-digits, exposes verification and
 * expiry, and provides AES-GCM helpers for the eventual encrypted
 * channel.
 *
 * The 32-byte token is the shared secret. Both peers derive the same
 * 6-digit code from it; the human reads the code aloud (or types it
 * in) to confirm both sides are talking to the right peer.
 *
 * After successful verification, both sides switch to AES-256-GCM
 * encryption keyed off the same token; nonces are 12-byte counters
 * (per spec, network-byte order). The counter starts at 0 for each
 * direction and never wraps — at 12B counter + per-message increment
 * we have more headroom than the session will ever need.
 */

import { createHmac, randomBytes } from 'node:crypto';

/** Length of the shared session secret in bytes. */
export const PAIRING_TOKEN_BYTES = 32;
/** Default expiry: 60 seconds. The spec calls for "60 seconds after generation". */
export const DEFAULT_CODE_TTL_MS = 60_000;
/** Always 6 decimal digits. */
export const PAIRING_CODE_LENGTH = 6;
/** AES-GCM nonce size in bytes (per NIST recommendation). */
export const AES_GCM_NONCE_BYTES = 12;
/** AES-GCM authentication-tag size in bytes. */
export const AES_GCM_TAG_BYTES = 16;

export interface PairingArtifact {
  /** Raw 32-byte token, hex-encoded for transport. */
  readonly tokenHex: string;
  /** Raw 32-byte token, as a Uint8Array (the actual key material). */
  readonly tokenBytes: Uint8Array;
  /** Six-digit decimal code derived from the token. */
  readonly code: string;
  /** ms-since-epoch the artifact was minted. */
  readonly mintedAt: number;
  /** ms-since-epoch the code stops verifying. */
  readonly expiresAt: number;
}

export interface PairingMintOptions {
  /** Override TTL. Defaults to {@link DEFAULT_CODE_TTL_MS}. */
  readonly ttlMs?: number;
  /** Inject a fixed token (tests). Defaults to a fresh 32 random bytes. */
  readonly tokenBytes?: Uint8Array;
  /** Inject the mint-time clock (tests). Defaults to `Date.now()`. */
  readonly now?: number;
}

/**
 * Derive a 6-digit decimal code from a token using HMAC-SHA256 with a
 * fixed salt. RFC4226-style dynamic truncation: read 4 bytes at offset
 * `digest[19] & 0x0f`, mod 10^6.
 *
 * The salt prevents code/token confusion (a 32-byte token is itself
 * not a code; deriving via HMAC makes the derivation one-way).
 */
export function deriveCode(tokenBytes: Uint8Array): string {
  const mac = createHmac('sha256', 'localcode-lan-pairing-v1');
  mac.update(Buffer.from(tokenBytes));
  const digest = mac.digest();
  const offsetByte = digest[19] ?? 0;
  const offset = offsetByte & 0x0f;
  const b0 = digest[offset] ?? 0;
  const b1 = digest[offset + 1] ?? 0;
  const b2 = digest[offset + 2] ?? 0;
  const b3 = digest[offset + 3] ?? 0;
  const truncated =
    ((b0 & 0x7f) << 24) | (b1 << 16) | (b2 << 8) | b3;
  const modded = truncated % 1_000_000;
  return modded.toString(10).padStart(PAIRING_CODE_LENGTH, '0');
}

/** Constant-time string compare. */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Mint a fresh pairing artifact. The token is never logged. */
export function mintPairing(options: PairingMintOptions = {}): PairingArtifact {
  const tokenBytes =
    options.tokenBytes ?? Uint8Array.from(randomBytes(PAIRING_TOKEN_BYTES));
  if (tokenBytes.length !== PAIRING_TOKEN_BYTES) {
    throw new Error(
      `pairing token must be ${PAIRING_TOKEN_BYTES} bytes, got ${tokenBytes.length}`,
    );
  }
  const mintedAt = options.now ?? Date.now();
  const expiresAt = mintedAt + (options.ttlMs ?? DEFAULT_CODE_TTL_MS);
  const tokenHex = Buffer.from(tokenBytes).toString('hex');
  const code = deriveCode(tokenBytes);
  return { tokenHex, tokenBytes, code, mintedAt, expiresAt };
}

/**
 * Verify a user-entered code against a pairing artifact and the
 * caller's clock. Returns one of:
 *   - 'ok'      — code matches and the artifact has not expired.
 *   - 'expired' — the artifact's TTL has elapsed.
 *   - 'mismatch'— code differs.
 *   - 'invalid' — input was malformed (not 6 digits).
 */
export type PairingVerifyResult = 'ok' | 'expired' | 'mismatch' | 'invalid';

export function verifyCode(
  artifact: PairingArtifact,
  inputCode: string,
  now: number = Date.now(),
): PairingVerifyResult {
  if (
    inputCode.length !== PAIRING_CODE_LENGTH ||
    !/^\d{6}$/.test(inputCode)
  ) {
    return 'invalid';
  }
  if (now > artifact.expiresAt) return 'expired';
  return constantTimeEquals(inputCode, artifact.code) ? 'ok' : 'mismatch';
}

/** Hex-decode a token, validating length. Throws on malformed input. */
export function tokenFromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length !== PAIRING_TOKEN_BYTES * 2) {
    throw new Error('pairing token must be 64 lowercase hex chars');
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

// ---------------------------------------------------------------
// AES-GCM helpers — used by lan-sync to encrypt every frame after
// the pairing handshake completes. Nonce supplied by the caller so
// we can run a deterministic counter on each direction.
// ---------------------------------------------------------------

/** Encode a non-negative integer counter into a 12-byte big-endian nonce. */
export function counterNonce(counter: bigint): Uint8Array {
  if (counter < 0n) throw new Error('counter must be non-negative');
  const out = new Uint8Array(AES_GCM_NONCE_BYTES);
  let c = counter;
  for (let i = AES_GCM_NONCE_BYTES - 1; i >= 0; i -= 1) {
    out[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return out;
}

let cachedKeyToken: Uint8Array | null = null;
let cachedKey: CryptoKey | null = null;

async function importAesKey(tokenBytes: Uint8Array): Promise<CryptoKey> {
  if (
    cachedKey !== null &&
    cachedKeyToken !== null &&
    cachedKeyToken.length === tokenBytes.length &&
    constantTimeBytesEqual(cachedKeyToken, tokenBytes)
  ) {
    return cachedKey;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(tokenBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  cachedKeyToken = Uint8Array.from(tokenBytes);
  cachedKey = key;
  return key;
}

/**
 * Detach a Uint8Array view into a standalone ArrayBuffer so the
 * WebCrypto type checker accepts it (TS distinguishes
 * `Uint8Array<ArrayBuffer>` from `Uint8Array<ArrayBufferLike>` —
 * passing a fresh ArrayBuffer dodges the variance entirely).
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.length);
  new Uint8Array(copy).set(view);
  return copy;
}

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return mismatch === 0;
}

export async function encryptFrame(
  tokenBytes: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(tokenBytes);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(plaintext),
  );
  return new Uint8Array(cipherBuf);
}

export async function decryptFrame(
  tokenBytes: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(tokenBytes);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(plainBuf);
}
