/**
 * LanDiscovery tests — drive a synthetic bonjour driver so we never
 * touch the real multicast stack.
 */
import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';

import type {
  BonjourBrowser,
  BonjourDriver,
  BonjourService,
  PublishedService,
  PublishOptions,
} from '@/networking';
import {
  LanDiscovery,
  LOCALCODE_PROTOCOL_VERSION,
  LOCALCODE_SERVICE_TYPE,
  MAX_PEERS,
} from '@/networking';

class FakeBrowser extends EventEmitter implements BonjourBrowser {
  start(): void {
    /* no-op */
  }
  stop(): void {
    /* no-op */
  }
}

class FakeDriver implements BonjourDriver {
  readonly published: PublishOptions[] = [];
  readonly browser = new FakeBrowser();
  destroyed = false;
  publish(opts: PublishOptions): PublishedService {
    this.published.push(opts);
    return {
      stop: (cb): void => {
        cb?.();
      },
    };
  }
  find(): BonjourBrowser {
    return this.browser;
  }
  destroy(): void {
    this.destroyed = true;
  }
  // helpers for tests
  emitUp(svc: BonjourService): void {
    this.browser.emit('up', svc);
  }
  emitDown(svc: BonjourService): void {
    this.browser.emit('down', svc);
  }
}

function buildPeerTxt(opts: {
  instanceId: string;
  displayName?: string;
  version?: string;
  capabilities?: string;
}): Record<string, string> {
  const txt: Record<string, string> = {
    version: opts.version ?? LOCALCODE_PROTOCOL_VERSION,
    instance_id: opts.instanceId,
    display_name: opts.displayName ?? 'peer@host',
  };
  if (opts.capabilities !== undefined) {
    txt['capabilities'] = opts.capabilities;
  }
  return txt;
}

describe('LanDiscovery', () => {
  test('start publishes a service with the correct TXT shape', async () => {
    const driver = new FakeDriver();
    const disc = new LanDiscovery({
      port: 7878,
      instanceId: 'self-instance',
      displayName: 'me@laptop',
      bonjourFactory: () => driver,
    });
    disc.start();
    expect(driver.published.length).toBe(1);
    const pub = driver.published[0];
    expect(pub).toBeDefined();
    expect(pub?.type).toBe(LOCALCODE_SERVICE_TYPE);
    expect(pub?.port).toBe(7878);
    expect(pub?.txt?.['version']).toBe(LOCALCODE_PROTOCOL_VERSION);
    expect(pub?.txt?.['instance_id']).toBe('self-instance');
    expect(pub?.txt?.['display_name']).toBe('me@laptop');
    expect(pub?.txt?.['capabilities']).toBe('share-session');
    await disc.stop();
  });

  test('emits peer-discovered on browser up and ignores self', async () => {
    const driver = new FakeDriver();
    const disc = new LanDiscovery({
      port: 1234,
      instanceId: 'self-instance',
      bonjourFactory: () => driver,
    });
    disc.start();
    const events: string[] = [];
    disc.on('peer-discovered', (peer) => events.push(peer.instanceId));
    // Self should be ignored.
    driver.emitUp({
      name: 'localcode-self',
      fqdn: 'localcode-self._localcode._tcp.local',
      host: '192.168.1.10',
      port: 1234,
      addresses: ['192.168.1.10'],
      txt: buildPeerTxt({ instanceId: 'self-instance' }),
    });
    // Remote peer.
    driver.emitUp({
      name: 'localcode-alice',
      fqdn: 'localcode-alice._localcode._tcp.local',
      host: '192.168.1.11',
      port: 4321,
      addresses: ['192.168.1.11'],
      txt: buildPeerTxt({ instanceId: 'alice-instance', displayName: 'alice@laptop' }),
    });
    expect(events).toEqual(['alice-instance']);
    expect(disc.listPeers().map((p) => p.instanceId)).toEqual(['alice-instance']);
    const alice = disc.getPeer('alice-instance');
    expect(alice?.displayName).toBe('alice@laptop');
    expect(alice?.port).toBe(4321);
    await disc.stop();
  });

  test('emits peer-left and drops from registry on browser down', async () => {
    const driver = new FakeDriver();
    const disc = new LanDiscovery({
      port: 1000,
      instanceId: 'self',
      bonjourFactory: () => driver,
    });
    disc.start();
    driver.emitUp({
      name: 'a',
      fqdn: 'a._localcode._tcp.local',
      host: 'h',
      port: 1,
      txt: buildPeerTxt({ instanceId: 'bob-instance-1' }),
    });
    expect(disc.listPeers()).toHaveLength(1);
    const left: string[] = [];
    disc.on('peer-left', (id) => left.push(id));
    driver.emitDown({
      name: 'a',
      fqdn: 'a._localcode._tcp.local',
      host: 'h',
      port: 1,
      txt: buildPeerTxt({ instanceId: 'bob-instance-1' }),
    });
    expect(left).toEqual(['bob-instance-1']);
    expect(disc.listPeers()).toHaveLength(0);
    await disc.stop();
  });

  test('caps peers at MAX_PEERS', async () => {
    const driver = new FakeDriver();
    const disc = new LanDiscovery({
      port: 1,
      instanceId: 'self',
      bonjourFactory: () => driver,
    });
    disc.start();
    for (let i = 0; i < MAX_PEERS + 5; i += 1) {
      driver.emitUp({
        name: `n-${i}`,
        fqdn: `n-${i}._localcode._tcp.local`,
        host: '127.0.0.1',
        port: 2000 + i,
        txt: buildPeerTxt({ instanceId: `peer-instance-${i}` }),
      });
    }
    expect(disc.listPeers().length).toBe(MAX_PEERS);
    await disc.stop();
  });

  test('drops malformed TXT silently', async () => {
    const driver = new FakeDriver();
    const disc = new LanDiscovery({
      port: 1,
      instanceId: 'self',
      bonjourFactory: () => driver,
    });
    disc.start();
    const seen: string[] = [];
    disc.on('peer-discovered', (p) => seen.push(p.instanceId));
    driver.emitUp({
      name: 'malformed',
      fqdn: 'malformed._localcode._tcp.local',
      host: 'h',
      port: 1,
      txt: { version: '1' }, // missing instance_id + display_name
    });
    expect(seen).toEqual([]);
    expect(disc.listPeers()).toHaveLength(0);
    await disc.stop();
  });
});
