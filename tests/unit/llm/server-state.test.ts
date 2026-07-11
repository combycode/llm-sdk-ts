/** resolveServerState (server-state decision brain) unit tests. */

import { describe, expect, it } from 'bun:test';
import { buildAssistantMessage } from '../../../src/llm/client-internal';
import { resolveServerState } from '../../../src/llm/server-state';
import type { Message } from '../../../src/llm/types/messages';
import type { ProviderName } from '../../../src/llm/types/provider';
import type { CompletionResponse } from '../../../src/llm/types/response';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';

const catalog = new ModelCatalog(); // empty → provider-level defaults
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function asst(serverStateId: string, provider: ProviderName, model: string, ageMs = 0): Message {
  return {
    role: 'assistant',
    content: 'ok',
    createdAt: NOW - ageMs,
    origin: { provider, model, serverStateId },
  };
}
const newTurn: Message = { role: 'user', content: 'next' };

describe('resolveServerState', () => {
  it('no assistant origin → resend full history, no id', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const r = resolveServerState({
      messages,
      provider: 'openai',
      model: 'gpt',
      catalog,
      stateful: true,
      now: NOW,
    });
    expect(r.previousResponseId).toBeUndefined();
    expect(r.messages).toBe(messages);
  });

  it('happy path (same provider + model, fresh) → id + only the new turn', () => {
    const messages = [
      { role: 'user', content: 'a' } as Message,
      asst('resp_1', 'openai', 'gpt-5.4-nano'),
      newTurn,
    ];
    const r = resolveServerState({
      messages,
      provider: 'openai',
      model: 'gpt-5.4-nano',
      catalog,
      stateful: true,
      now: NOW,
    });
    expect(r.previousResponseId).toBe('resp_1');
    expect(r.messages).toEqual([newTurn]);
  });

  it('foreign provider id → ignored, resend history (portability)', () => {
    const messages = [asst('resp_1', 'anthropic', 'claude'), newTurn];
    const r = resolveServerState({
      messages,
      provider: 'openai',
      model: 'gpt',
      catalog,
      stateful: true,
      now: NOW,
    });
    expect(r.previousResponseId).toBeUndefined();
    expect(r.messages).toBe(messages);
  });

  it('expired TTL → resend history', () => {
    const messages = [asst('resp_1', 'openai', 'gpt-5.4-nano', 31 * DAY), newTurn]; // > 30d
    const r = resolveServerState({
      messages,
      provider: 'openai',
      model: 'gpt-5.4-nano',
      catalog,
      stateful: true,
      now: NOW,
    });
    expect(r.previousResponseId).toBeUndefined();
  });

  it('model-bound provider + different model → resend history (openai)', () => {
    const messages = [asst('resp_1', 'openai', 'gpt-5.4-nano'), newTurn];
    const r = resolveServerState({
      messages,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      catalog,
      stateful: true,
      now: NOW,
    });
    expect(r.previousResponseId).toBeUndefined();
  });

  it('NOT model-bound (google) + different model → still chains', () => {
    const messages = [asst('int_1', 'google', 'gemini-3.1-flash-lite'), newTurn];
    const r = resolveServerState({
      messages,
      provider: 'google',
      model: 'gemini-2.5-flash',
      catalog,
      stateful: true,
      now: NOW,
    });
    expect(r.previousResponseId).toBe('int_1');
    expect(r.messages).toEqual([newTurn]);
  });

  it('stateful:false → always resend history', () => {
    const messages = [asst('resp_1', 'openai', 'gpt-5.4-nano'), newTurn];
    const r = resolveServerState({
      messages,
      provider: 'openai',
      model: 'gpt-5.4-nano',
      catalog,
      stateful: false,
      now: NOW,
    });
    expect(r.previousResponseId).toBeUndefined();
    expect(r.messages).toBe(messages);
  });

  it('unsupported provider (anthropic) → resend history', () => {
    const messages = [asst('x', 'anthropic', 'claude'), newTurn];
    const r = resolveServerState({
      messages,
      provider: 'anthropic',
      model: 'claude',
      catalog,
      stateful: true,
      now: NOW,
    });
    expect(r.previousResponseId).toBeUndefined();
  });
});

describe('buildAssistantMessage (provenance stamping — feeds resolveServerState)', () => {
  const resp = (id: string): CompletionResponse =>
    ({ id, content: [{ type: 'text', text: 'ok' }] }) as CompletionResponse;

  it('stateful API stamps origin.serverStateId from the response id', () => {
    for (const api of ['responses', 'interactions'] as const) {
      const m = buildAssistantMessage(resp('resp_1'), { provider: 'google', model: 'g', api });
      expect(m.origin?.serverStateId).toBe('resp_1');
      expect(m.id).toBe('resp_1');
    }
  });

  it('non-stateful API does NOT stamp serverStateId', () => {
    for (const api of ['generate', 'completions', 'messages'] as const) {
      const m = buildAssistantMessage(resp('resp_1'), { provider: 'anthropic', model: 'a', api });
      expect(m.origin?.serverStateId).toBeUndefined();
      expect(m.origin?.provider).toBe('anthropic');
    }
  });

  it('no response id → no serverStateId even on a stateful API', () => {
    const m = buildAssistantMessage(resp(''), { provider: 'openai', model: 'o', api: 'responses' });
    expect(m.origin?.serverStateId).toBeUndefined();
  });

  it('the stamped message chains on the next turn via resolveServerState', () => {
    const asstTurn = buildAssistantMessage(resp('int_42'), {
      provider: 'google',
      model: 'gemini-3.1-flash-lite',
      api: 'interactions',
    });
    const d = resolveServerState({
      messages: [{ role: 'user', content: 'hi' }, asstTurn, { role: 'tool', content: 'result' }],
      provider: 'google',
      model: 'gemini-3.1-flash-lite',
      catalog,
      stateful: true,
      now: Date.now(),
    });
    // Only the post-interaction turn is resent; the id continues server-side.
    expect(d.previousResponseId).toBe('int_42');
    expect(d.messages).toEqual([{ role: 'tool', content: 'result' }]);
  });
});
