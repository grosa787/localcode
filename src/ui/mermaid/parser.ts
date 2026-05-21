/**
 * Mermaid parser — a permissive subset large enough to handle the
 * diagrams the model actually emits in chat.
 *
 * Supported diagram kinds (everything else returns `kind: 'unknown'`):
 *   - `flowchart` / `graph` (TB|BT|LR|RL)
 *   - `sequenceDiagram`
 *   - `classDiagram`
 *   - `stateDiagram` / `stateDiagram-v2`
 *   - `erDiagram`
 *
 * The parser is deliberately tolerant — it ignores unknown statements
 * rather than throwing, because models routinely emit half-baked
 * mermaid and we'd rather render *something* than nothing.
 *
 * Pure functions; no I/O; safe to call from both the TUI and the web
 * bundle. The returned AST is the wire format that drives the ASCII
 * renderer (TUI) and is *not* used by the web renderer (which hands
 * the raw source to the mermaid library directly).
 */

export type Direction = 'TB' | 'BT' | 'LR' | 'RL';

export type NodeShape =
  | 'rect' // []
  | 'round' // ()
  | 'stadium' // ([])
  | 'subroutine' // [[]]
  | 'cylinder' // [()]
  | 'circle' // (())
  | 'rhombus' // {}
  | 'hexagon' // {{}}
  | 'parallelogram' // [//]
  | 'trapezoid' // [/\]
  | 'asymmetric'; // > ]

export interface ParsedNode {
  readonly id: string;
  readonly label: string;
  readonly shape: NodeShape;
}

export type EdgeStyle = 'solid' | 'dotted' | 'thick' | 'invisible';
export type EdgeHead = 'arrow' | 'open' | 'cross' | 'circle';

export interface ParsedEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  readonly style: EdgeStyle;
  readonly head: EdgeHead;
  /** True if `<--` / `<-->` etc — direction reversed. */
  readonly bidirectional: boolean;
}

export interface SequenceMessage {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly style: 'solid' | 'dotted';
  readonly arrow: 'arrow' | 'cross' | 'open';
}

export interface ClassMember {
  readonly name: string;
  readonly kind: 'attribute' | 'method';
  readonly visibility: '+' | '-' | '#' | '~' | '';
}

export interface ParsedClass {
  readonly id: string;
  readonly label: string;
  readonly members: readonly ClassMember[];
}

export interface ClassRelation {
  readonly from: string;
  readonly to: string;
  readonly kind: 'inheritance' | 'composition' | 'aggregation' | 'association' | 'dependency';
  readonly label: string | null;
}

export interface StateTransition {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
}

export interface ErEntity {
  readonly id: string;
  readonly attributes: readonly string[];
}

export interface ErRelation {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  readonly cardinality: string;
}

export type MermaidAst =
  | {
      readonly kind: 'flowchart';
      readonly direction: Direction;
      readonly nodes: readonly ParsedNode[];
      readonly edges: readonly ParsedEdge[];
    }
  | {
      readonly kind: 'sequence';
      readonly actors: readonly string[];
      readonly messages: readonly SequenceMessage[];
    }
  | {
      readonly kind: 'class';
      readonly classes: readonly ParsedClass[];
      readonly relations: readonly ClassRelation[];
    }
  | {
      readonly kind: 'state';
      readonly states: readonly string[];
      readonly transitions: readonly StateTransition[];
    }
  | {
      readonly kind: 'er';
      readonly entities: readonly ErEntity[];
      readonly relations: readonly ErRelation[];
    }
  | { readonly kind: 'unknown'; readonly reason: string };

// ---------- helpers ----------

/**
 * Pre-process the raw source: strip `%%…` comments (line and trailing),
 * normalise CRLF, drop completely-blank lines and collapse trailing
 * whitespace. We keep leading whitespace because indentation can matter
 * for `subgraph` blocks (which we don't fully support but mustn't crash
 * on).
 */
