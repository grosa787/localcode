/**
 * ShareCoordinator — high-level orchestrator that glues mDNS discovery,
 * pairing, and the encrypted sync channel together.
 *
 * Lifecycle:
 *   1. Caller wires a `--lan` LocalCode by constructing a
 *      ShareCoordinator with the local SessionManager and a port
 *      number. The coordinator starts an mDNS advertise +
 *      subscribe and a TCP listener.
 *   2. User on host A invokes `/share start` → coordinator mints a
 *      pairing artifact, returns the 6-digit code, and records the
 *      session as "shareable". The artifact lives in-memory only.
 *   3. User on host B types `/share accept <peer-id> <code>` → the
 *      coordinator dials the peer's TCP endpoint, exchanges a
 *      pairing handshake (the 6-digit code proves both sides share
 *      the same token), and on success opens an encrypted SyncChannel.
 *   4. Both sides ferry chat messages through the channel; the
 *      SessionManager's `lanSyncBridge` (LAN-SYNC-SECTION) calls
 *      `broadcastMessage` whenever a row lands locally so the peer
 *      sees it too.
 *
 * Network handling is deliberately split into a `BunTransport`
 * interface so tests can substitute an in-process loopback.
 */

import { EventEmitter } from 'node:events';

import {
  type DiscoveredPeer,
  LanDiscovery,
  type LanDiscoveryOptions,
} from './lan-discovery.js';
import {
  DEFAULT_CODE_TTL_MS,
  mintPairing,
  type PairingArtifact,
  tokenFromHex,
  verifyCode,
} from './pairing.js';
import {
  SyncChannel,
  type BunSocketLike,
  type SyncMessage,
  packFrame,
  unpackFrame,
} from './lan-sync.js';

export type ShareMode = 'view' | 'edit';

export interface ShareSession {
  readonly sessionId: string;
  readonly mode: ShareMode;
  readonly artifact: PairingArtifact;
}

export interface StartShareResult {
  readonly code: string;
  readonly peerUrl: string;
  readonly expiresAt: number;
}

export interface AcceptShareResult {
  readonly sessionId: string;
}

export interface BunListenHandle {
  stop(): Promise<void> | void;
  readonly port: number;
}

export interface BunTransportConnectArgs {
  readonly host: string;
  readonly port: number;
  readonly onData: (chunk: Uint8Array) => void;
  readonly onClose: () => void;
  readonly onError: (err: Error) => void;
  /**
   * Fires once the underlying TCP connection is open. Receives the
   * wrapped socket directly so the caller can `write()` the handshake
   * synchronously inside this callback — at this point the
   * transport's `connect(...)` promise has not yet resolved, so the
   * caller's local `socket` variable is still in the TDZ.
   */
  readonly onOpen: (socket: BunSocketLike) => void;
}

export interface BunTransport {
  listen(
    port: number,
    hostname: string,
    onAccept: (socket: BunSocketLike, onData: (chunk: Uint8Array) => void, onClose: () => void) => void,
  ): Promise<BunListenHandle>;
  connect(args: BunTransportConnectArgs): Promise<BunSocketLike>;
}

export interface ShareCoordinatorOptions {
  readonly instanceId?: string;
  readonly displayName?: string;
  readonly port: number;
  readonly hostname?: string;
  /** Inject a fake discovery (tests). */
  readonly discovery?: LanDiscovery;
  readonly discoveryOptions?: Partial<LanDiscoveryOptions>;
  /** Inject a fake transport (tests). */
  readonly transport?: BunTransport;
  /** Generator for "now" (tests). */
  readonly now?: () => number;
}

interface PendingDial {
  readonly peerId: string;
  readonly code: string;
}

/**
 * Tiny handshake frame shape used by acceptShare. Sent as plaintext
 * JSON length-prefixed (NOT AES-encrypted; the code is the secret).
 *
 *   { v: 1, code: '123456', dialerId: 'uuid' }
 *
 * On success, the listener replies with `{ v: 1, ok: true, sessionId,
 * sharerId }`. From then on the channel switches to encrypted mode.
 *
 * NOTE: the 6-digit code travels in the clear over the TCP socket —
 * that's why the code is short-lived (60s) and only useful as a
 * confirmation gate on top of the discovered peer identity. The full
 * 32-byte token never crosses the wire; both sides derive it
 * independently via their own pairing artifact (one was minted by the
 * sharer, the dialer reproduces it via the user-typed code matching
 * the sharer's known artifact). For symmetric AES later, the sharer
 * sends the 32-byte token only AFTER the code matches.
 */

