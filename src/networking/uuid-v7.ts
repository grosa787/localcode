/**
 * Minimal UUIDv7 generator — millisecond timestamp prefix + 74 random
 * bits, formatted as a standard 36-char hyphenated UUID string.
 *
 * We could pull in `uuid` as a dependency, but networking is the only
 * caller and this is ~30 lines. Kept dependency-light so the lan
 * surface adds zero runtime weight when `--lan` is off.
 */

function toHex(bytes: Uint8Array): string {
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    out[i] = b.toString(16).padStart(2, '0');
  }
  return out.join('');
}

/**
 * Produce a UUIDv7-shaped string. Not strictly RFC9562-compliant
 * (we don't bother with the variant bits) but unique-enough for
 * the instance-id use case: 48 bits of monotonic time + 74 bits of
 * cryptographic randomness ≫ collision floor on a LAN.
 */
export function generateUuidV7(): string {
  const now = Date.now();
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);

  // 48-bit timestamp (big-endian) || 80 random bits.
  const tsBytes = new Uint8Array(6);
  let t = now;
  for (let i = 5; i >= 0; i -= 1) {
    tsBytes[i] = t & 0xff;
    t = Math.floor(t / 256);
  }

  const full = new Uint8Array(16);
  full.set(tsBytes, 0);
  full.set(randomBytes, 6);

  // Set version (7) into top nibble of byte 6, variant (10xx) into top
  // 2 bits of byte 8 — keeps it parseable by standard UUID readers.
  const cur6 = full[6] ?? 0;
  full[6] = (cur6 & 0x0f) | 0x70;
  const cur8 = full[8] ?? 0;
  full[8] = (cur8 & 0x3f) | 0x80;

  const hex = toHex(full);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}
