/**
 * TCP-based sync channel between paired LocalCode peers.
 *
 * Each frame on the wire:
 *
 *     +--------+--------+---------------------------+
 *     | length |  nonce | AES-GCM ciphertext + tag  |
 *     | 4 BE   | 12 B   | (length - 12) bytes       |
 *     +--------+--------+---------------------------+
 *
 * - 4-byte big-endian length prefix bounds frame size. We refuse
 *   frames > MAX_FRAME_BYTES to make the parser resistant to a hostile
 *   or buggy peer.
 * - 12-byte AES-GCM nonce travels with each frame so peers don't have
 *   to sync counter state out-of-band. The nonce is also fed into the
 *   AEAD as the IV, so a replayed nonce will fail decryption only if
 *   the ciphertext was tampered — we additionally reject nonces seen
 *   before in the current session.
 * - Ciphertext payload decodes to a UTF-8 JSON object validated against
 *   {@link SyncMessageSchema}.
 *
 * Built on `Bun.listen` / `Bun.connect` so we don't pull in `node:net`
 * shims. Every socket gets an idle timeout so a half-open connection
 * is closed instead of leaking forever.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import {
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  decryptFrame,
  encryptFrame,
} from './pairing.js';

export const MAX_FRAME_BYTES = 1 << 20; // 1 MiB hard cap per frame
export const SOCKET_IDLE_TIMEOUT_MS = 60_000;

export const SyncMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    senderId: z.string().min(1),
    version: z.string().min(1),
    sessionMetadata: z
      .object({
        sessionId: z.string().min(1),
        title: z.string().nullable().optional(),
        model: z.string().optional(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal('message'),
    senderId: z.string().min(1),
    messageId: z.string().min(1),
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('tool_call'),
    senderId: z.string().min(1),
    toolName: z.string().min(1),
    summary: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('cursor'),
    senderId: z.string().min(1),
    column: z.number().int().nonnegative().optional(),
    typing: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('disconnect'),
    senderId: z.string().min(1),
    reason: z.string().optional(),
  }),
]);

export type SyncMessage = z.infer<typeof SyncMessageSchema>;

export interface SyncPeer {
  /** Stable peer identifier; same as instanceId from discovery. */
  readonly peerId: string;
  send(msg: SyncMessage): Promise<void>;
  close(reason?: string): void;
  readonly isOpen: boolean;
}

interface ChannelOptions {
  readonly tokenBytes: Uint8Array;
  readonly peerId: string;
  readonly remoteId: string;
  readonly emit: (msg: SyncMessage) => void;
  readonly onClose: (peerId: string) => void;
  readonly socket: BunSocketLike;
}

/**
 * Minimal subset of the Bun socket we depend on. Defined as an
 * interface so tests can drive synthetic in-memory sockets without
 * touching the OS.
 */
export interface BunSocketLike {
  write(data: Uint8Array): number;
  end(): void;
  readonly remoteAddress?: string;
}

export interface LanSyncListenOptions {
  readonly port: number;
  /** Bind host. Default `0.0.0.0` (all interfaces). */
  readonly hostname?: string;
}

export type FrameDispatchHandler = (
  remoteAddress: string,
  socket: BunSocketLike,
) => SocketHandlers;

export interface SocketHandlers {
  onData: (chunk: Uint8Array) => void;
  onClose: () => void;
  onError: (err: Error) => void;
}

/**
 * Build the wire frame: [4-byte length][12-byte nonce][ciphertext].
 * The reported length covers nonce + ciphertext.
 */
export async function packFrame(
  tokenBytes: Uint8Array,
  msg: SyncMessage,
  nonceOverride?: Uint8Array,
): Promise<Uint8Array> {
  const json = JSON.stringify(msg);
  const plaintext = new TextEncoder().encode(json);
  const nonce =
    nonceOverride ?? Uint8Array.from(randomBytes(AES_GCM_NONCE_BYTES));
  if (nonce.length !== AES_GCM_NONCE_BYTES) {
    throw new Error('nonce must be 12 bytes');
  }
  const ciphertext = await encryptFrame(tokenBytes, nonce, plaintext);
  const totalPayload = nonce.length + ciphertext.length;
  if (totalPayload > MAX_FRAME_BYTES) {
    throw new Error(
      `frame payload too large: ${totalPayload} > ${MAX_FRAME_BYTES}`,
    );
  }
  const out = new Uint8Array(4 + totalPayload);
  // 4-byte BE length (excluding the 4-byte length prefix itself).
  out[0] = (totalPayload >>> 24) & 0xff;
  out[1] = (totalPayload >>> 16) & 0xff;
  out[2] = (totalPayload >>> 8) & 0xff;
  out[3] = totalPayload & 0xff;
  out.set(nonce, 4);
  out.set(ciphertext, 4 + nonce.length);
  return out;
}

