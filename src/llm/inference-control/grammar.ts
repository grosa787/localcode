/**
 * Wave 16B — GBNF grammar compilation for tool calls.
 *
 * Compiles the OpenAI-compatible tool param schemas into a GBNF grammar
 * that llama.cpp's constrained decoder enforces. Two-pass design:
 *
 *   1. An ENUM grammar over the allowed tool NAMES. This alone kills the
 *      most common local-model failure: "calls a non-existent tool".
 *   2. A per-tool param-args grammar derived from each tool's JSON-Schema
 *      `parameters` (object / string / number / boolean / enum / array).
 *
 * Where an executor Zod validator is supplied (stricter than the wire
 * schema — e.g. `path` rejecting `..`, enum-of-literals), we tighten the
 * derived rule. Constraints GBNF cannot express (valid line ranges,
 * path-traversal containment, unique-find-text) are deliberately LEFT to
 * the preview/executor semantic check — grammar narrows the search space,
 * it does not replace validation. This keeps us from trading "malformed
 * JSON" for "valid JSON the executor rejects".
 *
 * Output shape (one tool call):
 *
 *   { "name": "<tool>", "arguments": <args-for-that-tool> }
 *
 * which matches the JSON the OpenAI tool-call `function` field carries.
 *
 * No external dependency: this is a small hand-rolled emitter. zod schemas
 * are introspected via their public `.shape` / `_def` surface guarded at
 * runtime — we never reach for `any`.
 */

import { z } from 'zod';
import type { JSONSchemaProperty, ToolSchema } from '@/types/message';
import type { GrammarSpec } from './types';

/** GBNF primitive rules shared across every compiled grammar. */
const GBNF_PRIMITIVES = `
ws       ::= [ \\t\\n\\r]*
string   ::= "\\"" char* "\\""
char     ::= [^"\\\\] | "\\\\" ( ["\\\\/bfnrt] | "u" hex hex hex hex )
hex      ::= [0-9a-fA-F]
number   ::= "-"? int frac? exp?
int      ::= "0" | [1-9] [0-9]*
frac     ::= "." [0-9]+
exp      ::= ("e" | "E") ("+" | "-")? [0-9]+
boolean  ::= "true" | "false"
`.trim();

