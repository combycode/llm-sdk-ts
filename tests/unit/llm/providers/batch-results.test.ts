/** Batch `getResults` — correlating provider results back to the caller's ids.
 *
 *  Three providers, three completely different result envelopes, and one shared
 *  contract: `{ customId, success, response, error }`. This is the join key for
 *  the whole batch feature — a customId read from the wrong field comes back
 *  `undefined`, every row correlates to nothing, and the batch looks like it
 *  simply returned no answers. Each provider's field names and success rule are
 *  pinned separately here.
 *
 *    anthropic  JSONL, one object per line, `custom_id` + `result.type`
 *    google     nested metadata.output.inlinedResponses.inlinedResponses[],
 *               id under `metadata.key`
 *    xai        `results` (or `data`), id under `batch_request_id` else `custom_id`
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicBatchAdapter } from '../../../../src/llm/providers/anthropic/batch';
import { GoogleBatchAdapter } from '../../../../src/llm/providers/google/batch';
import { XAIBatchAdapter } from '../../../../src/llm/providers/xai/batch';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../../src/network/types';

function stub(body: unknown, status = 200): { fetch: EngineFetch; seen: () => HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const fetch = (async (req: HttpRequest) => {
    seen.push(req);
    return { status, headers: {}, body } as HttpResponse;
  }) as EngineFetch;
  return { fetch, seen: () => seen };
}

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

// ─── Anthropic: JSONL ───────────────────────────────────────────────────────

describe('AnthropicBatchAdapter.getResults', () => {
  const a = new AnthropicBatchAdapter({ apiKey: 'sk-ant' });

  it('parses one JSONL row per result, keeping custom_id as the join key', async () => {
    const s = stub(
      jsonl(
        { custom_id: 'req-1', result: { type: 'succeeded', message: { id: 'msg_1', content: [] } } },
        { custom_id: 'req-2', result: { type: 'errored', error: { type: 'overloaded_error' } } },
      ),
    );
    const out = await a.getResults('batch_1', s.fetch);
    expect(out).toEqual([
      { customId: 'req-1', success: true, response: { id: 'msg_1', content: [] }, error: null },
      {
        customId: 'req-2',
        success: false,
        response: null,
        error: JSON.stringify({ type: 'errored', error: { type: 'overloaded_error' } }),
      },
    ]);
    expect(s.seen()[0].responseType).toBe('text');
  });

  it('only result.type === "succeeded" counts as success — `canceled` and `expired` do not', async () => {
    const s = stub(
      jsonl(
        { custom_id: 'a', result: { type: 'canceled' } },
        { custom_id: 'b', result: { type: 'expired' } },
        { custom_id: 'c', result: { type: 'succeeded', message: { id: 'm' } } },
      ),
    );
    expect((await a.getResults('b1', s.fetch)).map((r) => r.success)).toEqual([false, false, true]);
  });

  it('a succeeded row with no message yields response null rather than undefined', async () => {
    const s = stub(jsonl({ custom_id: 'a', result: { type: 'succeeded' } }));
    expect((await a.getResults('b1', s.fetch))[0]).toEqual({
      customId: 'a',
      success: true,
      response: null,
      error: null,
    });
  });

  it('a row with no result object at all is reported as a failure, not a crash', async () => {
    const s = stub(jsonl({ custom_id: 'a' }));
    const row = (await a.getResults('b1', s.fetch))[0];
    expect(row.success).toBe(false);
    expect(row.customId).toBe('a');
  });

  it('blank lines and trailing newlines are ignored', async () => {
    const s = stub(`\n${jsonl({ custom_id: 'a', result: { type: 'succeeded', message: {} } })}\n\n  \n`);
    expect(await a.getResults('b1', s.fetch)).toHaveLength(1);
  });

  it('an empty or missing body yields an empty list', async () => {
    expect(await a.getResults('b1', stub('').fetch)).toEqual([]);
    expect(await a.getResults('b1', stub(undefined).fetch)).toEqual([]);
  });
});

// ─── Google: nested inlined responses ───────────────────────────────────────

describe('GoogleBatchAdapter.getResults', () => {
  const g = new GoogleBatchAdapter({ apiKey: 'g-key' });
  const envelope = (items: unknown[]) => ({
    metadata: { output: { inlinedResponses: { inlinedResponses: items } } },
  });

  it('reads the id from metadata.key, four levels down the envelope', async () => {
    const s = stub(
      envelope([
        { metadata: { key: 'req-1' }, response: { candidates: [{ content: { parts: [{ text: 'a' }] } }] } },
        { metadata: { key: 'req-2' }, error: { code: 429, message: 'quota' } },
      ]),
    );
    const out = await g.getResults('batches/1', s.fetch);
    expect(out[0]).toEqual({
      customId: 'req-1',
      success: true,
      response: { candidates: [{ content: { parts: [{ text: 'a' }] } }] },
      error: null,
    });
    expect(out[1]).toEqual({
      customId: 'req-2',
      success: false,
      response: null,
      error: JSON.stringify({ code: 429, message: 'quota' }),
    });
  });

  it('a row with NO metadata key falls back to its positional index', async () => {
    const s = stub(envelope([{ response: { a: 1 } }, { response: { b: 2 } }]));
    expect((await g.getResults('b', s.fetch)).map((r) => r.customId)).toEqual(['req_0', 'req_1']);
  });

  it('a row carrying BOTH a response and an error is not a success', async () => {
    const s = stub(envelope([{ metadata: { key: 'k' }, response: { a: 1 }, error: { code: 500 } }]));
    const row = (await g.getResults('b', s.fetch))[0];
    expect(row.success).toBe(false);
    expect(row.response).toEqual({ a: 1 });
    expect(row.error).toBe(JSON.stringify({ code: 500 }));
  });

  it('an envelope missing any level of the nesting yields [] rather than throwing', async () => {
    expect(await g.getResults('b', stub({}).fetch)).toEqual([]);
    expect(await g.getResults('b', stub({ metadata: {} }).fetch)).toEqual([]);
    expect(await g.getResults('b', stub({ metadata: { output: {} } }).fetch)).toEqual([]);
    expect(await g.getResults('b', stub({ metadata: { output: { inlinedResponses: {} } } }).fetch)).toEqual([]);
    expect(await g.getResults('b', stub(null).fetch)).toEqual([]);
  });

  it('an error status yields [] and never a partial list', async () => {
    expect(await g.getResults('b', stub(envelope([{ response: {} }]), 403).fetch)).toEqual([]);
  });
});

// ─── xAI ────────────────────────────────────────────────────────────────────

describe('XAIBatchAdapter.getResults', () => {
  const x = new XAIBatchAdapter({ apiKey: 'xai-k' });

  it('prefers batch_request_id, falling back to custom_id then to the empty string', async () => {
    const s = stub({
      results: [
        { batch_request_id: 'brid-1', custom_id: 'ignored', status: 'succeeded', response: { id: 'r' } },
        { custom_id: 'cid-2', status: 'succeeded', response: { id: 'r2' } },
        { status: 'failed', error_message: 'nope' },
      ],
    });
    expect((await x.getResults('b', s.fetch)).map((r) => r.customId)).toEqual(['brid-1', 'cid-2', '']);
  });

  it('success is status "succeeded" OR the mere presence of a response', async () => {
    const s = stub({
      results: [
        { custom_id: 'a', status: 'succeeded' },
        { custom_id: 'b', status: 'in_progress', response: { id: 'r' } },
        { custom_id: 'c', status: 'failed' },
      ],
    });
    expect((await x.getResults('b', s.fetch)).map((r) => r.success)).toEqual([true, true, false]);
  });

  it('error_message wins over a structured error object', async () => {
    const s = stub({
      results: [
        { custom_id: 'a', status: 'failed', error_message: 'rate limited', error: { code: 429 } },
        { custom_id: 'b', status: 'failed', error: { code: 500 } },
        { custom_id: 'c', status: 'failed' },
      ],
    });
    expect((await x.getResults('b', s.fetch)).map((r) => r.error)).toEqual([
      'rate limited',
      JSON.stringify({ code: 500 }),
      null,
    ]);
  });

  it('accepts the `data` envelope as well as `results`', async () => {
    const s = stub({ data: [{ custom_id: 'a', status: 'succeeded', response: { id: 'r' } }] });
    expect((await x.getResults('b', s.fetch)).map((r) => r.customId)).toEqual(['a']);
  });

  it('an absent list, a null body, or an error status all yield []', async () => {
    expect(await x.getResults('b', stub({}).fetch)).toEqual([]);
    expect(await x.getResults('b', stub(null).fetch)).toEqual([]);
    expect(await x.getResults('b', stub({ results: [{ custom_id: 'a' }] }, 500).fetch)).toEqual([]);
  });
});
