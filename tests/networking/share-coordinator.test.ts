/**
 * ShareCoordinator integration test — uses an in-process loopback
 * transport so we never touch the real network. Discovery is also
 * synthetic.
 */
import { describe, test, expect } from 'bun:test';

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
import { EventEmitter } from 'node:events';

import type {
  BunListenHandle,
  BunSocketLike,
  BunTransport,
  BunTransportConnectArgs,
  BonjourDriver,
  BonjourBrowser,
  PublishedService,
  PublishOptions,
  SyncMessage,
} from '@/networking';
import {
  LanDiscovery,
  ShareCoordinator,
  LOCALCODE_PROTOCOL_VERSION,
} from '@/networking';

class FakeBrowser extends EventEmitter implements BonjourBrowser {
  start(): void {}
  stop(): void {}
}

function makeFakeDriver(): BonjourDriver & { browser: FakeBrowser } {
  const browser = new FakeBrowser();
  return {
    browser,
    publish(_opts: PublishOptions): PublishedService {
      return { stop: (cb): void => cb?.() };
    },
    find(): BonjourBrowser {
      return browser;
    },
    destroy(): void {},
  };
}

interface LoopbackEndpoint {
  send(data: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}

interface LoopbackPair {
  client: { socket: BunSocketLike; deliver(data: Uint8Array): void; close(): void };
  server: { socket: BunSocketLike; deliver(data: Uint8Array): void; close(): void };
}

/**
 * A synthetic transport that connects in-process. The "listen" side
 * stores its onAccept callback; the "connect" side invokes it
 * synchronously and the two sockets shovel bytes into each other.
 */
function makeLoopbackTransport(): {
  transport: BunTransport;
  pairs: LoopbackPair[];
} {
  let acceptCb:
    | ((
        socket: BunSocketLike,
        onData: (chunk: Uint8Array) => void,
        onClose: () => void,
      ) => void)
    | null = null;
  const pairs: LoopbackPair[] = [];

  const transport: BunTransport = {
    async listen(port, _host, onAccept) {
      acceptCb = onAccept;
      const handle: BunListenHandle = {
        port,
        stop: (): void => {
          acceptCb = null;
        },
      };
      return handle;
    },
    async connect(args: BunTransportConnectArgs) {
      if (!acceptCb) throw new Error('no listener');

      let serverEndpoint: LoopbackEndpoint | null = null;
      let clientEndpoint: LoopbackEndpoint | null = null;

      const clientSocket: BunSocketLike = {
        write: (data) => {
          serverEndpoint?.send(data);
          return data.length;
        },
        end: () => {
          serverEndpoint?.close();
        },
      };
      const serverSocket: BunSocketLike = {
        write: (data) => {
          clientEndpoint?.send(data);
          return data.length;
        },
        end: () => {
          clientEndpoint?.close();
        },
      };

      // Server-side handlers come from coordinator's handleIncomingSocket
      // which uses the shared incoming maps. The transport's onAccept
      // wires them via the coordinator. We mirror that here by storing
      // delivery shims.
      let serverOnData: ((d: Uint8Array) => void) | null = null;
      let serverOnClose: (() => void) | null = null;
      const serverEndpointImpl: LoopbackEndpoint = {
        send: (data) => {
          // Server received bytes from client; route via internals map.
          const handler = (
            globalThis as { __lcTestServerData?: (s: BunSocketLike, d: Uint8Array) => void }
          ).__lcTestServerData;
          if (handler) handler(serverSocket, data);
          else if (serverOnData) serverOnData(data);
        },
        close: () => {
          const handler = (
            globalThis as { __lcTestServerClose?: (s: BunSocketLike) => void }
          ).__lcTestServerClose;
          if (handler) handler(serverSocket);
          else if (serverOnClose) serverOnClose();
        },
      };
      const clientEndpointImpl: LoopbackEndpoint = {
        send: async (data) => {
          // Once the coordinator's installChannelDataPump has wired
          // the client socket into the incoming map, route there
          // instead of through the initial handshake onData.
          const { _internals } = await import('@/networking/share-coordinator');
          const wired = _internals.incomingDataHandlers.get(clientSocket);
          if (wired) wired(data);
          else args.onData(data);
        },
        close: async () => {
          const { _internals } = await import('@/networking/share-coordinator');
          const wired = _internals.incomingCloseHandlers.get(clientSocket);
          if (wired) wired();
          args.onClose();
        },
      };
      serverEndpoint = serverEndpointImpl;
      clientEndpoint = clientEndpointImpl;

      // Invoke the server's accept (mounts the coordinator's onData
      // pump that calls into the shared incoming maps).
      acceptCb(
        serverSocket,
        (d) => {
          serverOnData = (chunk: Uint8Array): void => {
            serverEndpointImpl.send(chunk);
            void d;
            void chunk;
          };
        },
        () => {
          serverOnClose = (): void => {};
        },
      );

      pairs.push({
        client: {
          socket: clientSocket,
          deliver: (d) => args.onData(d),
          close: () => args.onClose(),
        },
        server: {
          socket: serverSocket,
          deliver: (d) => serverEndpointImpl.send(d),
          close: () => serverEndpointImpl.close(),
        },
      });

      args.onOpen(clientSocket);
      return clientSocket;
    },
  };

  return { transport, pairs };
}

/**
 * Wire the share-coordinator's internal incomingData/Close handler
 * lookup into our globalThis hooks so the loopback transport can
 * route server-direction bytes correctly.
 */
async function wireServerHandlers(): Promise<void> {
  const { _internals } = await import('@/networking/share-coordinator');
  (
    globalThis as {
      __lcTestServerData?: (s: BunSocketLike, d: Uint8Array) => void;
      __lcTestServerClose?: (s: BunSocketLike) => void;
    }
  ).__lcTestServerData = (s, d) => {
    const handler = _internals.incomingDataHandlers.get(s);
    if (handler) handler(d);
  };
  (
    globalThis as { __lcTestServerClose?: (s: BunSocketLike) => void }
  ).__lcTestServerClose = (s) => {
    const handler = _internals.incomingCloseHandlers.get(s);
    if (handler) handler();
  };
}

describe('ShareCoordinator — end-to-end with loopback transport', () => {
  test('startSharing → acceptShare → broadcast → both peers see the message', async () => {
    await wireServerHandlers();
    const { transport } = makeLoopbackTransport();
    const sharerDriver = makeFakeDriver();
    const dialerDriver = makeFakeDriver();

    const sharerDiscovery = new LanDiscovery({
      port: 9999,
      instanceId: 'sharer-id',
      displayName: 'sharer',
      bonjourFactory: () => sharerDriver,
    });
    const dialerDiscovery = new LanDiscovery({
      port: 9999,
      instanceId: 'dialer-id',
      displayName: 'dialer',
      bonjourFactory: () => dialerDriver,
    });

    const sharer = new ShareCoordinator({
      port: 9999,
      transport,
      discovery: sharerDiscovery,
      instanceId: 'sharer-id',
    });
    const dialer = new ShareCoordinator({
      port: 9999,
      transport, // Same loopback — only one listener exists
      discovery: dialerDiscovery,
      instanceId: 'dialer-id',
    });

    // Only the sharer needs to listen for incoming connections in
    // this scenario (the dialer is the one calling acceptShare).
    await sharer.start();

    // Inject the sharer into the dialer's discovery so acceptShare can
    // resolve the peer record.
    dialerDriver.browser.emit('up', {
      name: 'sharer-svc',
      fqdn: 'sharer-svc._localcode._tcp.local',
      host: '127.0.0.1',
      port: 9999,
      addresses: ['127.0.0.1'],
      txt: {
        version: LOCALCODE_PROTOCOL_VERSION,
        instance_id: 'sharer-id',
        display_name: 'sharer',
        capabilities: 'share-session',
      },
    });
    // Dialer needs the discovery registry populated; start it so the
    // event handler is wired.
    dialerDiscovery.start();
    // Re-emit after start to push the peer through.
    dialerDriver.browser.emit('up', {
      name: 'sharer-svc',
      fqdn: 'sharer-svc._localcode._tcp.local',
      host: '127.0.0.1',
      port: 9999,
      addresses: ['127.0.0.1'],
      txt: {
        version: LOCALCODE_PROTOCOL_VERSION,
        instance_id: 'sharer-id',
        display_name: 'sharer',
        capabilities: 'share-session',
      },
    });

    // 1. Sharer mints a share.
    const start = sharer.startSharing('session-42', 'view');
    expect(start.code).toMatch(/^\d{6}$/);
    expect(sharer.isSharing('session-42')).toBe(true);

    // 2. Dialer accepts using the printed code.
    const sharerEvents: SyncMessage[] = [];
    const dialerEvents: SyncMessage[] = [];
    sharer.on('sync-message', (_id, msg) => sharerEvents.push(msg));
    dialer.on('sync-message', (_id, msg) => dialerEvents.push(msg));

    const sharerOpened: string[] = [];
    sharer.on('sync-channel-open', (id) => sharerOpened.push(id));

    // The dialer's coordinator never started its own listener — we
    // skip start() since we don't need it to listen, only to dial.
    // We still need its discovery populated (done above) and the
    // transport assigned (done in constructor).
    dialer['started'] = true; // bypass guard — test-only

    const result = await dialer.acceptShare('sharer-id', start.code);
    expect(result.sessionId).toBe('session-42');
    // Sharer should have observed an open channel for the dialer.
    expect(sharerOpened).toContain('dialer-id');

    // 3. Sharer broadcasts a chat message — dialer receives it.
    await sharer.broadcast({
      type: 'message',
      senderId: 'sharer-id',
      messageId: 'm-1',
      role: 'assistant',
      content: 'hello from sharer',
      ts: 1,
    });
    await flush();

    expect(dialerEvents.some((m) => m.type === 'message')).toBe(true);

    // 4. Dialer broadcasts back — sharer receives.
    await dialer.broadcast({
      type: 'message',
      senderId: 'dialer-id',
      messageId: 'm-2',
      role: 'user',
      content: 'ack from dialer',
      ts: 2,
    });
    await flush();

    expect(sharerEvents.some((m) => m.type === 'message')).toBe(true);

    // Cleanup.
    await sharer.stop();
    await dialerDiscovery.stop();
  });

  test('acceptShare rejects an invalid code', async () => {
    await wireServerHandlers();
    const { transport } = makeLoopbackTransport();
    const driverA = makeFakeDriver();
    const driverB = makeFakeDriver();
    const discA = new LanDiscovery({
      port: 9000,
      instanceId: 'A',
      bonjourFactory: () => driverA,
    });
    const discB = new LanDiscovery({
      port: 9000,
      instanceId: 'B',
      bonjourFactory: () => driverB,
    });
    const a = new ShareCoordinator({ port: 9000, transport, discovery: discA, instanceId: 'A' });
    const b = new ShareCoordinator({ port: 9000, transport, discovery: discB, instanceId: 'B' });
    await a.start();
    discB.start();
    driverB.browser.emit('up', {
      name: 'a-svc',
      fqdn: 'a-svc._localcode._tcp.local',
      host: '127.0.0.1',
      port: 9000,
      addresses: ['127.0.0.1'],
      txt: {
        version: LOCALCODE_PROTOCOL_VERSION,
        instance_id: 'A',
        display_name: 'A',
        capabilities: 'share-session',
      },
    });
    a.startSharing('s1');
    b['started'] = true;
    await expect(b.acceptShare('A', '000000')).rejects.toThrow();
    await a.stop();
    await discB.stop();
  });

  test('stopSharing removes the artifact', async () => {
    const { transport } = makeLoopbackTransport();
    const driver = makeFakeDriver();
    const disc = new LanDiscovery({ port: 1, instanceId: 'self', bonjourFactory: () => driver });
    const coord = new ShareCoordinator({ port: 1, transport, discovery: disc });
    await coord.start();
    coord.startSharing('s1');
    expect(coord.isSharing('s1')).toBe(true);
    expect(coord.stopSharing('s1')).toBe(true);
    expect(coord.isSharing('s1')).toBe(false);
    await coord.stop();
  });
});
