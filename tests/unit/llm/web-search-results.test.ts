/** A search that found images, and a response that did not contain them.
 *
 *  Two halves that only work together.
 *
 *  **Asking.** `web_search_call.results` is NOT returned by default. Setting
 *  `search_content_types: ['image']` alone gets a search that found images and
 *  a response with nothing in it — the results arrive only when the request
 *  also carries `include: ['web_search_call.results']`. The adapter derives
 *  that from the tool rather than exposing it as a second knob, because a
 *  caller who asked for images has already said what they want, and the two
 *  halves arriving separately is exactly how you get an empty result set that
 *  looks like "no images found".
 *
 *  **Reading.** `builtinCallFromResponsesItem` read `action.queries/query/url`
 *  and nothing else, so both the results and the `action.sources[]` behind an
 *  answer were parsed off the wire and thrown away.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { builtinCallFromResponsesItem } from '../../../src/llm/providers/openai/responses';

const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });

/** The JSON body the adapter would POST, for a given tool list. */
function body(tools: unknown[]) {
  return adapter.buildRequest({
    model: 'gpt-5.4-nano',
    messages: [{ role: 'user', content: 'find pictures of the bridge' }],
    tools,
  } as never).body as Record<string, unknown>;
}

describe('asking for image results', () => {
  it('adds the include that makes them arrive', () => {
    const b = body([{ type: 'web_search', params: { search_content_types: ['image', 'text'] } }]);
    expect(b.include).toEqual(['web_search_call.results']);
  });

  it('does not add it for a text-only search', () => {
    // The include is not free — it is extra payload on every response. Asked
    // for only when something needs it.
    expect(body([{ type: 'web_search', params: { search_content_types: ['text'] } }])).not.toHaveProperty(
      'include',
    );
    expect(body([{ type: 'web_search' }])).not.toHaveProperty('include');
    expect(body([{ type: 'code_interpreter' }])).not.toHaveProperty('include');
  });

  it('does not add it when there are no tools at all', () => {
    expect(body([])).not.toHaveProperty('include');
  });

  it('is not confused by a function tool named like a builtin', () => {
    // A function tool has no `type`, and reading `params` off one would be a
    // different object entirely.
    const fn = { name: 'web_search', description: 'mine', parameters: { type: 'object' } };
    expect(body([fn])).not.toHaveProperty('include');
  });

  it('still forwards the params themselves verbatim', () => {
    const b = body([
      {
        type: 'web_search',
        params: {
          search_content_types: ['image'],
          image_settings: { max_results: 3, caption: true },
          external_web_access: false,
        },
      },
    ]);
    const tool = (b.tools as Array<Record<string, unknown>>)[0];
    expect(tool?.type).toBe('web_search');
    expect(tool?.search_content_types).toEqual(['image']);
    expect(tool?.image_settings).toEqual({ max_results: 3, caption: true });
    // `false` has to survive: cache-only is the whole point of the flag.
    expect(tool?.external_web_access).toBe(false);
  });
});

describe('reading what came back', () => {
  it('keeps the image results, renaming the documented fields', () => {
    const call = builtinCallFromResponsesItem({
      type: 'web_search_call',
      id: 'ws_1',
      action: { type: 'search', queries: ['golden gate at sunset'] },
      results: [
        {
          image_url: 'https://img.test/a.jpg',
          source_website_url: 'https://news.test/story',
          thumbnail_url: 'https://img.test/a-thumb.jpg',
          caption: 'The bridge at dusk',
        },
      ],
    });
    expect(call?.results).toEqual([
      {
        imageUrl: 'https://img.test/a.jpg',
        sourceWebsiteUrl: 'https://news.test/story',
        thumbnailUrl: 'https://img.test/a-thumb.jpg',
        caption: 'The bridge at dusk',
      },
    ]);
    expect(call?.query).toBe('golden gate at sunset');
  });

  it('carries through a field we have never seen', () => {
    // This array exists because the payload is richer than our type. Dropping
    // the unrecognised half would defeat the point.
    const call = builtinCallFromResponsesItem({
      type: 'web_search_call',
      action: { type: 'search' },
      results: [{ image_url: 'https://img.test/a.jpg', published_at: '2026-09-30', rank: 2 }],
    });
    expect(call?.results?.[0]).toEqual({
      imageUrl: 'https://img.test/a.jpg',
      published_at: '2026-09-30',
      rank: 2,
    });
  });

  it('keeps the sources behind an answer', () => {
    const call = builtinCallFromResponsesItem({
      type: 'web_search_call',
      action: {
        type: 'search',
        queries: ['q'],
        sources: [{ type: 'url', url: 'https://a.test/1' }, { type: 'url', url: 'https://b.test/2' }],
      },
    });
    expect(call?.sources).toEqual(['https://a.test/1', 'https://b.test/2']);
  });

  it('is absent, not empty, when the provider sent none', () => {
    // `results: []` and "this response carried no results" are different
    // answers, and only one of them means the search came back empty.
    const call = builtinCallFromResponsesItem({
      type: 'web_search_call',
      action: { type: 'search', queries: ['q'] },
    });
    expect(call).not.toHaveProperty('results');
    expect(call).not.toHaveProperty('sources');

    const empty = builtinCallFromResponsesItem({
      type: 'web_search_call',
      action: { type: 'search', sources: [] },
      results: [],
    });
    expect(empty).not.toHaveProperty('results');
    expect(empty).not.toHaveProperty('sources');
  });

  it('ignores junk rather than throwing on it', () => {
    const call = builtinCallFromResponsesItem({
      type: 'web_search_call',
      action: { type: 'search', sources: ['not-an-object', { url: 42 }] },
      results: 'nope',
    });
    expect(call).not.toHaveProperty('results');
    expect(call).not.toHaveProperty('sources');
  });

  it('leaves the existing open_page payload alone', () => {
    const call = builtinCallFromResponsesItem({
      type: 'web_search_call',
      action: { type: 'open_page', url: 'https://a.test/page' },
    });
    expect(call?.url).toBe('https://a.test/page');
    expect(call).not.toHaveProperty('results');
  });
});
