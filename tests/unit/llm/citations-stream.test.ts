/** Streamed citations — one `citation` event per source, four wire shapes.
 *
 *  The buffered reader cannot be reused here: a stream never assembles the body
 *  it reads from. Each provider announces a source differently and at a
 *  different moment, and every shape below was RECORDED off a live stream
 *  (`onStreamChunk`), not written from what the docs imply:
 *
 *    anthropic  content_block_delta → delta.type 'citations_delta'
 *    responses  response.output_text.annotation.added   (OpenAI and xAI)
 *    chat       choices[].delta.annotations[]           (OpenRouter `:online`)
 *    google     a LATE chunk whose groundingMetadata is populated
 *
 *  The Google case is the one worth knowing: the first chunk carrying
 *  `groundingMetadata` has it EMPTY, and the populated one arrives near the end.
 *  Latching on first sight — which is what the `builtin_tool_start` marker beside
 *  it does — would report a search and no sources.
 */
import { describe, expect, it } from 'bun:test';

import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { XAIResponsesAdapter } from '../../../src/llm/providers/xai/responses';
import type { StreamEvent } from '../../../src/llm/types/stream';

const cfg = { apiKey: 'k' };

function citations(events: StreamEvent[]) {
  return events.filter((e) => e.type === 'citation');
}

describe('anthropic streams citations_delta', () => {
  it('emits the source with the passage it supports', () => {
    const parse = new AnthropicAdapter(cfg).createStreamParser();
    const events = parse({
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://www.python.org/downloads/',
            title: 'Download Python | Python.org',
            cited_text: 'Python 3.14.7 Aug. 5, 2026',
          },
        },
      }),
    });
    expect(citations(events)).toEqual([
      {
        type: 'citation',
        citation: {
          url: 'https://www.python.org/downloads/',
          title: 'Download Python | Python.org',
          text: 'Python 3.14.7 Aug. 5, 2026',
        },
      },
    ]);
  });

  it('does not mistake a search RESULT for a citation', () => {
    // `web_search_tool_result` lists every page the search returned. The model
    // cites some of them; reporting all as citations would claim sources the
    // answer never used.
    const parse = new AnthropicAdapter(cfg).createStreamParser();
    const events = parse({
      data: JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            { type: 'web_search_result', title: 'Some page', url: 'https://not-cited.example' },
          ],
        },
      }),
    });
    expect(citations(events)).toEqual([]);
  });

  it('a text delta is still a text delta', () => {
    const parse = new AnthropicAdapter(cfg).createStreamParser();
    const events = parse({
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      }),
    });
    expect(events).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('the Responses API streams annotation.added', () => {
  const EVENT = {
    type: 'response.output_text.annotation.added',
    annotation: {
      type: 'url_citation',
      url: 'https://www.python.org/downloads/release/python-3147/',
      title: 'Python Release Python 3.14.7 | Python.org',
      start_index: 98,
      end_index: 185,
    },
    annotation_index: 0,
    item_id: 'msg_1',
  };

  it('OpenAI emits one citation per annotation', () => {
    const events = new OpenAIResponsesAdapter(cfg).parseStreamEvent({
      data: JSON.stringify(EVENT),
    });
    expect(citations(events)).toEqual([
      {
        type: 'citation',
        citation: {
          url: 'https://www.python.org/downloads/release/python-3147/',
          title: 'Python Release Python 3.14.7 | Python.org',
        },
      },
    ]);
  });

  it('xAI streams the same surface, so it gets it for free', () => {
    const events = new XAIResponsesAdapter(cfg).parseStreamEvent({
      data: JSON.stringify({ ...EVENT, annotation: { ...EVENT.annotation, title: '1' } }),
    });
    expect(citations(events)).toHaveLength(1);
  });

  it('a non-url annotation is not a citation', () => {
    const events = new OpenAIResponsesAdapter(cfg).parseStreamEvent({
      data: JSON.stringify({
        type: 'response.output_text.annotation.added',
        annotation: { type: 'file_citation', file_id: 'file-1' },
      }),
    });
    expect(citations(events)).toEqual([]);
  });
});

describe('chat completions streams delta.annotations', () => {
  it('emits each annotation, and does not put page content in `text`', () => {
    // OpenRouter's `url_citation.content` is the whole scraped page. `text` means
    // the short passage a source supports (Anthropic's `cited_text`), so mapping
    // one to the other would put kilobytes of page under a field callers render.
    const parse = new OpenAIAdapter(cfg).createStreamParser();
    const events = parse({
      data: JSON.stringify({
        choices: [
          {
            delta: {
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    url: 'https://blog.python.org/2026/08/python-3147-31315/',
                    title: 'Python 3.14.7 and 3.13.15 are now available!',
                    content: 'a very long scraped page …',
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    expect(citations(events)).toEqual([
      {
        type: 'citation',
        citation: {
          url: 'https://blog.python.org/2026/08/python-3147-31315/',
          title: 'Python 3.14.7 and 3.13.15 are now available!',
        },
      },
    ]);
  });
});

describe('google streams grounding on a late chunk', () => {
  const parse = () => new GoogleAdapter(cfg).createStreamParser();

  it('reads the populated chunk, not the empty first one', () => {
    const p = parse();
    // Recorded: chunk 1 carries `groundingMetadata: {}`, chunk 2 the real thing.
    const first = p({
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'x' }] }, groundingMetadata: {} }],
      }),
    });
    expect(citations(first)).toEqual([]);

    const second = p({
      data: JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'y' }] },
            groundingMetadata: {
              webSearchQueries: ['latest python'],
              groundingChunks: [
                { web: { uri: 'https://python.org', title: 'python.org' } },
                { web: {} },
              ],
            },
          },
        ],
      }),
    });
    expect(citations(second)).toEqual([
      { type: 'citation', citation: { url: 'https://python.org', title: 'python.org' } },
    ]);
  });

  it('re-reports a repeated chunk — the client dedupes by url', () => {
    // Google resends grounding on more than one late chunk. The parser stays
    // stateless about it; deduplication lives where the final response is built,
    // so a consumer reading raw events still sees everything that arrived.
    const p = parse();
    const chunk = {
      candidates: [
        {
          content: { parts: [{ text: 'x' }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://python.org' } }] },
        },
      ],
    };
    const a = p({ data: JSON.stringify(chunk) });
    const b = p({ data: JSON.stringify(chunk) });
    expect(citations(a)).toHaveLength(1);
    expect(citations(b)).toHaveLength(1);
  });
});
