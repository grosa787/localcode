/**
 * Project filesystem scanner.
 *
 * Walks the project tree (respecting `.gitignore` + hard-coded excludes)
 * and produces a `ScanResult` containing:
 *   - a unix-style directory tree,
 *   - the total file count and byte size,
 *   - a list of "key files" (README, manifests, configs, entry points) with
 *     their truncated contents,
 *   - a list of detected programming languages sorted by file count desc.
 *
 * Limits (tuned for projects up to a few thousand files):
 *   - Max depth:  5 levels from the project root.
 *   - Max files:  10 000 total — partial result returned if exceeded.
 *   - Key-file content truncated to 2 000 chars per file.
 *   - Binary files detected via NUL byte in first 1 KB and skipped.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseGitignore, shouldIgnore } from './gitignore-parser';
import {
  extractCodeStyle,
  type ExtractedCodeStyle,
} from './code-style-extractor';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type KeyFileType = 'readme' | 'manifest' | 'config' | 'entry';

export interface KeyFile {
  path: string;
  content: string;
  type: KeyFileType;
}

export interface ScanResult {
  tree: string;
  fileCount: number;
  totalSize: number;
  keyFiles: KeyFile[];
  languages: string[];
  /**
   * ROADMAP #7 — auto-detected code style for the project. Optional for
   * backward compatibility: callers that constructed `ScanResult` literals
   * before this field existed (e.g. older tests) keep compiling. Production
   * scanner runs always populate this field via `extractCodeStyle`.
   */
  codeStyle?: ExtractedCodeStyle;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_DEPTH = 5;
const MAX_FILES = 10_000;
const KEY_FILE_MAX_CHARS = 2_000;
const BINARY_SNIFF_BYTES = 1024;
const TRUNCATION_MARKER = '\n\n[... truncated ...]';

/** Key-file matchers, in priority order. Case-insensitive exact matches. */
interface KeyFilePattern {
  type: KeyFileType;
  /** Path relative to project root, forward-slash separated. */
  match: string;
  /** If true, `match` is compared only against the file's basename. */
  basenameOnly: boolean;
}

const KEY_FILE_PATTERNS: readonly KeyFilePattern[] = [
  // Readmes.
  { type: 'readme', match: 'readme.md', basenameOnly: true },
  { type: 'readme', match: 'readme.rst', basenameOnly: true },
  { type: 'readme', match: 'readme.txt', basenameOnly: true },
  // Manifests.
  { type: 'manifest', match: 'package.json', basenameOnly: true },
  { type: 'manifest', match: 'pyproject.toml', basenameOnly: true },
  { type: 'manifest', match: 'requirements.txt', basenameOnly: true },
  { type: 'manifest', match: 'cargo.toml', basenameOnly: true },
  { type: 'manifest', match: 'go.mod', basenameOnly: true },
  { type: 'manifest', match: 'pom.xml', basenameOnly: true },
  { type: 'manifest', match: 'build.gradle', basenameOnly: true },
  { type: 'manifest', match: 'gemfile', basenameOnly: true },
  { type: 'manifest', match: 'composer.json', basenameOnly: true },
  // Configs.
  { type: 'config', match: '.env.example', basenameOnly: true },
  { type: 'config', match: 'docker-compose.yml', basenameOnly: true },
  { type: 'config', match: 'docker-compose.yaml', basenameOnly: true },
  { type: 'config', match: 'dockerfile', basenameOnly: true },
  { type: 'config', match: 'tsconfig.json', basenameOnly: true },
  // Entry points (path-sensitive).
  { type: 'entry', match: 'src/main.ts', basenameOnly: false },
  { type: 'entry', match: 'src/index.ts', basenameOnly: false },
  { type: 'entry', match: 'main.py', basenameOnly: false },
  { type: 'entry', match: 'src/main.rs', basenameOnly: false },
  { type: 'entry', match: 'main.go', basenameOnly: false },
  { type: 'entry', match: 'src/main.go', basenameOnly: false },
  { type: 'entry', match: 'index.js', basenameOnly: false },
  { type: 'entry', match: 'src/index.js', basenameOnly: false },
];

