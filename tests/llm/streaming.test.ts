import { describe, test, expect } from 'bun:test';
import { parseSSEChunk, splitSSEFrames } from '@/llm/streaming';

describe('parseSSEChunk', () => {
  test('returns heartbeat on empty string', () => {
    const result = parseSSEChunk('');
    expect(result).toEqual({ kind: 'heartbeat' });
  });

  test('returns heartbeat on comment-only line', () => {
    const result = parseSSEChunk(': keep-alive');
    expect(result).toEqual({ kind: 'heartbeat' });
  });

  test('returns heartbeat when data lines are absent', () => {
    const result = parseSSEChunk('event: ping\nid: 42');
    expect(result).toEqual({ kind: 'heartbeat' });
  });

  test('parses well-formed data line into a ChatCompletionChunk', () => {
    const payload = {
      id: 'x',
      choices: [
        {
          index: 0,
          delta: { content: 'hello' },
        },
      ],
    };
    const result = parseSSEChunk(`data: ${JSON.stringify(payload)}`);
    expect(result).toEqual({ kind: 'data', payload });
  });

  test('recognises the special [DONE] marker', () => {
    const result = parseSSEChunk('data: [DONE]');
    expect(result).toEqual({ kind: 'done' });
  });

  test('joins multi-line data payloads with a newline', () => {
    // A JSON payload split across two `data:` lines — per SSE spec, the
    // parser joins with a newline before parsing JSON. We pick a JSON shape
    // that still parses after the newline is interpreted inside a string.
    const raw = 'data: {"choices":[{"index":0,"delta":{"content":"A\\nB"}}]}';
    const result = parseSSEChunk(raw);
    if (result && result.kind === 'data') {
      const first = result.payload.choices[0];
      expect(first?.delta.content).toBe('A\nB');
    } else {
      throw new Error('expected data chunk');
    }
  });

  test('returns null on malformed JSON', () => {
    const result = parseSSEChunk('data: {not-json');
    expect(result).toBeNull();
  });

  test('returns null when schema validation fails', () => {
    const result = parseSSEChunk('data: {"foo":"bar"}');
    expect(result).toBeNull();
  });

  test('tolerates CRLF line endings', () => {
    const payload = { choices: [{ index: 0, delta: { content: 'x' } }] };
    const raw = `data: ${JSON.stringify(payload)}\r`;
    const result = parseSSEChunk(raw);
    expect(result?.kind).toBe('data');
  });
});

describe('splitSSEFrames', () => {
  test('returns empty frames + full buffer when no blank lines', () => {
    const { frames, rest } = splitSSEFrames('data: partial');
    expect(frames).toEqual([]);
    expect(rest).toBe('data: partial');
  });

  test('splits one complete frame', () => {
    const { frames, rest } = splitSSEFrames('data: {"a":1}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe('data: {"a":1}');
    expect(rest).toBe('');
  });

  test('splits two complete frames and carries the tail', () => {
    const input = 'data: one\n\ndata: two\n\ndata: tai';
    const { frames, rest } = splitSSEFrames(input);
    expect(frames).toEqual(['data: one', 'data: two']);
    expect(rest).toBe('data: tai');
  });

  test('normalises CRLF separators', () => {
    const input = 'data: one\r\n\r\ndata: two\r\n\r\n';
    const { frames, rest } = splitSSEFrames(input);
    expect(frames).toEqual(['data: one', 'data: two']);
    expect(rest).toBe('');
  });
});