function preprocess(src: string): readonly string[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    // Strip `%%` comments to end-of-line (mermaid spec). A `%%` inside a
    // string literal would be a false positive but the diagrams we see
    // never embed `%%` in labels, and the cost of building a tokeniser
    // outweighs the benefit.
    const commentIdx = raw.indexOf('%%');
    const stripped = commentIdx === -1 ? raw : raw.slice(0, commentIdx);
    const trimmed = stripped.replace(/\s+$/g, '');
    if (trimmed.trim().length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function detectKind(firstLine: string): MermaidAst['kind'] | 'flowchart' {
  const first = firstLine.trim().toLowerCase();
  if (first.startsWith('flowchart') || first.startsWith('graph')) {
    return 'flowchart';
  }
  if (first.startsWith('sequencediagram')) return 'sequence';
  if (first.startsWith('classdiagram')) return 'class';
  if (first.startsWith('statediagram')) return 'state';
  if (first.startsWith('erdiagram')) return 'er';
  return 'unknown';
}

function detectDirection(firstLine: string): Direction {
  const m = /\b(TB|TD|BT|LR|RL)\b/i.exec(firstLine);
  if (m === null) return 'TB';
  const code = (m[1] ?? 'TB').toUpperCase();
  if (code === 'TD') return 'TB';
  if (code === 'BT' || code === 'LR' || code === 'RL' || code === 'TB') {
    return code;
  }
  return 'TB';
}

// ---------- flowchart ----------

/**
 * Parse one flowchart statement. A statement is a single non-blank line
 * (we do NOT support multi-line statements with explicit `;` separators
 * — those are rare in chat output).
 *
 * Recognises shapes:
 *   id[label] | id(label) | id([label]) | id[[label]] | id[(label)]
 *   id((label)) | id{label} | id{{label}} | id[/label/] | id[\label\]
 *   id[/label\] | id[\label/]
 *
 * Edges (left → right):
 *   `-->`, `---`, `==>`, `===`, `-.->`, `-.-`, `--x`, `--o`
 * Bidirectional / reversed are detected via leading `<`.
 * Optional label: `--label-->` or `-- label -->` or `-->|label|`.
 */

interface ShapeMatch {
  readonly id: string;
  readonly label: string;
  readonly shape: NodeShape;
  /** Number of characters consumed (including id + braces + label). */
  readonly consumed: number;
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*/;

function matchId(s: string): { id: string; rest: string } | null {
  const m = ID_RE.exec(s);
  if (m === null) return null;
  return { id: m[0], rest: s.slice(m[0].length) };
}

/**
 * After an id, peek at the bracket sequence to decide which shape
 * follows. We accept the common bracket flavours; nested brackets
 * inside labels are not supported (and not necessary for ~99% of
 * diagrams).
 */
const SHAPE_PATTERNS: readonly { open: string; close: string; shape: NodeShape }[] = [
  // Order matters — longer prefixes first.
  { open: '([', close: '])', shape: 'stadium' },
  { open: '[[', close: ']]', shape: 'subroutine' },
  { open: '[(', close: ')]', shape: 'cylinder' },
  { open: '((', close: '))', shape: 'circle' },
  { open: '{{', close: '}}', shape: 'hexagon' },
  { open: '[/', close: '/]', shape: 'parallelogram' },
  { open: '[\\', close: '\\]', shape: 'parallelogram' },
  { open: '[/', close: '\\]', shape: 'trapezoid' },
  { open: '[\\', close: '/]', shape: 'trapezoid' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
  { open: '{', close: '}', shape: 'rhombus' },
  { open: '>', close: ']', shape: 'asymmetric' },
];

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function matchNodeWithShape(s: string): ShapeMatch | null {
  const idMatch = matchId(s);
  if (idMatch === null) return null;
  const { id, rest } = idMatch;

  for (const pat of SHAPE_PATTERNS) {
    if (!rest.startsWith(pat.open)) continue;
    const body = rest.slice(pat.open.length);
    const closeIdx = body.indexOf(pat.close);
    if (closeIdx === -1) continue;
    const label = stripQuotes(body.slice(0, closeIdx));
    return {
      id,
      label: label.length > 0 ? label : id,
      shape: pat.shape,
      consumed: id.length + pat.open.length + closeIdx + pat.close.length,
    };
  }
  // Bare id (no shape) — treat as rect with id as label.
  return { id, label: id, shape: 'rect', consumed: id.length };
}

interface EdgeMatch {
  readonly label: string | null;
  readonly style: EdgeStyle;
  readonly head: EdgeHead;
  readonly bidirectional: boolean;
  readonly consumed: number;
}

/**
 * Match an edge operator starting at the head of `s`. Returns the parts
 * needed by the AST plus how many characters to skip. We try the longest
 * patterns first to avoid `-.->`  being mis-parsed as `-->`.
 *
 * Supported (left → right; the bidirectional flag is set when a leading
 * `<` is present):
 *   `-->`, `---`, `==>`, `===`, `-.->`, `-.-`, `--x`, `--o`,
 *   plus optional `|label|` suffix and inline `-- label -->` form.
 */
function matchEdge(s: string): EdgeMatch | null {
  // Leading bidirectional marker.
  let cursor = 0;
  let bidi = false;
  if (s.startsWith('<')) {
    bidi = true;
    cursor = 1;
  }

  const body = s.slice(cursor);

  // Plain operators FIRST, longest-first — this avoids inline-label
  // patterns swallowing chained `A --> B --> C` as `A -- > B --> C`.
  const ops: { readonly op: string; readonly style: EdgeStyle; readonly head: EdgeHead }[] = [
    { op: '-.->', style: 'dotted', head: 'arrow' },
    { op: '==>', style: 'thick', head: 'arrow' },
    { op: '===', style: 'thick', head: 'open' },
    { op: '--x', style: 'solid', head: 'cross' },
    { op: '--o', style: 'solid', head: 'circle' },
    { op: '-->', style: 'solid', head: 'arrow' },
    { op: '-.-', style: 'dotted', head: 'open' },
    { op: '---', style: 'solid', head: 'open' },
    { op: '~~~', style: 'invisible', head: 'open' },
  ];

  for (const o of ops) {
    if (!body.startsWith(o.op)) continue;
    cursor += o.op.length;
    // Optional pipe-delimited label.
    const after = s.slice(cursor);
    const pipe = /^\s*\|([^|\n]*)\|/.exec(after);
    let label: string | null = null;
    if (pipe !== null) {
      const text = (pipe[1] ?? '').trim();
      label = text.length > 0 ? text : null;
      cursor += pipe[0].length;
    }
    return { label, style: o.style, head: o.head, bidirectional: bidi, consumed: cursor };
  }

  // Inline-label form: `-- text -->` or `-- text --` or `-. text .->`.
  // The lookahead `(?![->])` after `--` prevents `--> X` being interpreted
  // as `-- > X`. We require at least one non-dash char inside the label.
  const inlineSolid = /^--(?!-|>)\s*([^\n]+?)\s*--(>|x|o)/.exec(body);
  if (inlineSolid !== null) {
    const labelText = inlineSolid[1] ?? '';
    const headChar = inlineSolid[2] ?? '';
    const head: EdgeHead =
      headChar === 'x' ? 'cross' : headChar === 'o' ? 'circle' : 'arrow';
    return {
      label: labelText.trim().length > 0 ? labelText.trim() : null,
      style: 'solid',
      head,
      bidirectional: bidi,
      consumed: cursor + inlineSolid[0].length,
    };
  }

  const inlineDotted = /^-\.(?!-|>)\s*([^\n]+?)\s*\.->/.exec(body);
  if (inlineDotted !== null) {
    return {
      label: (inlineDotted[1] ?? '').trim() || null,
      style: 'dotted',
      head: 'arrow',
      bidirectional: bidi,
      consumed: cursor + inlineDotted[0].length,
    };
  }

  const inlineThick = /^==(?!=|>)\s*([^\n]+?)\s*==(>|x|o)/.exec(body);
  if (inlineThick !== null) {
    const headChar = inlineThick[2] ?? '';
    const head: EdgeHead =
      headChar === 'x' ? 'cross' : headChar === 'o' ? 'circle' : 'arrow';
    return {
      label: (inlineThick[1] ?? '').trim() || null,
      style: 'thick',
      head,
      bidirectional: bidi,
      consumed: cursor + inlineThick[0].length,
    };
  }

  return null;
}

interface FlowchartAccum {
  readonly nodes: Map<string, ParsedNode>;
  readonly edges: ParsedEdge[];
}

function recordNode(accum: FlowchartAccum, n: { id: string; label: string; shape: NodeShape }): void {
  const prev = accum.nodes.get(n.id);
  if (prev === undefined) {
    accum.nodes.set(n.id, { id: n.id, label: n.label, shape: n.shape });
    return;
  }
  // Upgrade an earlier bare-id reference if we now have a label/shape.
  if (prev.label === prev.id && n.label !== n.id) {
    accum.nodes.set(n.id, { id: n.id, label: n.label, shape: n.shape });
  }
}

function parseFlowchartLine(line: string, accum: FlowchartAccum): void {
  let s = line.trim();
  if (s.length === 0) return;
  // Skip statements we don't model.
  if (/^(subgraph|end|click|style|classDef|class |linkStyle|direction)\b/i.test(s)) {
    return;
  }

  // Walk the line: node, edge, node, [edge, node]*
  const first = matchNodeWithShape(s);
  if (first === null) return;
  recordNode(accum, first);
  s = s.slice(first.consumed).trimStart();
  let lastId = first.id;

  while (s.length > 0) {
    // Allow `&` to chain multiple sources/targets, but we treat each
    // chained id as bare and link only the closest pair (this is
    // permissive but matches what most chat-time diagrams need).
    if (s.startsWith('&')) {
      s = s.slice(1).trimStart();
      const more = matchNodeWithShape(s);
      if (more === null) break;
      recordNode(accum, more);
      lastId = more.id;
      s = s.slice(more.consumed).trimStart();
      continue;
    }

    const edge = matchEdge(s);
    if (edge === null) break;
    s = s.slice(edge.consumed).trimStart();
    const next = matchNodeWithShape(s);
    if (next === null) break;
    recordNode(accum, next);
    accum.edges.push({
      from: lastId,
      to: next.id,
      label: edge.label,
      style: edge.style,
      head: edge.head,
      bidirectional: edge.bidirectional,
    });
    if (edge.bidirectional) {
      accum.edges.push({
        from: next.id,
        to: lastId,
        label: edge.label,
        style: edge.style,
        head: edge.head,
        bidirectional: false,
      });
    }
    lastId = next.id;
    s = s.slice(next.consumed).trimStart();
  }
}

function parseFlowchart(firstLine: string, body: readonly string[]): MermaidAst {
  const direction = detectDirection(firstLine);
  const accum: FlowchartAccum = { nodes: new Map(), edges: [] };
  for (const raw of body) {
    // Split on `;` to allow multiple statements per line.
    const stmts = raw.split(';');
    for (const stmt of stmts) {
      parseFlowchartLine(stmt, accum);
    }
  }
  return {
    kind: 'flowchart',
    direction,
    nodes: Array.from(accum.nodes.values()),
    edges: accum.edges,
  };
}

// ---------- sequence ----------

function parseSequenceDiagram(body: readonly string[]): MermaidAst {
  const actorOrder: string[] = [];
  const seen = new Set<string>();
  const messages: SequenceMessage[] = [];
  const recordActor = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      actorOrder.push(id);
    }
  };

  for (const raw of body) {
    const line = raw.trim();
    if (line.length === 0) continue;

    // Skip non-message constructs we don't model.
    if (/^(autonumber|activate|deactivate|note|loop|alt|else|opt|par|and|critical|option|end|rect|box)\b/i.test(line)) {
      continue;
    }

    const participant = /^(?:participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?/i.exec(line);
    if (participant !== null) {
      const id = participant[1] ?? '';
      if (id.length > 0) recordActor(id);
      continue;
    }

    // Message: A->>B: text   A->B: text   A--xB: text   A-->>B: text
    const msg = /^([A-Za-z0-9_]+)\s*(-->>|-->|->>|->|--x|-x|-\)|--\))\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (msg !== null) {
      const from = msg[1] ?? '';
      const op = msg[2] ?? '->';
      const to = msg[3] ?? '';
      const text = (msg[4] ?? '').trim();
      if (from.length === 0 || to.length === 0) continue;
      recordActor(from);
      recordActor(to);
      const style: 'solid' | 'dotted' = op.startsWith('--') ? 'dotted' : 'solid';
      const arrow: 'arrow' | 'cross' | 'open' = op.endsWith('x')
        ? 'cross'
        : op.endsWith('>') || op.endsWith('>>')
          ? 'arrow'
          : 'open';
      messages.push({ from, to, label: text, style, arrow });
    }
  }

  return { kind: 'sequence', actors: actorOrder, messages };
}

// ---------- class ----------

function parseClassDiagram(body: readonly string[]): MermaidAst {
  const classes = new Map<string, { id: string; label: string; members: ClassMember[] }>();
  const relations: ClassRelation[] = [];
  const ensure = (id: string): { id: string; label: string; members: ClassMember[] } => {
    const existing = classes.get(id);
    if (existing !== undefined) return existing;
    const next = { id, label: id, members: [] as ClassMember[] };
    classes.set(id, next);
    return next;
  };

  for (const raw of body) {
    const line = raw.trim();
    if (line.length === 0) continue;

    // `class Foo { ... }`
    const classBlock = /^class\s+([A-Za-z0-9_]+)\s*\{([^}]*)\}\s*$/.exec(line);
    if (classBlock !== null) {
      const id = classBlock[1] ?? '';
      const inner = classBlock[2] ?? '';
      const c = ensure(id);
      for (const m of inner.split(/[\n;]+/).map((x) => x.trim()).filter((x) => x.length > 0)) {
        c.members.push(parseClassMember(m));
      }
      continue;
    }

    // Single-line: `class Foo`
    const classOnly = /^class\s+([A-Za-z0-9_]+)\s*$/.exec(line);
    if (classOnly !== null) {
      const id = classOnly[1] ?? '';
      ensure(id);
      continue;
    }

    // Dotted member declaration: `Foo : +bar()`.
    const dotted = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(line);
    if (dotted !== null && !/(--|<\||\|>|<>|--\*|\*--|<--|-->)/.test(dotted[2] ?? '')) {
      const id = dotted[1] ?? '';
      const member = (dotted[2] ?? '').trim();
      if (id.length > 0 && member.length > 0) {
        const c = ensure(id);
        c.members.push(parseClassMember(member));
        continue;
      }
    }

    // Relations: `A <|-- B`, `A *-- B`, `A o-- B`, `A --> B : text`, etc.
    const rel = /^([A-Za-z0-9_]+)\s*(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|--|\.\.)\s*([A-Za-z0-9_]+)(?:\s*:\s*(.*))?$/.exec(line);
    if (rel !== null) {
      const from = rel[1] ?? '';
      const op = rel[2] ?? '';
      const to = rel[3] ?? '';
      const lbl = (rel[4] ?? '').trim();
      ensure(from);
      ensure(to);
      relations.push({
        from,
        to,
        kind: classifyClassRelation(op),
        label: lbl.length > 0 ? lbl : null,
      });
    }
  }

  return {
    kind: 'class',
    classes: Array.from(classes.values()).map((c) => ({
      id: c.id,
      label: c.label,
      members: c.members,
    })),
    relations,
  };
}

