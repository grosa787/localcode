/**
 * OntologyGraph — read-only ASCII overlay for `/ontology graph <symbol>`.
 *
 * Renders a single symbol surrounded by its incoming and outgoing edges:
 *
 *   Symbol: ToolExecutor (class) — src/llm/tool-executor.ts:42
 *
 *   Incoming ──────────────────────────────────────
 *     references ← app.tsx#App                       src/app.tsx:1458
 *     calls      ← runChatLoop                        src/llm/chat-runtime.ts:120
 *
 *   Outgoing ──────────────────────────────────────
 *     calls      → resolveApprovalPolicy              src/llm/tool-executor.ts:60
 *     uses-type  → ToolHandler                        src/llm/tool-executor.ts:55
 *
 * Press Esc / q to close.
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

import type { Ontology } from '@/ontology/types';

export interface OntologyGraphProps {
  /** Live ontology snapshot. */
  ontology: Ontology;
  /** Symbol name (bare) typed via `/ontology graph <symbol>`. */
  symbolName: string;
  /** Close callback fired on Esc / q. */
  onClose: () => void;
  /** Cap on rows rendered per direction. Default 12. */
  maxRowsPerSide?: number;
}

interface RowEntry {
  kind: string;
  /** Other end of the edge, label-only (caller for incoming, callee for outgoing). */
  other: string;
  file: string;
  line: number;
}

/**
 * Strip the `<file>#` prefix from a symbol id so the row stays short.
 */
function trimId(id: string): string {
  const idx = id.indexOf('#');
  return idx === -1 ? id : id.slice(idx + 1);
}

const OntologyGraph: React.FC<OntologyGraphProps> = ({
  ontology,
  symbolName,
  onClose,
  maxRowsPerSide = 12,
}) => {
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'Q') {
      onClose();
    }
  });

  const view = useMemo(() => {
    const matches = [...ontology.symbols.values()].filter(
      (s) => s.name === symbolName,
    );
    if (matches.length === 0) {
      return { matches, neighbourhoods: [] };
    }
    const neighbourhoods = matches.map((sym) => {
      const incoming: RowEntry[] = [];
      const outgoing: RowEntry[] = [];
      for (const edge of ontology.edges) {
        if (edge.to === sym.id) {
          incoming.push({
            kind: edge.kind,
            other: trimId(edge.from),
            file: edge.file ?? sym.file,
            line: edge.line ?? sym.line,
          });
        }
        if (edge.from === sym.id) {
          outgoing.push({
            kind: edge.kind,
            other: trimId(edge.to),
            file: edge.file ?? sym.file,
            line: edge.line ?? sym.line,
          });
        }
      }
      return { sym, incoming, outgoing };
    });
    return { matches, neighbourhoods };
  }, [ontology, symbolName]);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>
        Ontology graph for <Text bold>{symbolName}</Text>
        {'  '}
        <Text dimColor>(esc/q to close)</Text>
      </Text>
      {view.matches.length === 0 ? (
        <Box marginTop={1}>
          <Text color="yellow">No symbol named "{symbolName}" in the ontology.</Text>
        </Box>
      ) : (
        view.neighbourhoods.map((nb) => (
          <Box flexDirection="column" key={nb.sym.id} marginTop={1}>
            <Text>
              <Text color="cyan">{nb.sym.kind}</Text>{' '}
              <Text bold>{nb.sym.name}</Text>{' '}
              <Text dimColor>
                — {nb.sym.file}:{nb.sym.line}
              </Text>
            </Text>
            <Box marginTop={1}>
              <Text dimColor>Incoming ──────────────────────────────────────</Text>
            </Box>
            {nb.incoming.length === 0 ? (
              <Text dimColor>  (no incoming edges)</Text>
            ) : (
              nb.incoming.slice(0, maxRowsPerSide).map((e, i) => (
                <Text key={`in-${i}`}>
                  {'  '}
                  <Text color="green">{e.kind.padEnd(10)}</Text>{' '}
                  ← {e.other}
                  {'  '}
                  <Text dimColor>
                    {e.file}:{e.line}
                  </Text>
                </Text>
              ))
            )}
            {nb.incoming.length > maxRowsPerSide && (
              <Text dimColor>
                {'  '}… {nb.incoming.length - maxRowsPerSide} more
              </Text>
            )}
            <Box marginTop={1}>
              <Text dimColor>Outgoing ──────────────────────────────────────</Text>
            </Box>
            {nb.outgoing.length === 0 ? (
              <Text dimColor>  (no outgoing edges)</Text>
            ) : (
              nb.outgoing.slice(0, maxRowsPerSide).map((e, i) => (
                <Text key={`out-${i}`}>
                  {'  '}
                  <Text color="magenta">{e.kind.padEnd(10)}</Text>{' '}
                  → {e.other}
                  {'  '}
                  <Text dimColor>
                    {e.file}:{e.line}
                  </Text>
                </Text>
              ))
            )}
            {nb.outgoing.length > maxRowsPerSide && (
              <Text dimColor>
                {'  '}… {nb.outgoing.length - maxRowsPerSide} more
              </Text>
            )}
          </Box>
        ))
      )}
    </Box>
  );
};

export default OntologyGraph;
