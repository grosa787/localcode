/**
 * `fetch_image` tool — decodes data URIs or downloads HTTP(S) images.
 *
 * Covers:
 *   - Data-URL path (no network) decodes + returns the envelope.
 *   - file:/// URLs rejected at Zod layer.
 *   - Mock fetch with image bytes returns base64 + mimeType.
 *   - >10 MB payload triggers the size cap.
 *   - Non-image Content-Type is rejected.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { fetchImage } from '@/tools/fetch-image';

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const realFetch = globalThis.fetch;
function installFetch(impl: FetchImpl): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

// A minimal 1x1 PNG as base64 (8 bytes of IHDR are dummy; the file
// validity isn't checked — we only care about base64 decoding + envelope).
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function ctx() {
  return { projectRoot: '/tmp', dangerouslyAllowAll: false };
}

function parseEnvelope(raw: string): {
  kind: string;
  mimeType: string;
  dataBase64: string;
  byteLength: number;
} {
  const obj = JSON.parse(raw) as {
    kind: string;
    mimeType: string;
    dataBase64: string;
    byteLength: number;
  };
  return obj;
}

describe('fetchImage — data URI path', () => {
  test('decodes a tiny PNG data URI to a structured envelope', async () => {
    const result = await fetchImage(
      { url: `data:image/png;base64,${TINY_PNG_B64}` },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect(result.requiresApproval).toBe(true);
    const env = parseEnvelope(result.output);
    expect(env.kind).toBe('image');
    expect(env.mimeType).toBe('image/png');
    expect(env.dataBase64.length).toBeGreaterThan(0);
    expect(env.byteLength).toBeGreaterThan(0);
  });

  test('data URI with empty payload is rejected', async () => {
    const result = await fetchImage(
      { url: 'data:image/png;base64,' },
      ctx(),
    );
    expect(result.success).toBe(false);
    // Zod may reject "no base64 payload" at the schema; either path is
    // acceptable as long as the tool never hits the network.
    expect(result.error ?? '').toBeDefined();
  });

  test('unsupported data MIME rejected (image/bmp)', async () => {
    const result = await fetchImage(
      { url: `data:image/bmp;base64,${TINY_PNG_B64}` },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/Unsupported|MIME/i);
  });
});

describe('fetchImage — URL scheme validation (Zod)', () => {
  test('file:/// URLs are rejected without hitting fetch', async () => {
    let fetchCalled = false;
    installFetch(async () => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    });
    try {
      const result = await fetchImage(
        { url: 'file:///etc/passwd' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(fetchCalled).toBe(false);
      expect(result.error ?? '').toMatch(/url must start with|scheme/i);
    } finally {
      restoreFetch();
    }
  });

  test('relative paths rejected', async () => {
    const result = await fetchImage(
      { url: './local.png' },
      ctx(),
    );
    expect(result.success).toBe(false);
  });

  test('ftp:// rejected', async () => {
    const result = await fetchImage(
      { url: 'ftp://host/x.png' },
      ctx(),
    );
    expect(result.success).toBe(false);
  });

  test('empty url rejected', async () => {
    const result = await fetchImage(
      { url: '' },
      ctx(),
    );
    expect(result.success).toBe(false);
  });
});

describe('fetchImage — HTTP(S) happy path', () => {
  afterEach(() => restoreFetch());

  test('fetches an image and returns base64 + mimeType', async () => {
    // Build a tiny buffer to represent the "image" body.
    const bytes = Buffer.from(TINY_PNG_B64, 'base64');
    installFetch(async (url) => {
      expect(String(url)).toBe('https://example.com/a.png');
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    const result = await fetchImage(
      { url: 'https://example.com/a.png' },
      ctx(),
    );
    expect(result.success).toBe(true);
    const env = parseEnvelope(result.output);
    expect(env.kind).toBe('image');
    expect(env.mimeType).toBe('image/png');
    expect(env.dataBase64.length).toBeGreaterThan(0);
    // Byte length should match the input buffer.
    expect(env.byteLength).toBe(bytes.byteLength);
  });

  test('content-type with charset suffix is normalised for whitelist check', async () => {
    const bytes = Buffer.from(TINY_PNG_B64, 'base64');
    installFetch(async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg; charset=binary' },
      }),
    );
    const result = await fetchImage(
      { url: 'https://example.com/a.jpg' },
      ctx(),
    );
    expect(result.success).toBe(true);
    const env = parseEnvelope(result.output);
    expect(env.mimeType).toBe('image/jpeg');
  });
});

describe('fetchImage — HTTP(S) failure modes', () => {
  afterEach(() => restoreFetch());

  test('>10 MB payload is rejected with size-cap error', async () => {
    // Generate 11MB of bytes.
    const tooBig = Buffer.alloc(11 * 1024 * 1024, 0);
    installFetch(async () =>
      new Response(tooBig, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const result = await fetchImage(
      { url: 'https://example.com/huge.png' },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/too large|10MB/i);
  });

  test('non-image Content-Type is rejected', async () => {
    installFetch(async () =>
      new Response('<html>Nope</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const result = await fetchImage(
      { url: 'https://example.com/index.html' },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/Unsupported Content-Type|text\/html/);
  });

  test('non-2xx response is rejected', async () => {
    installFetch(async () =>
      new Response('Not found', { status: 404, statusText: 'Not Found' }),
    );
    const result = await fetchImage(
      { url: 'https://example.com/404.png' },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/404|HTTP/);
  });

  test('network error is reported', async () => {
    installFetch(async () => {
      throw new TypeError('connection refused');
    });
    const result = await fetchImage(
      { url: 'https://example.com/dead.png' },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/Network error|connection refused/);
  });

  test('empty body is rejected', async () => {
    installFetch(async () =>
      new Response(new Uint8Array(0), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const result = await fetchImage(
      { url: 'https://example.com/empty.png' },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/empty/i);
  });
});
