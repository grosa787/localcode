/**
 * VersionFooter — small muted footer at the bottom of the sidebar.
 *
 * Replaces the old NoxLogo/mascot. Shows "localcode v<version>" on a
 * single line. When the sidebar is collapsed, renders just the version
 * number so it still fits in a 56px-wide rail.
 *
 * The version is imported directly from the SPA's `package.json` at
 * build time (Vite handles `*.json` imports natively) so the displayed
 * value never drifts from the actual bundle's package version.
 */

import pkg from '../../package.json';

import styles from './VersionFooter.module.css';

const PKG_VERSION = (pkg as { version?: string }).version ?? 'dev';

export interface VersionFooterProps {
  version?: string;
  collapsed?: boolean;
}

export function VersionFooter({
  version = PKG_VERSION,
  collapsed = false,
}: VersionFooterProps): JSX.Element {
  return (
    <div
      className={`${styles.root} ${collapsed ? styles.collapsed : ''}`}
      aria-label={`localcode v${version}`}
    >
      {collapsed ? `v${version}` : `localcode v${version}`}
    </div>
  );
}
