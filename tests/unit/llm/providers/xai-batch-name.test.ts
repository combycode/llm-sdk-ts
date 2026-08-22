/** The xAI batch create call used to name itself `batch_${Date.now()}`.
 *
 *  That made it the only request in the provider surface that was not a pure
 *  function of its input: unassertable in a test, unreproducible from a log, and
 *  — the part that actually bites — a retried create produced a second batch
 *  under a different name, which nothing downstream could deduplicate.
 *
 *  These tests pin the property, not the format: same input, same request.
 */

import { describe, expect, it } from 'bun:test';
import { XAIBatchAdapter } from '../../../../src/llm/providers/xai/batch';
import type { BatchRequest } from '../../../../src/plugins/batch/types';

/** Capture the create call without performing it. */
function createBody(requests: BatchRequest[]): Record<string, unknown> {
  const adapter = new XAIBatchAdapter({ apiKey: 'k' });
  const seen: any[] = [];
  const fetch = (async (r: any) => {
    seen.push(r);
    return { status: 200, headers: {}, body: { batch_id: 'b1' } };
  }) as any;
  void adapter.submit(requests, fetch);
  return seen[0].body as Record<string, unknown>;
}

const reqs = (...ids: string[]): BatchRequest[] =>
  ids.map((customId) => ({ customId, body: { model: 'grok-4', messages: [] } }));

describe('xAI batch create is deterministic', () => {
  it('produces an identical request for identical input', () => {
    const a = createBody(reqs('a', 'b', 'c'));
    const b = createBody(reqs('a', 'b', 'c'));
    expect(a).toEqual(b);
  });

  it('carries no timestamp', () => {
    const name = createBody(reqs('a')).name as string;
    // A 13-digit epoch would match; the content-derived name must not.
    expect(name).not.toMatch(/\d{13}/);
  });

  it('distinguishes different batches', () => {
    const a = createBody(reqs('a', 'b')).name;
    const b = createBody(reqs('a', 'c')).name;
    const c = createBody(reqs('a')).name;
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('is stable across adapter instances', () => {
    expect(createBody(reqs('x', 'y')).name).toBe(createBody(reqs('x', 'y')).name);
  });
});
