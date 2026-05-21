import type { Strings } from './types';

export const en: Strings = {
  nav: {
    install: 'Install',
    features: 'Features',
    docs: 'Docs',
    github: 'GitHub',
  },
  hero: {
    tagline: 'Your terminal, but it actually understands the codebase.',
    subtitle:
      'LocalCode is a local-first AI coding assistant. Bring your own LLM — Ollama, Anthropic, OpenAI, OpenRouter, anything OpenAI-compatible. Terminal + web. Inspectable. Fast.',
    installCta: 'Install in 10 seconds',
    copy: 'Copy',
    copied: 'Copied',
  },
  install: {
    heading: 'One line. No Electron. No telemetry.',
    subheading: 'Pick your platform — the right command is highlighted.',
    macos: 'macOS',
    linux: 'Linux',
    wsl: 'WSL',
    windows: 'Windows',
  },
  features: {
    heading: 'Why LocalCode',
    tiles: [
      {
        icon: 'spark',
        title: 'Bring your own LLM',
        body: 'Ollama, LM Studio, Anthropic, OpenAI, OpenRouter, Gemini, Groq. Switch with a slash.',
      },
      {
        icon: 'shield',
        title: 'Approval gates by default',
        body: 'Diff previews. Command previews. Per-tool autoapprove. Five permission profiles.',
      },
      {
        icon: 'bolt',
        title: 'Two surfaces, one brain',
        body: 'Polished ink TUI and a real web UI with tabs, dock, voice, drag-drop, PDF, whiteboard.',
      },
      {
        icon: 'brain',
        title: 'Skills + memory',
        body: 'Markdown skills auto-discovered. Project memory persists across sessions.',
      },
      {
        icon: 'tools',
        title: 'Tool ecosystem',
        body: 'read/write/edit, run, glob, lint, find_symbol, fetch_image, MCP servers, plugins.',
      },
      {
        icon: 'usb',
        title: 'MCP + plugins',
        body: 'Wire any Model Context Protocol server. Drop in custom plugins as tools.',
      },
      {
        icon: 'lock',
        title: 'Local-first',
        body: 'Single Bun binary. SQLite session store. No cloud calls unless you opt in.',
      },
      {
        icon: 'agent',
        title: 'Sub-agents',
        body: 'Spawn architect, debugger, security-reviewer workers from a curated catalog.',
      },
    ],
  },
  surfaces: {
    heading: 'Two surfaces, same brain',
    tui: 'Terminal',
    web: 'Web',
    toggle: 'Toggle',
  },
  demo: {
    heading: 'See it move',
    caption: 'Live tool call with diff preview, approval, and streaming. (demo gif placeholder)',
  },
  channels: {
    heading: 'Install channels',
    soon: 'coming soon',
  },
  footer: {
    tagline: 'Made with care, not vibes.',
    license: 'MIT licensed',
    contact: 'Contact',
    contactValue: 'open an issue on GitHub',
  },
};
