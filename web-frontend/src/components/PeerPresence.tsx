/**
 * PeerPresence — multi-user collaboration peer-dots strip.
 *
 * Renders a tiny horizontal strip at the top of the chat surface showing
 * every peer currently connected to the session. Each peer is a small
 * colored dot + their displayName; peers that are currently typing get
 * a pulsing animation. Renders nothing when no peers are present so the
 * default single-user experience is unchanged.
 *
 * The Composer is responsible for displaying the "typing…" verbose
 * strip immediately above the textarea — this component is the durable
 * "who is here" indicator that stays visible at all times.
 */

import { useMemo, type JSX } from 'react';

import { useT } from '../i18n';
import { useStore, type PeerInfo } from '../state/store';

import styles from './PeerPresence.module.css';

export interface PeerPresenceProps {
  sessionId: string;
}

/**
 * Deterministically map a userId to a visible color. FNV-1a hash → HSL
 * hue. Keeps avatars stable across reloads without storing per-user
 * colors on the server.
 */
export function colorForUserId(userId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

export function PeerPresence(props: PeerPresenceProps): JSX.Element | null {
  const t = useT();
  const peersBySession = useStore((s) => s.peers);
  const peers = useMemo<PeerInfo[]>(() => {
    const bucket = peersBySession[props.sessionId];
    if (bucket === undefined) return [];
    return Object.values(bucket).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }, [peersBySession, props.sessionId]);

  if (peers.length === 0) return null;

  return (
    <div
      className={styles.root}
      data-testid="peer-presence"
      aria-label={t('presence.peers', { n: peers.length })}
    >
      <span className={styles.count}>
        {t('presence.peers', { n: peers.length })}
      </span>
      <ul className={styles.list}>
        {peers.map((peer) => (
          <li
            key={peer.userId}
            className={styles.peer}
            data-typing={peer.typing ? 'true' : 'false'}
            title={peer.displayName}
          >
            <span
              className={styles.dot}
              style={{ backgroundColor: colorForUserId(peer.userId) }}
              aria-hidden="true"
            />
            <span className={styles.name}>{peer.displayName}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
