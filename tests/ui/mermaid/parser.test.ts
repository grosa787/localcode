/**
 * Mermaid parser tests — covers every diagram kind we support plus
 * malformed / edge-case input. The parser is permissive (it never
 * throws), so most tests assert AST shape directly.
 */

import { describe, expect, test } from 'bun:test';
import { parseMermaid } from '@/ui/mermaid/parser';

describe('parseMermaid — flowchart basics', () => {
  test('parses simple A --> B', () => {
    const ast = parseMermaid(`flowchart TD\nA --> B`);
    expect(ast.kind).toBe('flowchart');
    if (ast.kind !== 'flowchart') return;
    expect(ast.nodes).toHaveLength(2);
    expect(ast.edges).toHaveLength(1);
    expect(ast.edges[0]?.from).toBe('A');
    expect(ast.edges[0]?.to).toBe('B');
    expect(ast.edges[0]?.style).toBe('solid');
    expect(ast.direction).toBe('TB');
  });

  test('recognises `graph LR` as flowchart', () => {
    const ast = parseMermaid(`graph LR\nfoo --> bar`);
    expect(ast.kind).toBe('flowchart');
    if (ast.kind !== 'flowchart') return;
    expect(ast.direction).toBe('LR');
  });

  test('handles TD as alias for TB', () => {
    const ast = parseMermaid(`flowchart TD\nA --> B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.direction).toBe('TB');
  });

  test('parses node shapes', () => {
    const src = `flowchart TB
A[rect]
B(round)
C{rhombus}
D((circle))
E([stadium])
F[[subroutine]]
G[(cylinder)]
H{{hexagon}}`;
    const ast = parseMermaid(src);
    if (ast.kind !== 'flowchart') return;
    const shapes = ast.nodes.map((n) => [n.id, n.shape]);
    expect(shapes).toEqual([
      ['A', 'rect'],
      ['B', 'round'],
      ['C', 'rhombus'],
      ['D', 'circle'],
      ['E', 'stadium'],
      ['F', 'subroutine'],
      ['G', 'cylinder'],
      ['H', 'hexagon'],
    ]);
  });

  test('parses labels with spaces and quotes', () => {
    const ast = parseMermaid(`flowchart TB\nA["Hello World"] --> B[Goodbye]`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.nodes[0]?.label).toBe('Hello World');
    expect(ast.nodes[1]?.label).toBe('Goodbye');
  });

  test('parses dotted edges', () => {
    const ast = parseMermaid(`flowchart TB\nA -.-> B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges[0]?.style).toBe('dotted');
  });

  test('parses thick edges', () => {
    const ast = parseMermaid(`flowchart TB\nA ==> B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges[0]?.style).toBe('thick');
  });

  test('parses cross-head edges', () => {
    const ast = parseMermaid(`flowchart TB\nA --x B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges[0]?.head).toBe('cross');
  });

  test('parses circle-head edges', () => {
    const ast = parseMermaid(`flowchart TB\nA --o B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges[0]?.head).toBe('circle');
  });

  test('parses pipe-labelled edges', () => {
    const ast = parseMermaid(`flowchart TB\nA -->|yes| B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges[0]?.label).toBe('yes');
  });

  test('parses inline-labelled edges', () => {
    const ast = parseMermaid(`flowchart TB\nA -- click me --> B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges[0]?.label).toBe('click me');
  });

  test('parses chained edges A --> B --> C', () => {
    const ast = parseMermaid(`flowchart TB\nA --> B --> C`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.nodes).toHaveLength(3);
    expect(ast.edges).toHaveLength(2);
    expect(ast.edges[0]?.from).toBe('A');
    expect(ast.edges[1]?.from).toBe('B');
  });

  test('strips %% comments', () => {
    const ast = parseMermaid(`flowchart TB\n%% comment line\nA --> B %% trailing`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.nodes).toHaveLength(2);
  });

  test('ignores subgraph/end and unsupported statements', () => {
    const ast = parseMermaid(`flowchart TB
subgraph S1
A --> B
end
style A fill:#f00`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });

  test('handles whitespace-heavy input', () => {
    const ast = parseMermaid(`  flowchart TB  \n\n  A   -->   B  \n\n`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges).toHaveLength(1);
  });

  test('multi-statement line with semicolons', () => {
    const ast = parseMermaid(`flowchart TB\nA --> B; B --> C`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges).toHaveLength(2);
  });

  test('bidirectional edge produces two edges', () => {
    const ast = parseMermaid(`flowchart TB\nA <--> B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges).toHaveLength(2);
    expect(ast.edges[0]?.from).toBe('A');
    expect(ast.edges[1]?.from).toBe('B');
  });
});

describe('parseMermaid — sequence', () => {
  test('parses simple sequence with two participants', () => {
    const ast = parseMermaid(`sequenceDiagram\nAlice->>Bob: Hi\nBob-->>Alice: Hello`);
    expect(ast.kind).toBe('sequence');
    if (ast.kind !== 'sequence') return;
    expect(ast.actors).toEqual(['Alice', 'Bob']);
    expect(ast.messages).toHaveLength(2);
    expect(ast.messages[0]?.label).toBe('Hi');
    expect(ast.messages[1]?.style).toBe('dotted');
  });

  test('records explicit participants', () => {
    const ast = parseMermaid(`sequenceDiagram\nparticipant A\nparticipant B`);
    if (ast.kind !== 'sequence') return;
    expect(ast.actors).toEqual(['A', 'B']);
  });

  test('cross arrow head detected', () => {
    const ast = parseMermaid(`sequenceDiagram\nA->>B: ping\nB--xA: gone`);
    if (ast.kind !== 'sequence') return;
    expect(ast.messages[1]?.arrow).toBe('cross');
  });

  test('skips note/loop/alt directives gracefully', () => {
    const src = `sequenceDiagram
A->>B: hi
note over A,B: chitchat
loop forever
A->>B: ping
end`;
    const ast = parseMermaid(src);
    if (ast.kind !== 'sequence') return;
    expect(ast.messages).toHaveLength(2);
  });
});

describe('parseMermaid — class', () => {
  test('parses class block and inheritance', () => {
    const src = `classDiagram
class Animal {
  +name: string
  +eat()
}
class Dog
Animal <|-- Dog`;
    const ast = parseMermaid(src);
    expect(ast.kind).toBe('class');
    if (ast.kind !== 'class') return;
    expect(ast.classes.map((c) => c.id).sort()).toEqual(['Animal', 'Dog']);
    expect(ast.relations[0]?.kind).toBe('inheritance');
  });

  test('parses single-line member declaration', () => {
    const ast = parseMermaid(`classDiagram\nFoo : +bar()\nFoo : -baz`);
    if (ast.kind !== 'class') return;
    expect(ast.classes[0]?.members).toHaveLength(2);
    expect(ast.classes[0]?.members[0]?.kind).toBe('method');
    expect(ast.classes[0]?.members[1]?.kind).toBe('attribute');
    expect(ast.classes[0]?.members[1]?.visibility).toBe('-');
  });

  test('parses composition relation', () => {
    const ast = parseMermaid(`classDiagram\nA *-- B`);
    if (ast.kind !== 'class') return;
    expect(ast.relations[0]?.kind).toBe('composition');
  });
});

describe('parseMermaid — state', () => {
  test('parses transitions', () => {
    const ast = parseMermaid(`stateDiagram\n[*] --> Idle\nIdle --> Running: start\nRunning --> [*]`);
    expect(ast.kind).toBe('state');
    if (ast.kind !== 'state') return;
    expect(ast.transitions).toHaveLength(3);
    expect(ast.transitions[1]?.label).toBe('start');
  });

  test('handles stateDiagram-v2', () => {
    const ast = parseMermaid(`stateDiagram-v2\nA --> B`);
    expect(ast.kind).toBe('state');
  });
});

describe('parseMermaid — ER', () => {
  test('parses entity block + relation', () => {
    const src = `erDiagram
CUSTOMER {
  string name
  int id
}
CUSTOMER ||--o{ ORDER : places`;
    const ast = parseMermaid(src);
    expect(ast.kind).toBe('er');
    if (ast.kind !== 'er') return;
    const cust = ast.entities.find((e) => e.id === 'CUSTOMER');
    expect(cust?.attributes).toHaveLength(2);
    expect(ast.relations[0]?.label).toBe('places');
    expect(ast.relations[0]?.cardinality).toBe('||--o{');
  });
});

describe('parseMermaid — robustness', () => {
  test('empty input returns unknown', () => {
    const ast = parseMermaid('');
    expect(ast.kind).toBe('unknown');
  });

  test('unknown diagram type returns unknown', () => {
    const ast = parseMermaid('pieChart\nFoo: 12');
    expect(ast.kind).toBe('unknown');
  });

  test('malformed flowchart returns flowchart with zero edges', () => {
    const ast = parseMermaid('flowchart TB\n!!! garbage !!!');
    expect(ast.kind).toBe('flowchart');
    if (ast.kind !== 'flowchart') return;
    expect(ast.edges).toHaveLength(0);
  });

  test('preserves first-seen node label across duplicate references', () => {
    const ast = parseMermaid(`flowchart TB\nA[hello] --> B\nA --> C`);
    if (ast.kind !== 'flowchart') return;
    const a = ast.nodes.find((n) => n.id === 'A');
    expect(a?.label).toBe('hello');
  });

  test('labels containing %% are truncated but never crash', () => {
    // Documented limitation: the naive %% strip drops everything after
    // %% on a line, so a label with %% in it loses its tail. We just
    // verify the parser doesn't throw and still records the node id.
    const ast = parseMermaid(`flowchart TB\nA["100%% safe"] --> B`);
    if (ast.kind !== 'flowchart') return;
    expect(ast.nodes.length).toBeGreaterThanOrEqual(1);
    expect(ast.nodes[0]?.id).toBe('A');
  });
});
