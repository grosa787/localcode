/**
 * Public barrel for the LAN session-sharing networking layer.
 *
 * Importers (cli.tsx, app.tsx, commands, tests) should consume this
 * module rather than reach into the per-file modules so we can refactor
 * the internals without breaking call sites.
 */

export {
  LanDiscovery,
  LOCALCODE_PROTOCOL_VERSION,
  LOCALCODE_SERVICE_TYPE,
  MAX_PEERS,
} from './lan-discovery.js';
export type {
  BonjourBrowser,
  BonjourDriver,
  BonjourService,
  DiscoveredPeer,
  LanDiscoveryOptions,
  PeerCapability,
  PublishedService,
  PublishOptions,
} from './lan-discovery.js';

export {
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  DEFAULT_CODE_TTL_MS,
  PAIRING_CODE_LENGTH,
  PAIRING_TOKEN_BYTES,
  counterNonce,
  deriveCode,
  decryptFrame,
  encryptFrame,
  mintPairing,
  tokenFromHex,
  verifyCode,
  constantTimeEquals,
} from './pairing.js';
export type {
  PairingArtifact,
  PairingMintOptions,
  PairingVerifyResult,
} from './pairing.js';

export {
  FrameReader,
  MAX_FRAME_BYTES,
  SOCKET_IDLE_TIMEOUT_MS,
  SyncChannel,
  SyncMessageSchema,
  packFrame,
  unpackFrame,
} from './lan-sync.js';
export type {
  BunSocketLike,
  Frame,
  LanSyncListenOptions,
  SyncMessage,
  SyncPeer,
} from './lan-sync.js';

export { ShareCoordinator } from './share-coordinator.js';
export type {
  AcceptShareResult,
  BunListenHandle,
  BunTransport,
  BunTransportConnectArgs,
  ShareCoordinatorOptions,
  ShareMode,
  ShareSession,
  StartShareResult,
} from './share-coordinator.js';

export { generateUuidV7 } from './uuid-v7.js';
