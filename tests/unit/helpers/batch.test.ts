/** batch() helper — orchestration (submit → poll → collect → parse) and the
 *  dual-mode handle, via a fake EngineHandle whose fetch simulates the OpenAI
 *  batch lifecycle. No network. */

import { describe, expect, it } from 'bun:test';
import { batch, submitBatch } from '../../../src/helpers/batch';
import type { EngineHandle } from '../../../src/helpers/engine';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import type { EngineFetch, HttpResponse } from '../../../src/network/types';

const OUTPUT_JSONL =
  `${JSON.stringify({ custom_id: 'a', response: { status_code: 200, body: { output_text: 'Apple' } } })}\n` +
  `${JSON.stringify({ custom_id: 'b', response: { status_code: 200, body: { output_text: 'Banana' } } })}`;

/** Fake EngineFetch routing the OpenAI batch endpoints. `batchStatus` controls
 *  what GET /v1/batches/:id reports. */
function fakeEngine(batchStatus: 'completed' | 'in_progress'): EngineHandle {
  const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
    const url = req.url;
    const method = req.method ?? 'POST';
    if (url.endsWith('/v1/files') && method === 'POST') {
      return { status: 200, headers: {}, body: { id: 'file_in_1' } };
    }
    if (url.endsWith('/v1/batches') && method === 'POST') {
      return { status: 200, headers: {}, body: { id: 'batch_1' } };
    }
    if (url.includes('/v1/batches/batch_1') && method === 'GET') {
      return {
        status: 200,
        headers: {},
        body: {
          id: 'batch_1',
          status: batchStatus,
          request_counts: { total: 2, completed: batchStatus === 'completed' ? 2 : 0, failed: 0 },
          output_file_id: batchStatus === 'completed' ? 'file_out_1' : undefined,
        },
      };
    }
    if (url.includes('/v1/files/file_out_1/content') && method === 'GET') {
      return { status: 200, headers: {}, body: OUTPUT_JSONL };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  const hooks = new HookBus();
  const catalog = new ModelCatalog();
  catalog.set('openai', 'gpt-5-nano', { pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 } });
  return { apiKeys: { openai: 'k' }, fetch, hooks, catalog } as unknown as EngineHandle;
}

describe('batch() — auto mode', () => {
  it('submits, polls to completion, and returns parsed results keyed by customId', async () => {
    const results = await batch({
      model: 'openai/gpt-5-nano',
      engine: fakeEngine('completed'),
      pollIntervalMs: 1,
      requests: [
        { customId: 'a', prompt: 'Say apple.' },
        { customId: 'b', prompt: 'Say banana.' },
      ],
    });
    expect(results).toHaveLength(2);
    const byId = new Map(results.map((r) => [r.customId, r]));
    expect(byId.get('a')?.text).toBe('Apple');
    expect(byId.get('b')?.text).toBe('Banana');
    expect(results.every((r) => r.success)).toBe(true);
    expect(byId.get('a')?.response?.text).toBe('Apple');
  });

  it('reports progress via onProgress', async () => {
    const seen: string[] = [];
    await batch({
      model: 'openai/gpt-5-nano',
      engine: fakeEngine('completed'),
      pollIntervalMs: 1,
      onProgress: (s) => seen.push(s.status),
      requests: [{ prompt: 'hi' }],
    });
    expect(seen).toContain('completed');
  });
});

describe('submitBatch() — manual mode handle', () => {
  it('returns a handle with the provider batch id', async () => {
    const job = await submitBatch({
      model: 'openai/gpt-5-nano',
      engine: fakeEngine('in_progress'),
      requests: [{ customId: 'a', prompt: 'x' }],
    });
    expect(job.id).toBe('batch_1');
    expect(job.provider).toBe('openai');
  });

  it('status() reflects provider progress', async () => {
    const job = await submitBatch({
      model: 'openai/gpt-5-nano',
      engine: fakeEngine('in_progress'),
      requests: [{ prompt: 'x' }],
    });
    expect((await job.status()).status).toBe('processing');
  });

  it('results() throws while the batch is not terminal', async () => {
    const job = await submitBatch({
      model: 'openai/gpt-5-nano',
      engine: fakeEngine('in_progress'),
      requests: [{ prompt: 'x' }],
    });
    await expect(job.results()).rejects.toThrow(/not complete/);
  });

  it('defaults missing customId to req-<index>', async () => {
    const job = await submitBatch({
      model: 'openai/gpt-5-nano',
      engine: fakeEngine('completed'),
      requests: [{ prompt: 'apple' }, { prompt: 'banana' }],
    });
    const results = await job.results();
    expect(results.map((r) => r.customId).sort()).toEqual(['a', 'b'].map((_, i) => `req-${i}`));
  });
});
