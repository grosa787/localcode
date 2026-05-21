/**
 * file-icons — map a filename to the appropriate Lucide icon + tint.
 *
 * The mapping is deliberately conservative: we keep the icon catalogue
 * small (5 buckets) to stay friendly to the icon-budget guidance in
 * `icons.ts`. The colour is a CSS variable name (without the `var(...)`
 * wrapper) so consumers can apply it via inline style and pick up the
 * active theme automatically.
 */

import type { ComponentType, SVGProps } from 'react';

import {
  Archive,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  File as FileIcon,
} from '../icons';

export type IconCmp = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }
>;

export interface FileIconSpec {
  Icon: IconCmp;
  /** CSS token name (without `var(--…)`). Used to tint the glyph. */
  colorVar: string;
}

const SPECS: Record<string, FileIconSpec> = {
  // ---- Code ----
  ts: { Icon: FileCode, colorVar: '--accent-primary' },
  tsx: { Icon: FileCode, colorVar: '--accent-primary' },
  js: { Icon: FileCode, colorVar: '--warning' },
  jsx: { Icon: FileCode, colorVar: '--warning' },
  mjs: { Icon: FileCode, colorVar: '--warning' },
  cjs: { Icon: FileCode, colorVar: '--warning' },
  py: { Icon: FileCode, colorVar: '--accent-primary' },
  rb: { Icon: FileCode, colorVar: '--danger' },
  go: { Icon: FileCode, colorVar: '--accent-primary' },
  rs: { Icon: FileCode, colorVar: '--warning' },
  java: { Icon: FileCode, colorVar: '--warning' },
  kt: { Icon: FileCode, colorVar: '--accent-primary' },
  swift: { Icon: FileCode, colorVar: '--warning' },
  c: { Icon: FileCode, colorVar: '--text-secondary' },
  h: { Icon: FileCode, colorVar: '--text-secondary' },
  cpp: { Icon: FileCode, colorVar: '--text-secondary' },
  hpp: { Icon: FileCode, colorVar: '--text-secondary' },
  cs: { Icon: FileCode, colorVar: '--accent-primary' },
  php: { Icon: FileCode, colorVar: '--accent-primary' },
  lua: { Icon: FileCode, colorVar: '--accent-primary' },
  sh: { Icon: FileCode, colorVar: '--text-secondary' },
  bash: { Icon: FileCode, colorVar: '--text-secondary' },
  zsh: { Icon: FileCode, colorVar: '--text-secondary' },
  ps1: { Icon: FileCode, colorVar: '--text-secondary' },
  sql: { Icon: FileCode, colorVar: '--accent-primary' },

  // ---- Markup / styles ----
  html: { Icon: FileCode, colorVar: '--warning' },
  htm: { Icon: FileCode, colorVar: '--warning' },
  xml: { Icon: FileCode, colorVar: '--text-secondary' },
  css: { Icon: FileCode, colorVar: '--accent-primary' },
  scss: { Icon: FileCode, colorVar: '--accent-primary' },
  sass: { Icon: FileCode, colorVar: '--accent-primary' },
  less: { Icon: FileCode, colorVar: '--accent-primary' },
  vue: { Icon: FileCode, colorVar: '--accent-primary' },
  svelte: { Icon: FileCode, colorVar: '--warning' },

  // ---- Data ----
  json: { Icon: FileJson, colorVar: '--warning' },
  yaml: { Icon: FileText, colorVar: '--text-secondary' },
  yml: { Icon: FileText, colorVar: '--text-secondary' },
  toml: { Icon: FileText, colorVar: '--text-secondary' },
  ini: { Icon: FileText, colorVar: '--text-secondary' },
  env: { Icon: FileText, colorVar: '--text-secondary' },
  csv: { Icon: FileText, colorVar: '--text-secondary' },
  tsv: { Icon: FileText, colorVar: '--text-secondary' },

  // ---- Docs ----
  md: { Icon: FileText, colorVar: '--text-secondary' },
  mdx: { Icon: FileText, colorVar: '--text-secondary' },
  txt: { Icon: FileText, colorVar: '--text-muted' },
  rst: { Icon: FileText, colorVar: '--text-secondary' },
  pdf: { Icon: FileText, colorVar: '--danger' },

  // ---- Images ----
  png: { Icon: FileImage, colorVar: '--accent-primary' },
  jpg: { Icon: FileImage, colorVar: '--accent-primary' },
  jpeg: { Icon: FileImage, colorVar: '--accent-primary' },
  gif: { Icon: FileImage, colorVar: '--accent-primary' },
  webp: { Icon: FileImage, colorVar: '--accent-primary' },
  svg: { Icon: FileImage, colorVar: '--warning' },
  bmp: { Icon: FileImage, colorVar: '--accent-primary' },
  ico: { Icon: FileImage, colorVar: '--accent-primary' },

  // ---- Archives ----
  zip: { Icon: Archive, colorVar: '--text-muted' },
  tar: { Icon: Archive, colorVar: '--text-muted' },
  gz: { Icon: Archive, colorVar: '--text-muted' },
  tgz: { Icon: Archive, colorVar: '--text-muted' },
  bz2: { Icon: Archive, colorVar: '--text-muted' },
  '7z': { Icon: Archive, colorVar: '--text-muted' },
  rar: { Icon: Archive, colorVar: '--text-muted' },
};

