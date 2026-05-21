/**
 * NotificationBell — badge rendering + click toggle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useStore } from '../state/store';

import { NotificationBell } from './NotificationBell';

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState({
    ...initialState,
    notifications: [],
    notificationsOpen: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('NotificationBell', () => {
  test('renders without a badge when there are no unread notifications', () => {
    render(<NotificationBell />);
    expect(screen.queryByTestId('notification-badge')).toBeNull();
  });

  test('renders a badge with the unread count', () => {
    useStore.getState().pushNotification({
      type: 'agent_completed',
      title: 'a',
    });
    useStore.getState().pushNotification({
      type: 'agent_errored',
      title: 'b',
    });
    render(<NotificationBell />);
    const badge = screen.getByTestId('notification-badge');
    expect(badge.textContent).toBe('2');
  });

  test('caps badge text at "99+" when unread > 99', () => {
    for (let i = 0; i < 120; i += 1) {
      useStore.getState().pushNotification({
        type: 'agent_completed',
        title: `t${i}`,
      });
    }
    render(<NotificationBell />);
    const badge = screen.getByTestId('notification-badge');
    expect(badge.textContent).toBe('99+');
  });

  test('read notifications are excluded from the unread count', () => {
    useStore.getState().pushNotification({
      type: 'agent_completed',
      title: 'a',
    });
    useStore.getState().pushNotification({
      type: 'agent_completed',
      title: 'b',
    });
    const id = useStore.getState().notifications[0]?.id;
    useStore.getState().markRead(id ?? '');
    render(<NotificationBell />);
    expect(screen.getByTestId('notification-badge').textContent).toBe('1');
  });

  test('clicking the bell toggles notificationsOpen', () => {
    render(<NotificationBell />);
    expect(useStore.getState().notificationsOpen).toBe(false);
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(useStore.getState().notificationsOpen).toBe(true);
  });
});