export interface CoordinatorEvents {
  'peer-discovered': (peer: DiscoveredPeer) => void;
  'peer-left': (instanceId: string) => void;
  'share-started': (sessionId: string, code: string) => void;
  'share-stopped': (sessionId: string) => void;
  'sync-message': (peerId: string, msg: SyncMessage) => void;
  'sync-channel-open': (peerId: string) => void;
  'sync-channel-closed': (peerId: string) => void;
}

export class ShareCoordinator extends EventEmitter {
  readonly discovery: LanDiscovery;
  readonly port: number;
  readonly hostname: string;
  private readonly transport: BunTransport;
  private readonly now: () => number;
  private listenHandle: BunListenHandle | null = null;
  private readonly shares = new Map<string, ShareSession>();
  private readonly channels = new Map<string, SyncChannel>();
  /** Outgoing pending dials keyed by remote peerId. */
  private readonly pendingDials = new Map<string, PendingDial>();
  private started = false;

  constructor(opts: ShareCoordinatorOptions) {
    super();
    this.port = opts.port;
    this.hostname = opts.hostname ?? '0.0.0.0';
    this.now = opts.now ?? ((): number => Date.now());
    this.discovery =
      opts.discovery ??
      new LanDiscovery({
        port: opts.port,
        ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
        ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
        ...(opts.discoveryOptions ?? {}),
      });
    this.discovery.on('peer-discovered', (peer: DiscoveredPeer) =>
      this.emit('peer-discovered', peer),
    );
    this.discovery.on('peer-left', (id: string) => {
      this.channels.get(id)?.close('peer departed');
      this.channels.delete(id);
      this.emit('peer-left', id);
    });
    this.transport = opts.transport ?? defaultTransport();
  }

  get instanceId(): string {
    return this.discovery.instanceId;
  }

  get displayName(): string {
    return this.discovery.displayName;
  }

