/**
 * lan-sync tests — framing + encryption round-trip + parser robustness.
 *
 * We intentionally do NOT touch the real network. Bun.listen / Bun.connect
 * exposure is covered indirectly via share-coordinator.test.ts (which
 * uses a synthetic in-memory transport).
 */
import { describe, test, expect } from 'bun:test';

import {
  FrameReader,
  MAX_FRAME_BYTES,
  PAIRING_TOKEN_BYTES,
  SyncChannel,
  SyncMessageSchema,
  type BunSocketLike,
  type SyncMessage,
  packFrame,
  unpackFrame,
} from '@/networking';

function freshToken(): Uint8Array {
  const t = new Uint8Array(PAIRING_TOKEN_BYTES);
  crypto.getRandomValues(t);
  return t;
}

describe('lan-sync — packFrame / unpackFrame', () => {
  test('round-trips a hello message', async () => {
    const token = freshToken();
    const msg: SyncMessage = {
      type: 'hello',
      senderId: 'me',
      version: '1',
      sessionMetadata: {
        sessionId: 'sess-1',
        title: 'shared chat',
        model: 'gpt-test',
      },
    };
    const frame = await packFrame(token, msg);
    // 4-byte length prefix
    expect(frame.length).toBeGreaterThan(4);
    const payload = frame.slice(4);
    const decoded = await unpackFrame(token, payload);
    expect(decoded).toEqual(msg);
  });

  test('frame schema rejects unknown type', async () => {
    const token = freshToken();
    // Manually craft a payload with a bad type field.
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const bogus = JSON.stringify({ type: 'invalid' });
    const { encryptFrame } = await import('@/networking');
    const ct = await encryptFrame(token, nonce, new TextEncoder().encode(bogus));
    const payload = new Uint8Array(nonce.length + ct.length);
    payload.set(nonce, 0);
    payload.set(ct, nonce.length);
    await expect(unpackFrame(token, payload)).rejects.toThrow();
  });

  test('unpackFrame rejects tampered ciphertext', async () => {
    const token = freshToken();
    const msg: SyncMessage = {
      type: 'cursor',
      senderId: 'me',
      typing: true,
    };
    const frame = await packFrame(token, msg);
    const payload = frame.slice(4);
    const lastIdx = payload.length - 1;
    const cur = payload[lastIdx] ?? 0;
    payload[lastIdx] = cur ^ 0xff; // flip a bit in the tag
    await expect(unpackFrame(token, payload)).rejects.toThrow();
  });
});

describe('lan-sync — FrameReader', () => {
  test('drains a single complete frame', async () => {
    const token = freshToken();
    const frame = await packFrame(token, {
      type: 'cursor',
      senderId: 'me',
      typing: false,
    });
    const reader = new FrameReader();
    reader.push(frame);
    const frames = reader.drainFrames();
    expect(frames).toHaveLength(1);
    const first = frames[0];
    expect(first).toBeDefined();
    if (first) {
      const decoded = await unpackFrame(token, first);
      expect(decoded.type).toBe('cursor');
    }
  });

  test('handles split chunks across boundaries', async () => {
    const token = freshToken();
    const f1 = await packFrame(token, {
      type: 'message',
      senderId: 'me',
      messageId: 'm1',
      role: 'user',
      content: 'hi',
      ts: 1,
    });
    const f2 = await packFrame(token, {
      type: 'message',
      senderId: 'me',
      messageId: 'm2',
      role: 'assistant',
      content: 'yo',
      ts: 2,
    });
    const reader = new FrameReader();
    // Push in awkward slices.
    reader.push(f1.slice(0, 3));
    expect(reader.drainFrames()).toHaveLength(0);
    reader.push(f1.slice(3));
    const drained1 = reader.drainFrames();
    expect(drained1).toHaveLength(1);
    // Now push f2 in two halves.
    reader.push(f2.slice(0, 7));
    expect(reader.drainFrames()).toHaveLength(0);
    reader.push(f2.slice(7));
    const drained2 = reader.drainFrames();
    expect(drained2).toHaveLength(1);
  });

  test('refuses frames larger than MAX_FRAME_BYTES', () => {
    const reader = new FrameReader();
    const header = new Uint8Array(4);
    // Encode length = MAX_FRAME_BYTES + 1
    const big = MAX_FRAME_BYTES + 1;
    header[0] = (big >>> 24) & 0xff;
    header[1] = (big >>> 16) & 0xff;
    header[2] = (big >>> 8) & 0xff;
    header[3] = big & 0xff;
    reader.push(header);
    expect(() => reader.drainFrames()).toThrow();
  });
});

