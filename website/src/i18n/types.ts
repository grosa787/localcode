export type Locale = 'en' | 'ru';

export interface Strings {
  readonly nav: {
    readonly install: string;
    readonly features: string;
    readonly docs: string;
    readonly github: string;
  };
  readonly hero: {
    readonly tagline: string;
    readonly subtitle: string;
    readonly installCta: string;
    readonly copy: string;
    readonly copied: string;
  };
  readonly install: {
    readonly heading: string;
    readonly subheading: string;
    readonly macos: string;
    readonly linux: string;
    readonly wsl: string;
    readonly windows: string;
  };
  readonly features: {
    readonly heading: string;
    readonly tiles: ReadonlyArray<{ readonly title: string; readonly body: string; readonly icon: string }>;
  };
  readonly surfaces: {
    readonly heading: string;
    readonly tui: string;
    readonly web: string;
    readonly toggle: string;
  };
  readonly demo: {
    readonly heading: string;
    readonly caption: string;
  };
  readonly channels: {
    readonly heading: string;
    readonly soon: string;
  };
  readonly footer: {
    readonly tagline: string;
    readonly license: string;
    readonly contact: string;
    readonly contactValue: string;
  };
}
