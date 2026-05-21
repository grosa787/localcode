import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadPlugins,
  loadPluginRecords,
  buildPluginHandlerMap,
  buildPluginToolIndex,
} from '@/plugins';

let tmpRoot = '';

async function writePlugin(rel: string, body: string): Promise<void> {
  const full = path.join(tmpRoot, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await fsWriteFile(full, body, 'utf8');
}

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-plugin-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('loadPlugins', () => {
  test('loads a plugin via default export', async () => {
    await writePlugin(
      '.localcode/plugins/echo.mjs',
      `export default {
  name: 'echo',
  tools: [{
    name: 'echo_tool',
    description: 'Echo input',
    parameters: { type: 'object', properties: {} },
    async execute(args) {
      return { success: true, output: 'echo:' + JSON.stringify(args) };
    },
  }],
};`,
    );
    const plugins = await loadPlugins({ projectRoot: tmpRoot, globalDir: null });
    expect(plugins).toHaveLength(1);
    const first = plugins[0];
    expect(first?.name).toBe('echo');
    expect(first?.tools).toHaveLength(1);
    expect(first?.tools[0]?.name).toBe('echo_tool');
  });

  test('loads a plugin via named tool export and infers name from filename', async () => {
    await writePlugin(
      '.localcode/plugins/my-tool.mjs',
      `export const tool = {
  name: 'my_tool',
  description: 'Single tool plugin',
  parameters: { type: 'object', properties: {} },
  async execute() { return { success: true, output: 'ok' }; },
};`,
    );
    const plugins = await loadPlugins({ projectRoot: tmpRoot, globalDir: null });
    expect(plugins).toHaveLength(1);
    const first = plugins[0];
    expect(first?.name).toBe('my-tool');
    expect(first?.tools[0]?.name).toBe('my_tool');
  });

  test('skips invalid plugins (bad name, missing description, etc.)', async () => {
    // Plugin with invalid name (uppercase).
    await writePlugin(
      '.localcode/plugins/bad-name.mjs',
      `export default {
  name: 'BadName!!',
  tools: [{
    name: 'foo',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute() { return { success: true, output: 'ok' }; }
  }],
};`,
    );
    // Plugin with no description.
    await writePlugin(
      '.localcode/plugins/no-desc.mjs',
      `export default {
  name: 'no-desc',
  tools: [{
    name: 'foo',
    parameters: { type: 'object', properties: {} },
    async execute() { return { success: true, output: 'ok' }; }
  }],
};`,
    );
    const errors: string[] = [];
    const plugins = await loadPlugins({
      projectRoot: tmpRoot,
      globalDir: null,
      onLoadError: (_path, err) => errors.push(err.message),
    });
    expect(plugins).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  test('project plugins override global plugins of the same name', async () => {
    const globalDir = path.join(tmpRoot, 'g-plugins');
    await mkdir(globalDir, { recursive: true });
    await fsWriteFile(
      path.join(globalDir, 'thing.mjs'),
      `export default {
  name: 'thing',
  tools: [{
    name: 'thing_tool',
    description: 'global thing',
    parameters: { type: 'object', properties: {} },
    async execute() { return { success: true, output: 'global' }; }
  }],
};`,
      'utf8',
    );
    await writePlugin(
      '.localcode/plugins/thing.mjs',
      `export default {
  name: 'thing',
  tools: [{
    name: 'thing_tool',
    description: 'project thing',
    parameters: { type: 'object', properties: {} },
    async execute() { return { success: true, output: 'project' }; }
  }],
};`,
    );

    const records = await loadPluginRecords({ projectRoot: tmpRoot, globalDir });
    expect(records).toHaveLength(1);
    const first = records[0];
    expect(first?.source).toBe('project');
    expect(first?.plugin.tools[0]?.description).toBe('project thing');
  });

  test('returns empty list when neither dir exists', async () => {
    const plugins = await loadPlugins({ projectRoot: tmpRoot, globalDir: null });
    expect(plugins).toEqual([]);
  });
});

describe('buildPluginHandlerMap', () => {
  test('wraps tool execute as preview, normalises results, catches throws', async () => {
    await writePlugin(
      '.localcode/plugins/bag.mjs',
      `export default {
  name: 'bag',
  tools: [
    {
      name: 'good',
      description: 'good tool',
      parameters: { type: 'object', properties: {} },
      async execute() { return { success: true, output: 'OK' }; }
    },
    {
      name: 'broken',
      description: 'broken tool',
      parameters: { type: 'object', properties: {} },
      async execute() { throw new Error('boom'); }
    },
    {
      name: 'malformed',
      description: 'returns string',
      parameters: { type: 'object', properties: {} },
      async execute() { return 'not-an-object'; }
    },
  ],
};`,
    );
    const plugins = await loadPlugins({ projectRoot: tmpRoot, globalDir: null });
    const map = buildPluginHandlerMap(plugins);

    const good = map['good'];
    const broken = map['broken'];
    const malformed = map['malformed'];
    expect(good).toBeDefined();
    expect(broken).toBeDefined();
    expect(malformed).toBeDefined();

    const okResult = await good!.preview({}, { projectRoot: tmpRoot });
    expect(okResult.success).toBe(true);
    expect(okResult.output).toBe('OK');

    const brokenResult = await broken!.preview({}, { projectRoot: tmpRoot });
    expect(brokenResult.success).toBe(false);
    expect(brokenResult.error).toContain('boom');

    const malformedResult = await malformed!.preview({}, { projectRoot: tmpRoot });
    expect(malformedResult.success).toBe(false);
    expect(malformedResult.error).toContain('non-object');
  });
});

describe('buildPluginToolIndex', () => {
  test('maps tool names back to (plugin, tool) records', async () => {
    await writePlugin(
      '.localcode/plugins/idx.mjs',
      `export default {
  name: 'idx',
  tools: [{
    name: 't1',
    description: 'tool 1',
    parameters: { type: 'object', properties: {} },
    async execute() { return { success: true, output: '1' }; }
  }],
};`,
    );
    const plugins = await loadPlugins({ projectRoot: tmpRoot, globalDir: null });
    const idx = buildPluginToolIndex(plugins);
    const record = idx.get('t1');
    expect(record?.plugin.name).toBe('idx');
    expect(record?.tool.name).toBe('t1');
  });
});