  listPeers(): DiscoveredPeer[] {
    return this.discovery.listPeers();
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.listenHandle = await this.transport.listen(
      this.port,
      this.hostname,
      (socket, _onData, _onClose) => this.handleIncomingSocket(socket),
    );
    this.discovery.start();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const ch of this.channels.values()) {
      ch.close('coordinator shutdown');
    }
    this.channels.clear();
    this.shares.clear();
    this.pendingDials.clear();
    try {
      await this.discovery.stop();
    } catch {
      /* swallow */
    }
    try {
      if (this.listenHandle) await this.listenHandle.stop();
    } catch {
      /* swallow */
    }
    this.listenHandle = null;
  }

  /**
   * Begin sharing `sessionId`. Returns the 6-digit code and a `peerUrl`
   * the user can hand to the remote peer (informational — the real
   * lookup happens via mDNS discovery).
   */
  startSharing(sessionId: string, mode: ShareMode = 'view'): StartShareResult {
    if (!this.started) throw new Error('coordinator not started');
    const existing = this.shares.get(sessionId);
    if (existing && existing.artifact.expiresAt > this.now()) {
      return {
        code: existing.artifact.code,
        peerUrl: this.peerUrl(),
        expiresAt: existing.artifact.expiresAt,
      };
    }
    const artifact = mintPairing({ now: this.now() });
    this.shares.set(sessionId, { sessionId, mode, artifact });
    this.emit('share-started', sessionId, artifact.code);
    return {
      code: artifact.code,
      peerUrl: this.peerUrl(),
      expiresAt: artifact.expiresAt,
    };
  }

  stopSharing(sessionId: string): boolean {
    const removed = this.shares.delete(sessionId);
    if (removed) {
      this.emit('share-stopped', sessionId);
    }
    return removed;
  }

  isSharing(sessionId: string): boolean {
    const share = this.shares.get(sessionId);
    if (!share) return false;
    return share.artifact.expiresAt > this.now();
  }

  /**
   * Dial a discovered peer and present the 6-digit code. On success
   * the coordinator opens a SyncChannel and returns the session id
   * the sharer assigned to it.
   */
  async acceptShare(peerInstanceId: string, code: string): Promise<AcceptShareResult> {
    if (!this.started) throw new Error('coordinator not started');
    const peer = this.discovery.getPeer(peerInstanceId);
    if (peer === null) {
      throw new Error(`no such peer: ${peerInstanceId}`);
    }
    if (this.channels.has(peerInstanceId)) {
      throw new Error(`already connected to ${peerInstanceId}`);
    }
    this.pendingDials.set(peerInstanceId, { peerId: peerInstanceId, code });
    let openResolve: (() => void) | null = null;
    let openReject: ((err: Error) => void) | null = null;
    const openPromise = new Promise<void>((resolve, reject) => {
      openResolve = resolve;
      openReject = reject;
    });
    const dataBuffer: Uint8Array[] = [];
    let sessionId: string | null = null;
    let handshakeDone = false;
    let liveSocket: BunSocketLike | null = null;
    const socket = await this.transport.connect({
      host: peer.host,
      port: peer.port,
      onOpen: (sock): void => {
        liveSocket = sock;
        const handshakeBody = JSON.stringify({
          v: 1,
          code,
          dialerId: this.instanceId,
        });
        const bytes = new TextEncoder().encode(handshakeBody);
        sock.write(prefix4(bytes));
      },
      onData: (chunk): void => {
        if (handshakeDone) return;
        const activeSocket = liveSocket;
        if (activeSocket === null) return;
        dataBuffer.push(chunk);
        const merged = mergeChunks(dataBuffer);
        if (merged.length < 4) return;
        const len =
          ((merged[0] ?? 0) << 24) |
          ((merged[1] ?? 0) << 16) |
          ((merged[2] ?? 0) << 8) |
          (merged[3] ?? 0);
        if (merged.length < 4 + len) return;
        const body = merged.slice(4, 4 + len);
        const remaining = merged.slice(4 + len);
        dataBuffer.length = 0;
        if (remaining.length > 0) dataBuffer.push(remaining);
        let reply: { ok?: boolean; error?: string; sessionId?: string; sharerId?: string; tokenHex?: string };
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
          if (parsed === null || typeof parsed !== 'object') {
            throw new Error('handshake reply not an object');
          }
          reply = parsed as typeof reply;
        } catch (err) {
          openReject?.(err instanceof Error ? err : new Error(String(err)));
          activeSocket.end();
          return;
        }
        if (reply.ok !== true || typeof reply.tokenHex !== 'string' || typeof reply.sessionId !== 'string' || typeof reply.sharerId !== 'string') {
          openReject?.(new Error(reply.error ?? 'handshake rejected'));
          activeSocket.end();
          return;
        }
        sessionId = reply.sessionId;
        const tokenBytes = tokenFromHex(reply.tokenHex);
        const channel = new SyncChannel({
          tokenBytes,
          peerId: this.instanceId,
          remoteId: peerInstanceId,
          socket: activeSocket,
          emit: (msg) => this.emit('sync-message', peerInstanceId, msg),
          onClose: (id) => {
            this.channels.delete(id);
            this.emit('sync-channel-closed', id);
          },
        });
        this.channels.set(peerInstanceId, channel);
        this.installChannelDataPump(activeSocket, channel);
        handshakeDone = true;
        if (dataBuffer.length > 0) {
          const rest = mergeChunks(dataBuffer);
          dataBuffer.length = 0;
          void channel.handleData(rest);
        }
        this.emit('sync-channel-open', peerInstanceId);
        openResolve?.();
      },
      onClose: (): void => {
        this.channels.get(peerInstanceId)?.handleSocketClose();
        this.channels.delete(peerInstanceId);
        this.pendingDials.delete(peerInstanceId);
        if (!handshakeDone) {
          openReject?.(new Error('socket closed before handshake completed'));
        }
      },
      onError: (err): void => {
        if (!handshakeDone) openReject?.(err);
      },
    });
    void socket; // already referenced
    await openPromise;
    if (sessionId === null) {
      throw new Error('handshake reply missing sessionId');
    }
    return { sessionId };
  }

  /** Broadcast a sync message to every open channel. */
  async broadcast(msg: SyncMessage): Promise<void> {
    const errors: unknown[] = [];
    for (const channel of this.channels.values()) {
      try {
        await channel.send(msg);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      // surface first error but don't throw — broadcast is best-effort
      const first = errors[0];
      this.emit(
        'error',
        first instanceof Error ? first : new Error(String(first)),
      );
    }
  }

  listChannels(): readonly string[] {
    return [...this.channels.keys()];
  }

  getSharedSession(sessionId: string): ShareSession | null {
    const share = this.shares.get(sessionId);
    if (!share) return null;
    if (share.artifact.expiresAt <= this.now()) return null;
    return share;
  }

  private peerUrl(): string {
    return `localcode://${this.discovery.instanceId}@${this.hostname}:${this.port}`;
  }

  private handleIncomingSocket(socket: BunSocketLike): void {
    let handshakeDone = false;
    const dataBuffer: Uint8Array[] = [];
    let channel: SyncChannel | null = null;
    const onData = (chunk: Uint8Array): void => {
      if (handshakeDone) {
        if (channel) void channel.handleData(chunk);
        return;
      }
      dataBuffer.push(chunk);
      const merged = mergeChunks(dataBuffer);
      if (merged.length < 4) return;
      const len =
        ((merged[0] ?? 0) << 24) |
        ((merged[1] ?? 0) << 16) |
        ((merged[2] ?? 0) << 8) |
        (merged[3] ?? 0);
      if (merged.length < 4 + len) return;
      const body = merged.slice(4, 4 + len);
      const remaining = merged.slice(4 + len);
      dataBuffer.length = 0;
      if (remaining.length > 0) dataBuffer.push(remaining);
      let parsed: { v?: number; code?: string; dialerId?: string };
      try {
        const raw: unknown = JSON.parse(new TextDecoder().decode(body));
        if (raw === null || typeof raw !== 'object') {
          throw new Error('handshake not an object');
        }
        parsed = raw as typeof parsed;
      } catch {
        this.writeReply(socket, { ok: false, error: 'malformed handshake' });
        socket.end();
        return;
      }
      const code = typeof parsed.code === 'string' ? parsed.code : '';
      const dialerId = typeof parsed.dialerId === 'string' ? parsed.dialerId : '';
      if (code.length === 0 || dialerId.length === 0) {
        this.writeReply(socket, { ok: false, error: 'missing code or dialerId' });
        socket.end();
        return;
      }
      // Find a share whose code matches.
      let matchedSessionId: string | null = null;
      let matchedArtifact: PairingArtifact | null = null;
      for (const share of this.shares.values()) {
        const verdict = verifyCode(share.artifact, code, this.now());
        if (verdict === 'ok') {
          matchedSessionId = share.sessionId;
          matchedArtifact = share.artifact;
          break;
        }
      }
      if (matchedSessionId === null || matchedArtifact === null) {
        this.writeReply(socket, { ok: false, error: 'invalid or expired code' });
        socket.end();
        return;
      }
      this.writeReply(socket, {
        ok: true,
        sessionId: matchedSessionId,
        sharerId: this.instanceId,
        tokenHex: matchedArtifact.tokenHex,
      });
      channel = new SyncChannel({
        tokenBytes: matchedArtifact.tokenBytes,
        peerId: this.instanceId,
        remoteId: dialerId,
        socket,
        emit: (msg) => this.emit('sync-message', dialerId, msg),
        onClose: (id) => {
          this.channels.delete(id);
          this.emit('sync-channel-closed', id);
        },
      });
      this.channels.set(dialerId, channel);
      handshakeDone = true;
      this.emit('sync-channel-open', dialerId);
      if (dataBuffer.length > 0) {
        const rest = mergeChunks(dataBuffer);
        dataBuffer.length = 0;
        void channel.handleData(rest);
      }
    };
    // Bun's listen `socket` callback already provided wiring; the
    // transport adapter is responsible for routing `data` calls into
    // `onData`. We expose a tiny attach hook so the adapter can call
    // back into us.
    incomingDataHandlers.set(socket, onData);
    incomingCloseHandlers.set(socket, () => {
      if (channel) channel.handleSocketClose();
    });
  }

  private installChannelDataPump(
    socket: BunSocketLike,
    channel: SyncChannel,
  ): void {
    incomingDataHandlers.set(socket, (chunk) => {
      void channel.handleData(chunk);
    });
    incomingCloseHandlers.set(socket, () => channel.handleSocketClose());
  }

  private writeReply(socket: BunSocketLike, body: Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    socket.write(prefix4(bytes));
  }
}

