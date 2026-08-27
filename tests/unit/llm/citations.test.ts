/** `response.citations` — the sources an answer cited, unified across providers.
 *
 *  This existed only as a regex over `response.raw` in an example, i.e. every
 *  consumer reimplementing provider knowledge that belongs here.
 *
 *  Two things are pinned. First the four wire shapes, which agree on nothing:
 *  Anthropic hangs citations off the text block WITH the passage they support,
 *  Google puts them in `groundingMetadata` on the candidate, OpenAI Responses
 *  annotates the output text, and xAI lists bare URLs at the top level. Second —
 *  and this is the one that would rot silently — that EVERY adapter is wired to
 *  the extractor. Adding a field to four of five parsers leaves the fifth
 *  reporting "no citations", which is indistinguishable from a model that never
 *  searched.
 *
 *  The bodies here are the shapes measured live in the Python port's verification
 *  run (all four providers answered "latest stable Python version" with real,
 *  cited URLs), reduced to the fields the extractor reads.
 */
import { describe, expect, it } from 'bun:test';

import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../../../src/llm/providers/google/interactions';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { OpenRouterAdapter } from '../../../src/llm/providers/openrouter/completions';
import { XAIAdapter } from '../../../src/llm/providers/xai/completions';
import { extractCitations } from '../../../src/llm/providers/_shared/citations';
import type { ProviderAdapter } from '../../../src/llm/types/provider';

const cfg = { apiKey: 'k' };

describe('extractCitations', () => {
  it('reads Anthropic text-block citations, with the cited passage', () => {
    expect(
      extractCitations('messages', {
        content: [
          {
            type: 'text',
            text: '3.14.7',
            citations: [
              {
                type: 'web_search_result_location',
                url: 'https://python.org/downloads/',
                title: 'Downloads',
                cited_text: 'Python 3.14.7',
              },
            ],
          },
        ],
      }),
    ).toEqual([
      { url: 'https://python.org/downloads/', title: 'Downloads', text: 'Python 3.14.7' },
    ]);
  });

  it('reads Google grounding chunks and skips ones with no uri', () => {
    expect(
      extractCitations('generate', {
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://python.org', title: 'python.org' } },
                { web: {} },
                {},
              ],
            },
          },
        ],
      }),
    ).toEqual([{ url: 'https://python.org', title: 'python.org' }]);
  });

  it('reads Responses annotations and ignores non-url ones', () => {
    // `file_citation` annotations carry no URL. Emitting them URL-less would put
    // an unusable entry in a list callers render as links.
    expect(
      extractCitations('responses', {
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: '3.14.7',
                annotations: [
                  { type: 'url_citation', url: 'https://python.org', title: 'Downloads' },
                  { type: 'file_citation', file_id: 'file-1' },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([{ url: 'https://python.org', title: 'Downloads' }]);
  });

  it('reads BOTH chat-completions shapes', () => {
    // OpenAI nests under `url_citation`; xAI lists bare URLs at the top level.
    // Handling one and not the other reports zero for that provider, which reads
    // exactly like a model that did not search.
    expect(
      extractCitations('completions', {
        choices: [
          {
            message: {
              content: '3.14.7',
              annotations: [
                { type: 'url_citation', url_citation: { url: 'https://a.example', title: 'A' } },
              ],
            },
          },
        ],
        citations: ['https://b.example'],
      }),
    ).toEqual([{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example' }]);
  });

  it('returns [] for a response with nothing cited, and for junk', () => {
    expect(extractCitations('messages', { content: [{ type: 'text', text: 'hi' }] })).toEqual([]);
    expect(extractCitations('completions', { choices: [{ message: { content: 'hi' } }] })).toEqual(
      [],
    );
    // An unknown surface is still a valid answer; it just has no reader.
    expect(extractCitations('nonesuch', { content: [] })).toEqual([]);
    expect(extractCitations('messages', null)).toEqual([]);
    expect(extractCitations('messages', 'not an object')).toEqual([]);
  });
});

/** One citation-bearing body per adapter, in that adapter's own wire shape. */
const WIRED: Array<{ name: string; adapter: ProviderAdapter; raw: unknown; url: string }> = [
  {
    name: 'anthropic/messages',
    adapter: new AnthropicAdapter(cfg),
    url: 'https://a.example',
    raw: {
      id: 'msg_1',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'x', citations: [{ url: 'https://a.example' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  {
    name: 'google/generate',
    adapter: new GoogleAdapter(cfg),
    url: 'https://g.example',
    raw: {
      candidates: [
        {
          content: { parts: [{ text: 'x' }] },
          finishReason: 'STOP',
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://g.example' } }] },
        },
      ],
    },
  },
  {
    name: 'openai/responses',
    adapter: new OpenAIResponsesAdapter(cfg),
    url: 'https://o.example',
    raw: {
      id: 'resp_1',
      model: 'gpt-4.1-mini',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'x',
              annotations: [{ type: 'url_citation', url: 'https://o.example' }],
            },
          ],
        },
      ],
    },
  },
  {
    name: 'openai/completions',
    adapter: new OpenAIAdapter(cfg),
    url: 'https://c.example',
    raw: {
      id: 'c1',
      model: 'gpt-4.1-mini',
      choices: [
        {
          message: {
            content: 'x',
            annotations: [{ type: 'url_citation', url_citation: { url: 'https://c.example' } }],
          },
          finish_reason: 'stop',
        },
      ],
    },
  },
  {
    // Inherits the completions parser. Included because inheritance is exactly
    // what makes it easy to believe a subclass is covered when it is not.
    name: 'xai/completions',
    adapter: new XAIAdapter(cfg),
    url: 'https://x.example',
    raw: {
      id: 'x1',
      model: 'grok-4-fast',
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      citations: ['https://x.example'],
    },
  },
  {
    name: 'openrouter/completions',
    adapter: new OpenRouterAdapter(cfg),
    url: 'https://r.example',
    raw: {
      id: 'r1',
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      citations: ['https://r.example'],
    },
  },
];

describe('every adapter is wired to it', () => {
  for (const { name, adapter, raw, url } of WIRED) {
    it(`${name} surfaces citations on the parsed response`, () => {
      const parsed = adapter.parseResponse(raw, 1);
      expect(parsed.citations).toEqual([{ url }]);
    });
  }

  it('google/interactions parses, and reports no citations -- an UNMAPPED surface', () => {
    // Recorded body shape: Interactions returns `steps[]`, never `candidates[]`.
    // No recorded Interactions response carries grounding, so there is nothing to
    // write a reader against, and `fromGoogle` would read a key that is never
    // there. This test exists so the gap is a recorded decision rather than an
    // absence nobody notices -- when the shape is measured, it fails here first.
    const parsed = new GoogleInteractionsAdapter(cfg).parseResponse(
      {
        id: 'v1_x',
        status: 'completed',
        model: 'models/gemini-3.1-flash-lite',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }] }],
        usage: { total_input_tokens: 1, total_output_tokens: 1 },
      },
      1,
    );
    expect(parsed.text).toBe('x');
    expect(parsed.citations).toBeUndefined();
  });

  it('is absent, not empty, when nothing was cited (R3: optional field)', () => {
    // Matches the `files` / `builtinToolCalls` convention it sits beside. The
    // Python port exposes an always-present array; TypeScript cannot, because
    // R3 forbids adding a required field to a response type.
    const parsed = new AnthropicAdapter(cfg).parseResponse(
      {
        id: 'msg_1',
        model: 'm',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      1,
    );
    expect(parsed.citations).toBeUndefined();
    expect(parsed.citations ?? []).toEqual([]);
  });
});
