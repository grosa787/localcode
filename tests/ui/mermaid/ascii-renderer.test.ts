/**
 * ASCII renderer tests — fixture-based + width-fit + cyclic-fallback.
 * We snapshot known shapes as strings rather than committing a binary
 * snapshot file because the output is small and easy to eyeball during
 * review.
 */

import { describe, expect, test } from 'bun:test';
import { parseMermaid } from '@/ui/mermaid/parser';
import { renderMermaidAscii } from '@/ui/mermaid/ascii-renderer';

function render(src: string, width = 80): string[] {
  return renderMermaidAscii(parseMermaid(src), { width });
}

describe('renderMermaidAscii — flowchart', () => {
  test('renders a simple A --> B', () => {
    const lines = render(`flowchart TB\nA --> B`);
    // Should contain box borders for both nodes and at least one
    // vertical edge glyph between them.
    expect(lines.some((l) => l.includes('A'))).toBe(true);
    expect(lines.some((l) => l.includes('B'))).toBe(true);
    expect(lines.some((l) => l.includes('│') || l.includes('v'))).toBe(true);
  });

  test('respects target width', () => {
    const lines = render(`flowchart TB\nA --> B --> C --> D --> E --> F`, 60);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(60);
    }
  });

  test('cyclic fallback emits bullet list with header', () => {
    const lines = render(`flowchart TB\nA --> B\nB --> A`);
    expect(lines[0]).toContain('cyclic');
    expect(lines.some((l) => l.includes('•'))).toBe(true);
  });

  test('empty flowchart returns placeholder', () => {
    const lines = render(`flowchart TB`);
    expect(lines.join('\n')).toContain('empty');
  });

  test('labelled edge appears somewhere in output', () => {
    const lines = render(`flowchart TB\nA -->|click| B`);
    expect(lines.some((l) => l.includes('click'))).toBe(true);
  });

  test('LR direction renders direction header', () => {
    const lines = render(`flowchart LR\nA --> B`);
    expect(lines[0]).toContain('LR');
  });

  test('snapshot — three-node linear flow', () => {
    const lines = render(`flowchart TB\nA[Start] --> B[Middle] --> C[End]`, 80);
    const out = lines.join('\n');
    // The snapshot is structural: each node label must appear and the
    // total line count fits within ~12 rows for a 3-node graph (3 boxes
    // × 3 rows + 2 arrow gaps).
    expect(out).toContain('Start');
    expect(out).toContain('Middle');
    expect(out).toContain('End');
    expect(lines.length).toBeLessThanOrEqual(15);
  });
});

describe('renderMermaidAscii — sequence', () => {
  test('renders actors and messages', () => {
    const lines = render(`sequenceDiagram\nAlice->>Bob: Hi\nBob-->>Alice: Bye`);
    expect(lines.some((l) => l.includes('Alice'))).toBe(true);
    expect(lines.some((l) => l.includes('Bob'))).toBe(true);
    expect(lines.some((l) => l.includes('Hi'))).toBe(true);
  });
});

describe('renderMermaidAscii — class', () => {
  test('renders class block + members', () => {
    const lines = render(`classDiagram\nclass Dog { +bark() }`);
    const out = lines.join('\n');
    expect(out).toContain('Dog');
    expect(out).toContain('bark');
  });
});

describe('renderMermaidAscii — state', () => {
  test('renders state list + transitions', () => {
    const lines = render(`stateDiagram\n[*] --> Idle\nIdle --> Running`);
    const out = lines.join('\n');
    expect(out).toContain('Idle');
    expect(out).toContain('Running');
  });
});

describe('renderMermaidAscii — ER', () => {
  test('renders entity block + relation', () => {
    const lines = render(`erDiagram\nCUSTOMER ||--o{ ORDER : places`);
    const out = lines.join('\n');
    expect(out).toContain('CUSTOMER');
    expect(out).toContain('ORDER');
    expect(out).toContain('places');
  });
});

describe('renderMermaidAscii — performance', () => {
  test('handles 30 nodes under 100ms', () => {
    const edges: string[] = [];
    for (let i = 0; i < 30; i++) edges.push(`N${i} --> N${i + 1}`);
    const src = `flowchart TB\n${edges.join('\n')}`;
    const start = performance.now();
    const lines = render(src);
    const dur = performance.now() - start;
    expect(dur).toBeLessThan(100);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('renderMermaidAscii — line-length guarantee', () => {
  test('never exceeds the requested width across multiple cases', () => {
    const cases: readonly string[] = [
      `flowchart TB\nA[a very long label here] --> B[another long one]`,
      `flowchart LR\nA --> B --> C --> D`,
      `sequenceDiagram\nXYZ->>OPQ: a fairly long message text indeed`,
      `classDiagram\nclass VeryLongClassName { +foo() +bar() }`,
    ];
    for (const c of cases) {
      const lines = render(c, 80);
      for (const l of lines) {
        expect(l.length).toBeLessThanOrEqual(80);
      }
    }
  });
});
