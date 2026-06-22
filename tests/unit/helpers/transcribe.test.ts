/** transcribe() — openai multipart adapter + helper routing, via a fake
 *  EngineFetch (no network). */

import { describe, expect, it } from 'bun:test';
import { transcribe } from '../../../src/helpers/transcribe';
import type { EngineHandle } from '../../../src/helpers/engine';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import { OpenAITranscriptionAdapter } from '../../../src/llm/providers/openai/transcription';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../src/network/types';

function capturingFetch(body: unknown): { fetch: EngineFetch; last: () => HttpRequest } {
  let captured: HttpRequest | undefined;
  const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
    captured = req;
    return { status: 200, headers: {}, body };
  };
  return { fetch, last: () => captured as HttpRequest };
}

describe('OpenAITranscriptionAdapter', () => {
  it('POSTs multipart to /v1/audio/transcriptions and returns text', async () => {
    const { fetch, last } = capturingFetch({ text: 'hello' });
    const adapter = new OpenAITranscriptionAdapter({ apiKey: 'k' });
    const text = await adapter.transcribe(
      { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav', model: 'gpt-4o-transcribe' },
      fetch,
    );
    expect(text).toBe('hello');
    const req = last();
    expect(req.url).toContain('/v1/audio/transcriptions');
    expect(req.rawBody).toBe(true);
    expect(req.body).toBeInstanceOf(FormData);
    expect((req.body as FormData).get('model')).toBe('gpt-4o-transcribe');
  });

  it('passes a language hint when given', async () => {
    const { fetch, last } = capturingFetch({ text: 'bonjour' });
    await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: new Uint8Array([0]), mimeType: 'audio/wav', model: 'm', language: 'fr' },
      fetch,
    );
    expect((last().body as FormData).get('language')).toBe('fr');
  });
});

describe('transcribe() — provider routing', () => {
  it('routes openai to the transcription endpoint', async () => {
    const { fetch, last } = capturingFetch({ text: 'hello' });
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-4o-transcribe', { pricing: { perMinute: 0.006 } });
    const engine = { apiKeys: { openai: 'k' }, fetch, hooks, catalog } as unknown as EngineHandle;
    const res = await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine,
      audio: new Uint8Array([1, 2, 3]),
    });
    expect(res.text).toBe('hello');
    expect(last().url).toContain('/v1/audio/transcriptions');
  });
});
