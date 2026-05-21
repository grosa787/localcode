/**
 * ASCII renderer for Mermaid diagrams (TUI).
 *
 * Strategy per diagram kind:
 *
 *   - flowchart: Sugiyama-lite. Topologically sort the DAG into layers,
 *     paint each node as a small box, then draw orthogonal edges with
 *     Unicode box-drawing glyphs. Cyclic graphs fall back to a
 *     bullet-list with a warning header (we want the model's intent
 *     visible even when we can't lay it out).
 *
 *   - sequence: vertical actor lanes with horizontal arrows between
 *     them. Each message is a single row.
 *
 *   - class / state / er: simple bordered-list representation —
 *     readable but not visually fancy.
 *
 * Output is `string[]` (one element per line). Lines are ANSI-free so
 * the surrounding ink `<Text>` can colour them uniformly if it wants.
 *
 * Width-aware: the caller passes a target `width` (defaults to 80) and
 * we ensure no produced line exceeds it (long labels are truncated with
 * an ellipsis). The TUI passes `process.stdout.columns - padding`.
 */

import type {
  ClassRelation,
  ErRelation,
  MermaidAst,
  ParsedClass,
  ParsedEdge,
  ParsedNode,
  SequenceMessage,
  StateTransition,
} from './parser.js';

export interface RenderOptions {
  /** Maximum line width. Default 80. Clamped to >=24. */
  readonly width?: number;
  /** Maximum total lines. Default 200 — guards against pathological graphs. */
  readonly maxLines?: number;
}

const DEFAULT_WIDTH = 80;
const DEFAULT_MAX_LINES = 200;

export function renderMermaidAscii(
  ast: MermaidAst,
  opts: RenderOptions = {},
): string[] {
  const width = Math.max(24, opts.width ?? DEFAULT_WIDTH);
  const maxLines = Math.max(20, opts.maxLines ?? DEFAULT_MAX_LINES);

  let lines: string[];
  switch (ast.kind) {
    case 'flowchart':
      lines = renderFlowchart(ast.nodes, ast.edges, ast.direction, width);
      break;
    case 'sequence':
      lines = renderSequence(ast.actors, ast.messages, width);
      break;
    case 'class':
      lines = renderClass(ast.classes, ast.relations, width);
      break;
    case 'state':
      lines = renderState(ast.states, ast.transitions, width);
      break;
    case 'er':
      lines = renderEr(ast.entities, ast.relations, width);
      break;
    case 'unknown':
      lines = ['[mermaid] unsupported diagram type', `reason: ${ast.reason}`];
      break;
  }

  if (lines.length > maxLines) {
    const trimmed = lines.slice(0, maxLines);
    trimmed.push(`… ${lines.length - maxLines} more line(s) (truncated)`);
    return trimmed;
  }
  return lines;
}

// ---------- shared helpers ----------

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + ' '.repeat(width - text.length);
}

/**
 * Place a snippet into a 2D char grid at (row, col). The grid is
 * mutable; callers should treat each row as a fresh array because we
 * do in-place patching of cells.
 */
function patchCell(grid: string[][], row: number, col: number, ch: string): void {
  if (row < 0 || row >= grid.length) return;
  const line = grid[row];
  if (line === undefined) return;
  if (col < 0 || col >= line.length) return;
  line[col] = ch;
}

function patchString(grid: string[][], row: number, col: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    patchCell(grid, row, col + i, text[i] ?? ' ');
  }
}

function gridToLines(grid: string[][]): string[] {
  return grid.map((row) => row.join('').replace(/\s+$/g, ''));
}

function makeGrid(rows: number, cols: number): string[][] {
  const grid: string[][] = [];
  for (let r = 0; r < rows; r++) {
    grid.push(new Array<string>(cols).fill(' '));
  }
  return grid;
}

// ---------- flowchart layout ----------

/**
 * Layered DAG layout. We:
 *   1. detect cycles — if any, fall back to a bullet list.
 *   2. assign each node to a layer = max(layer(pred)) + 1.
 *   3. order nodes within each layer by first-seen ordering.
 *   4. compute node-box width per layer column.
 *   5. paint nodes + orthogonal arrows.
 *
 * For LR/RL we lay layers horizontally; for TB/BT vertically. For
 * simplicity the routing is the same — we just rotate the layer axis.
 */
