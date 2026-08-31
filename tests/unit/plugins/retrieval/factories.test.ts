/** The retrieval plugin's entry points.
 *
 *  These four one-liners plus `createRetrieval` are the whole public surface of
 *  the plugin, and the runtime factory is the only place a backend name is
 *  matched against a string. An unknown name must FAIL LOUDLY: silently
 *  returning the local backend for a typo'd `'hostedOpenai'` would build an
 *  empty in-memory index and answer every search with nothing found, which
 *  looks exactly like a corpus that has not been populated yet.
 */

import { describe, expect, it } from 'bun:test';
import {
  createRetrieval,
  googleRetrieval,
  localRetrieval,
  openaiRetrieval,
  xaiRetrieval,
} from '../../../../src/plugins/retrieval/index';
import { HostedGoogleRetrievalBackend } from '../../../../src/plugins/retrieval/hosted-google';
import { HostedOpenAIRetrievalBackend } from '../../../../src/plugins/retrieval/hosted-openai';
import { HostedXaiRetrievalBackend } from '../../../../src/plugins/retrieval/hosted-xai';
import { LocalRetrievalBackend } from '../../../../src/plugins/retrieval/local';
import { InMemoryVectorStore } from '../../../../src/plugins/retrieval/vector-store';
import type { EmbeddingProviderAdapter } from '../../../../src/plugins/embeddings/types';
import type { EngineFetch } from '../../../../src/network/types';
import type { LocalRetrievalConfig } from '../../../../src/plugins/retrieval/local';

const fetch: EngineFetch = (async () => ({ status: 200, headers: {}, body: {} })) as EngineFetch;

const embedAdapter: EmbeddingProviderAdapter = {
  name: 'stub',
  async embed(req) {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      embeddings: inputs.map(() => [1, 0, 0]),
      model: req.model,
      dimensions: 3,
    };
  },
};

const localConfig: LocalRetrievalConfig = {
  embedAdapter,
  fetch,
  embeddingModel: 'stub-embed',
};

describe('named factories', () => {
  it('localRetrieval builds a LocalRetrievalBackend from the config it is given', () => {
    const store = new InMemoryVectorStore();
    const backend = localRetrieval({ ...localConfig, vectorStore: store });
    expect(backend).toBeInstanceOf(LocalRetrievalBackend);
    // Not a fresh default store: the one that was passed in.
    expect((backend as unknown as { vectorStore: unknown }).vectorStore).toBe(store);
  });

  it('openaiRetrieval builds a hosted OpenAI vector-store backend', () => {
    const backend = openaiRetrieval({ apiKey: 'sk-x', fetch });
    expect(backend).toBeInstanceOf(HostedOpenAIRetrievalBackend);
    expect(backend.capabilities.citationFormat).toBe('file_id');
  });

  it('googleRetrieval builds a hosted Gemini File Search backend', () => {
    const backend = googleRetrieval({ apiKey: 'k', fetch });
    expect(backend).toBeInstanceOf(HostedGoogleRetrievalBackend);
    expect(backend.capabilities.citationFormat).toBe('gemini');
  });

  it('xaiRetrieval builds a hosted Grok Collections backend', () => {
    const backend = xaiRetrieval({ apiKey: 'k', managementApiKey: 'm', fetch });
    expect(backend).toBeInstanceOf(HostedXaiRetrievalBackend);
    // xAI is the only hosted backend that supports searching directly.
    expect(backend.capabilities.directSearch).toBe(true);
  });

  it('each factory returns a NEW backend, never a shared singleton', () => {
    expect(openaiRetrieval({ apiKey: 'k', fetch })).not.toBe(
      openaiRetrieval({ apiKey: 'k', fetch }),
    );
    expect(localRetrieval(localConfig)).not.toBe(localRetrieval(localConfig));
  });
});

describe('createRetrieval — the runtime factory', () => {
  it('dispatches every documented backend name to its own class', () => {
    expect(createRetrieval('local', localConfig)).toBeInstanceOf(LocalRetrievalBackend);
    expect(createRetrieval('hostedOpenAI', { apiKey: 'k', fetch })).toBeInstanceOf(
      HostedOpenAIRetrievalBackend,
    );
    expect(createRetrieval('hostedGoogle', { apiKey: 'k', fetch })).toBeInstanceOf(
      HostedGoogleRetrievalBackend,
    );
    expect(
      createRetrieval('hostedXai', { apiKey: 'k', managementApiKey: 'm', fetch }),
    ).toBeInstanceOf(HostedXaiRetrievalBackend);
  });

  it('agrees with the named factory for the same name and config', () => {
    const viaName = createRetrieval('hostedGoogle', { apiKey: 'k', fetch });
    const viaFactory = googleRetrieval({ apiKey: 'k', fetch });
    expect(viaName.capabilities).toEqual(viaFactory.capabilities);
  });

  it('an unknown backend name throws, naming the value it was given', () => {
    const call = (name: string): unknown =>
      (createRetrieval as unknown as (n: string, c: unknown) => unknown)(name, localConfig);

    expect(() => call('hostedOpenai')).toThrow(
      'createRetrieval: unknown backend "hostedOpenai"',
    );
    expect(() => call('')).toThrow('createRetrieval: unknown backend ""');
    expect(() => call('LOCAL')).toThrow(/unknown backend "LOCAL"/);
  });

  it('the name match is exact — no trimming, no case folding', () => {
    const call = (name: string): unknown =>
      (createRetrieval as unknown as (n: string, c: unknown) => unknown)(name, localConfig);
    expect(() => call(' local')).toThrow(/unknown backend/);
    expect(() => call('local ')).toThrow(/unknown backend/);
  });
});
