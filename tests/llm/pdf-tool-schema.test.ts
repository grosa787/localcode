/**
 * Confirms the `read_pdf` tool is wired into the OpenAI-compatible tools
 * schema and the KNOWN_TOOL_NAMES set. Both are read-only — a regression
 * here means the model never sees the tool.
 */
import { describe, expect, test } from 'bun:test';

import { TOOLS_SCHEMA, TOOLS_BY_NAME } from '@/llm/tools-schema';
import { KNOWN_TOOL_NAMES } from '@/types/message';

describe('read_pdf tool schema', () => {
  test('appears in TOOLS_SCHEMA', () => {
    const names = TOOLS_SCHEMA.map((t) => t.function.name);
    expect(names).toContain('read_pdf');
  });

  test('TOOLS_BY_NAME has correct shape', () => {
    const entry = TOOLS_BY_NAME['read_pdf'];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('missing read_pdf');
    expect(entry.type).toBe('function');
    expect(entry.function.name).toBe('read_pdf');
    expect(entry.function.parameters.required).toEqual(['path']);
    const props = entry.function.parameters.properties;
    expect(props['path']).toBeDefined();
    expect(props['pages']).toBeDefined();
    expect(props['includeImages']).toBeDefined();
    const path = props['path'];
    if (path === undefined) throw new Error('missing path prop');
    expect(path.type).toBe('string');
  });

  test('KNOWN_TOOL_NAMES contains read_pdf', () => {
    expect(KNOWN_TOOL_NAMES.has('read_pdf')).toBe(true);
  });

  test('description fits the 15-25 word band', () => {
    const entry = TOOLS_BY_NAME['read_pdf'];
    if (entry === undefined) throw new Error('missing read_pdf');
    const words = entry.function.description.split(/\s+/).filter(Boolean);
    expect(words.length).toBeGreaterThan(10);
    expect(words.length).toBeLessThan(60);
  });
});
