/**
 * /ontology command tests — exercises `status`, `refresh`, and `graph
 * <symbol>` subcommands. The command never touches the LLM, so we
 * inject a tiny stub indexer + capture every `ctx.print` line.
 */

import { describe, expect, test } from 'bun:test';

import { createOntologyCommand } from '@/commands/cmd-ontology';
import {
  emptyOntology,
  makeSymbolId,
  type Ontology,
  type OntologySymbol,
} from '@/ontology/types';
import type { AppConfig, CommandContext } from '@/types/global';

function fnSym(file: string, name: string, line = 1): OntologySymbol {
  return {
    id: makeSymbolId(file, name, null),
    name,
    kind: 'function',
    file,
    line,
    column: 0,
    container: null,
  };
}

function makeStubIndexer(
  ont: Ontology,
  trigger?: () => Promise<boolean>,
): {
  readonly current: Ontology;
  readonly isIndexing: boolean;
  indexProject?: () => Promise<boolean>;
} {
  return {
    get current() { return ont; },
    get isIndexing() { return false; },
    indexProject: trigger,
  };
}

function makeCtx(printSink: string[]): CommandContext {
  return {
    projectRoot: '/tmp/proj',
    sessionId: null,
    config: {} as AppConfig,
    print: (text: string) => {
      printSink.push(text);
    },
    setScreen: () => {},
  };
}

describe('/ontology status', () => {
  test('reports symbol + edge counts', async () => {
    const ont = emptyOntology('/proj');
    ont.symbols.set('x#a', fnSym('x.ts', 'a'));
    ont.edges = [];
    ont.builtAt = Date.parse('2024-01-01T00:00:00Z');
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(ont),
    });
    const sink: string[] = [];
    await cmd.execute('status', makeCtx(sink));
    expect(sink.some((l) => l.includes('1 symbols'))).toBe(true);
    expect(sink.some((l) => l.includes('Indexing'))).toBe(true);
  });

  test('default subcommand is status', async () => {
    const ont = emptyOntology('/proj');
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(ont),
    });
    const sink: string[] = [];
    await cmd.execute('', makeCtx(sink));
    expect(sink.some((l) => l.startsWith('Ontology:'))).toBe(true);
  });

  test('reports when indexer is unwired', async () => {
    const cmd = createOntologyCommand({ getIndexer: () => null });
    const sink: string[] = [];
    await cmd.execute('status', makeCtx(sink));
    expect(sink.some((l) => l.includes('not wired'))).toBe(true);
  });
});

describe('/ontology refresh', () => {
  test('calls indexer.indexProject when available', async () => {
    const ont = emptyOntology('/proj');
    let invoked = 0;
    const trigger = async (): Promise<boolean> => {
      invoked += 1;
      return true;
    };
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(ont, trigger),
    });
    const sink: string[] = [];
    await cmd.execute('refresh', makeCtx(sink));
    expect(invoked).toBe(1);
    expect(sink.some((l) => l.includes('queued'))).toBe(true);
    expect(sink.some((l) => l.includes('complete'))).toBe(true);
  });

  test('reports gracefully when refresh is unavailable', async () => {
    const ont = emptyOntology('/proj');
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(ont),
    });
    const sink: string[] = [];
    await cmd.execute('refresh', makeCtx(sink));
    expect(sink.some((l) => l.includes('not available'))).toBe(true);
  });
});

describe('/ontology graph <symbol>', () => {
  test('prints ASCII neighbourhood when no openGraph dispatcher is wired', async () => {
    const ont = emptyOntology('/proj');
    const target = fnSym('src/util.ts', 'doThing');
    const caller = fnSym('src/a.ts', 'caller', 10);
    ont.symbols.set(target.id, target);
    ont.symbols.set(caller.id, caller);
    ont.edges = [
      { from: caller.id, to: target.id, kind: 'calls', file: 'src/a.ts', line: 11 },
    ];
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(ont),
    });
    const sink: string[] = [];
    await cmd.execute('graph doThing', makeCtx(sink));
    expect(sink.some((l) => l.includes('doThing'))).toBe(true);
    expect(sink.some((l) => l.includes('Incoming'))).toBe(true);
  });

  test('delegates to openGraph when supplied', async () => {
    const ont = emptyOntology('/proj');
    const captured: string[] = [];
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(ont),
      openGraph: (sym: string) => {
        captured.push(sym);
      },
    });
    const sink: string[] = [];
    await cmd.execute('graph foo', makeCtx(sink));
    expect(captured).toEqual(['foo']);
    expect(sink.length).toBe(0);
  });

  test('reports missing symbol when no openGraph wired', async () => {
    const ont = emptyOntology('/proj');
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(ont),
    });
    const sink: string[] = [];
    await cmd.execute('graph nothing-here', makeCtx(sink));
    expect(sink.some((l) => l.includes('No symbol named'))).toBe(true);
  });

  test('asks for a symbol when none provided', async () => {
    const ont = emptyOntology('/proj');
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(ont),
    });
    const sink: string[] = [];
    await cmd.execute('graph', makeCtx(sink));
    expect(sink.some((l) => l.includes('Usage:'))).toBe(true);
  });
});

describe('/ontology — unknown subcommand', () => {
  test('reports an unknown subcommand', async () => {
    const cmd = createOntologyCommand({
      getIndexer: () => makeStubIndexer(emptyOntology('/proj')),
    });
    const sink: string[] = [];
    await cmd.execute('banana', makeCtx(sink));
    expect(sink.some((l) => l.includes('Unknown subcommand'))).toBe(true);
  });
});
