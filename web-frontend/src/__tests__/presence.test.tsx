/**
 * Presence tests — multi-user collaboration UI (Wave 9).
 *
 * Covers:
 *   - Store slice (upsertPeer / removePeer / sweepStalePeers / filters own userId).
 *   - PeerPresence component renders peers, hides own, marks typing.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

import { PeerPresence, colorForUserId } from '../components/PeerPresence';
import {
  PRESENCE_VISIBLE_WINDOW_MS,
  useStore,
  type PeerInfo,
} from '../state/store';

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState({
    ...initialState,
    peers: {},
    myPresenceUserId: 'me-1234',
    myPresenceDisplayName: 'user-me',
  });
});

describe('peers store slice', () => {
  test('upsertPeer stores a peer keyed by userId', () => {
    const peer: PeerInfo = {
      userId: 'u-aaaa',
      displayName: 'user-aaaa',
      typing: true,
      lastSeenMs: Date.now(),
    };
    useStore.getState().upsertPeer('sess-1', peer);
    const bucket = useStore.getState().peers['sess-1'];
    expect(bucket).toBeDefined();
    expect(bucket?.['u-aaaa']?.typing).toBe(true);
  });

  test('upsertPeer filters our own userId', () => {
    useStore.getState().upsertPeer('sess-1', {
      userId: 'me-1234',
      displayName: 'user-me',
      typing: true,
      lastSeenMs: Date.now(),
    });
    expect(useStore.getState().peers['sess-1']).toBeUndefined();
  });

  test('upsertPeer overwrites typing state on subsequent calls', () => {
    const t = Date.now();
    useStore.getState().upsertPeer('sess-1', {
      userId: 'u-aaaa',
      displayName: 'user-aaaa',
      typing: true,
      lastSeenMs: t,
    });
    useStore.getState().upsertPeer('sess-1', {
      userId: 'u-aaaa',
      displayName: 'user-aaaa',
      typing: false,
      lastSeenMs: t + 500,
    });
    expect(useStore.getState().peers['sess-1']?.['u-aaaa']?.typing).toBe(false);
  });

  test('removePeer drops a single entry', () => {
    useStore.getState().upsertPeer('sess-1', {
      userId: 'u-aaaa',
      displayName: 'A',
      typing: true,
      lastSeenMs: Date.now(),
    });
    useStore.getState().upsertPeer('sess-1', {
      userId: 'u-bbbb',
      displayName: 'B',
      typing: false,
      lastSeenMs: Date.now(),
    });
    useStore.getState().removePeer('sess-1', 'u-aaaa');
    const bucket = useStore.getState().peers['sess-1'];
    expect(bucket?.['u-aaaa']).toBeUndefined();
    expect(bucket?.['u-bbbb']).toBeDefined();
  });

  test('removePeer is a silent no-op for unknown ids', () => {
    useStore.getState().removePeer('sess-1', 'ghost');
    expect(useStore.getState().peers['sess-1']).toBeUndefined();
  });

  test('sweepStalePeers drops peers older than the visible window', () => {
    const now = Date.now();
    useStore.getState().upsertPeer('sess-1', {
      userId: 'u-old',
      displayName: 'Old',
      typing: false,
      lastSeenMs: now - PRESENCE_VISIBLE_WINDOW_MS - 5_000,
    });
    useStore.getState().upsertPeer('sess-1', {
      userId: 'u-fresh',
      displayName: 'Fresh',
      typing: true,
      lastSeenMs: now,
    });
    useStore.getState().sweepStalePeers(now);
    const bucket = useStore.getState().peers['sess-1'];
    expect(bucket?.['u-old']).toBeUndefined();
    expect(bucket?.['u-fresh']).toBeDefined();
  });

  test('setPresenceDisplayName updates the slice + ignores empties', () => {
    useStore.getState().setPresenceDisplayName('Alice');
    expect(useStore.getState().myPresenceDisplayName).toBe('Alice');
    useStore.getState().setPresenceDisplayName('   ');
    // Whitespace-only is rejected — value stays as 'Alice'.
    expect(useStore.getState().myPresenceDisplayName).toBe('Alice');
  });
});

describe('colorForUserId', () => {
  test('produces the same HSL string for the same input', () => {
    expect(colorForUserId('u-aaaa')).toBe(colorForUserId('u-aaaa'));
  });

  test('produces different colors for typical-distinct ids', () => {
    // Not a strong guarantee, but ensures the hash isn't a constant.
    const a = colorForUserId('u-aaaa');
    const b = colorForUserId('u-zzzz');
    expect(a).not.toBe(b);
  });
});

describe('PeerPresence component', () => {
  test('renders nothing when no peers are present', () => {
    const { container } = render(<PeerPresence sessionId="sess-1" />);
    expect(container.firstChild).toBeNull();
    cleanup();
  });

  test('renders peers + count strip when peers are present', () => {
    act(() => {
      useStore.getState().upsertPeer('sess-1', {
        userId: 'u-aaaa',
        displayName: 'Alice',
        typing: false,
        lastSeenMs: Date.now(),
      });
      useStore.getState().upsertPeer('sess-1', {
        userId: 'u-bbbb',
        displayName: 'Bob',
        typing: true,
        lastSeenMs: Date.now(),
      });
    });
    render(<PeerPresence sessionId="sess-1" />);
    const strip = screen.getByTestId('peer-presence');
    expect(strip.textContent).toContain('Alice');
    expect(strip.textContent).toContain('Bob');
    // The peer-list <li> has data-typing reflecting the state.
    const bob = strip.querySelectorAll('li')[1];
    expect(bob?.getAttribute('data-typing')).toBe('true');
    cleanup();
  });

  test('renders peers only for the requested session id', () => {
    act(() => {
      useStore.getState().upsertPeer('sess-other', {
        userId: 'u-aaaa',
        displayName: 'Alice',
        typing: false,
        lastSeenMs: Date.now(),
      });
    });
    const { container } = render(<PeerPresence sessionId="sess-1" />);
    expect(container.firstChild).toBeNull();
    cleanup();
  });
});
