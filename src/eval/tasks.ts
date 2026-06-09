/**
 * Golden-task catalog.
 *
 * Each task scaffolds a tiny, self-contained tmp repo, hands the agent a
 * prompt, and defines a deterministic OFFLINE success check. Tasks cover
 * the real reliability surface of an autonomous coding agent:
 *
 *   - implement a function so a pre-written test passes,
 *   - fix a failing test,
 *   - rename a symbol across two files,
 *   - implement a small spec,
 *   - fix a type error,
 *   - add error handling,
 *   - write a missing export,
 *   - delete dead code,
 *   - add a JSON field,
 *   - wire two modules together.
 *
 * Determinism contract: every `success` check must be runnable with no
 * network — `node` for executing JS, `grep` for content assertions, or a
 * `fileContains` substring match. The `bun`/`node` binaries are assumed
 * present (CI + dev both have them). Tasks deliberately avoid `bun test`
 * inside the scaffold to keep the success check free of the parent
 * bunfig preload; they use plain `node` assertions instead.
 */

import type { GoldenTask } from './types';

/**
 * Frozen catalog of golden tasks. Exported as `readonly` so callers can't
 * mutate the shared fixtures between suite runs.
 */
export const GOLDEN_TASKS: readonly GoldenTask[] = [
  // 1. Add a function + make a (node) test pass.
  {
    id: 'add-function-sum',
    title: 'Implement sum() so the test passes',
    tags: ['implement', 'test'],
    scaffold: {
      files: {
        'sum.js': '// TODO: implement sum(a, b) and export it.\n',
        'test.js': [
          "const { sum } = require('./sum.js');",
          "const assert = require('node:assert');",
          'assert.strictEqual(sum(2, 3), 5);',
          'assert.strictEqual(sum(-1, 1), 0);',
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'Implement and export a `sum(a, b)` function in sum.js that returns ' +
      'the numeric sum of its two arguments. Use CommonJS `module.exports`. ' +
      'The existing test.js must pass.',
    success: { kind: 'command', cmd: 'node test.js', expectExit: 0 },
    maxTurns: 8,
  },

  // 2. Fix a failing test (bug in the implementation).
  {
    id: 'fix-failing-multiply',
    title: 'Fix the buggy multiply() implementation',
    tags: ['fix', 'test'],
    scaffold: {
      files: {
        'multiply.js': [
          'function multiply(a, b) {',
          '  return a + b; // BUG: should multiply',
          '}',
          'module.exports = { multiply };',
          '',
        ].join('\n'),
        'test.js': [
          "const { multiply } = require('./multiply.js');",
          "const assert = require('node:assert');",
          'assert.strictEqual(multiply(3, 4), 12);',
          'assert.strictEqual(multiply(0, 9), 0);',
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'multiply.js has a bug — the test fails. Fix multiply() so it ' +
      'returns the product of a and b. Do not change test.js.',
    success: { kind: 'command', cmd: 'node test.js', expectExit: 0 },
    maxTurns: 8,
  },

  // 3. Rename a symbol across two files.
  {
    id: 'rename-symbol-across-files',
    title: 'Rename getValue -> readValue across two files',
    tags: ['refactor', 'rename'],
    scaffold: {
      files: {
        'lib.js': [
          'function getValue() {',
          '  return 42;',
          '}',
          'module.exports = { getValue };',
          '',
        ].join('\n'),
        'main.js': [
          "const { getValue } = require('./lib.js');",
          "const assert = require('node:assert');",
          'assert.strictEqual(getValue(), 42);',
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'Rename the function `getValue` to `readValue` everywhere it appears ' +
      '— both its definition/export in lib.js AND its import + call site ' +
      'in main.js. After the rename, running main.js must still print ok ' +
      'and the name getValue must no longer appear in either file.',
    success: {
      kind: 'command',
      // Passes (exit 0) only when neither file mentions getValue AND main.js runs.
      cmd:
        '! grep -rq getValue lib.js main.js && node -e ' +
        "\"const{readValue}=require('./lib.js');require('node:assert')" +
        '.strictEqual(readValue(),42)"',
      expectExit: 0,
    },
    maxTurns: 10,
  },

  // 4. Implement a small spec (FizzBuzz).
  {
    id: 'implement-fizzbuzz-spec',
    title: 'Implement fizzbuzz(n) to spec',
    tags: ['implement', 'spec'],
    scaffold: {
      files: {
        'fizzbuzz.js': '// Implement fizzbuzz(n) per the prompt spec.\n',
        'test.js': [
          "const { fizzbuzz } = require('./fizzbuzz.js');",
          "const assert = require('node:assert');",
          "assert.strictEqual(fizzbuzz(1), '1');",
          "assert.strictEqual(fizzbuzz(3), 'Fizz');",
          "assert.strictEqual(fizzbuzz(5), 'Buzz');",
          "assert.strictEqual(fizzbuzz(15), 'FizzBuzz');",
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'Implement and export `fizzbuzz(n)` in fizzbuzz.js. Spec: return the ' +
      "string 'Fizz' when n is divisible by 3, 'Buzz' when divisible by 5, " +
      "'FizzBuzz' when divisible by both, otherwise the number as a string. " +
      'Use CommonJS exports. test.js must pass.',
    success: { kind: 'command', cmd: 'node test.js', expectExit: 0 },
    maxTurns: 10,
  },

  // 5. Fix a type error (TS syntax error that breaks node import).
  {
    id: 'fix-type-error-return',
    title: 'Fix the broken return shape so the test passes',
    tags: ['fix', 'types'],
    scaffold: {
      files: {
        'shape.js': [
          'function makePoint(x, y) {',
          '  // BUG: returns an array instead of an {x, y} object',
          '  return [x, y];',
          '}',
          'module.exports = { makePoint };',
          '',
        ].join('\n'),
        'test.js': [
          "const { makePoint } = require('./shape.js');",
          "const assert = require('node:assert');",
          'const p = makePoint(1, 2);',
          'assert.strictEqual(p.x, 1);',
          'assert.strictEqual(p.y, 2);',
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'makePoint returns the wrong shape — the test expects an object with ' +
      '`x` and `y` properties but it returns an array. Fix makePoint so it ' +
      'returns `{ x, y }`. Do not edit test.js.',
    success: { kind: 'command', cmd: 'node test.js', expectExit: 0 },
    maxTurns: 8,
  },

  // 6. Add error handling (throw on invalid input).
  {
    id: 'add-error-handling-divide',
    title: 'Add divide-by-zero error handling',
    tags: ['implement', 'error-handling'],
    scaffold: {
      files: {
        'divide.js': [
          'function divide(a, b) {',
          '  return a / b;',
          '}',
          'module.exports = { divide };',
          '',
        ].join('\n'),
        'test.js': [
          "const { divide } = require('./divide.js');",
          "const assert = require('node:assert');",
          'assert.strictEqual(divide(10, 2), 5);',
          'assert.throws(() => divide(1, 0), /zero/i);',
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'Add error handling to divide(a, b): when b is 0 it must throw an ' +
      "Error whose message mentions 'zero'. Normal division must still " +
      'work. test.js must pass.',
    success: { kind: 'command', cmd: 'node test.js', expectExit: 0 },
    maxTurns: 8,
  },

  // 7. Write a missing export.
  {
    id: 'write-missing-export',
    title: 'Export the existing greet() function',
    tags: ['fix', 'export'],
    scaffold: {
      files: {
        'greet.js': [
          'function greet(name) {',
          "  return 'Hello, ' + name + '!';",
          '}',
          '// greet is defined but never exported.',
          '',
        ].join('\n'),
        'test.js': [
          "const mod = require('./greet.js');",
          "const assert = require('node:assert');",
          "assert.strictEqual(typeof mod.greet, 'function');",
          "assert.strictEqual(mod.greet('Ada'), 'Hello, Ada!');",
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'greet.js defines greet() but never exports it, so the test cannot ' +
      'import it. Add a CommonJS export so `require("./greet.js").greet` ' +
      'is the function. Do not change the function body or test.js.',
    success: { kind: 'command', cmd: 'node test.js', expectExit: 0 },
    maxTurns: 8,
  },

  // 8. Delete dead code (remove an unused, syntactically broken block).
  {
    id: 'remove-dead-code',
    title: 'Remove the broken dead-code block',
    tags: ['refactor', 'cleanup'],
    scaffold: {
      files: {
        'calc.js': [
          'function add(a, b) {',
          '  return a + b;',
          '}',
          '',
          '// DEAD CODE BELOW — references an undefined symbol and breaks the file.',
          'const broken = undefinedHelper(1, 2);',
          '',
          'module.exports = { add };',
          '',
        ].join('\n'),
        'test.js': [
          "const { add } = require('./calc.js');",
          "const assert = require('node:assert');",
          'assert.strictEqual(add(2, 2), 4);',
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'calc.js has a dead-code line that calls an undefined function and ' +
      'crashes the module on load. Remove ONLY the dead-code line (and its ' +
      'comment) so the file loads. Keep add() and its export intact. ' +
      'test.js must pass.',
    success: { kind: 'command', cmd: 'node test.js', expectExit: 0 },
    maxTurns: 8,
  },

  // 9. Add a field to a JSON config (fileContains check, no exec).
  {
    id: 'add-json-config-field',
    title: 'Add a "version" field to config.json',
    tags: ['implement', 'config'],
    scaffold: {
      files: {
        'config.json': '{\n  "name": "demo"\n}\n',
      },
    },
    prompt:
      'Edit config.json to add a top-level string field "version" set to ' +
      '"1.0.0". Keep the existing "name" field. The file must stay valid ' +
      'JSON.',
    success: { kind: 'fileContains', path: 'config.json', needle: '"version"' },
    maxTurns: 6,
  },

  // 10. Wire two modules together (use an existing helper).
  {
    id: 'wire-modules-together',
    title: 'Wire double() into main via the helper module',
    tags: ['implement', 'integration'],
    scaffold: {
      files: {
        'helper.js': [
          'function double(n) {',
          '  return n * 2;',
          '}',
          'module.exports = { double };',
          '',
        ].join('\n'),
        'main.js': [
          '// TODO: import double from ./helper.js and export quadruple(n)',
          '// quadruple(n) must return double(double(n)).',
          '',
        ].join('\n'),
        'test.js': [
          "const { quadruple } = require('./main.js');",
          "const assert = require('node:assert');",
          'assert.strictEqual(quadruple(3), 12);',
          'assert.strictEqual(quadruple(0), 0);',
          "console.log('ok');",
          '',
        ].join('\n'),
      },
    },
    prompt:
      'In main.js, require the existing `double` helper from ./helper.js, ' +
      'then implement and export `quadruple(n)` that returns ' +
      'double(double(n)). Do not edit helper.js or test.js. test.js must ' +
      'pass.',
    success: { kind: 'command', cmd: 'node test.js', expectExit: 0 },
    maxTurns: 10,
  },
];

/**
 * Look up a task by id. Returns `null` when no task matches — callers
 * (the `/eval <task-id>` command) surface a friendly "unknown task"
 * message rather than throwing.
 */
export function findTaskById(id: string): GoldenTask | null {
  const trimmed = id.trim();
  for (const t of GOLDEN_TASKS) {
    if (t.id === trimmed) return t;
  }
  return null;
}

/** Every task id, in catalog order. Used by the command's help output. */
export function listTaskIds(): readonly string[] {
  return GOLDEN_TASKS.map((t) => t.id);
}
