/**
 * Wave 16B — GBNF grammar compilation tests.
 *
 * Verifies the two-pass design: (1) tool NAMES are constrained to the
 * enum of real tools in the `root` rule, (2) a sample tool's args grammar
 * is emitted, and an executor enum tightens a field into an enum rule.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { compileToolGrammar } from '@/llm/inference-control';
import { TOOLS_SCHEMA } from '@/llm/tools-schema';
import type { ToolSchema } from '@/types/message';

const readFileTool: ToolSchema = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number' },
        respondWithSummary: { type: 'boolean' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

const colorTool: ToolSchema = {
  type: 'function',
  function: {
    name: 'set_color',
    description: 'set',
    parameters: {
      type: 'object',
      properties: {
        color: { type: 'string', enum: ['red', 'green', 'blue'] },
      },
      required: ['color'],
      additionalProperties: false,
    },
  },
};

describe('compileToolGrammar', () => {
  test('root constrains tool names to the enum of real tools', () => {
    const spec = compileToolGrammar([readFileTool, colorTool]);
    expect(spec.toolNames).toEqual(['read_file', 'set_color']);
    // Root references one call rule per tool.
    const rootLine = spec.gbnf
      .split('\n')
      .find((l) => l.startsWith('root ::='));
    expect(rootLine).toBeDefined();
    expect(rootLine).toContain('call-read-file');
    expect(rootLine).toContain('call-set-color');
    // Each call rule pins the literal tool name.
    expect(spec.gbnf).toContain('\\"read_file\\"');
    expect(spec.gbnf).toContain('\\"set_color\\"');
  });

  test('an enum field yields an enum rule with the allowed literals', () => {
    const spec = compileToolGrammar([colorTool]);
    expect(spec.gbnf).toContain('\\"red\\"');
    expect(spec.gbnf).toContain('\\"green\\"');
    expect(spec.gbnf).toContain('\\"blue\\"');
    // The enum rule lists them as alternatives.
    const enumLine = spec.gbnf
      .split('\n')
      .find((l) => l.includes('\\"red\\"') && l.includes('|'));
    expect(enumLine).toBeDefined();
  });

  test('a sample tool emits typed arg rules (string/number/boolean)', () => {
    const spec = compileToolGrammar([readFileTool]);
    // args object rule exists and pins the `path` key + value types.
    expect(spec.gbnf).toContain('args-read-file');
    expect(spec.gbnf).toContain('\\"path\\"');
    // primitives are present (note: aligned with multiple spaces).
    expect(spec.gbnf).toMatch(/string\s+::=/);
    expect(spec.gbnf).toMatch(/number\s+::=/);
    expect(spec.gbnf).toMatch(/boolean\s+::=/);
  });

  test('executor enum validator tightens a wire string into an enum rule', () => {
    // Wire schema says `mode` is a free string; executor pins it to enum.
    const tool: ToolSchema = {
      type: 'function',
      function: {
        name: 'pick',
        description: 'pick',
        parameters: {
          type: 'object',
          properties: { mode: { type: 'string' } },
          required: ['mode'],
          additionalProperties: false,
        },
      },
    };
    const executor = { pick: z.object({ mode: z.enum(['fast', 'slow']) }) };
    const loose = compileToolGrammar([tool]);
    expect(loose.gbnf).not.toContain('\\"fast\\"');
    expect(loose.derivedFromExecutor).toBe(false);

    const tight = compileToolGrammar([tool], executor);
    expect(tight.gbnf).toContain('\\"fast\\"');
    expect(tight.gbnf).toContain('\\"slow\\"');
    expect(tight.derivedFromExecutor).toBe(true);
  });

  test('round-trips the real TOOLS_SCHEMA without throwing + names match', () => {
    const spec = compileToolGrammar(TOOLS_SCHEMA);
    expect(spec.toolNames.length).toBe(TOOLS_SCHEMA.length);
    for (const t of TOOLS_SCHEMA) {
      expect(spec.toolNames).toContain(t.function.name);
      // Each real tool name appears as a literal in the grammar.
      expect(spec.gbnf).toContain(`\\"${t.function.name}\\"`);
    }
    // Grammar is a non-trivial string with a root rule.
    expect(spec.gbnf.startsWith('root ::=')).toBe(true);
    expect(spec.gbnf.length).toBeGreaterThan(100);
  });

  test('array fields emit an array rule', () => {
    const tool: ToolSchema = {
      type: 'function',
      function: {
        name: 'tags',
        description: 't',
        parameters: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'string' } },
          },
          required: ['items'],
          additionalProperties: false,
        },
      },
    };
    const spec = compileToolGrammar([tool]);
    expect(spec.gbnf).toContain('"["');
    expect(spec.gbnf).toContain('"]"');
  });

  test('empty tool list still produces a valid root rule', () => {
    const spec = compileToolGrammar([]);
    expect(spec.toolNames).toEqual([]);
    expect(spec.gbnf.startsWith('root ::=')).toBe(true);
  });
});
