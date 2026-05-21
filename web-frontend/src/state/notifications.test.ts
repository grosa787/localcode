/**
 * Notifications store slice — push, markRead, markAllRead, clearAll,
 * FIFO cap behaviour.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import { NOTIFICATION_CAP, useStore } from './store';

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState({
    ...initialState,
    notifications: [],
    notificationsOpen: false,
    browserNotificationsEnabled: false,
  });
});

describe('notifications store slice', () => {
  test('pushNotification appends with id/timestamp/read=false', () => {
    useStore.getState().pushNotification({
      type: 'agent_completed',
      title: 'hello',
    });
    const list = useStore.getState().notifications;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBeTruthy();
    expect(list[0]?.timestamp).toBeGreaterThan(0);
    expect(list[0]?.read).toBe(false);
    expect(list[0]?.title).toBe('hello');
  });

  test('pushNotification preserves optional body + sessionId', () => {
    useStore.getState().pushNotification({
      type: 'approval_required',
      title: 'approve',
      body: 'write_file',
      sessionId: 's1',
    });
    const entry = useStore.getState().notifications[0];
    expect(entry?.body).toBe('write_file');
    expect(entry?.sessionId).toBe('s1');
  });

  test('markRead flips a single entry to read=true', () => {
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'a' });
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'b' });
    const id = useStore.getState().notifications[0]?.id;
    expect(id).toBeTruthy();
    useStore.getState().markRead(id ?? '');
    const list = useStore.getState().notifications;
    expect(list[0]?.read).toBe(true);
    expect(list[1]?.read).toBe(false);
  });

  test('markRead is a no-op when the id is unknown', () => {
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'a' });
    const before = useStore.getState().notifications;
    useStore.getState().markRead('does-not-exist');
    expect(useStore.getState().notifications).toBe(before);
  });

  test('markAllRead flips every entry to read=true', () => {
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'a' });
    useStore.getState().pushNotification({ type: 'agent_errored', title: 'b' });
    useStore.getState().markAllRead();
    const list = useStore.getState().notifications;
    expect(list.every((n) => n.read)).toBe(true);
  });

  test('clearAll empties the list', () => {
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'a' });
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'b' });
    useStore.getState().clearAll();
    expect(useStore.getState().notifications).toHaveLength(0);
  });

  test('FIFO cap evicts oldest entries past NOTIFICATION_CAP', () => {
    for (let i = 0; i < NOTIFICATION_CAP + 5; i += 1) {
      useStore.getState().pushNotification({
        type: 'agent_completed',
        title: `t${i}`,
      });
    }
    const list = useStore.getState().notifications;
    expect(list).toHaveLength(NOTIFICATION_CAP);
    // First entries (t0..t4) should have been evicted.
    expect(list[0]?.title).toBe('t5');
    expect(list[list.length - 1]?.title).toBe(`t${NOTIFICATION_CAP + 4}`);
  });

  test('toggleNotificationCenter flips the open flag', () => {
    expect(useStore.getState().notificationsOpen).toBe(false);
    useStore.getState().toggleNotificationCenter();
    expect(useStore.getState().notificationsOpen).toBe(true);
    useStore.getState().toggleNotificationCenter();
    expect(useStore.getState().notificationsOpen).toBe(false);
  });

  test('setBrowserNotificationsEnabled writes the flag', () => {
    useStore.getState().setBrowserNotificationsEnabled(true);
    expect(useStore.getState().browserNotificationsEnabled).toBe(true);
    useStore.getState().setBrowserNotificationsEnabled(false);
    expect(useStore.getState().browserNotificationsEnabled).toBe(false);
  });
});
