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
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { readonly name: IconName }): JSX.Element {
  return ICONS[name];
}

export function isIconName(value: string): value is IconName {
  return value in ICONS;
}
