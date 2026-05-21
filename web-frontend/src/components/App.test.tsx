/**
 * App — Wave 8B layout assertions.
 *
 * RightDock was removed from the composition root; this test guards the
 * "no dock mount" invariant by static-inspecting the App module source.
 * A full mount is out of scope here (the App boots a WSClient + REST
 * client that would need extensive mocking) — App.responsive.test.tsx
 * already covers the live render path via the Sidebar shell.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

describe('App — RightDock removal (Wave 8B)', () => {
  const appSource = readFileSync(
    resolve(__dirname, '..', 'App.tsx'),
    'utf8',
  );

  test('App.tsx does NOT mount <RightDock />', () => {
    expect(appSource).not.toMatch(/<RightDock\b/);
  });

  test('App.tsx does NOT import { RightDock } from components', () => {
    expect(appSource).not.toMatch(/import\s*\{[^}]*\bRightDock\b[^}]*\}\s*from\s*['"][.][^'"]*RightDock/);
  });

  test('App.tsx mounts the MemoryEditor modal (memoryOverlayOpen gate)', () => {
    expect(appSource).toMatch(/memoryOverlayOpen/);
    expect(appSource).toMatch(/<MemoryEditor\b/);
  });
});
