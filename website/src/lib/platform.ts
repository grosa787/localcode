export type Platform = 'macos' | 'linux' | 'wsl' | 'windows';

const INSTALL_BASE =
  'curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | bash';

export const INSTALL_COMMANDS: Record<Platform, string> = {
  macos: INSTALL_BASE,
  linux: INSTALL_BASE,
  wsl: INSTALL_BASE,
  // Windows native ships through WSL today; surface a hint instead of a broken cmd.
  windows: '# Use WSL — see docs',
};

/**
 * Best-effort browser-side platform detection. SSR returns 'macos' as a
 * stable default; the client effect refines it after hydration so SEO
 * snapshots stay deterministic.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'macos';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('windows')) return ua.includes('wsl') ? 'wsl' : 'windows';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'macos';
}
