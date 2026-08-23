/** The corpus for the last four request-building surfaces outside the adapters:
 *  exact token counting, live model listing, file retrieval, and the provenance
 *  check.
 *
 *  Each is small, which is exactly why each was written by hand and then not
 *  looked at again. Freezing them surfaced the reason it matters: the token-count
 *  APIs defaulted to `globalThis.fetch`, so every exact count for Anthropic and
 *  Google went out AROUND the NetworkEngine — no queue, no rate limit, no retry,
 *  no telemetry — while every other file in the library repeats that all HTTP goes
 *  through the injected fetch. They now take an EngineFetch, and it is required.
 *
 *  The capture below normalises a `(url, init)` pair and an engine request object
 *  to the same fields, which is what let the fixture frozen BEFORE that change
 *  keep judging the code after it.
 */

import { AnthropicCountApi, GoogleCountApi } from '../../../src/plugins/context-measurer/counter/count-api';
import { listModelsLive } from '../../../src/helpers/models';
import { retrieveFile, streamFile } from '../../../src/llm/files/retrieve';
import { OpenAIProvenanceAdapter } from '../../../src/llm/providers/openai/provenance';
import type { ProviderName } from '../../../src/llm/types/provider';

export const KEY = 'k';

export type UtilityOp = 'count' | 'models' | 'retrieve' | 'stream' | 'provenance';

export interface UtilityCase {
  name: string;
  op: UtilityOp;
  provider?: ProviderName;
  model?: string;
  text?: string;
  system?: string;
  /** retrieve/stream: the file reference to fetch. */
  file?: { id?: string; url?: string; name?: string; mimeType?: string; ref?: { containerId?: string } };
}

export const UTILITY_CASES: UtilityCase[] = [
  // ── exact token counting ───────────────────────────────────────────────────
  { name: 'anthropic.text', op: 'count', provider: 'anthropic', model: 'claude-haiku-4-5', text: 'hello' },
  {
    name: 'anthropic.system',
    op: 'count',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    text: 'hello',
    system: 'be brief',
  },
  { name: 'google.bare', op: 'count', provider: 'google', model: 'gemini-3-flash', text: 'hello' },
  // A model id that ALREADY carries the `models/` prefix must not get a second one.
  { name: 'google.prefixed', op: 'count', provider: 'google', model: 'models/gemini-3-flash', text: 'hello' },

  // ── live model listing: five providers, five shapes ────────────────────────
  { name: 'openai', op: 'models', provider: 'openai' },
  { name: 'anthropic', op: 'models', provider: 'anthropic' },
  { name: 'google', op: 'models', provider: 'google' },
  { name: 'xai', op: 'models', provider: 'xai' },
  { name: 'openrouter', op: 'models', provider: 'openrouter' },

  // ── file retrieval ─────────────────────────────────────────────────────────
  // A file the provider named by ID is fetched from that provider's content
  // endpoint; one that carries an absolute URL is fetched from there instead, and
  // the auth header must NOT follow it to a third-party CDN.
  { name: 'openai.byId', op: 'retrieve', provider: 'openai', file: { id: 'file-abc', name: 'r.pdf' } },
  { name: 'anthropic.byId', op: 'retrieve', provider: 'anthropic', file: { id: 'file-abc', name: 'r.pdf' } },
  { name: 'google.byId', op: 'retrieve', provider: 'google', file: { id: 'files/abc', name: 'r.pdf' } },
  { name: 'xai.byId', op: 'retrieve', provider: 'xai', file: { id: 'file-abc', name: 'r.pdf' } },
  {
    name: 'absoluteUrl',
    op: 'retrieve',
    provider: 'openai',
    file: { url: 'https://cdn.example.com/out/r.pdf', name: 'r.pdf' },
  },
  {
    // A code-execution output file lives inside a CONTAINER — a different path,
    // not a query parameter on the same one.
    name: 'openai.container',
    op: 'retrieve',
    provider: 'openai',
    file: { id: 'file-abc', name: 'r.png', ref: { containerId: 'cntr-1' } },
  },
  { name: 'openai.stream', op: 'stream', provider: 'openai', file: { id: 'file-abc', name: 'r.pdf' } },

  // ── provenance ─────────────────────────────────────────────────────────────
  { name: 'png', op: 'provenance' },
];

/** Both fetch shapes reduced to what actually goes on the wire. */
function normalise(url: string, init: Record<string, unknown>): Record<string, unknown> {
  const body = init.body;
  return {
    url,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    ...(body === undefined || body === null
      ? {}
      : { body: typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : body }),
    ...(init.responseType ? { responseType: init.responseType } : {}),
  };
}

/** Accepts a request object OR a `(url, init)` pair and records the same shape. */
function capture(seen: unknown[]) {
  return (a: unknown, b?: unknown) => {
    if (typeof a === 'string') seen.push(normalise(a, (b ?? {}) as Record<string, unknown>));
    else {
      const r = a as Record<string, unknown>;
      seen.push(normalise(String(r.url), r));
    }
  };
}

const MODELS_BODY = { data: [{ id: 'm-1' }], models: [{ name: 'models/m-1' }] };

export async function driveUtility(c: UtilityCase): Promise<unknown[]> {
  const seen: unknown[] = [];
  const record = capture(seen);

  // Engine-shaped, for everything else.
  const engineFetch = (async (req: unknown) => {
    record(req);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body:
        c.op === 'models'
          ? MODELS_BODY
          : c.op === 'provenance'
            ? { results: [] }
            : c.op === 'count'
              ? { input_tokens: 3, totalTokens: 3 }
              : new Uint8Array([1, 2, 3]),
    };
  }) as never;

  try {
    switch (c.op) {
      case 'count': {
        if (c.provider === 'anthropic') {
          const api = new AnthropicCountApi(KEY, engineFetch);
          await api.countMessages(c.model!, [{ role: 'user', content: c.text }], c.system);
        } else {
          const api = new GoogleCountApi(KEY, engineFetch);
          await api.countText(c.model!, c.text!);
        }
        break;
      }
      case 'models':
        await listModelsLive({
          provider: c.provider!,
          apiKey: KEY,
          refresh: true,
          engine: { fetch: engineFetch, apiKeys: {}, catalog: null } as never,
        });
        break;
      case 'retrieve':
        await retrieveFile(c.file as never, { provider: c.provider!, apiKey: KEY, fetch: engineFetch });
        break;
      case 'stream':
        await streamFile(c.file as never, { provider: c.provider!, apiKey: KEY, fetch: engineFetch });
        break;
      case 'provenance':
        await new OpenAIProvenanceAdapter({ apiKey: KEY }).check(
          new Uint8Array([137, 80, 78, 71]),
          'shot.png',
          'image/png',
          engineFetch,
        );
        break;
    }
  } catch {
    /* the fake response may not parse; the requests are already captured */
  }
  return seen;
}

export const utilityKey = (c: UtilityCase, i: number): string =>
  `utility/${c.op}.${c.name}${i ? `.${i}` : ''}`;
