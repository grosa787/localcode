/**
 * AnthropicAdapter — multimodal `image_url` translation.
 *
 * Anthropic's Messages API uses `{ type: 'image', source: { type: 'base64'
 * | 'url', ... } }` content blocks, NOT the OpenAI `image_url` shape.
 * The adapter MUST translate our internal `MessageContentPart[]` (which
 * uses the OpenAI shape verbatim) into Anthropic's `image` blocks
 * before sending the request. This test pins that translation.
 */
import { describe, expect, test } from 'bun:test';
import { toAnthropicMessageContent } from '@/llm/adapter-anthropic';
import type { MessageContentPart } from '@/types/message';

const TINY_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';

describe('toAnthropicMessageContent — happy paths', () => {
  test('text part round-trips unchanged', () => {
    const parts: MessageContentPart[] = [
      { type: 'text', text: 'What is in this image?' },
    ];
    const blocks = toAnthropicMessageContent(parts);
    expect(blocks).toEqual([
      { type: 'text', text: 'What is in this image?' },
    ]);
  });

  test('data: URI → base64 image block with media_type + data', () => {
    const dataUri = `data:image/png;base64,${TINY_BASE64}`;
    const parts: MessageContentPart[] = [
      { type: 'image_url', image_url: { url: dataUri } },
    ];
    const blocks = toAnthropicMessageContent(parts);
    expect(blocks).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: TINY_BASE64,
        },
      },
    ]);
  });

  test('https:// URL → url image block', () => {
    const parts: MessageContentPart[] = [
      {
        type: 'image_url',
        image_url: { url: 'https://example.com/foo.png' },
      },
    ];
    const blocks = toAnthropicMessageContent(parts);
    expect(blocks).toEqual([
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/foo.png' },
      },
    ]);
  });

  test('image + trailing text part both emit (order preserved)', () => {
    const parts: MessageContentPart[] = [
      {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${TINY_BASE64}` },
      },
      { type: 'text', text: 'Describe this.' },
    ];
    const blocks = toAnthropicMessageContent(parts);
    expect(blocks.length).toBe(2);
    const first = blocks[0]!;
    expect(first.type).toBe('image');
    const second = blocks[1]!;
    expect(second.type).toBe('text');
    if (second.type === 'text') {
      expect(second.text).toBe('Describe this.');
    }
  });
});

describe('toAnthropicMessageContent — defensive paths', () => {
  test('empty text part is dropped', () => {
    const parts: MessageContentPart[] = [{ type: 'text', text: '' }];
    expect(toAnthropicMessageContent(parts)).toEqual([]);
  });

  test('malformed data: URI (missing base64 payload) is dropped', () => {
    const parts: MessageContentPart[] = [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' } },
    ];
    expect(toAnthropicMessageContent(parts)).toEqual([]);
  });

  test('unrecognised scheme (file://) is dropped', () => {
    const parts: MessageContentPart[] = [
      { type: 'image_url', image_url: { url: 'file:///tmp/x.png' } },
    ];
    expect(toAnthropicMessageContent(parts)).toEqual([]);
  });

  test('empty URL is dropped', () => {
    const parts: MessageContentPart[] = [
      { type: 'image_url', image_url: { url: '' } },
    ];
    expect(toAnthropicMessageContent(parts)).toEqual([]);
  });
});