/**
 * Stateful frame parser. Feed bytes via {@link push}, then drain
 * complete frames via {@link drain}. Resilient to chunk boundaries.
 */
export class FrameReader {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }

  drainFrames(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    while (this.buf.length >= 4) {
      const b0 = this.buf[0] ?? 0;
      const b1 = this.buf[1] ?? 0;
      const b2 = this.buf[2] ?? 0;
      const b3 = this.buf[3] ?? 0;
      const len = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
      if (len < 0 || len > MAX_FRAME_BYTES) {
        throw new Error(`invalid frame length: ${len}`);
      }
      if (this.buf.length < 4 + len) break; // need more bytes
      frames.push(this.buf.slice(4, 4 + len));
      this.buf = this.buf.slice(4 + len);
    }
    return frames;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}

/**
 * Unpack a single payload (nonce || ciphertext) into a validated
 * SyncMessage. Throws on decryption failure, parse failure, or
 * malformed length.
 */
export async function unpackFrame(
  tokenBytes: Uint8Array,
  payload: Uint8Array,
): Promise<SyncMessage> {
  if (payload.length < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES) {
    throw new Error('frame payload too short');
  }
  const nonce = payload.slice(0, AES_GCM_NONCE_BYTES);
  const ciphertext = payload.slice(AES_GCM_NONCE_BYTES);
  const plaintext = await decryptFrame(tokenBytes, nonce, ciphertext);
  const json = new TextDecoder().decode(plaintext);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `frame JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = SyncMessageSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`frame schema rejected: ${validated.error.message}`);
  }
  return validated.data;
}

/**
 * Active end-to-end channel between two paired peers. Wraps a single
 * Bun TCP socket. Used by both the listening and dialing sides.
 */
export class SyncChannel extends EventEmitter implements SyncPeer {
  readonly peerId: string;
  readonly remoteId: string;
  private readonly tokenBytes: Uint8Array;
  private readonly socket: BunSocketLike;
  private readonly reader = new FrameReader();
  private readonly seenNonces = new Set<string>();
  private open = true;
  private readonly onCloseExternal: (peerId: string) => void;
  private readonly emitExternal: (msg: SyncMessage) => void;

  constructor(opts: ChannelOptions) {
    super();
    this.peerId = opts.peerId;
    this.remoteId = opts.remoteId;
    this.tokenBytes = opts.tokenBytes;
    this.socket = opts.socket;
    this.emitExternal = opts.emit;
    this.onCloseExternal = opts.onClose;
  }

  get isOpen(): boolean {
    return this.open;
  }

  async send(msg: SyncMessage): Promise<void> {
    if (!this.open) throw new Error('channel is closed');
    const frame = await packFrame(this.tokenBytes, msg);
    this.socket.write(frame);
  }

  close(reason?: string): void {
    if (!this.open) return;
    this.open = false;
    try {
      // Best-effort goodbye; do NOT await to avoid blocking on a dead
      // socket.
      void this.send({
        type: 'disconnect',
        senderId: this.peerId,
        ...(reason !== undefined ? { reason } : {}),
      }).catch(() => {
        /* swallow */
      });
    } catch {
      /* swallow */
    }
    try {
      this.socket.end();
    } catch {
      /* swallow */
    }
    this.onCloseExternal(this.remoteId);
  }

  async handleData(chunk: Uint8Array): Promise<void> {
    if (!this.open) return;
    this.reader.push(chunk);
    let frames: Uint8Array[];
    try {
      frames = this.reader.drainFrames();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.close('protocol error');
      return;
    }
    for (const frame of frames) {
      const nonceHex = Buffer.from(
        frame.slice(0, AES_GCM_NONCE_BYTES),
      ).toString('hex');
      if (this.seenNonces.has(nonceHex)) {
        // Replayed nonce — refuse silently.
        continue;
      }
      this.seenNonces.add(nonceHex);
      let msg: SyncMessage;
      try {
        msg = await unpackFrame(this.tokenBytes, frame);
      } catch (err) {
        this.emit(
          'error',
          err instanceof Error ? err : new Error(String(err)),
        );
        continue;
      }
      if (msg.type === 'disconnect') {
        this.close(msg.reason);
        return;
      }
      this.emitExternal(msg);
    }
  }

  handleSocketClose(): void {
    if (!this.open) return;
    this.open = false;
    this.onCloseExternal(this.remoteId);
  }
}

export type Frame = Uint8Array;
