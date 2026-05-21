/**
 * mDNS-based LAN peer discovery for LocalCode session sharing.
 *
 * Wraps `bonjour-service` (the well-maintained successor to the legacy
 * `bonjour` module). Each LocalCode process that opts in via `--lan`
 * advertises a single service of type `_localcode._tcp.local` carrying
 * a TXT record with the protocol version, a stable per-process
 * `instance_id` (uuidv7), a human-readable `display_name`, and a
 * comma-separated capability list.
 *
 * Subscribers receive `peer-discovered` and `peer-left` events. The
 * registry caps itself at MAX_PEERS to prevent runaway memory on a
 * misbehaving (or hostile) LAN.
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import { z } from 'zod';

import { generateUuidV7 } from './uuid-v7.js';

export const LOCALCODE_SERVICE_TYPE = 'localcode';
export const LOCALCODE_PROTOCOL_VERSION = '1';
/** Hard cap on how many peers we'll track in the registry. */
export const MAX_PEERS = 50;

export type PeerCapability = 'share-session' | 'view-only';

export interface DiscoveredPeer {
  readonly instanceId: string;
  readonly displayName: string;
  readonly version: string;
  readonly host: string;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly capabilities: readonly PeerCapability[];
  readonly seenAt: number;
}

export interface LanDiscoveryOptions {
  /** TCP port we will accept incoming connections on. */
  readonly port: number;
  /** Human label. Defaults to `${user}@${hostname}`. */
  readonly displayName?: string;
  /** Capabilities to advertise. Defaults to `['share-session']`. */
  readonly capabilities?: readonly PeerCapability[];
  /** Override the auto-generated instance id (tests). */
  readonly instanceId?: string;
  /**
   * Optional factory for the bonjour driver. Tests inject a fake so
   * we never touch the real network. The default lazy-loads
   * `bonjour-service`.
   */
  readonly bonjourFactory?: () => BonjourDriver;
}

/**
 * Minimal surface of the bonjour-service driver we depend on. Keeping
 * it narrow lets tests stub it without re-implementing the whole
 * package.
 */
export interface BonjourDriver {
  publish(opts: PublishOptions): PublishedService;
  find(opts: FindOptions, onUp?: (svc: BonjourService) => void): BonjourBrowser;
  destroy(): void;
}

export interface PublishOptions {
  readonly name: string;
  readonly type: string;
  readonly port: number;
  readonly txt?: Record<string, string>;
}

export interface PublishedService {
  stop?: (cb?: () => void) => void;
}

export interface FindOptions {
  readonly type: string;
}

export interface BonjourService {
  readonly name: string;
  readonly fqdn: string;
  readonly host: string;
  readonly port: number;
  readonly addresses?: readonly string[];
  readonly txt?: Record<string, unknown>;
}

export interface BonjourBrowser {
  on(event: 'up', listener: (svc: BonjourService) => void): void;
  on(event: 'down', listener: (svc: BonjourService) => void): void;
  start?: () => void;
  stop?: () => void;
}

const TxtSchema = z.object({
  version: z.string().min(1),
  instance_id: z.string().min(8),
  display_name: z.string().min(1),
  capabilities: z.string().optional(),
});

function parseCapabilities(raw: string | undefined): PeerCapability[] {
  if (!raw) return [];
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const out: PeerCapability[] = [];
  for (const token of tokens) {
    if (token === 'share-session' || token === 'view-only') {
      out.push(token);
    }
  }
  return out;
}

function decodeTxt(input: Record<string, unknown> | undefined): {
  version: string;
  instanceId: string;
  displayName: string;
  capabilities: PeerCapability[];
} | null {
  if (!input) return null;
  const normalised: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      normalised[key] = value;
    } else if (value instanceof Buffer) {
      normalised[key] = value.toString('utf8');
    } else if (value !== undefined && value !== null) {
      normalised[key] = String(value);
    }
  }
  const parsed = TxtSchema.safeParse(normalised);
  if (!parsed.success) return null;
  return {
    version: parsed.data.version,
    instanceId: parsed.data.instance_id,
    displayName: parsed.data.display_name,
    capabilities: parseCapabilities(parsed.data.capabilities),
  };
}

function defaultDisplayName(): string {
  const hostname = os.hostname();
  let user: string;
  try {
    user = os.userInfo().username;
  } catch {
    user = 'user';
  }
  return `${user}@${hostname}`;
}

export interface LanDiscoveryEvents {
  'peer-discovered': (peer: DiscoveredPeer) => void;
  'peer-left': (instanceId: string) => void;
}

/**
 * Public events:
 *  - `peer-discovered` — a remote LocalCode advertised on the LAN.
 *  - `peer-left`        — a previously-known peer goodbye'd.
 */
export class LanDiscovery extends EventEmitter {
  readonly instanceId: string;
  readonly displayName: string;
  readonly port: number;
  readonly capabilities: readonly PeerCapability[];

