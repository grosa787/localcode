import { test, expect } from 'bun:test';
import pkg from '../../package.json';

/**
 * Guards the version single-source-of-truth. PKG_VERSION (cli.tsx) and
 * PKG_VERSION_FOR_UPDATER (app.tsx) drifted to 0.22.0 / 0.19.0 across
 * several releases because they were hardcoded literals — which made the
 * auto-updater believe it was perpetually out-of-date and re-download a
 * "newer" release on every launch. Both must now derive from the
 * package.json import; this test fails if anyone reverts to a literal.
 */

test('package.json version is a clean semver', () => {
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test('cli.tsx PKG_VERSION derives from package.json (not a hardcoded literal)', async () => {
  const src = await Bun.file(
    new URL('../../src/cli.tsx', import.meta.url),
  ).text();
  expect(src).toContain('const PKG_VERSION = pkgJson.version;');
  expect(src).not.toMatch(/const PKG_VERSION\s*=\s*'[\d.]+'/);
});

test('app.tsx PKG_VERSION_FOR_UPDATER derives from package.json (not a literal)', async () => {
  const src = await Bun.file(
    new URL('../../src/app.tsx', import.meta.url),
  ).text();
  expect(src).toContain('const PKG_VERSION_FOR_UPDATER = pkgJson.version;');
  expect(src).not.toMatch(/const PKG_VERSION_FOR_UPDATER\s*=\s*'[\d.]+'/);
});