function parseClassMember(raw: string): ClassMember {
  const trimmed = raw.trim();
  let visibility: ClassMember['visibility'] = '';
  let body = trimmed;
  const first = trimmed[0];
  if (first === '+' || first === '-' || first === '#' || first === '~') {
    visibility = first;
    body = trimmed.slice(1).trim();
  }
  const kind: ClassMember['kind'] = body.includes('(') ? 'method' : 'attribute';
  return { name: body, kind, visibility };
}

function classifyClassRelation(op: string): ClassRelation['kind'] {
  if (op.includes('|')) return 'inheritance';
  if (op.includes('*')) return 'composition';
  if (op.includes('o')) return 'aggregation';
  if (op.includes('.')) return 'dependency';
  return 'association';
}

// ---------- state ----------

function parseStateDiagram(body: readonly string[]): MermaidAst {
  const states = new Set<string>();
  const transitions: StateTransition[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^(state|note|direction)\b/i.test(line) && !/-->/.test(line)) {
      // declarations of the form `state "Label" as id` — record id.
      const decl = /^state\s+(?:"[^"]*"\s+as\s+)?([A-Za-z0-9_*\[\]]+)/i.exec(line);
      if (decl !== null) states.add(decl[1] ?? '');
      continue;
    }
    const transition = /^([A-Za-z0-9_*\[\]]+)\s*-->\s*([A-Za-z0-9_*\[\]]+)(?:\s*:\s*(.*))?$/.exec(line);
    if (transition !== null) {
      const from = transition[1] ?? '';
      const to = transition[2] ?? '';
      const lbl = (transition[3] ?? '').trim();
      if (from.length === 0 || to.length === 0) continue;
      states.add(from);
      states.add(to);
      transitions.push({ from, to, label: lbl.length > 0 ? lbl : null });
    }
  }
  return { kind: 'state', states: Array.from(states), transitions };
}

