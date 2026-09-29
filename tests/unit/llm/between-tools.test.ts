/** `thinking: { mode: 'between_tools' }` — Anthropic's reason-between-tool-calls
 *  mode, and the model gate it needs.
 *
 *  Measured 2026-09-29 against EVERY active Anthropic chat model: exactly one
 *  accepts it — `claude-sonnet-5.5` — and the other twelve answer
 *  `400 "thinking.type.between_tools" is not supported for this model`,
 *  `claude-opus-5.5` among them. A deliberately invalid thinking type is refused
 *  everywhere, so the field is READ rather than tolerated, and a 200 means the
 *  model genuinely takes it.
 *
 *  That distribution is why the gate runs the opposite way round to
 *  `reasoning.canDisable`: almost every model can disable reasoning, so only an
 *  explicit `false` stops that one. Almost none takes `between_tools`, so this
 *  one is sent only on an explicit `true` — one annotation instead of twelve,
 *  and no caller ever buys a surprise 400.
 */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { HookBus } from '../../../src/bus/hook-bus';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { LLMClient } from '../../../src/llm/client';
import type { HttpRequest, HttpResponse } from '../../../src/network/types';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const catalog = ModelCatalog.withProviderDefaults();

describe('the catalog records who takes it', () => {
  it('marks the one model that does', () => {
    expect(catalog.get('anthropic', 'claude-sonnet-5.5')?.reasoning?.betweenTools).toBe(true);
  });

  it.each(['claude-opus-5.5', 'claude-sonnet-5', 'claude-sonnet-4.6', 'claude-haiku-4.5'])(
    'leaves %s unmarked, which is what stops the request',
    (model) => {
      expect(catalog.get('anthropic', model)?.reasoning?.betweenTools).toBeUndefined();
    },
  );

  it('does not let the one model donate it to its family', () => {
    // `claude-sonnet` is ONE family spanning 4.5, 4.6, 5 and 5.5, and family
    // annotations are inherited. Three of those four were measured refusing it,
    // so donating a measured YES would look exactly like a measured fact.
    const family = catalog
      .list()
      .filter((m) => m.provider === 'anthropic' && m.family === 'claude-sonnet');
    const marked = family.filter((m) => m.reasoning?.betweenTools === true).map((m) => m.model);
    expect(marked).toEqual(['claude-sonnet-5.5']);
  });
});

describe('what reaches the wire', () => {
  const adapter = new AnthropicAdapter({ apiKey: 'k' });
  const bodyOf = (model: string, thinking: unknown) =>
    (
      adapter.buildRequest({
        model,
        wireSpec: catalog.get('anthropic', model)?.wireSpec,
        messages: [{ role: 'user', content: 'hi' }],
        thinking,
      } as unknown as NormalizedRequest) as { body: Record<string, unknown> }
    ).body;

  it('sends the mode as its own thinking type', () => {
    expect(bodyOf('claude-sonnet-5.5', { mode: 'between_tools' }).thinking).toEqual({
      type: 'between_tools',
    });
  });

  it('never sends it alongside the adaptive shape', () => {
    // They are siblings in Anthropic's ThinkingConfigParam, not variants: one
    // field, one shape.
    const thinking = bodyOf('claude-sonnet-5.5', { mode: 'between_tools' }).thinking as Record<
      string,
      unknown
    >;
    expect(thinking.type).toBe('between_tools');
    expect(thinking.effort).toBeUndefined();
  });

  it('still sends adaptive for the ordinary modes', () => {
    expect((bodyOf('claude-sonnet-5.5', { mode: 'on' }).thinking as { type: string }).type).toBe(
      'adaptive',
    );
  });
});

describe('and the gate in front of it', () => {
  const run = async (model: string) => {
    const hooks = new HookBus();
    const warnings: string[] = [];
    hooks.on('onWarning', (w) => {
      if (w.code === 'request_adjusted') warnings.push(w.message);
    });
    const sent: Array<Record<string, unknown>> = [];
    const client = new LLMClient({
      provider: 'anthropic',
      model,
      apiKey: 'k',
      hooks,
      catalog,
      adapter: new AnthropicAdapter({ apiKey: 'k' }),
      fetch: (async (req: HttpRequest) => {
        sent.push((req.body ?? {}) as Record<string, unknown>);
        return { status: 200, headers: {}, body: {} };
      }) as unknown as (r: HttpRequest) => Promise<HttpResponse>,
    });
    await client
      .complete('hi', { maxTokens: 8, thinking: { mode: 'between_tools' } })
      .catch(() => undefined);
    return { warnings, sent };
  };

  it('lets it through on the model that takes it, silently', async () => {
    const { warnings, sent } = await run('claude-sonnet-5.5');
    expect(sent[0]?.thinking).toEqual({ type: 'between_tools' });
    expect(warnings).toEqual([]);
  });

  it('drops it everywhere else, and says so', async () => {
    // Downgraded rather than refused — what Anthropic's own fallback middleware
    // does with this value. The caller gets a request that works plus a warning.
    const { warnings, sent } = await run('claude-opus-5.5');
    expect(sent[0]?.thinking).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('between_tools');
    expect(warnings[0]).toContain('claude-sonnet-5.5');
  });

  it('leaves the other thinking modes alone', async () => {
    const hooks = new HookBus();
    const warnings: string[] = [];
    hooks.on('onWarning', (w) => {
      if (w.code === 'request_adjusted') warnings.push(w.message);
    });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-opus-5.5',
      apiKey: 'k',
      hooks,
      catalog,
      adapter: new AnthropicAdapter({ apiKey: 'k' }),
      fetch: (async () => ({ status: 200, headers: {}, body: {} })) as unknown as (
        r: HttpRequest,
      ) => Promise<HttpResponse>,
    });
    await client.complete('hi', { maxTokens: 8, thinking: { mode: 'on' } }).catch(() => undefined);
    expect(warnings).toEqual([]);
  });
});
