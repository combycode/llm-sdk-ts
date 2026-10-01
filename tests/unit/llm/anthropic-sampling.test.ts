/** Sampling parameters Anthropic REFUSES, which we were sending anyway.
 *
 *  The row behind this said to keep our sampling options because "the wire still
 *  accepts them on older models". Measured 2026-10-01, that is half true and the
 *  other half was a shipped defect:
 *
 *    claude-opus-5.5   400  `temperature` is deprecated for this model.
 *    claude-sonnet-4.6 200  (each one alone)
 *
 *  So a caller who set `temperature` — an ordinary thing to set — and used any
 *  model from the `claude-opus-4.8` generation onward got a FAILED REQUEST. Our own
 *  public option was a guaranteed 400 on the majority of a provider's line, which
 *  is the same defect class as `effort: 'max'` the run before.
 *
 *  The boundary is exactly the wire-spec era: every model on
 *  `anthropic/messages@4.7` refuses all three, every model on `@4.6` accepts them.
 *  `top_k` had already been removed there for this reason; `temperature` and
 *  `top_p` had not.
 *
 *  Three separate things are checked below, because each can regress alone:
 *  what travels, what is reported, and the `temperature`+`top_p` pair rule — which
 *  is a different fault (those models accept either field alone and refuse the
 *  two together).
 */

import { describe, expect, it } from 'bun:test';
import { createEngine } from '../../../src/index';

/** Builds one request through the real client and returns the wire body plus the
 *  `request_adjusted` warnings it produced. Nothing is sent: the transport is a
 *  stub that answers a minimal Anthropic message. */
async function build(model: string, options: Record<string, unknown>) {
  const bodies: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const engine = createEngine({
    apiKeys: { anthropic: 'k' },
    registerAsDefault: false,
    fetch: (async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'm',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as never,
  });
  engine.hooks.on('onWarning', (w) => {
    const warning = w as { code?: string; message?: string };
    if (warning.code === 'request_adjusted') warnings.push(String(warning.message ?? ''));
  });
  const llm = engine.createClient({ model });
  await llm.complete('hi', { maxTokens: 16, ...options });
  llm.destroy();
  engine.destroy();
  return { body: bodies[0] ?? {}, warnings };
}

const FOURSEVEN = 'anthropic/claude-opus-5.5';
const FOURSIX = 'anthropic/claude-sonnet-4.6';

describe('a 4.7-era model, which refuses all three', () => {
  it('sends no temperature, so the request is not a guaranteed 400', async () => {
    const { body } = await build(FOURSEVEN, { temperature: 0.3 });
    expect(body.temperature).toBeUndefined();
  });

  it('says what it dropped, instead of dropping it silently', async () => {
    // `removeFields` deletes a field at inheritance time and says nothing, which
    // is how `top_k` has behaved since 4.7 shipped: a caller who set it got
    // default sampling and no way to know.
    const { warnings } = await build(FOURSEVEN, { temperature: 0.3 });
    expect(warnings.join(' ')).toContain('temperature was not sent');
  });

  it('names every option the caller set, in one note', async () => {
    // Three warnings about one decision read as three problems.
    const { warnings } = await build(FOURSEVEN, { temperature: 0.3, topP: 0.8, topK: 10 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('temperature');
    expect(warnings[0]).toContain('topP');
    expect(warnings[0]).toContain('topK');
  });

  it('does not claim a trade it did not make', async () => {
    // The pair note would say "topP was dropped so temperature could be sent".
    // On this era temperature was not sent either, so that sentence is false.
    const { warnings } = await build(FOURSEVEN, { temperature: 0.3, topP: 0.8 });
    expect(warnings.join(' ')).not.toContain('so topP was dropped');
  });

  it('says nothing when the caller set no sampling options', async () => {
    const { warnings } = await build(FOURSEVEN, {});
    expect(warnings.filter((w) => w.includes('sampl'))).toHaveLength(0);
  });
});

describe('a 4.6-era model, which accepts them', () => {
  it('still sends temperature — the fix is an era boundary, not a removal', async () => {
    // The assertion that keeps this from being a blanket deletion. Without it, a
    // fix that dropped sampling everywhere would look identical from the 4.7 side.
    const { body } = await build(FOURSIX, { temperature: 0.3 });
    expect(body.temperature).toBe(0.3);
  });

  it('sends top_p and top_k too', async () => {
    const { body } = await build(FOURSIX, { topP: 0.8 });
    expect(body.top_p).toBe(0.8);
    const k = await build(FOURSIX, { topK: 10 });
    expect(k.body.top_k).toBe(10);
  });

  it('warns about nothing when everything travelled', async () => {
    const { warnings } = await build(FOURSIX, { temperature: 0.3 });
    expect(warnings.filter((w) => w.includes('not sent'))).toHaveLength(0);
  });
});

describe('the temperature + topP pair, which those models refuse together', () => {
  it('sends one of them rather than failing the request', async () => {
    // `400 \`temperature\` and \`top_p\` cannot both be specified for this model.
    // Please use only one.` — measured on claude-sonnet-4.6 and claude-haiku-4.5.
    const { body } = await build(FOURSIX, { temperature: 0.3, topP: 0.8 });
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBeUndefined();
  });

  it('says which one it kept, and why', async () => {
    const { warnings } = await build(FOURSIX, { temperature: 0.3, topP: 0.8 });
    expect(warnings.join(' ')).toContain('topP was dropped');
    expect(warnings.join(' ')).toContain('temperature (0.3) was sent');
  });

  it('does NOT also claim the model rejects topP', async () => {
    // It accepts topP perfectly well on its own. Saying otherwise about a field we
    // removed ourselves would teach a reader to distrust the other warnings.
    const { warnings } = await build(FOURSIX, { temperature: 0.3, topP: 0.8 });
    expect(warnings.join(' ')).not.toContain('topP was not sent');
  });

  it('leaves a request with only one of them alone', async () => {
    const t = await build(FOURSIX, { temperature: 0.3 });
    expect(t.body.temperature).toBe(0.3);
    const p = await build(FOURSIX, { topP: 0.8 });
    expect(p.body.top_p).toBe(0.8);
    expect([...t.warnings, ...p.warnings].join(' ')).not.toContain('dropped');
  });

  it('is Anthropic-only — no other provider refuses the pair', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const engine = createEngine({
      apiKeys: { openai: 'k' },
      registerAsDefault: false,
      fetch: (async (_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: 'resp_1',
            output: [
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as never,
    });
    const llm = engine.createClient({ model: 'openai/gpt-5.4-nano' });
    await llm.complete('hi', { temperature: 0.3, topP: 0.8 });
    expect(bodies[0]?.temperature).toBe(0.3);
    expect(bodies[0]?.top_p).toBe(0.8);
    llm.destroy();
    engine.destroy();
  });
});