function renderFlowchart(
  nodes: readonly ParsedNode[],
  edges: readonly ParsedEdge[],
  direction: 'TB' | 'BT' | 'LR' | 'RL',
  width: number,
): string[] {
  if (nodes.length === 0) {
    return ['[mermaid flowchart] (empty)'];
  }

  const visited = detectCycle(nodes, edges);
  if (visited.cyclic) {
    return cyclicFallback(nodes, edges, width);
  }

  const layers = assignLayers(nodes, edges);
  if (direction === 'BT') layers.reverse();

  // Vertical layouts (TB/BT) — layers stacked top-to-bottom.
  // Horizontal layouts (LR/RL) — layers placed left-to-right.
  // The vertical layout is the most readable in a terminal, so for
  // LR/RL we still draw layers stacked (top→bottom) but annotate the
  // direction. This keeps the column width manageable without
  // wrapping wide labels.
  const isHorizontal = direction === 'LR' || direction === 'RL';

  // For horizontal layouts we lay nodes left-to-right inside each
  // layer (so layer 0 is leftmost). For vertical layouts the column
  // count per row equals layer size. Common path: render each layer
  // as a centred row of boxes with arrows pointing down (or right).
  if (isHorizontal) {
    return renderFlowchartHorizontal(layers, edges, direction === 'RL', width);
  }
  return renderFlowchartVertical(layers, edges, width);
}

function renderFlowchartVertical(
  layers: readonly (readonly ParsedNode[])[],
  edges: readonly ParsedEdge[],
  width: number,
): string[] {
  if (layers.length === 0) return ['[mermaid flowchart] (empty)'];

  // For each layer, pick a box width that fits within `width`. Boxes
  // are centred horizontally; arrows span between centres.
  const boxes = layers.map((layer) =>
    layer.map((node) => formatBox(node, Math.floor(width / Math.max(1, layer.length)) - 2)),
  );

  // Compute column slots per layer (centre x of each box).
  const layerColumns: { centre: number; left: number; right: number }[][] = [];
  for (const layer of boxes) {
    const totalCells = layer.reduce((s, b) => s + b.width, 0) + Math.max(0, layer.length - 1) * 4;
    const startX = Math.max(0, Math.floor((width - totalCells) / 2));
    let x = startX;
    const cols: { centre: number; left: number; right: number }[] = [];
    for (const b of layer) {
      cols.push({ centre: x + Math.floor(b.width / 2), left: x, right: x + b.width - 1 });
      x += b.width + 4;
    }
    layerColumns.push(cols);
  }

  // Compute per-layer height (boxes are 3 rows + 1 arrow row between layers).
  const layerHeight = 3;
  const arrowHeight = 2;
  const totalRows =
    layers.length * layerHeight + Math.max(0, layers.length - 1) * arrowHeight;
  const grid = makeGrid(totalRows, width);

  // Paint boxes.
  const nodeToPosition = new Map<string, { row: number; centreCol: number; box: BoxRender }>();
  let row = 0;
  for (let li = 0; li < boxes.length; li++) {
    const layer = boxes[li] ?? [];
    const cols = layerColumns[li] ?? [];
    for (let ni = 0; ni < layer.length; ni++) {
      const b = layer[ni];
      const c = cols[ni];
      if (b === undefined || c === undefined) continue;
      paintBox(grid, row, c.left, b);
      nodeToPosition.set(b.node.id, {
        row,
        centreCol: c.centre,
        box: b,
      });
    }
    row += layerHeight + arrowHeight;
  }

  // Paint edges.
  for (const edge of edges) {
    const from = nodeToPosition.get(edge.from);
    const to = nodeToPosition.get(edge.to);
    if (from === undefined || to === undefined) continue;
    paintVerticalEdge(grid, from, to, edge);
  }

  const out = gridToLines(grid);
  // Drop trailing blank lines.
  while (out.length > 0 && (out[out.length - 1] ?? '').trim().length === 0) {
    out.pop();
  }
  return out;
}

function renderFlowchartHorizontal(
  layers: readonly (readonly ParsedNode[])[],
  edges: readonly ParsedEdge[],
  reversed: boolean,
  width: number,
): string[] {
  // For terminal readability we still render layers top-to-bottom but
  // annotate the direction.
  const arrow = reversed ? '←' : '→';
  const header = `[mermaid flowchart · ${reversed ? 'RL' : 'LR'} (${arrow})]`;
  const body = renderFlowchartVertical(layers, edges, width);
  return [header, ...body];
}

/**
 * Detect cycles via DFS three-colour marking. Returns whether the graph
 * has at least one cycle.
 */