describe('lan-sync — SyncMessageSchema', () => {
  test('accepts all defined kinds', () => {
    const samples: SyncMessage[] = [
      { type: 'hello', senderId: 'a', version: '1', sessionMetadata: { sessionId: 's' } },
      { type: 'message', senderId: 'a', messageId: 'm', role: 'user', content: 'hi', ts: 0 },
      { type: 'tool_call', senderId: 'a', toolName: 't', summary: 'x', ts: 0 },
      { type: 'cursor', senderId: 'a' },
      { type: 'disconnect', senderId: 'a' },
    ];
    for (const s of samples) {
      const parsed = SyncMessageSchema.safeParse(s);
      expect(parsed.success).toBe(true);
    }
  });

  test('rejects message missing required fields', () => {
    const parsed = SyncMessageSchema.safeParse({ type: 'message', senderId: 'a' });
    expect(parsed.success).toBe(false);
  });
});

/** Tick a few times so chained micro-tasks (decryptFrame) complete. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('lan-sync — SyncChannel', () => {
  test('two synthetic channels exchange a message', async () => {
    const token = freshToken();
    const eventsA: SyncMessage[] = [];
    const eventsB: SyncMessage[] = [];

    let channelA: SyncChannel | null = null;
    let channelB: SyncChannel | null = null;

    const socketA: BunSocketLike = {
      write: (data) => {
        if (channelB) void channelB.handleData(data);
        return data.length;
      },
      end: () => {},
    };
    const socketB: BunSocketLike = {
      write: (data) => {
        if (channelA) void channelA.handleData(data);
        return data.length;
      },
      end: () => {},
    };

    channelA = new SyncChannel({
      tokenBytes: token,
      peerId: 'A',
      remoteId: 'B',
      socket: socketA,
      emit: (m) => eventsA.push(m),
      onClose: () => {},
    });
    channelB = new SyncChannel({
      tokenBytes: token,
      peerId: 'B',
      remoteId: 'A',
      socket: socketB,
      emit: (m) => eventsB.push(m),
      onClose: () => {},
    });

    await channelA.send({
      type: 'message',
      senderId: 'A',
      messageId: 'msg-1',
      role: 'user',
      content: 'ping',
      ts: 100,
    });
    await flush();
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]?.type).toBe('message');

    await channelB.send({
      type: 'message',
      senderId: 'B',
      messageId: 'msg-2',
      role: 'assistant',
      content: 'pong',
      ts: 200,
    });
    await flush();
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]?.type).toBe('message');
  });

  test('replayed frame is dropped', async () => {
    const token = freshToken();
    const events: SyncMessage[] = [];
    let target: SyncChannel | null = null;

    const senderSocket: BunSocketLike = {
      write: (data) => {
        if (target) {
          void target.handleData(data);
          void target.handleData(data);
        }
        return data.length;
      },
      end: () => {},
    };
    const receiverSocket: BunSocketLike = {
      write: () => 0,
      end: () => {},
    };
    const sender = new SyncChannel({
      tokenBytes: token,
      peerId: 'S',
      remoteId: 'R',
      socket: senderSocket,
      emit: () => {},
      onClose: () => {},
    });
    target = new SyncChannel({
      tokenBytes: token,
      peerId: 'R',
      remoteId: 'S',
      socket: receiverSocket,
      emit: (m) => events.push(m),
      onClose: () => {},
    });
    await sender.send({
      type: 'cursor',
      senderId: 'S',
      typing: true,
    });
    await flush();
    expect(events).toHaveLength(1);
  });
});