function prefix4(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  out[0] = (bytes.length >>> 24) & 0xff;
  out[1] = (bytes.length >>> 16) & 0xff;
  out[2] = (bytes.length >>> 8) & 0xff;
  out[3] = bytes.length & 0xff;
  out.set(bytes, 4);
  return out;
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) {
    const only = chunks[0];
    return only ?? new Uint8Array(0);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Shared maps used by the default transport to route socket events
// into the coordinator. We don't use WeakMap because socket identity
// is opaque and we want a single-process lookup.
const incomingDataHandlers = new Map<BunSocketLike, (c: Uint8Array) => void>();
const incomingCloseHandlers = new Map<BunSocketLike, () => void>();

export const _internals = {
  incomingDataHandlers,
  incomingCloseHandlers,
};

function defaultTransport(): BunTransport {
  return {
    async listen(port, hostname, onAccept) {
      const bunGlobal: unknown = (globalThis as { Bun?: unknown }).Bun;
      if (
        bunGlobal === null ||
        typeof bunGlobal !== 'object' ||
        typeof (bunGlobal as { listen?: unknown }).listen !== 'function'
      ) {
        throw new Error('Bun.listen is not available in this runtime');
      }
      const Bun = bunGlobal as {
        listen: (opts: BunListenSpec) => BunListenResult;
      };
      const server = Bun.listen({
        hostname,
        port,
        socket: {
          open(socket): void {
            const wrapped: BunSocketLike = {
              write: (data) => socket.write(data),
              end: () => socket.end(),
              ...(typeof socket.remoteAddress === 'string'
                ? { remoteAddress: socket.remoteAddress }
                : {}),
            };
            socketProxies.set(socket, wrapped);
            onAccept(wrapped, () => {}, () => {});
          },
          data(socket, data): void {
            const wrapped = socketProxies.get(socket);
            if (!wrapped) return;
            const handler = incomingDataHandlers.get(wrapped);
            if (handler) handler(toUint8(data));
          },
          close(socket): void {
            const wrapped = socketProxies.get(socket);
            if (!wrapped) return;
            const handler = incomingCloseHandlers.get(wrapped);
            if (handler) handler();
            socketProxies.delete(socket);
            incomingDataHandlers.delete(wrapped);
            incomingCloseHandlers.delete(wrapped);
          },
          error(_socket, _error): void {
            /* surfaced via close */
          },
        },
      });
      return {
        port: server.port ?? port,
        stop: () => {
          try {
            server.stop?.();
          } catch {
            /* swallow */
          }
        },
      };
    },
    async connect(args) {
      const bunGlobal: unknown = (globalThis as { Bun?: unknown }).Bun;
      if (
        bunGlobal === null ||
        typeof bunGlobal !== 'object' ||
        typeof (bunGlobal as { connect?: unknown }).connect !== 'function'
      ) {
        throw new Error('Bun.connect is not available in this runtime');
      }
      const Bun = bunGlobal as {
        connect: (opts: BunConnectSpec) => Promise<BunSocketRaw>;
      };
      let wrapped: BunSocketLike | null = null;
      const socket = await Bun.connect({
        hostname: args.host,
        port: args.port,
        socket: {
          open(s): void {
            wrapped = {
              write: (data) => s.write(data),
              end: () => s.end(),
              ...(typeof s.remoteAddress === 'string'
                ? { remoteAddress: s.remoteAddress }
                : {}),
            };
            socketProxies.set(s, wrapped);
            args.onOpen(wrapped);
          },
          data(s, data): void {
            const w = socketProxies.get(s) ?? wrapped;
            if (!w) return;
            const handler = incomingDataHandlers.get(w);
            if (handler) handler(toUint8(data));
            else args.onData(toUint8(data));
          },
          close(s): void {
            const w = socketProxies.get(s) ?? wrapped;
            if (w) {
              const handler = incomingCloseHandlers.get(w);
              if (handler) handler();
              incomingDataHandlers.delete(w);
              incomingCloseHandlers.delete(w);
            }
            socketProxies.delete(s);
            args.onClose();
          },
          error(_s, err): void {
            args.onError(err instanceof Error ? err : new Error(String(err)));
          },
        },
      });
      void socket;
      if (wrapped === null) {
        throw new Error('Bun.connect resolved without opening socket');
      }
      return wrapped;
    },
  };
}

interface BunListenSpec {
  hostname: string;
  port: number;
  socket: {
    open: (socket: BunSocketRaw) => void;
    data: (socket: BunSocketRaw, data: Uint8Array | string) => void;
    close: (socket: BunSocketRaw) => void;
    error: (socket: BunSocketRaw, err: Error) => void;
  };
}
interface BunConnectSpec {
  hostname: string;
  port: number;
  socket: {
    open: (socket: BunSocketRaw) => void;
    data: (socket: BunSocketRaw, data: Uint8Array | string) => void;
    close: (socket: BunSocketRaw) => void;
    error: (socket: BunSocketRaw, err: Error) => void;
  };
}
interface BunSocketRaw {
  write(data: Uint8Array | string): number;
  end(): void;
  remoteAddress?: string;
}
interface BunListenResult {
  port?: number;
  stop?: () => void;
}

const socketProxies = new Map<BunSocketRaw, BunSocketLike>();

function toUint8(data: Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data;
}

// Re-export shapes commonly needed by callers.
export { mintPairing, packFrame, unpackFrame };