// ---------- ER ----------

function parseErDiagram(body: readonly string[]): MermaidAst {
  const entities = new Map<string, string[]>();
  const relations: ErRelation[] = [];
  const ensure = (id: string): string[] => {
    const existing = entities.get(id);
    if (existing !== undefined) return existing;
    const arr: string[] = [];
    entities.set(id, arr);
    return arr;
  };

  let cursor = 0;
  while (cursor < body.length) {
    const raw = body[cursor] ?? '';
    cursor++;
    const line = raw.trim();
    if (line.length === 0) continue;

    // Block declaration: `CUSTOMER { attr1 attr2 }`.
    const blockOpen = /^([A-Z0-9_]+)\s*\{/i.exec(line);
    if (blockOpen !== null) {
      const id = blockOpen[1] ?? '';
      const attrs = ensure(id);
      const inlineRest = line.slice(blockOpen[0].length);
      const buffer: string[] = [];
      if (inlineRest.length > 0) buffer.push(inlineRest);
      while (cursor < body.length) {
        const next = body[cursor] ?? '';
        cursor++;
        if (next.includes('}')) {
          buffer.push(next.replace(/}.*$/, ''));
          break;
        }
        buffer.push(next);
      }
      for (const a of buffer.flatMap((x) => x.split(/\n|;/))) {
        const t = a.trim();
        if (t.length > 0) attrs.push(t);
      }
      continue;
    }

    // Relations: `CUSTOMER ||--o{ ORDER : places`.
    const rel = /^([A-Z0-9_]+)\s+([|}{o<>+\-]+)\s+([A-Z0-9_]+)\s*(?::\s*(.*))?$/i.exec(line);
    if (rel !== null) {
      const from = rel[1] ?? '';
      const cardinality = rel[2] ?? '';
      const to = rel[3] ?? '';
      const lbl = (rel[4] ?? '').trim();
      ensure(from);
      ensure(to);
      relations.push({
        from,
        to,
        cardinality,
        label: lbl.length > 0 ? lbl : null,
      });
    }
  }

  return {
    kind: 'er',
    entities: Array.from(entities.entries()).map(([id, attributes]) => ({ id, attributes })),
    relations,
  };
}

// ---------- entry point ----------

export function parseMermaid(source: string): MermaidAst {
  const lines = preprocess(source);
  if (lines.length === 0) {
    return { kind: 'unknown', reason: 'empty document' };
  }
  const firstLine = lines[0] ?? '';
  const kind = detectKind(firstLine);
  const body = lines.slice(1);

  switch (kind) {
    case 'flowchart':
      return parseFlowchart(firstLine, body);
    case 'sequence':
      return parseSequenceDiagram(body);
    case 'class':
      return parseClassDiagram(body);
    case 'state':
      return parseStateDiagram(body);
    case 'er':
      return parseErDiagram(body);
    case 'unknown':
    default:
      return { kind: 'unknown', reason: `unsupported diagram type: ${firstLine}` };
  }
}