/** Escape a string literal for embedding inside a GBNF double-quoted token. */
function gbnfLiteral(s: string): string {
  // GBNF string literals are double-quoted; escape backslash and quote.
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"\\"${escaped}\\""`;
}

/** A safe GBNF rule-name fragment derived from a tool / field name. */
function ruleId(...parts: string[]): string {
  return parts
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Extract the enum string-literals a Zod schema admits for a given key,
 * if the executor validator constrains it to a `z.enum([...])` /
 * `z.union([z.literal(...)])`. Returns null when not enumerable.
 */
function zodEnumValues(schema: z.ZodTypeAny): readonly string[] | null {
  const def: unknown = schema._def;
  if (!def || typeof def !== 'object') return null;
  const typeName = (def as { typeName?: unknown }).typeName;
  if (typeName === z.ZodFirstPartyTypeKind.ZodEnum) {
    const values = (def as { values?: unknown }).values;
    if (Array.isArray(values) && values.every((v) => typeof v === 'string')) {
      return values;
    }
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodNativeEnum) {
    const enumObj = (def as { values?: unknown }).values;
    if (enumObj && typeof enumObj === 'object') {
      const vals = Object.values(enumObj as Record<string, unknown>).filter(
        (v): v is string => typeof v === 'string',
      );
      if (vals.length > 0) return vals;
    }
  }
  return null;
}

/**
 * Pull the per-field Zod schema out of an executor validator (a
 * `z.object({...})`). Returns null when the validator is not an object
 * schema or has no such field.
 */
function zodFieldSchema(
  validator: z.ZodTypeAny | undefined,
  field: string,
): z.ZodTypeAny | null {
  if (!validator) return null;
  const def: unknown = validator._def;
  if (!def || typeof def !== 'object') return null;
  const typeName = (def as { typeName?: unknown }).typeName;
  if (typeName !== z.ZodFirstPartyTypeKind.ZodObject) return null;
  const shapeFn = (def as { shape?: unknown }).shape;
  if (typeof shapeFn !== 'function') return null;
  const shape: unknown = shapeFn.call(def);
  if (!shape || typeof shape !== 'object') return null;
  const candidate = (shape as Record<string, unknown>)[field];
  return candidate instanceof z.ZodType ? (candidate as z.ZodTypeAny) : null;
}

interface RuleBag {
  /** Accumulated named rules: name → body. Deduped by name. */
  rules: Map<string, string>;
}

/**
 * Emit a value rule for a single JSON-Schema property, tightened by the
 * executor field validator where possible. Returns the rule REFERENCE
 * (rule name or primitive) and registers any new named rules in `bag`.
 */
function emitValueRule(
  bag: RuleBag,
  nameHint: string,
  prop: JSONSchemaProperty,
  executorField: z.ZodTypeAny | null,
): { ref: string; usedExecutor: boolean } {
  // 1. Enum from the wire schema (explicit `enum` list).
  if (prop.enum && prop.enum.length > 0) {
    const ruleName = ruleId(nameHint, 'enum');
    bag.rules.set(ruleName, prop.enum.map(gbnfLiteral).join(' | '));
    return { ref: ruleName, usedExecutor: false };
  }

  // 2. Enum tightened from the executor validator (stricter than wire).
  const execEnum = executorField ? zodEnumValues(executorField) : null;
  if (execEnum && execEnum.length > 0) {
    const ruleName = ruleId(nameHint, 'enum');
    bag.rules.set(ruleName, execEnum.map(gbnfLiteral).join(' | '));
    return { ref: ruleName, usedExecutor: true };
  }

  switch (prop.type) {
    case 'string':
      return { ref: 'string', usedExecutor: false };
    case 'number':
      return { ref: 'number', usedExecutor: false };
    case 'boolean':
      return { ref: 'boolean', usedExecutor: false };
    case 'array': {
      const itemHint = ruleId(nameHint, 'item');
      const item = prop.items
        ? emitValueRule(bag, itemHint, prop.items, null)
        : { ref: 'value', usedExecutor: false };
      const arrRule = ruleId(nameHint, 'array');
      // Non-empty + empty: [] or [ v (, v)* ]
      bag.rules.set(
        arrRule,
        `"[" ws ( ${item.ref} ( ws "," ws ${item.ref} )* )? ws "]"`,
      );
      return { ref: arrRule, usedExecutor: item.usedExecutor };
    }
    case 'object': {
      // Nested object — emit an object rule from its own properties when
      // present, else fall back to a permissive JSON value.
      if (prop.properties && Object.keys(prop.properties).length > 0) {
        return emitObjectRule(
          bag,
          ruleId(nameHint, 'obj'),
          prop.properties,
          prop.required ?? [],
          undefined,
        );
      }
      return { ref: 'value', usedExecutor: false };
    }
    default:
      return { ref: 'value', usedExecutor: false };
  }
}

/**
 * Emit an object rule whose key order is fixed (required keys first, in
 * declaration order). We constrain to the declared keys; optional keys
 * are wrapped so the model may omit them. Returns the rule reference.
 */
function emitObjectRule(
  bag: RuleBag,
  ruleName: string,
  properties: Record<string, JSONSchemaProperty>,
  required: readonly string[],
  executor: z.ZodTypeAny | undefined,
): { ref: string; usedExecutor: boolean } {
  const keys = Object.keys(properties);
  let usedExecutor = false;
  // Stable order: required keys (declaration order) then optionals.
  const reqSet = new Set(required);
  const ordered = [
    ...keys.filter((k) => reqSet.has(k)),
    ...keys.filter((k) => !reqSet.has(k)),
  ];

  const memberRefs: { key: string; valueRef: string; optional: boolean }[] = [];
  for (const key of ordered) {
    const prop = properties[key];
    if (!prop) continue;
    const execField = zodFieldSchema(executor, key);
    const v = emitValueRule(bag, ruleId(ruleName, key), prop, execField);
    if (v.usedExecutor) usedExecutor = true;
    memberRefs.push({
      key,
      valueRef: v.ref,
      optional: !reqSet.has(key),
    });
  }

  if (memberRefs.length === 0) {
    // No declared properties: accept the empty object.
    bag.rules.set(ruleName, `"{" ws "}"`);
    return { ref: ruleName, usedExecutor };
  }

  // Build a comma-joined member sequence. Required members are mandatory;
  // optional members collapse to nothing. GBNF can't express arbitrary
  // key reordering cleanly, so we fix the order — local decoders comply.
  const parts: string[] = [`"{" ws`];
  let emittedRequired = false;
  for (let i = 0; i < memberRefs.length; i++) {
    const m = memberRefs[i];
    if (!m) continue;
    const pair = `${gbnfLiteral(m.key)} ws ":" ws ${m.valueRef}`;
    if (m.optional) {
      // Optional members: prefix with a comma only if something precedes.
      // We allow an optional `( "," ws <pair> )?` block.
      parts.push(`( ws "," ws ${pair} )?`);
    } else {
      if (emittedRequired) parts.push(`ws "," ws`);
      parts.push(pair);
      emittedRequired = true;
    }
  }
  parts.push(`ws "}"`);
  bag.rules.set(ruleName, parts.join(' '));
  return { ref: ruleName, usedExecutor };
}

/**
 * Compile a set of OpenAI-compatible tool schemas into a single GBNF
 * grammar string.
 *
 * @param toolSchemas      the wire tool schemas (`TOOLS_SCHEMA`).
 * @param executorValidators optional map tool-name → executor Zod schema.
 *   When present, per-tool arg rules are tightened from the validator
 *   (enums especially). Absent entries fall back to the wire schema.
 */
export function compileToolGrammar(
  toolSchemas: readonly ToolSchema[],
  executorValidators?: Readonly<Record<string, z.ZodTypeAny>>,
): GrammarSpec {
  const toolNames = toolSchemas.map((t) => t.function.name);
  const bag: RuleBag = { rules: new Map() };
  let derivedFromExecutor = false;

  // Per-tool call rule: { "name": "<tool>", "arguments": <args> }
  const callRefs: string[] = [];
  for (const tool of toolSchemas) {
    const name = tool.function.name;
    const params = tool.function.parameters;
    const argsRuleName = ruleId('args', name);
    const argsRule = emitObjectRule(
      bag,
      argsRuleName,
      params.properties ?? {},
      params.required ?? [],
      executorValidators?.[name],
    );
    if (argsRule.usedExecutor) derivedFromExecutor = true;

    const callRuleName = ruleId('call', name);
    bag.rules.set(
      callRuleName,
      `"{" ws ${gbnfLiteral('name')} ws ":" ws ${gbnfLiteral(name)} ws "," ws ` +
        `${gbnfLiteral('arguments')} ws ":" ws ${argsRule.ref} ws "}"`,
    );
    callRefs.push(callRuleName);
  }

  // Root: exactly one of the tool-call rules. The alternation over fixed
  // tool names is the pass-1 enum that kills non-existent-tool calls.
  const rootBody =
    callRefs.length > 0 ? callRefs.join(' | ') : `"{" ws "}"`;

  // A permissive JSON value fallback (only referenced by nested
  // free-form objects / arrays where we couldn't tighten further).
  bag.rules.set(
    'value',
    `string | number | boolean | "null" | object | array`,
  );
  bag.rules.set('object', `"{" ws ( string ws ":" ws value ( ws "," ws string ws ":" ws value )* )? ws "}"`);
  bag.rules.set('array', `"[" ws ( value ( ws "," ws value )* )? ws "]"`);

  const lines: string[] = [];
  lines.push(`root ::= ${rootBody}`);
  for (const [name, body] of bag.rules) {
    lines.push(`${name} ::= ${body}`);
  }
  lines.push(GBNF_PRIMITIVES);

  return {
    gbnf: lines.join('\n'),
    toolNames,
    derivedFromExecutor,
  };
}
