/** `complete()` must send the same options whether or not `tools` was passed.
 *
 *  The helper has two branches — AgentLoop when tools are present, plain
 *  LLMClient otherwise — and they had drifted: the tools branch forwarded only
 *  `structured`, silently dropping `providerOptions`, `audio`, `outputModalities`
 *  and `serviceTier`. `cache` was missing from both, and from `CompleteOptions`
 *  entirely, so asking for prompt caching through this helper did nothing at all.
 *
 *  Found by a benchmark that reported zero cached tokens for every arm. Nothing
 *  errored: the option is not declared, so it was dropped in silence.
 *
 *  These assert against the REQUEST BODY, so they cannot pass on a type alone.
 */

import { describe, expect, it } from 'bun:test';
import { complete } from '../../../src/helpers/one-shot';
import { createEngine } from '../../../src/helpers/engine';
import { defineTool } from '../../../src/helpers/define-tool';

function stubbed() {
  const bodies: unknown[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetch = (async (_url: unknown, init: { body?: unknown; headers?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    headers.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;

  const engine = createEngine({ fetch, registerAsDefault: false });
  return { engine, bodies, headers };
}

const base = { model: 'anthropic/claude-haiku-4-5', apiKey: 'k', prompt: 'hi', system: 'a system prompt' };

describe('complete() option forwarding', () => {
  it('sends cache_control when `cache` is requested, without tools', async () => {
    const { engine, bodies } = stubbed();
    await complete({ ...base, engine, cache: { system: true } });
    expect(JSON.stringify(bodies[0])).toContain('cache_control');
  });

  it('sends cache_control when `cache` is requested WITH tools', async () => {
    const { engine, bodies } = stubbed();
    await complete({
      ...base,
      engine,
      cache: { system: true, tools: true },
      tools: [
        defineTool({
          name: 'noop',
          description: 'does nothing',
          params: {},
          execute: () => 'never called',
        }),
      ],
    });
    expect(JSON.stringify(bodies[0])).toContain('cache_control');
  });

  it('sends no cache_control when `cache` is omitted', async () => {
    const { engine, bodies } = stubbed();
    await complete({ ...base, engine });
    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
  });

  it('forwards providerOptions through the TOOLS branch, which used to drop them', async () => {
    const { engine, headers } = stubbed();
    await complete({
      ...base,
      engine,
      // `userProfileId` is one this adapter actually reads (messages.ts:297); a
      // key the adapter ignores would make the test pass or fail for reasons that
      // have nothing to do with forwarding.
      providerOptions: { userProfileId: 'u-42' },
      tools: [
        defineTool({ name: 'noop', description: 'does nothing', params: {}, execute: () => 'never called' }),
      ],
    });
    // It rides as a HEADER, not in the body (messages.ts:299).
    expect(JSON.stringify(headers[0])).toContain('u-42');
  });
});
