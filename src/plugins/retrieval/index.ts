/** Retrieval plugin — ergonomic entry helpers.
 *
 *  Usage (local, browser-safe):
 *
 *    const retrieval = localRetrieval({
 *      embedAdapter: new OpenAIEmbeddingAdapter({ apiKey }),
 *      fetch: engine.fetch,
 *      embeddingModel: 'text-embedding-3-small',
 *    });
 *    const corpus = await retrieval.createCorpus({ name: 'my-docs' });
 *    await retrieval.addDocument(corpus, { text: '...', label: 'doc.txt' });
 *    const tool = retrieval.asTool([corpus]);          // AgentTool for any provider
 *    const hits = await retrieval.search([corpus], 'query');
 *
 *  Usage (hosted OpenAI vector stores):
 *
 *    const retrieval = openaiRetrieval({ apiKey, fetch: engine.fetch });
 *    const corpus = await retrieval.createCorpus({ name: 'my-store' });
 *    await retrieval.addDocument(corpus, { text: '...', label: 'doc.txt' });
 *    const toolSpec = retrieval.asTool([corpus]);      // ProviderToolSpec for Responses API
 *
 *  Usage (hosted Google Gemini File Search):
 *
 *    const retrieval = googleRetrieval({ apiKey, fetch: engine.fetch });
 *    const corpus = await retrieval.createCorpus({ name: 'my-store' });
 *    await retrieval.addDocument(corpus, { text: '...', label: 'doc.txt' });
 *    const toolSpec = retrieval.asTool([corpus]);      // ProviderToolSpec for generateContent
 *
 *  Usage (hosted xAI Grok Collections):
 *
 *    const retrieval = xaiRetrieval({ apiKey, managementApiKey, fetch: engine.fetch });
 *    const corpus = await retrieval.createCorpus({ name: 'my-collection' });
 *    await retrieval.addDocument(corpus, { text: '...', label: 'doc.txt' });
 *    const hits = await retrieval.search([corpus], 'query');  // direct search supported
 *    const toolSpec = retrieval.asTool([corpus]);             // file_search for Responses API
 */

export { LocalRetrievalBackend } from './local';
export type { LocalRetrievalConfig } from './local';
export { HostedOpenAIRetrievalBackend } from './hosted-openai';
export type { HostedOpenAIRetrievalConfig } from './hosted-openai';
export { HostedGoogleRetrievalBackend } from './hosted-google';
export type { HostedGoogleRetrievalConfig } from './hosted-google';
export { HostedXaiRetrievalBackend } from './hosted-xai';
export type { HostedXaiRetrievalConfig } from './hosted-xai';
export { InMemoryVectorStore } from './vector-store';
export type { VectorStore, VectorEntry, InMemoryVectorStoreConfig } from './vector-store';
export { chunkText, DEFAULT_CHUNK_MAX_TOKENS, DEFAULT_CHUNK_OVERLAP_TOKENS } from './chunker';
export type { ChunkOptions, TextChunk, EstimateTokensFn } from './chunker';
export type {
  RetrievalBackend,
  RetrievalBackendName,
  RetrievalCapabilities,
  RetrievalHit,
  CorpusRef,
  DocumentRef,
  DocumentSource,
  IndexStatus,
  IndexState,
  IndexCounts,
  ProviderToolSpec,
  CreateCorpusOptions,
  AddDocumentOptions,
  RetrievalSearchOptions,
  AsToolOptions,
  ChunkingOptions,
} from './types';

import { LocalRetrievalBackend } from './local';
import type { LocalRetrievalConfig } from './local';
import { HostedOpenAIRetrievalBackend } from './hosted-openai';
import type { HostedOpenAIRetrievalConfig } from './hosted-openai';
import { HostedGoogleRetrievalBackend } from './hosted-google';
import type { HostedGoogleRetrievalConfig } from './hosted-google';
import { HostedXaiRetrievalBackend } from './hosted-xai';
import type { HostedXaiRetrievalConfig } from './hosted-xai';

/** Build a local (zero-dep, cross-env) retrieval backend. */
export function localRetrieval(config: LocalRetrievalConfig): LocalRetrievalBackend {
  return new LocalRetrievalBackend(config);
}

/** Build a hosted OpenAI Vector Stores retrieval backend. */
export function openaiRetrieval(config: HostedOpenAIRetrievalConfig): HostedOpenAIRetrievalBackend {
  return new HostedOpenAIRetrievalBackend(config);
}

/** Build a hosted Google Gemini File Search retrieval backend. */
export function googleRetrieval(config: HostedGoogleRetrievalConfig): HostedGoogleRetrievalBackend {
  return new HostedGoogleRetrievalBackend(config);
}

/** Build a hosted xAI Grok Collections retrieval backend. */
export function xaiRetrieval(config: HostedXaiRetrievalConfig): HostedXaiRetrievalBackend {
  return new HostedXaiRetrievalBackend(config);
}

/** Generic factory when the backend is selected at runtime. */
export function createRetrieval(
  backend: 'local',
  config: LocalRetrievalConfig,
): LocalRetrievalBackend;
export function createRetrieval(
  backend: 'hostedOpenAI',
  config: HostedOpenAIRetrievalConfig,
): HostedOpenAIRetrievalBackend;
export function createRetrieval(
  backend: 'hostedGoogle',
  config: HostedGoogleRetrievalConfig,
): HostedGoogleRetrievalBackend;
export function createRetrieval(
  backend: 'hostedXai',
  config: HostedXaiRetrievalConfig,
): HostedXaiRetrievalBackend;
export function createRetrieval(
  backend: string,
  config: LocalRetrievalConfig | HostedOpenAIRetrievalConfig | HostedGoogleRetrievalConfig | HostedXaiRetrievalConfig,
): LocalRetrievalBackend | HostedOpenAIRetrievalBackend | HostedGoogleRetrievalBackend | HostedXaiRetrievalBackend {
  if (backend === 'local') return new LocalRetrievalBackend(config as LocalRetrievalConfig);
  if (backend === 'hostedOpenAI') return new HostedOpenAIRetrievalBackend(config as HostedOpenAIRetrievalConfig);
  if (backend === 'hostedGoogle') return new HostedGoogleRetrievalBackend(config as HostedGoogleRetrievalConfig);
  if (backend === 'hostedXai') return new HostedXaiRetrievalBackend(config as HostedXaiRetrievalConfig);
  throw new Error(`createRetrieval: unknown backend "${backend}"`);
}