function detectCycle(
  nodes: readonly ParsedNode[],
  edges: readonly ParsedEdge[],
): { cyclic: boolean } {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    const list = adj.get(e.from);
    if (list !== undefined) list.push(e.to);
  }
  const colour = new Map<string, 0 | 1 | 2>();
  for (const n of nodes) colour.set(n.id, 0);
  const dfs = (id: string): boolean => {
    colour.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      const c = colour.get(next);
      if (c === 1) return true;
      if (c === 0 && dfs(next)) return true;
    }
    colour.set(id, 2);
    return false;
  };
  for (const n of nodes) {
    if (colour.get(n.id) === 0 && dfs(n.id)) return { cyclic: true };
  }
  return { cyclic: false };
}

function cyclicFallback(
  nodes: readonly ParsedNode[],
  edges: readonly ParsedEdge[],
  width: number,
): string[] {
  const out: string[] = [];
  out.push('[mermaid flowchart · cyclic — bullet fallback]');
  out.push('');
  out.push('Nodes:');
  for (const n of nodes) {
    out.push(truncate(`  • ${n.label}${n.label === n.id ? '' : ` (${n.id})`}`, width));
  }
  if (edges.length > 0) {
    out.push('');
    out.push('Edges:');
    for (const e of edges) {
      const lbl = e.label !== null ? ` [${e.label}]` : '';
      const op = e.style === 'dotted' ? '⇢' : e.style === 'thick' ? '⇒' : '→';
      out.push(truncate(`  ${e.from} ${op} ${e.to}${lbl}`, width));
    }
  }
  return out;
}

/**
 * Compute the layer for each node = longest-path-from-a-root + 1.
 * Roots are nodes with no incoming edges (or all nodes if the graph is
 * a forest with cycles already stripped — which can't happen here
 * because we abort on cycles).
 */
