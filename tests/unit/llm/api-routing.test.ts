/** Which API a model is called on.
 *
 *  `resolveApi` picked purely by PROVIDER, so every OpenAI model went to the
 *  Responses API. Six catalogued models cannot be called there at all, and the
 *  failure was invisible until one was actually used:
 *
 *      The requested model 'gpt-audio' is not supported with the Responses API.
 *
 *  The catalog had carried `preferredApi` per model the whole time, and the
 *  routing never read it.
 *
 *  On what each test below actually covers, measured by breaking the source and
 *  watching them fail — the systemic case at the bottom would NOT have caught the
 *  original bug, and saying otherwise would be the more comfortable lie. The
 *  catalog claimed `preferredApi: responses` AND listed `responses` in
 *  `supportedApis`, so router and catalog agreed with each other perfectly while
 *  both were wrong about the provider. Only the named audio case catches that.
 *  The systemic test catches the DIFFERENT failure of the two drifting apart,
 *  which is the one that arrives silently when a model is added later.
 */
import { describe, expect, it } from 'bun:test';
import { createEngine, createLLM } from '../../../src/index';
import { resolveApi } from '../../../src/llm/client-internal';
import { ModelCatalog } from '../../../src/catalog/catalog';

describe('resolveApi', () => {
  it('an explicit api beats everything', () => {
    expect(resolveApi('openai', 'completions', 'responses')).toBe('completions');
    expect(resolveApi('openai', 'responses', 'completions')).toBe('responses');
  });

  it("'auto' means 'decide for me', not a choice", () => {
    expect(resolveApi('openai', 'auto', 'completions')).toBe('completions');
  });

  it("the model's own preference beats the provider default", () => {
    // The whole bug in one line: openai defaults to responses, gpt-audio cannot
    // use it.
    expect(resolveApi('openai', undefined, 'completions')).toBe('completions');
  });

  it('falls back to the provider default for a model nothing is known about', () => {
    expect(resolveApi('openai', undefined, null)).toBe('responses');
    expect(resolveApi('anthropic', undefined, null)).toBe('messages');
    expect(resolveApi('openrouter', undefined, undefined)).toBe('completions');
  });
});

describe('a client routes to the API its model supports', () => {
  const engine = createEngine({ registerAsDefault: false, apiKeys: { openai: 'sk-test' } });
  const apiFor = (model: string) => createLLM({ engine, provider: 'openai', model }).api;

  it('sends audio models to Chat Completions', () => {
    // OpenAI's own guide: "For this audio-chat pattern, use Chat Completions with
    // an audio-capable model." The Responses API has no audio request parameter.
    for (const m of ['gpt-audio', 'gpt-audio-1.5', 'gpt-audio-mini']) {
      expect(apiFor(m)).toBe('completions');
    }
  });

  it('sends *-search models to Chat Completions', () => {
    for (const m of ['gpt-5-search', 'gpt-4o-search', 'gpt-4o-mini-search']) {
      expect(apiFor(m)).toBe('completions');
    }
  });

  it('leaves every other OpenAI model on Responses', () => {
    expect(apiFor('gpt-5.4-nano')).toBe('responses');
  });
});

describe('the catalog and the router agree, for every model', () => {
  it('never routes a model to an API it does not support', () => {
    // Systemic: this fails for ANY model whose preferred/default API is missing
    // from its own `supportedApis`, without naming one. It cannot see a catalog
    // that is internally consistent and wrong about the provider — that is what
    // the named cases above are for.
    const catalog = ModelCatalog.withProviderDefaults();
    const broken: string[] = [];
    for (const m of catalog.list()) {
      const api = resolveApi(
        m.provider as never,
        undefined,
        catalog.getPreferredApi(m.provider, m.model),
      );
      if (!m.supportedApis.includes(api)) {
        broken.push(`${m.provider}/${m.model}: routed to ${api}, supports ${m.supportedApis.join('/')}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
