// Minimal stroke-icon set. Inline SVG, ~24px, single colour via currentColor.
// Distinctive line weight and consistent stroke caps for a hand-drawn feel.

function Frame({ children, size = 26 }: { readonly children: React.ReactNode; readonly size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  spark: (
    <Frame>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </Frame>
  ),
  shield: (
    <Frame>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </Frame>
  ),
  bolt: (
    <Frame>
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
    </Frame>
  ),
  brain: (
    <Frame>
      <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3v-2M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3v-2" />
      <path d="M12 4v16M9 9h3M12 14h3" />
    </Frame>
  ),
  tools: (
    <Frame>
      <path d="M14 7l5 5-9 9-5-5 9-9z" />
      <path d="M13 8l3 3M3 21l4-4" />
    </Frame>
  ),
  usb: (
    <Frame>
      <circle cx="12" cy="20" r="2" />
      <path d="M12 18V6M12 6L8 10M12 6l4 4M9 13h6v3" />
    </Frame>
  ),
  lock: (
    <Frame>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Frame>
  ),
  agent: (
    <Frame>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3-7 8-7s8 3 8 7" />
      <path d="M9 8l3 3 3-3" />
    </Frame>
  ),
  branch: (
    <Frame>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="20" r="2" />
      <path d="M6 8v4a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V8" />
      <path d="M12 16v2" />
    </Frame>
  ),
  graph: (
    <Frame>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M7.5 7.5l3 3M16.5 7.5l-3 3M7.5 16.5l3-3M16.5 16.5l-3-3" />
    </Frame>
  ),
  compass: (
    <Frame>
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-2 5-5 2 2-5 5-2z" />
    </Frame>
  ),
  shieldKey: (
    <Frame>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
      <circle cx="10" cy="13" r="2" />
      <path d="M11.5 14l3 3M13 15.5l1 1" />
    </Frame>
  ),
  network: (
    <Frame>
      <circle cx="12" cy="12" r="3" />
      <circle cx="4" cy="6" r="1.7" />
      <circle cx="20" cy="6" r="1.7" />
      <circle cx="4" cy="18" r="1.7" />
      <circle cx="20" cy="18" r="1.7" />
      <path d="M9.5 10.5L5.2 7.2M14.5 10.5l4.3-3.3M9.5 13.5L5.2 16.8M14.5 13.5l4.3 3.3" />
    </Frame>
  ),
  palette: (
    <Frame>
      <path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2 0-1.5 1-2 2.5-2H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10" cy="7.5" r="1" />
      <circle cx="14.5" cy="7.5" r="1" />
      <circle cx="17" cy="11" r="1" />
    </Frame>
  ),
  refresh: (
    <Frame>
      <path d="M4 12a8 8 0 0 1 14-5.3L20 4v6h-6" />
      <path d="M20 12a8 8 0 0 1-14 5.3L4 20v-6h6" />
    </Frame>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { readonly name: IconName }): JSX.Element {
  return ICONS[name];
}

export function isIconName(value: string): value is IconName {
  return value in ICONS;
}