function assignLayers(
  nodes: readonly ParsedNode[],
  edges: readonly ParsedEdge[],
): ParsedNode[][] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const idToNode = new Map<string, ParsedNode>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
    idToNode.set(n.id, n);
  }
  for (const e of edges) {
    if (!inDegree.has(e.from) || !inDegree.has(e.to)) continue;
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    const list = adj.get(e.from);
    if (list !== undefined) list.push(e.to);
  }
  // Kahn's algorithm to compute layer indices.
  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) {
      layer.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const li = layer.get(id) ?? 0;
    for (const next of adj.get(id) ?? []) {
      const cur = layer.get(next);
      if (cur === undefined || cur < li + 1) {
        layer.set(next, li + 1);
      }
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  const maxLayer = Math.max(0, ...Array.from(layer.values()));
  const layers: ParsedNode[][] = [];
  for (let i = 0; i <= maxLayer; i++) layers.push([]);
  // Preserve original insertion order within each layer for stability.
  for (const n of nodes) {
    const li = layer.get(n.id) ?? 0;
    const target = layers[li];
    if (target !== undefined) target.push(n);
  }
  return layers;
}

interface BoxRender {
  readonly node: ParsedNode;
  readonly width: number;
  readonly height: number;
  readonly top: string;
  readonly mid: string;
  readonly bot: string;
}

function formatBox(node: ParsedNode, maxLabelWidth: number): BoxRender {
  const minLabelWidth = Math.min(4, maxLabelWidth > 0 ? maxLabelWidth : 4);
  const labelMax = Math.max(minLabelWidth, Math.min(maxLabelWidth, 24));
  const label = truncate(node.label, labelMax);
  const inner = ` ${label} `;
  const width = inner.length + 2; // borders
  const corners = cornerGlyphs(node.shape);
  const top = `${corners.tl}${corners.h.repeat(width - 2)}${corners.tr}`;
  const mid = `${corners.v}${padRight(inner, width - 2)}${corners.v}`;
  const bot = `${corners.bl}${corners.h.repeat(width - 2)}${corners.br}`;
  return { node, width, height: 3, top, mid, bot };
}

function cornerGlyphs(shape: ParsedNode['shape']): {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
} {
  switch (shape) {
    case 'rhombus':
    case 'hexagon':
      return { tl: '╱', tr: '╲', bl: '╲', br: '╱', h: '─', v: '│' };
    case 'circle':
      return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
    case 'stadium':
    case 'round':
      return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
    case 'subroutine':
      return { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };
    case 'cylinder':
      return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '═', v: '│' };
    default:
      return { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
  }
}

function paintBox(grid: string[][], row: number, col: number, b: BoxRender): void {
  patchString(grid, row, col, b.top);
  patchString(grid, row + 1, col, b.mid);
  patchString(grid, row + 2, col, b.bot);
}

interface BoxPosition {
  readonly row: number;
  readonly centreCol: number;
  readonly box: BoxRender;
}

function paintVerticalEdge(
  grid: string[][],
  from: BoxPosition,
  to: BoxPosition,
  edge: ParsedEdge,
): void {
  // We support the typical case where `to` is strictly below `from`.
  // For back-edges (`to.row <= from.row`) we just skip drawing — the
  // graph is acyclic by precondition but layer assignment can still
  // produce same-row siblings due to disconnected components.
  if (to.row <= from.row) return;
  const fromBottomRow = from.row + from.box.height - 1; // bottom border
  const toTopRow = to.row;
  const startRow = fromBottomRow + 1;
  const endRow = toTopRow - 1;
  if (endRow < startRow) return;

  const startCol = from.centreCol;
  const endCol = to.centreCol;

  const vGlyph = edge.style === 'dotted' ? '┊' : edge.style === 'thick' ? '┃' : '│';
  const hGlyph = edge.style === 'dotted' ? '┄' : edge.style === 'thick' ? '━' : '─';
  const arrowGlyph =
    edge.head === 'cross' ? '✕' : edge.head === 'circle' ? '○' : 'v';

  if (startCol === endCol) {
    for (let r = startRow; r <= endRow; r++) {
      patchCell(grid, r, startCol, vGlyph);
    }
    patchCell(grid, endRow, endCol, arrowGlyph);
  } else {
    // Orthogonal route: down, across, down to target column.
    const midRow = Math.floor((startRow + endRow) / 2);
    for (let r = startRow; r < midRow; r++) patchCell(grid, r, startCol, vGlyph);
    const cornerOut = startCol < endCol ? '└' : '┘';
    const cornerIn = startCol < endCol ? '┐' : '┌';
    patchCell(grid, midRow, startCol, cornerOut);
    const lo = Math.min(startCol, endCol);
    const hi = Math.max(startCol, endCol);
    for (let c = lo + 1; c < hi; c++) patchCell(grid, midRow, c, hGlyph);
    patchCell(grid, midRow, endCol, cornerIn);
    for (let r = midRow + 1; r <= endRow; r++) patchCell(grid, r, endCol, vGlyph);
    patchCell(grid, endRow, endCol, arrowGlyph);
  }

  // Edge label — render once near the start row, off to the side.
  if (edge.label !== null && edge.label.length > 0) {
    const labelRow = startRow;
    const labelCol = Math.min(startCol, endCol) + 1;
    const truncated = truncate(edge.label, 16);
    // Only paint into cells currently blank to avoid clobbering glyphs.
    for (let i = 0; i < truncated.length; i++) {
      const ch = truncated[i] ?? ' ';
      const row = grid[labelRow];
      if (row === undefined) break;
      const target = row[labelCol + i];
      if (target === ' ') patchCell(grid, labelRow, labelCol + i, ch);
    }
  }
}

// ---------- sequence renderer ----------

function renderSequence(
  actors: readonly string[],
  messages: readonly SequenceMessage[],
  width: number,
): string[] {
  if (actors.length === 0) return ['[mermaid sequence] (no actors)'];
  // Compute column positions: each actor gets a lane centred on a
  // column. Min spacing is 14 cells; if total exceeds `width` we
  // shrink lanes proportionally.
  const minLane = 14;
  const maxLaneWidth = Math.max(8, Math.floor((width - 2) / actors.length));
  const lane = Math.min(minLane, maxLaneWidth);
  const total = lane * actors.length + 2;
  const usedWidth = Math.min(total, width);

  const actorRow: string[] = [];
  const centres: number[] = [];
  for (let i = 0; i < actors.length; i++) {
    const name = truncate(actors[i] ?? '?', lane - 2);
    const cell = padRight(`[${name}]`, lane);
    actorRow.push(cell);
    centres.push(i * lane + Math.floor(lane / 2));
  }
  const lines: string[] = [];
  lines.push(actorRow.join('').slice(0, usedWidth));

  // Lifeline row between actor headers and messages.
  const lifeline = makeGrid(1, usedWidth);
  for (const c of centres) patchCell(lifeline, 0, c, '│');
  lines.push(...gridToLines(lifeline));

  for (const m of messages) {
    const fromIdx = actors.indexOf(m.from);
    const toIdx = actors.indexOf(m.to);
    if (fromIdx < 0 || toIdx < 0) continue;
    const fromCol = centres[fromIdx] ?? 0;
    const toCol = centres[toIdx] ?? 0;
    const row = makeGrid(2, usedWidth);
    // Vertical lifelines stay visible.
    for (const c of centres) {
      patchCell(row, 0, c, '│');
      patchCell(row, 1, c, '│');
    }
    if (fromIdx === toIdx) {
      patchCell(row, 0, fromCol + 1, '┐');
      patchCell(row, 1, fromCol + 1, '┘');
      const label = truncate(m.label, usedWidth - fromCol - 4);
      patchString(row, 0, fromCol + 3, label);
    } else {
      const lo = Math.min(fromCol, toCol);
      const hi = Math.max(fromCol, toCol);
      const ch = m.style === 'dotted' ? '┄' : '─';
      for (let c = lo + 1; c < hi; c++) patchCell(row, 0, c, ch);
      // Arrowhead
      const arrowGlyph = m.arrow === 'cross' ? '✕' : m.arrow === 'open' ? '○' : fromIdx < toIdx ? '►' : '◄';
      patchCell(row, 0, toCol, arrowGlyph);
      // Label centred above the line.
      const label = truncate(m.label, hi - lo - 2);
      const labelStart = lo + Math.max(1, Math.floor(((hi - lo) - label.length) / 2));
      patchString(row, 0, labelStart, label);
    }
    lines.push(...gridToLines(row));
  }
  return lines;
}

// ---------- class renderer ----------

function renderClass(
  classes: readonly ParsedClass[],
  relations: readonly ClassRelation[],
  width: number,
): string[] {
  const lines: string[] = [];
  lines.push('[mermaid classDiagram]');
  lines.push('');
  for (const c of classes) {
    const header = `┌─ class ${c.id} ` + '─'.repeat(Math.max(0, width - 11 - c.id.length));
    lines.push(truncate(header, width));
    if (c.members.length === 0) {
      lines.push(`│ (no members)`.padEnd(width - 1) + '│');
    } else {
      for (const m of c.members) {
        const sigil = m.visibility.length > 0 ? m.visibility : ' ';
        const text = `${sigil} ${m.name}`;
        lines.push(`│ ${truncate(text, width - 4).padEnd(width - 4, ' ')} │`);
      }
    }
    lines.push('└' + '─'.repeat(Math.max(0, width - 2)) + '┘');
  }
  if (relations.length > 0) {
    lines.push('');
    lines.push('Relations:');
    for (const r of relations) {
      const op = classRelGlyph(r);
      const lbl = r.label !== null ? ` [${r.label}]` : '';
      lines.push(truncate(`  ${r.from} ${op} ${r.to}${lbl}`, width));
    }
  }
  return lines;
}

function classRelGlyph(r: ClassRelation): string {
  switch (r.kind) {
    case 'inheritance':
      return '◁──';
    case 'composition':
      return '◆──';
    case 'aggregation':
      return '◇──';
    case 'dependency':
      return '╌╌▶';
    case 'association':
      return '───';
  }
}

// ---------- state renderer ----------

function renderState(
  states: readonly string[],
  transitions: readonly StateTransition[],
  width: number,
): string[] {
  const lines: string[] = [];
  lines.push('[mermaid stateDiagram]');
  lines.push('');
  if (states.length > 0) {
    lines.push('States:');
    for (const s of states) {
      lines.push(truncate(`  ( ${s} )`, width));
    }
  }
  if (transitions.length > 0) {
    lines.push('');
    lines.push('Transitions:');
    for (const t of transitions) {
      const lbl = t.label !== null ? `  : ${t.label}` : '';
      lines.push(truncate(`  ${t.from} ──▶ ${t.to}${lbl}`, width));
    }
  }
  return lines;
}

// ---------- ER renderer ----------

function renderEr(
  entities: readonly { readonly id: string; readonly attributes: readonly string[] }[],
  relations: readonly ErRelation[],
  width: number,
): string[] {
  const lines: string[] = [];
  lines.push('[mermaid erDiagram]');
  lines.push('');
  for (const e of entities) {
    const header = `┌─ entity ${e.id} ` + '─'.repeat(Math.max(0, width - 12 - e.id.length));
    lines.push(truncate(header, width));
    if (e.attributes.length === 0) {
      lines.push(`│ (no attributes)`.padEnd(width - 1) + '│');
    } else {
      for (const a of e.attributes) {
        lines.push(`│ ${truncate(a, width - 4).padEnd(width - 4, ' ')} │`);
      }
    }
    lines.push('└' + '─'.repeat(Math.max(0, width - 2)) + '┘');
  }
  if (relations.length > 0) {
    lines.push('');
    lines.push('Relations:');
    for (const r of relations) {
      const lbl = r.label !== null ? `  : ${r.label}` : '';
      lines.push(truncate(`  ${r.from} ${r.cardinality} ${r.to}${lbl}`, width));
    }
  }
  return lines;
}
