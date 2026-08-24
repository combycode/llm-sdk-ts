/** The check is actually reachable from a real client — and silent unless asked.
 *
 *  `response-shape.test.ts` proves the checker's logic. This proves the WIRING,
 *  which is the half that can rot without any test noticing: a flag that never
 *  reaches the client, or a call site that moved, leaves every unit test green
 *  while the feature does nothing at all.
 *
 *  Both directions matter. A diagnostic nobody asked for is a regression too —
 *  warnings on by default would land in the logs of every existing consumer.
 *
 *  The stub body comes from the RECORDING, not from this file. The first draft
 *  hand-wrote "a normal Anthropic response" and the check immediately reported
 *  eight fields missing: `stop_details`, `usage.cache_creation`,
 *  `usage.cache_read_input_tokens`, `usage.service_tier`, `usage.inference_geo`
 *  and more, all of which Anthropic sends every time. The check was right and the
 *  hand-written body was wrong, which is the entire argument for the corpus.
 */
import { describe, expect, it } from 'bun:test';
import { createEngine, createLLM } from '../../../src/index';
import type { ResponseCell } from './response-corpus';
import golden from '../../fixtures/response-golden.json' with { type: 'json' };

const corpus = golden as unknown as Record<string, ResponseCell>;
const RECORDED = (corpus['anthropic/messages::text'] as ResponseCell).raw as Record<string, unknown>;

/** A real recorded body, optionally mutated by the case. */
function bodyLike(mutate?: (b: Record<string, unknown>) => void): Record<string, unknown> {
  const body = structuredClone(RECORDED);
  mutate?.(body);
  return body;
}

function engineFor(body: Record<string, unknown>, check: boolean) {
  const fetchStub = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  const engine = createEngine({ registerAsDefault: false, fetch: fetchStub, checkResponseShapes: check });
  const warnings: string[] = [];
  engine.hooks.on('onWarning', (ctx) => {
    if (ctx.code.startsWith('response_shape_')) warnings.push(`${ctx.code} ${ctx.message}`);
  });
  return { engine, warnings };
}

async function run(body: Record<string, unknown>, check: boolean): Promise<string[]> {
  const { engine, warnings } = engineFor(body, check);
  const llm = createLLM({
    engine,
    provider: 'anthropic',
    model: 'claude-haiku-4.5',
    apiKey: 'stub',
  } as never);
  await llm.complete('hi', { maxTokens: 8 }).catch(() => undefined);
  await engine.destroy();
  return warnings;
}

describe('response shape check, through a real client', () => {
  it('is off by default — an engine that never asked hears nothing', async () => {
    const engine = createEngine({ registerAsDefault: false });
    expect(engine.checkResponseShapes).toBe(false);
    await engine.destroy();

    const warnings = await run(bodyLike((b) => (b.a_field_from_the_future = 1)), false);
    expect(warnings).toEqual([]);
  });

  it('says nothing about a response that matches what we recorded', async () => {
    // Guards the failure that kills a diagnostic: one that warns about ordinary
    // traffic gets switched off, and is then worth nothing when it matters.
    expect(await run(bodyLike(), true)).toEqual([]);
  });

  it('reports an unfamiliar field when the engine asked for it', async () => {
    const warnings = await run(bodyLike((b) => (b.a_field_from_the_future = 1)), true);
    expect(warnings.some((w) => w.includes('unknown_field') && w.includes('a_field_from_the_future'))).toBe(true);
  });

  it('reports a usage field that disappeared', async () => {
    // The rename case, end to end: the provider still answers 200, the parse still
    // succeeds, and the token count it produced is `undefined`.
    const warnings = await run(
      bodyLike((b) => {
        delete (b.usage as Record<string, unknown>).output_tokens;
      }),
      true,
    );
    expect(warnings.some((w) => w.includes('missing_field') && w.includes('usage.output_tokens'))).toBe(true);
  });

  it('checks STREAM events too, not only whole bodies', async () => {
    // The streaming call site is separate from the non-streaming one, so it needs
    // its own evidence: removing it leaves every other test in this file green.
    const events = (corpus['anthropic/messages::stream.text'] as ResponseCell).raw as Array<{
      event?: string;
      data: string;
    }>;
    const line = (e: { event?: string; data: string }) =>
      `${e.event ? `event: ${e.event}\n` : ''}data: ${e.data}\n\n`;
    // One event type the parser has never seen. In a real stream this is skipped
    // in silence and the reply is simply missing a piece.
    const sse = events.map(line).join('') + line({ event: 'message_teleport', data: '{"type":"message_teleport"}' });

    const streamStub = (async () =>
      new Response(new TextEncoder().encode(sse), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;

    const engine = createEngine({
      registerAsDefault: false,
      fetch: streamStub,
      checkResponseShapes: true,
    });
    const warnings: string[] = [];
    engine.hooks.on('onWarning', (ctx) => {
      if (ctx.code.startsWith('response_shape_')) warnings.push(`${ctx.code} ${ctx.message}`);
    });

    const llm = createLLM({
      engine,
      provider: 'anthropic',
      model: 'claude-haiku-4.5',
      apiKey: 'stub',
    } as never);
    for await (const _ of llm.stream('hi', { maxTokens: 8 })) void _;
    await engine.destroy();

    expect(warnings.some((w) => w.includes('unknown_event') && w.includes('message_teleport'))).toBe(true);
    // And the recorded events themselves must pass, or the check is just noisy.
    expect(warnings.filter((w) => !w.includes('message_teleport'))).toEqual([]);
  });

  it('reports a content block type nothing branches on', async () => {
    const warnings = await run(
      bodyLike((b) => {
        (b.content as Array<Record<string, unknown>>).push({ type: 'holographic_diagram', data: 'x' });
      }),
      true,
    );
    expect(warnings.some((w) => w.includes('unknown_value') && w.includes('holographic_diagram'))).toBe(true);
  });
});
