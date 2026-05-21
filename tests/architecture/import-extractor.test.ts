/**
 * Import-extractor tests.
 *
 * Covers the supported import shapes and the tsconfig-paths resolution
 * branch. Each fixture writes a minimal project tree under tmp so
 * extension resolution sees real files.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetTsconfigCache,
  extractImports,
  extractImportsFromSource,
} from '@/architecture';

let projectRoot = '';

beforeEach(async () => {
  projectRoot = path.join(os.tmpdir(), `arch-extract-${crypto.randomUUID()}`);
  await mkdir(path.join(projectRoot, 'src', 'ui'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src', 'llm'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src', 'types'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'llm', 'adapter.ts'), 'export const x = 1;');
  await writeFile(path.join(projectRoot, 'src', 'types', 'global.ts'), 'export const t = 1;');
  await writeFile(path.join(projectRoot, 'src', 'ui', 'helper.ts'), 'export const h = 1;');
  _resetTsconfigCache();
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  _resetTsconfigCache();
});

async function withTsconfig(): Promise<void> {
  const tsconfig = {
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['./src/*'] },
    },
  };
  await writeFile(path.join(projectRoot, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
}

describe('extractImports', () => {
  test('handles default + named + namespace + side-effect + dynamic + type-only', async () => {
    await withTsconfig();
    const source = `
import adapter from '@/llm/adapter';
import { x } from '@/llm/adapter';
import * as Z from '@/llm/adapter';
import '@/ui/helper';
import type T from '@/types/global';
const lazy = await import('@/llm/adapter');
export { x as y } from '@/llm/adapter';
`;
    const filePath = path.join(projectRoot, 'src', 'ui', 'main.ts');
    await writeFile(filePath, source);
    const edges = extractImports(filePath, projectRoot);
    const specifiers = edges.map((e) => e.specifier);
    expect(specifiers).toContain('@/llm/adapter');
    expect(specifiers).toContain('@/ui/helper');
    expect(specifiers).toContain('@/types/global');
    // 4 distinct edges to @/llm/adapter (default, named, namespace, dynamic, re-export) + helper + types
    const adapterCount = specifiers.filter((s) => s === '@/llm/adapter').length;
    expect(adapterCount).toBeGreaterThanOrEqual(5);
  });

  test('resolves tsconfig paths to absolute file paths', async () => {
    await withTsconfig();
    const source = `import X from '@/llm/adapter';`;
    const filePath = path.join(projectRoot, 'src', 'ui', 'main.ts');
    await writeFile(filePath, source);
    const edges = extractImports(filePath, projectRoot);
    expect(edges.length).toBe(1);
    expect(edges[0]?.resolvedAbsolute).toBe(
      path.join(projectRoot, 'src', 'llm', 'adapter.ts'),
    );
  });

  test('resolves relative imports against source dir', async () => {
    const source = `import { h } from './helper';`;
    const filePath = path.join(projectRoot, 'src', 'ui', 'consumer.ts');
    await writeFile(filePath, source);
    const edges = extractImports(filePath, projectRoot);
    expect(edges.length).toBe(1);
    expect(edges[0]?.resolvedAbsolute).toBe(
      path.join(projectRoot, 'src', 'ui', 'helper.ts'),
    );
  });

  test('leaves bare specifiers (npm, node builtin) as unresolved', async () => {
    const source = `
import { z } from 'zod';
import fs from 'node:fs';
import { test } from 'bun:test';
`;
    const filePath = path.join(projectRoot, 'src', 'ui', 'bare.ts');
    await writeFile(filePath, source);
    const edges = extractImports(filePath, projectRoot);
    expect(edges.length).toBe(3);
    for (const e of edges) {
      expect(e.resolvedAbsolute).toBeNull();
    }
  });

  test('records line numbers', async () => {
    const source = '// line1\n// line2\nimport "./helper";\n';
    const filePath = path.join(projectRoot, 'src', 'ui', 'lined.ts');
    await writeFile(filePath, source);
    const edges = extractImports(filePath, projectRoot);
    expect(edges[0]?.line).toBe(3);
  });

  test('tolerates tsconfig with comments', async () => {
    const tsconfigWithComments = `{
  // baseUrl is relative to this file
  "compilerOptions": {
    /* multi
       line */
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  }
}
`;
    await writeFile(path.join(projectRoot, 'tsconfig.json'), tsconfigWithComments);
    _resetTsconfigCache();
    const source = `import X from '@/llm/adapter';`;
    const filePath = path.join(projectRoot, 'src', 'ui', 'cm.ts');
    await writeFile(filePath, source);
    const edges = extractImports(filePath, projectRoot);
    expect(edges[0]?.resolvedAbsolute).toBe(
      path.join(projectRoot, 'src', 'llm', 'adapter.ts'),
    );
  });

  test('extractImportsFromSource avoids disk read', () => {
    const source = `import { foo } from './bar';`;
    const edges = extractImportsFromSource(
      path.join(projectRoot, 'src', 'ui', 'in-memory.ts'),
      source,
      projectRoot,
    );
    // Specifier captured even though bar.ts doesn't exist on disk —
    // resolution returns null but the edge is still emitted.
    expect(edges.length).toBe(1);
    expect(edges[0]?.specifier).toBe('./bar');
    expect(edges[0]?.resolvedAbsolute).toBeNull();
  });

  test('returns [] when file is missing', () => {
    const edges = extractImports(
      path.join(projectRoot, 'src', 'ui', 'missing.ts'),
      projectRoot,
    );
    expect(edges).toEqual([]);
  });

  test('resolves directory imports via index file', async () => {
    await mkdir(path.join(projectRoot, 'src', 'pkg'), { recursive: true });
    await writeFile(path.join(projectRoot, 'src', 'pkg', 'index.ts'), 'export const k = 1;');
    const source = `import { k } from './pkg';`;
    const filePath = path.join(projectRoot, 'src', 'consumer.ts');
    await writeFile(filePath, source);
    const edges = extractImports(filePath, projectRoot);
    expect(edges[0]?.resolvedAbsolute).toBe(
      path.join(projectRoot, 'src', 'pkg', 'index.ts'),
    );
  });
});