/** Extension → language mapping. Lowercase keys including the leading dot. */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.hpp': 'C++',
  '.h': 'C++',
  '.c': 'C',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.md': 'Markdown',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.html': 'Web',
  '.css': 'Web',
};

// ---------------------------------------------------------------------------
// Internal walk types
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  isDir: boolean;
  children: TreeNode[];
}

interface WalkAccumulator {
  fileCount: number;
  totalSize: number;
  /** Relative forward-slash paths of every discovered file. */
  filePaths: string[];
  /** Count per detected language. */
  languageCounts: Map<string, number>;
  /** `true` once MAX_FILES was exceeded — stops further descent. */
  limitReached: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class ProjectScanner {
  /**
   * Scan the given project root and return a ScanResult.
   *
   * Never throws on per-file errors — they are silently skipped. Throws
   * only if the project root itself cannot be stat-ed.
   */
  async scan(projectRoot: string): Promise<ScanResult> {
    const absRoot = path.resolve(projectRoot);
    await fs.stat(absRoot); // throws if root is unreadable

    const patterns = parseGitignore(absRoot);
    const rootName = path.basename(absRoot) || absRoot;

    const accumulator: WalkAccumulator = {
      fileCount: 0,
      totalSize: 0,
      filePaths: [],
      languageCounts: new Map<string, number>(),
      limitReached: false,
    };

    const rootNode: TreeNode = { name: rootName, isDir: true, children: [] };
    await this.walkDirectory(absRoot, '', 0, patterns, accumulator, rootNode);

    const tree = this.renderTree(rootNode);
    const keyFiles = await this.collectKeyFiles(absRoot, accumulator.filePaths);
    const languages = this.finalizeLanguages(accumulator.languageCounts);

    // Code style extraction (ROADMAP #7). Best-effort — never throws.
    let codeStyle: ExtractedCodeStyle | undefined;
    try {
      codeStyle = await extractCodeStyle(absRoot);
    } catch {
      codeStyle = undefined;
    }

    return {
      tree,
      fileCount: accumulator.fileCount,
      totalSize: accumulator.totalSize,
      keyFiles,
      languages,
      codeStyle,
    };
  }

  // -------------------------------------------------------------------------
  // Walk
  // -------------------------------------------------------------------------

  private async walkDirectory(
    absDir: string,
    relDir: string,
    depth: number,
    patterns: string[],
    acc: WalkAccumulator,
    parentNode: TreeNode,
  ): Promise<void> {
    if (acc.limitReached) return;
    if (depth > MAX_DEPTH) return;

    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      const dirents = await fs.readdir(absDir, { withFileTypes: true });
      entries = dirents.map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
      }));
    } catch {
      return; // permission / broken link — just skip
    }

    // Sort: directories first, then files, both alphabetically (case-
    // insensitive) for stable, readable output.
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    for (const entry of entries) {
      if (acc.limitReached) return;

      const relPath = relDir === ''
        ? entry.name
        : `${relDir}/${entry.name}`;

      if (shouldIgnore(relPath, patterns)) continue;

      const absPath = path.join(absDir, entry.name);

      if (entry.isDirectory) {
        const childNode: TreeNode = {
          name: entry.name,
          isDir: true,
          children: [],
        };

        if (depth + 1 <= MAX_DEPTH) {
          await this.walkDirectory(
            absPath,
            relPath,
            depth + 1,
            patterns,
            acc,
            childNode,
          );
        }
        parentNode.children.push(childNode);
        continue;
      }

      // Regular file.
      if (acc.fileCount >= MAX_FILES) {
        acc.limitReached = true;
        return;
      }

      let size = 0;
      try {
        const stat = await fs.stat(absPath);
        size = stat.size;
      } catch {
        // Unreadable — still count it in the tree but skip language/size.
      }

      acc.fileCount += 1;
      acc.totalSize += size;
      acc.filePaths.push(relPath);

      const ext = path.extname(entry.name).toLowerCase();
      const lang = ext.length > 0 ? EXTENSION_LANGUAGES[ext] : undefined;
      if (lang !== undefined) {
        const prev = acc.languageCounts.get(lang) ?? 0;
        acc.languageCounts.set(lang, prev + 1);
      }

      parentNode.children.push({
        name: entry.name,
        isDir: false,
        children: [],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Tree rendering
  // -------------------------------------------------------------------------

  /**
   * Render a unix-style tree:
   *   projectName/
   *     dirA/
   *       file1.ts
   *     file2.ts
   *
   * Two-space indentation per depth level; directories end with `/`.
   */
  private renderTree(root: TreeNode): string {
    const lines: string[] = [];
    lines.push(`${root.name}/`);
    this.appendTreeLines(root.children, 1, lines);
    return lines.join('\n');
  }

  private appendTreeLines(
    nodes: TreeNode[],
    depth: number,
    out: string[],
  ): void {
    const indent = '  '.repeat(depth);
    for (const node of nodes) {
      out.push(`${indent}${node.name}${node.isDir ? '/' : ''}`);
      if (node.isDir && node.children.length > 0) {
        this.appendTreeLines(node.children, depth + 1, out);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Key-file collection
  // -------------------------------------------------------------------------

  private async collectKeyFiles(
    absRoot: string,
    filePaths: string[],
  ): Promise<KeyFile[]> {
    // Build a case-insensitive index of relative paths → actual path on disk.
    const byLowerPath = new Map<string, string>();
    const byLowerBasename = new Map<string, string[]>();
    for (const rel of filePaths) {
      const lower = rel.toLowerCase();
      if (!byLowerPath.has(lower)) byLowerPath.set(lower, rel);
      const base = path.basename(rel).toLowerCase();
      const list = byLowerBasename.get(base) ?? [];
      list.push(rel);
      byLowerBasename.set(base, list);
    }

    const results: KeyFile[] = [];
    const takenPaths = new Set<string>();

    for (const pattern of KEY_FILE_PATTERNS) {
      const candidates: string[] = [];

      if (pattern.basenameOnly) {
        const matches = byLowerBasename.get(pattern.match) ?? [];
        // Only include files whose relative path is shallow — prefer the
        // root-level one if multiple exist.
        const sorted = [...matches].sort(
          (a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b),
        );
        for (const m of sorted) {
          if (!takenPaths.has(m)) candidates.push(m);
        }
      } else {
        const exact = byLowerPath.get(pattern.match);
        if (exact !== undefined && !takenPaths.has(exact)) {
          candidates.push(exact);
        }
      }

      // For each pattern, take only the FIRST matching file (we don't want
      // to flood the LLM with 30 copies of the same type).
      const first = candidates[0];
      if (first === undefined) continue;

      const absFile = path.join(absRoot, first);
      const content = await this.readKeyFileContent(absFile);
      if (content === null) continue;

      results.push({
        path: first,
        content,
        type: pattern.type,
      });
      takenPaths.add(first);
    }

    return results;
  }

  /**
   * Read a key file, truncating to KEY_FILE_MAX_CHARS and skipping binary
   * content. Returns `null` if the file is binary or unreadable.
   */
  private async readKeyFileContent(absPath: string): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(absPath, 'r');
      const sniff = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(
        sniff,
        0,
        BINARY_SNIFF_BYTES,
        0,
      );
      for (let i = 0; i < bytesRead; i += 1) {
        if (sniff[i] === 0) {
          return null; // binary
        }
      }
    } catch {
      return null;
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // swallow
        }
      }
    }

    let raw: string;
    try {
      raw = await fs.readFile(absPath, 'utf-8');
    } catch {
      return null;
    }

    if (raw.length <= KEY_FILE_MAX_CHARS) return raw;
    return raw.slice(0, KEY_FILE_MAX_CHARS) + TRUNCATION_MARKER;
  }

  // -------------------------------------------------------------------------
  // Language summary
  // -------------------------------------------------------------------------

  private finalizeLanguages(counts: Map<string, number>): string[] {
    const entries = Array.from(counts.entries());
    entries.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const [lang] of entries) {
      if (seen.has(lang)) continue;
      seen.add(lang);
      out.push(lang);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function depthOf(relPath: string): number {
  if (relPath.length === 0) return 0;
  let count = 0;
  for (const ch of relPath) {
    if (ch === '/') count += 1;
  }
  return count;
}