  private driver: BonjourDriver | null = null;
  private published: PublishedService | null = null;
  private browser: BonjourBrowser | null = null;
  private readonly peers = new Map<string, DiscoveredPeer>();
  private started = false;

  constructor(private readonly options: LanDiscoveryOptions) {
    super();
    this.instanceId = options.instanceId ?? generateUuidV7();
    this.displayName = options.displayName ?? defaultDisplayName();
    this.port = options.port;
    this.capabilities = options.capabilities ?? ['share-session'];
  }

  /** True after `start()` has been called and not yet stopped. */
  isRunning(): boolean {
    return this.started;
  }

  /** Snapshot of currently-known peers, excluding self. */
  listPeers(): DiscoveredPeer[] {
    return [...this.peers.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }

  getPeer(instanceId: string): DiscoveredPeer | null {
    return this.peers.get(instanceId) ?? null;
  }

  start(): void {
    if (this.started) return;
    const factory =
      this.options.bonjourFactory ?? (() => createDefaultBonjour());
    this.driver = factory();

    const txt: Record<string, string> = {
      version: LOCALCODE_PROTOCOL_VERSION,
      instance_id: this.instanceId,
      display_name: this.displayName,
      capabilities: this.capabilities.join(','),
    };
    this.published = this.driver.publish({
      name: `localcode-${this.instanceId.slice(0, 12)}`,
      type: LOCALCODE_SERVICE_TYPE,
      port: this.port,
      txt,
    });

    this.browser = this.driver.find({ type: LOCALCODE_SERVICE_TYPE });
    this.browser.on('up', (svc) => this.handleUp(svc));
    this.browser.on('down', (svc) => this.handleDown(svc));
    if (typeof this.browser.start === 'function') this.browser.start();

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      if (this.browser && typeof this.browser.stop === 'function') {
        this.browser.stop();
      }
    } catch {
      /* swallow */
    }
    try {
      if (this.published && typeof this.published.stop === 'function') {
        await new Promise<void>((resolve) => {
          this.published?.stop?.(() => resolve());
          // Defensive: bonjour-service is supposed to call back, but
          // we don't want to hang forever if the underlying socket is
          // already closed.
          setTimeout(() => resolve(), 250);
        });
      }
    } catch {
      /* swallow */
    }
    try {
      this.driver?.destroy();
    } catch {
      /* swallow */
    }
    this.driver = null;
    this.published = null;
    this.browser = null;
    this.peers.clear();
  }

  private handleUp(svc: BonjourService): void {
    const meta = decodeTxt(svc.txt);
    if (meta === null) return;
    // Ignore self.
    if (meta.instanceId === this.instanceId) return;
    // Cap to avoid registry blow-up on a noisy/hostile LAN.
    if (this.peers.size >= MAX_PEERS && !this.peers.has(meta.instanceId)) {
      return;
    }
    const peer: DiscoveredPeer = {
      instanceId: meta.instanceId,
      displayName: meta.displayName,
      version: meta.version,
      host: svc.host,
      port: svc.port,
      addresses: svc.addresses ? [...svc.addresses] : [],
      capabilities: meta.capabilities,
      seenAt: Date.now(),
    };
    this.peers.set(peer.instanceId, peer);
    this.emit('peer-discovered', peer);
  }

  private handleDown(svc: BonjourService): void {
    const meta = decodeTxt(svc.txt);
    let instanceId: string | null = meta?.instanceId ?? null;
    if (instanceId === null) {
      // Fall back to matching by fqdn — some mDNS goodbye packets omit
      // TXT data entirely.
      for (const [id, peer] of this.peers.entries()) {
        if (peer.host === svc.host && peer.port === svc.port) {
          instanceId = id;
          break;
        }
      }
    }
    if (instanceId === null) return;
    if (this.peers.delete(instanceId)) {
      this.emit('peer-left', instanceId);
    }
  }
}

/**
 * Lazily resolves the real `bonjour-service` driver. Kept as an
 * indirection so the rest of the codebase (and tests that inject a
 * fake) never imports the native multicast dependency. Using
 * `createRequire` rather than a static `import` so this whole file is
 * still tree-shake-friendly when `--lan` is not used.
 */
function createDefaultBonjour(): BonjourDriver {
  const requireFn = createRequire(import.meta.url);
  const moduleUnknown: unknown = requireFn('bonjour-service');
  if (
    moduleUnknown === null ||
    typeof moduleUnknown !== 'object'
  ) {
    throw new Error('bonjour-service module did not load');
  }
  const moduleRec = moduleUnknown as Record<string, unknown>;
  const candidate =
    typeof moduleRec['Bonjour'] === 'function'
      ? (moduleRec['Bonjour'] as new () => unknown)
      : typeof moduleRec['default'] === 'function'
        ? (moduleRec['default'] as new () => unknown)
        : null;
  if (candidate === null) {
    throw new Error('bonjour-service module did not export Bonjour');
  }
  const instance: unknown = new candidate();
  return instance as BonjourDriver;
}