/** Lookup by full filename — used for dotfiles like `.gitignore` etc. */
const BY_FILENAME: Record<string, FileIconSpec> = {
  '.gitignore': { Icon: FileText, colorVar: '--text-muted' },
  '.gitattributes': { Icon: FileText, colorVar: '--text-muted' },
  '.editorconfig': { Icon: FileText, colorVar: '--text-muted' },
  '.npmrc': { Icon: FileText, colorVar: '--text-muted' },
  '.nvmrc': { Icon: FileText, colorVar: '--text-muted' },
  '.dockerignore': { Icon: FileText, colorVar: '--text-muted' },
  Dockerfile: { Icon: FileCode, colorVar: '--accent-primary' },
  Makefile: { Icon: FileCode, colorVar: '--accent-primary' },
  LICENSE: { Icon: FileText, colorVar: '--text-muted' },
  README: { Icon: FileText, colorVar: '--text-secondary' },
};

/** Pure: pick the icon spec for a filename. */
export function pickFileIcon(filename: string): FileIconSpec {
  const exact = BY_FILENAME[filename];
  if (exact !== undefined) return exact;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) {
    return { Icon: FileIcon, colorVar: '--text-muted' };
  }
  const ext = filename.slice(dot + 1).toLowerCase();
  const spec = SPECS[ext];
  if (spec !== undefined) return spec;
  return { Icon: FileIcon, colorVar: '--text-muted' };
}

/** True when the extension should render as an inline image preview. */
export function isImageFilename(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filename.slice(dot + 1).toLowerCase();
  return (
    ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' ||
    ext === 'webp' || ext === 'svg' || ext === 'bmp' || ext === 'ico'
  );
}

/** Map filename → language id for SyntaxBlock (or null when unknown). */
export function inferLanguageForSyntax(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) {
    if (filename === 'Dockerfile') return 'bash';
    if (filename === 'Makefile') return 'bash';
    return null;
  }
  const ext = filename.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'ts': return 'typescript';
    case 'tsx': return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs': return 'javascript';
    case 'jsx': return 'jsx';
    case 'py': return 'python';
    case 'sh':
    case 'bash':
    case 'zsh': return 'bash';
    case 'json': return 'json';
    case 'md':
    case 'mdx': return 'markdown';
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg': return 'html';
    case 'css':
    case 'scss':
    case 'sass':
    case 'less': return 'css';
    default: return null;
  }
}

/** Pretty-print a byte count: 12 B / 4.2 KB / 1.3 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
