/** batchJob() resume + cancel() — the manual half of the batch helper.
 *  (submitBatch/batch/wait live in batch.test.ts.)
 *
 *  Behaviour pinned here:
 *   - batchJob() reconstructs a working handle from nothing but {id, provider}
 *     plus a key. It performs NO HTTP of its own: rebuilding a handle after a
 *     process restart must not cost a provider round-trip.
 *   - The rebuilt handle talks to the right batch id: status(), results() and
 *     cancel() all address the id that was passed in.
 *   - A resumed handle has no submitted model, so it must still parse results
 *     — the model is only needed for pricing, not for reading the output file.
 *   - The key resolves from the ref first, then engine.apiKeys[provider]; a
 *     missing key throws SYNCHRONOUSLY (batchJob is not async) with a message
 *     naming the function and the provider and telling the caller both ways to
 *     supply one.
 *   - cancel() issues the provider's cancel call for that id and resolves
 *     without a value.
 *
 *  No network: engine.fetch is a fake OpenAI batch endpoint. */

import { describe, expect, it } from 'bun:test';
import { batchJob, submitBatch } from '../../../src/helpers/batch';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import type { EngineFetch, HttpResponse } from '../../../src/network/types';

const OUTPUT_JSONL =
  `${JSON.stringify({ custom_id: 'a', response: { status_code: 200, body: { output_text: 'Apple' } } })}\n` +
  `${JSON.stringify({ custom_id: 'b', response: { status_code: 200, body: { output_text: 'Banana' } } })}`;

interface FakeEngine extends EngineHandle {
  calls: Array<{ method: string; url: string }>;
}

function fakeEngine(
  opts: { status?: 'completed' | 'in_progress'; apiKeys?: Record<string, string> } = {},
): FakeEngine {
  const batchStatus = opts.status ?? 'completed';
  const calls: Array<{ method: string; url: string }> = [];
  const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
    const method = req.method ?? 'POST';
    calls.push({ method, url: req.url });
    if (req.url.endsWith('/v1/files') && method === 'POST') {
      return { status: 200, headers: {}, body: { id: 'file_in_1' } };
    }
    if (req.url.endsWith('/v1/batches') && method === 'POST') {
      return { status: 200, headers: {}, body: { id: 'batch_new' } };
    }
    if (req.url.endsWith('/cancel') && method === 'POST') {
      return { status: 200, headers: {}, body: { id: 'batch_resumed', status: 'cancelling' } };
    }
    if (req.url.includes('/v1/batches/') && method === 'GET') {
      return {
        status: 200,
        headers: {},
        body: {
          id: 'batch_resumed',
          status: batchStatus,
          request_counts: { total: 2, completed: batchStatus === 'completed' ? 2 : 0, failed: 0 },
          output_file_id: batchStatus === 'completed' ? 'file_out_1' : undefined,
        },
      };
    }
    if (req.url.includes('/v1/files/file_out_1/content') && method === 'GET') {
      return { status: 200, headers: {}, body: OUTPUT_JSONL };
    }
    throw new Error(`unexpected fetch: ${method} ${req.url}`);
  };
  const catalog = new ModelCatalog();
  catalog.set('openai', 'gpt-5-nano', { pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 } });
  return {
    apiKeys: opts.apiKeys ?? { openai: 'k' },
    fetch,
    hooks: new HookBus(),
    catalog,
    calls,
  } as unknown as FakeEngine;
}

// ─── Resume ───────────────────────────────────────────────────────────────────

describe('batchJob() — resume from a persisted id', () => {
  it('rebuilds a handle carrying the id and provider it was given', () => {
    const job = batchJob({ id: 'batch_resumed', provider: 'openai', engine: fakeEngine() });
    expect(job.id).toBe('batch_resumed');
    expect(job.provider).toBe('openai');
  });

  it('performs no HTTP while rebuilding the handle', () => {
    const engine = fakeEngine();
    batchJob({ id: 'batch_resumed', provider: 'openai', engine });
    expect(engine.calls).toHaveLength(0);
  });

  it('status() queries the provider for exactly that batch id', async () => {
    const engine = fakeEngine({ status: 'in_progress' });
    const job = batchJob({ id: 'batch_resumed', provider: 'openai', engine });
    const status = await job.status();
    expect(status.status).toBe('processing');
    expect(status.total).toBe(2);
    expect(engine.calls[0]).toMatchObject({ method: 'GET' });
    expect(engine.calls[0].url).toContain('/v1/batches/batch_resumed');
  });

  it('results() parses the output file even though the resumed handle has no model', async () => {
    const job = batchJob({ id: 'batch_resumed', provider: 'openai', engine: fakeEngine() });
    const results = await job.results();
    const byId = new Map(results.map((r) => [r.customId, r]));
    expect(byId.get('a')?.text).toBe('Apple');
    expect(byId.get('b')?.text).toBe('Banana');
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('results() refuses while the batch is still running', async () => {
    const job = batchJob({ id: 'batch_resumed', provider: 'openai', engine: fakeEngine({ status: 'in_progress' }) });
    await expect(job.results()).rejects.toThrow(/batch batch_resumed not complete \(status: processing\)/);
  });

  it('takes the key from the ref when one is passed', () => {
    const engine = fakeEngine({ apiKeys: {} });
    expect(() => batchJob({ id: 'b', provider: 'openai', apiKey: 'direct-key', engine })).not.toThrow();
  });

  it('falls back to engine.apiKeys for the provider', () => {
    expect(() => batchJob({ id: 'b', provider: 'openai', engine: fakeEngine() })).not.toThrow();
  });

  it('throws synchronously when no key can be found, naming batchJob and the provider', () => {
    const engine = fakeEngine({ apiKeys: {} });
    expect(() => batchJob({ id: 'b', provider: 'anthropic', engine })).toThrow(
      /batchJob: no API key for provider "anthropic"\. Pass apiKey or set engine\.apiKeys\["anthropic"\]\./,
    );
  });
});

// ─── cancel ───────────────────────────────────────────────────────────────────

describe('BatchJob.cancel()', () => {
  it('POSTs the provider cancel endpoint for that batch id', async () => {
    const engine = fakeEngine();
    const job = batchJob({ id: 'batch_resumed', provider: 'openai', engine });
    await expect(job.cancel()).resolves.toBeUndefined();
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].method).toBe('POST');
    expect(engine.calls[0].url).toBe('https://api.openai.com/v1/batches/batch_resumed/cancel');
  });

  it('cancels the id of a freshly submitted job too', async () => {
    const engine = fakeEngine();
    const job = await submitBatch({
      model: 'openai/gpt-5-nano',
      engine,
      requests: [{ customId: 'a', prompt: 'hi' }],
    });
    engine.calls.length = 0;
    await job.cancel();
    expect(engine.calls[0].url).toContain('/v1/batches/batch_new/cancel');
  });
});
