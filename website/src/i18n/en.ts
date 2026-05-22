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
    versionBadge: 'v0.21 — local-first',
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
        icon: 'tools',
        title: '30+ tools out of the box',
        body: 'read_file, edit_file, run_command, glob_search, lint_file, find_symbol, fetch_image, web_search, and more.',
      },
      {
        icon: 'agent',
        title: 'Sub-agents on demand',
        body: 'Spawn architect, debugger, security-reviewer workers from a curated catalog via /spawn.',
      },
      {
        icon: 'brain',
        title: 'Memory + skills + hooks + MCP',
        body: 'Markdown skills hot-reload. Per-project memory. Settings-driven hooks. Any MCP server.',
      },
      {
        icon: 'branch',
        title: 'Branching sessions + /undo',
        body: 'Fork any turn into a side branch. Roll back a tool call without losing the conversation.',
      },
      {
        icon: 'graph',
        title: 'Code ontology',
        body: 'LSP-powered query tools map symbols, references, and types across the repo.',
      },
      {
        icon: 'compass',
        title: 'Architecture rules',
        body: '.localcode/arch.toml declares which modules may import which. Violations block edits.',
      },
      {
        icon: 'shieldKey',
        title: 'Secret scanner + sensitive files',
        body: 'Keys, tokens, .env paths flagged before they hit a diff or a commit.',
      },
      {
        icon: 'network',
        title: 'LAN P2P session sharing',
        body: 'mDNS-discovered peers can attach to your session on the local network. No cloud relay.',
      },
      {
        icon: 'palette',
        title: 'Whiteboard + PDF + voice',
        body: 'Drag-drop a PDF, sketch on the whiteboard, dictate the next step — all in the web UI.',
      },
      {
        icon: 'refresh',
        title: 'Auto-update with delta patches',
        body: 'Background self-update. Bsdiff/xdelta-style binary patches keep updates tiny.',
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
    ],
  },
  commands: {
    heading: 'Slash commands',
    subheading: 'Powerful actions, one keystroke away.',
    items: [
      { cmd: '/web', body: 'Open the web UI in your browser — tabs, files, sessions, voice.' },
      { cmd: '/update', body: 'Self-update to the latest release. Delta patches keep it tiny.' },
      { cmd: '/diff', body: 'Show pending diffs across the session before you commit.' },
      { cmd: '/branch', body: 'Fork the current turn into a side branch. Try ideas without losing context.' },
      { cmd: '/spawn', body: 'Spawn a sub-agent — architect, debugger, security-reviewer — on a subtask.' },
      { cmd: '/usage', body: 'Per-model token + cost breakdown for the current session.' },
      { cmd: '/language', body: 'Switch UI language. EN / RU built in.' },
      { cmd: '/undo', body: 'Roll back the last tool call without losing chat history.' },
    ],
  },
  profiles: {
    heading: 'Permission profiles',
    subheading: 'Five presets. Switch with /permissions.',
    items: [
      { name: 'Read-only', body: 'Read tools auto-approve. Everything mutating requires confirmation.' },
      { name: 'Cautious', body: 'Default. Read auto, every write/run shows a diff or command preview.' },
      { name: 'Trusted edits', body: 'Edits in the project root auto-approve. Shell commands still gated.' },
      { name: 'Trusted shell', body: 'Edits + shell auto-approve inside the project. Network calls gated.' },
      { name: 'Unrestricted', body: 'Everything auto. Use only in throwaway sandboxes.' },
    ],
  },
  privacy: {
    heading: 'Privacy + security',
    points: [
      {
        title: 'Local-first by design',
        body: 'A single Bun binary running on your machine. Sessions, settings, and skills live in ~/.localcode and your project.',
      },
      {
        title: 'No telemetry',
        body: 'Your code never leaves your machine unless you choose a cloud LLM. Even then, only the prompt goes out — never your filesystem.',
      },
      {
        title: 'Signed + notarized releases',
        body: 'macOS builds are code-signed and Apple-notarized. Linux releases are checksummed and signed.',
      },
      {
        title: 'Secret scanner blocks leaks',
        body: 'Keys, tokens, and .env content are detected before they hit a diff or a shell command. Commit-blocking by default.',
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
