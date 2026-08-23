/** The corpus for the three HOSTED retrieval backends.
 *
 *  These are provider REST surfaces like any other — vector stores, file search
 *  stores, collections — but they lived outside the wire specs because they hang
 *  off a plugin rather than off an LLM adapter. Being reached through
 *  `RetrievalBackend` instead of `buildRequest` is not a reason for the request to
 *  be built by hand.
 *
 *  Kept as plain data so the freeze script and the differential cannot disagree
 *  about what a case is — the same arrangement the other corpora use.
 */

import type {
  AddDocumentOptions,
  CreateCorpusOptions,
  DocumentSource,
  RetrievalSearchOptions,
} from '../../../src/plugins/retrieval/types';

/** Every backend is driven against the same corpus handle, so a URL that forgets
 *  to interpolate the id is visible rather than plausible. */
export const CORPUS_ID = {
  openai: 'vs_abc123',
  google: 'fileSearchStores/store-abc123',
  xai: 'col_abc123',
} as const;

/** The document id each `removeDocument` case targets. Google's is a Files API
 *  name, not a bare id — that difference is exactly what the URL must preserve. */
export const DOC_ID = {
  openai: 'file-doc123',
  google: 'files/doc123',
  xai: 'file_doc123',
} as const;

/** A long-running operation name, for the Google import poll. */
export const OPERATION_NAME = 'fileSearchStores/store-abc123/operations/op-789';

/** A page token with characters that MUST survive encoding. A raw `+` in a query
 *  string is a space, so an unencoded token pages from the wrong place — silently,
 *  because the API answers 200 with the wrong page. */
export const PAGE_TOKEN = 'tok/en+with spaces&more=1';

export type RetrievalOp =
  | 'createCorpus'
  | 'addDocument'
  | 'indexStatus'
  | 'removeDocument'
  | 'deleteCorpus'
  | 'listCorpora'
  | 'pollOperation'
  | 'search';

export interface RetrievalCase {
  name: string;
  provider: 'openai' | 'google' | 'xai';
  op: RetrievalOp;
  create?: CreateCorpusOptions;
  source?: DocumentSource;
  addOpts?: AddDocumentOptions;
  query?: string;
  searchOpts?: RetrievalSearchOptions;
  /** listCorpora only: hand back a nextPageToken once, so the SECOND page request
   *  is captured too. Nothing else exercises the token-encoding path. */
  paginate?: boolean;
}

const TEXT = 'The refund window is 30 days.';

export const RETRIEVAL_CASES: RetrievalCase[] = [
  // ── openai: vector stores ──────────────────────────────────────────────────
  { name: 'create.minimal', provider: 'openai', op: 'createCorpus', create: { name: 'docs' } },
  {
    name: 'create.chunking',
    provider: 'openai',
    op: 'createCorpus',
    create: { name: 'docs', chunking: { maxTokens: 400, overlapTokens: 100 } },
  },
  {
    // An EMPTY chunking object still asks for static chunking — at the defaults.
    // Dropping the block here would silently switch the store back to `auto`.
    name: 'create.chunkingDefaults',
    provider: 'openai',
    op: 'createCorpus',
    create: { name: 'docs', chunking: {} },
  },
  {
    name: 'create.expiry',
    provider: 'openai',
    op: 'createCorpus',
    create: { name: 'docs', expiresAfter: { anchor: 'last_active_at', days: 7 } },
  },
  { name: 'add.labelled', provider: 'openai', op: 'addDocument', source: { text: TEXT, label: 'refunds.txt' } },
  { name: 'add.unlabelled', provider: 'openai', op: 'addDocument', source: { text: TEXT } },
  {
    name: 'add.metadata',
    provider: 'openai',
    op: 'addDocument',
    source: { text: TEXT, label: 'refunds.txt' },
    addOpts: { metadata: { category: 'policy', version: 2 } },
  },
  { name: 'status', provider: 'openai', op: 'indexStatus' },
  { name: 'remove', provider: 'openai', op: 'removeDocument' },
  { name: 'delete', provider: 'openai', op: 'deleteCorpus' },
  { name: 'list', provider: 'openai', op: 'listCorpora' },

  // ── google: file search stores ─────────────────────────────────────────────
  { name: 'create.minimal', provider: 'google', op: 'createCorpus', create: { name: 'docs' } },
  {
    name: 'create.embeddingModel',
    provider: 'google',
    op: 'createCorpus',
    create: { name: 'docs', embeddingModel: 'models/text-embedding-004' },
  },
  { name: 'add.labelled', provider: 'google', op: 'addDocument', source: { text: TEXT, label: 'refunds.txt' } },
  { name: 'add.unlabelled', provider: 'google', op: 'addDocument', source: { text: TEXT } },
  {
    // Google takes metadata as a LIST of {key,value} pairs with stringified values,
    // not as an object — the one place a non-string value must be coerced.
    name: 'add.metadata',
    provider: 'google',
    op: 'addDocument',
    source: { text: TEXT, label: 'refunds.txt' },
    addOpts: { metadata: { category: 'policy', version: 2 } },
  },
  { name: 'poll', provider: 'google', op: 'pollOperation' },
  { name: 'status', provider: 'google', op: 'indexStatus' },
  { name: 'remove', provider: 'google', op: 'removeDocument' },
  { name: 'delete', provider: 'google', op: 'deleteCorpus' },
  { name: 'list', provider: 'google', op: 'listCorpora' },
  { name: 'list.paged', provider: 'google', op: 'listCorpora', paginate: true },

  // ── xai: grok collections (two hosts, two keys) ────────────────────────────
  { name: 'create', provider: 'xai', op: 'createCorpus', create: { name: 'docs' } },
  {
    name: 'add.labelled',
    provider: 'xai',
    op: 'addDocument',
    source: { text: TEXT, label: 'refunds.txt' },
    addOpts: { metadata: { category: 'policy' } },
  },
  { name: 'add.bare', provider: 'xai', op: 'addDocument', source: { text: TEXT } },
  { name: 'status', provider: 'xai', op: 'indexStatus' },
  { name: 'remove', provider: 'xai', op: 'removeDocument' },
  { name: 'delete', provider: 'xai', op: 'deleteCorpus' },
  { name: 'list', provider: 'xai', op: 'listCorpora' },
  { name: 'search.default', provider: 'xai', op: 'search', query: 'refund window' },
  {
    name: 'search.keyword',
    provider: 'xai',
    op: 'search',
    query: 'refund window',
    searchOpts: { searchMode: 'keyword' },
  },
  {
    // An unknown mode falls back to the default rather than reaching the API and
    // being rejected there.
    name: 'search.unknownMode',
    provider: 'xai',
    op: 'search',
    query: 'refund window',
    searchOpts: { searchMode: 'telepathy' as never },
  },
];

