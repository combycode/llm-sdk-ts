/** Every surface sends the PROVIDER's id, not our slug.
 *
 *  Our canonical id is dotted (`claude-haiku-4.5`); the callable one may be dated
 *  (`claude-haiku-4-5-20251001`). `createLLM` has always translated through the
 *  catalog. Nothing else did — so batch, embed, transcribe and moderate worked
 *  only for models whose slug happens to BE their api id, and the day the sample
 *  corpus moved to our canonical id every batch request came back
 *  `not_found_error: model: claude-haiku-4.5`.
 *
 *  The other half of the contract matters too: `model` stays the SLUG for pricing
 *  and catalog lookups, which are keyed by it.
 */

import { describe, expect, it } from 'bun:test';
import { batch } from '../../../src/helpers/batch';
import { embed } from '../../../src/helpers/embed';
import { createEngine } from '../../../src/helpers/engine';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { EngineFetch } from '../../../src/network/types';

const SLUG = 'claude-haiku-4.5';
const API_ID = 'claude-haiku-4-5-20251001';

function engineWith(fetch: EngineFetch, extra?: (c: ModelCatalog) => void) {
  const catalog = new ModelCatalog();
  catalog.set('anthropic', SLUG, {
    type: 'chat',
    pricing: {},
    providerModelName: API_ID,
    aliases: [API_ID],
  } as never);
  extra?.(catalog);
  return createEngine({
    apiKeys: { anthropic: 'k', openai: 'k' },
    registerAsDefault: false,
    catalog,
    fetch: (() => {
      throw new Error('unused');
    }) as never,
  } as never) as unknown as { fetch: EngineFetch; catalog: ModelCatalog };
}

describe('the id that goes on the wire', () => {
  it('batch submits the provider id', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (req: { url: string; body?: unknown }) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      bodies.push(body);
      // Enough of a response for submit() to return an id and for polling to end.
      return {
        status: 200,
        headers: {},
        body: {
          id: 'batch_1',
          processing_status: 'ended',
          results_url: 'https://x/results',
          request_counts: {},
        },
      };
    }) as unknown as EngineFetch;

    const engine = engineWith(fetch);
    (engine as { fetch: EngineFetch }).fetch = fetch;

    await batch({
      model: `anthropic/${SLUG}`,
      apiKey: 'k',
      engine: engine as never,
      requests: [{ customId: 'a', prompt: 'hi', maxTokens: 8 }],
    }).catch(() => undefined); // the fake results payload may not parse; the request is what matters

    const submitted = JSON.stringify(bodies);
    expect(submitted).toContain(API_ID);
    expect(submitted).not.toContain(SLUG);
  });

  it('embed sends the provider id', async () => {
    let sentModel: unknown;
    const fetch = (async (req: { body?: { model?: unknown } }) => {
      sentModel = req.body?.model;
      return { status: 200, headers: {}, body: { data: [{ embedding: [0.1] }], usage: {} } };
    }) as unknown as EngineFetch;

    const catalog = new ModelCatalog();
    catalog.set('openai', 'text-embedding-3.small', {
      type: 'embedding',
      pricing: {},
      providerModelName: 'text-embedding-3-small',
    } as never);
    const engine = createEngine({
      apiKeys: { openai: 'k' },
      registerAsDefault: false,
      catalog,
    } as never) as unknown as { fetch: EngineFetch };
    engine.fetch = fetch;

    await embed({
      model: 'openai/text-embedding-3.small',
      apiKey: 'k',
      input: 'hi',
      engine: engine as never,
    });

    expect(sentModel).toBe('text-embedding-3-small');
  });
});
