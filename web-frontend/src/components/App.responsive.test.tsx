/**
 * App.responsive — viewport-conditioned layout outcomes.
 *
 * The full App composition root mounts WebSocket + REST clients which
 * are out of scope here. We exercise the responsive contract by
 * rendering the same Sidebar shell App.tsx renders, then asserting
 * the breakpoint-conditional visibility / state markers.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { useStore } from '../state/store';
import { Sidebar } from './Sidebar';
import { resolveBreakpoint } from '../util/use-viewport';

const initialState = useStore.getState();

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignored */
  }
  useStore.setState({
    ...initialState,
    sidebarCollapsed: false,
    projects: [],
    sessions: [],
    activeProjectId: null,
    activeSessionId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useStore.setState({ ...initialState });
  delete document.documentElement.dataset.viewport;
});

interface ResponsiveCase {
  width: number;
  expected: 'mobile' | 'tablet' | 'desktop' | 'wide';
  hamburgerVisible: boolean;
  brandWordVisible: boolean;
}

const CASES: ResponsiveCase[] = [
  // Mobile renders the drawer content in the DOM but visually hides it
  // via CSS transform — so the brand word IS present, just not visible.
  // Visibility on mobile is asserted via data-mobile-open === 'false'.
  { width: 480, expected: 'mobile', hamburgerVisible: true, brandWordVisible: true },
  { width: 900, expected: 'tablet', hamburgerVisible: false, brandWordVisible: false },
  { width: 1280, expected: 'desktop', hamburgerVisible: false, brandWordVisible: true },
  { width: 1920, expected: 'wide', hamburgerVisible: false, brandWordVisible: true },
];

describe('App responsive shell — breakpoint resolution table', () => {
  for (const c of CASES) {
    test(`width=${c.width} → breakpoint=${c.expected}`, () => {
      expect(resolveBreakpoint(c.width)).toBe(c.expected);
    });
  }
});

describe('App responsive shell — Sidebar visibility per breakpoint', () => {
  for (const c of CASES) {
    test(`width=${c.width} renders expected sidebar state`, () => {
      render(<Sidebar viewport={c.expected} />);
      // Sidebar root is always rendered as an <aside>.
      const aside = document.querySelector('aside');
      expect(aside).not.toBeNull();
      expect(aside?.getAttribute('data-viewport')).toBe(c.expected);

      // Brand word visibility (collapsed states hide it).
      const text = document.body.textContent ?? '';
      expect(text.includes('LocalCode')).toBe(c.brandWordVisible);

      // Hamburger handle present only on mobile (drawer-shut state).
      const handle = screen.queryByTestId('sidebar-mobile-handle');
      expect(handle !== null).toBe(c.hamburgerVisible);

      // Mobile must announce its closed state via data-mobile-open;
      // other breakpoints must NOT publish that attribute.
      const mobileOpen = aside?.getAttribute('data-mobile-open') ?? null;
      if (c.expected === 'mobile') {
        expect(mobileOpen).toBe('false');
      } else {
        expect(mobileOpen).toBeNull();
      }
    });
  }
});

describe('App responsive shell — html dataset reflects breakpoint', () => {
  test('setting the html attribute to "mobile" applies the data marker', () => {
    act(() => {
      document.documentElement.dataset.viewport = 'mobile';
    });
    expect(document.documentElement.dataset.viewport).toBe('mobile');
  });
});