// ── the driver ───────────────────────────────────────────────────────────────
//
// The freeze script and the differential run the SAME function, so they cannot
// drift into measuring different things. (The other families kept a copy each,
// which is one more place for the two to disagree about what a case even is.)

import { HostedOpenAIRetrievalBackend } from '../../../src/plugins/retrieval/hosted-openai';
import { HostedGoogleRetrievalBackend } from '../../../src/plugins/retrieval/hosted-google';
import { HostedXaiRetrievalBackend } from '../../../src/plugins/retrieval/hosted-xai';
import type { CorpusRef } from '../../../src/plugins/retrieval/types';

export const KEYS = { apiKey: 'k', managementApiKey: 'mk' };

/** Answers each call with enough shape for the method to reach the NEXT one. */
function responseFor(c: RetrievalCase, callIndex: number): unknown {
  if (c.op === 'addDocument') {
    // First call uploads the bytes, second attaches/imports the result.
    if (callIndex === 0) return { id: DOC_ID[c.provider], file: { name: DOC_ID.google } };
    return { name: OPERATION_NAME, id: DOC_ID[c.provider] };
  }
  if (c.op === 'pollOperation') return { done: true, name: OPERATION_NAME };
  if (c.op === 'listCorpora') {
    if (c.provider === 'xai') return [];
    // One nextPageToken, once: enough to make the second page request happen and
    // then stop.
    if (c.paginate && callIndex === 0) return { fileSearchStores: [], nextPageToken: PAGE_TOKEN };
    return { data: [], fileSearchStores: [] };
  }
  if (c.op === 'search') return { matches: [] };
  return { id: 'x', name: 'x', status: 'completed', documents_count: 1 };
}

function backendFor(c: RetrievalCase, fetch: never) {
  if (c.provider === 'openai') return new HostedOpenAIRetrievalBackend({ apiKey: KEYS.apiKey, fetch });
  if (c.provider === 'google') return new HostedGoogleRetrievalBackend({ apiKey: KEYS.apiKey, fetch });
  return new HostedXaiRetrievalBackend({ ...KEYS, fetch });
}

/** Run one case against a capturing fetch and return every request it made. */
export async function driveRetrieval(c: RetrievalCase): Promise<unknown[]> {
  const seen: unknown[] = [];
  const fetch = (async (r: unknown) => {
    const body = responseFor(c, seen.length);
    seen.push(r);
    return { status: 200, headers: {}, body };
  }) as never;

  const b = backendFor(c, fetch) as unknown as Record<string, (...a: never[]) => Promise<unknown>>;
  const corpus: CorpusRef = {
    id: CORPUS_ID[c.provider],
    name: 'docs',
    backend: 'local',
  } as unknown as CorpusRef;

  try {
    switch (c.op) {
      case 'createCorpus':
        await b.createCorpus(c.create as never);
        break;
      case 'addDocument':
        await b.addDocument(corpus as never, c.source as never, c.addOpts as never);
        break;
      case 'indexStatus':
        await b.indexStatus(corpus as never);
        break;
      case 'removeDocument':
        await b.removeDocument(corpus as never, DOC_ID[c.provider] as never);
        break;
      case 'deleteCorpus':
        await b.deleteCorpus(corpus as never);
        break;
      case 'listCorpora':
        await b.listCorpora();
        break;
      case 'pollOperation':
        await b.pollOperation(OPERATION_NAME as never);
        break;
      case 'search':
        await b.search([corpus] as never, c.query as never, c.searchOpts as never);
        break;
    }
  } catch {
    /* a fake response may not parse; the requests are already captured */
  }
  return seen;
}

/** Stable ordering and a FormData that survives JSON, so a multipart upload can
 *  compare equal to itself across two runs. */
export const canon = (v: unknown): unknown => {
  if (typeof FormData !== 'undefined' && v instanceof FormData) {
    return canon({
      __formData: [...v.entries()].map(([name, x]) =>
        typeof x === 'string'
          ? { name, value: x }
          : { name, filename: (x as File).name, type: (x as File).type, size: (x as File).size },
      ),
    });
  }
  if (v instanceof Uint8Array) return { __bytes: v.length };
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) if (src[k] !== undefined) out[k] = canon(src[k]);
    return out;
  }
  return v;
};

/** The key a captured request is filed under. */
export const keyFor = (c: RetrievalCase, i: number): string =>
  `retrieval/${c.provider}/${c.op}.${c.name}${i ? `.${i}` : ''}`;
