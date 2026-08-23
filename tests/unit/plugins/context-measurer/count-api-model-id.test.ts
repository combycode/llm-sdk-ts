/** The count endpoint is sent the PROVIDER's id, not our slug.
 *
 *  Our canonical id is dotted (`claude-haiku-4.5`); the callable one may be dated
 *  (`claude-haiku-4-5-20251001`). The chat path translates through the catalog.
 *  The count path did not, so the first model whose slug differed from its api id
 *  answered 404 — and nothing noticed, because no catalogued model selected the
 *  count strategy at all until the tokenizer data arrived.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicCountApi, CountApiCounter } from '../../../../src/plugins/context-measurer/counter/count-api';
import { ModelCatalog } from '../../../../src/catalog/catalog';
import type { EngineFetch } from '../../../../src/network/types';

function catalogWithDatedId(): ModelCatalog {
  const c = new ModelCatalog();
  c.set('anthropic', 'claude-haiku-4.5', {
    type: 'chat',
    pricing: {},
    providerModelName: 'claude-haiku-4-5-20251001',
    tokenizer: { strategy: 'count_api', charsPerTokenDefault: 3.5, countApiAvailable: true },
  } as never);
  return c;
}

describe('count API model id', () => {
  it('sends providerModelName when the slug differs from it', async () => {
    let sent: string | undefined;
    const fetch = (async (req: { body?: { model?: string } }) => {
      sent = req.body?.model;
      return { status: 200, headers: {}, body: { input_tokens: 19 } };
    }) as unknown as EngineFetch;

    const catalog = catalogWithDatedId();
    const counter = new CountApiCounter(catalog, { anthropic: new AnthropicCountApi('k', fetch) });

    const n = await counter.measure('hi', { provider: 'anthropic', model: 'claude-haiku-4.5' } as never);

    expect(sent).toBe('claude-haiku-4-5-20251001');
    expect(n).toBe(19);
  });

  it('passes an already-callable id through untouched', async () => {
    let sent: string | undefined;
    const fetch = (async (req: { body?: { model?: string } }) => {
      sent = req.body?.model;
      return { status: 200, headers: {}, body: { input_tokens: 19 } };
    }) as unknown as EngineFetch;

    const counter = new CountApiCounter(catalogWithDatedId(), {
      anthropic: new AnthropicCountApi('k', fetch),
    });
    await counter.measure('hi', {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    } as never);

    expect(sent).toBe('claude-haiku-4-5-20251001');
  });
});
