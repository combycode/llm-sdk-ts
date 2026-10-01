/** OpenAI data residency: a named region instead of a hand-written host.
 *
 *  OpenAI serves the same API from four hosts and a project provisioned for one
 *  region must use that region's. Getting it wrong is not a silent fallback --
 *  measured 2026-10-01 against /v1/responses from an unrestricted project, the
 *  default host answers 200 while `us.` refuses with "incorrect regional hostname.
 *  Please make your request to api.openai.com" and `eu.` with "only accessible by
 *  projects with geography restrictions enabled". Each reply names the host that was
 *  reached, so it is the routing that is proven, not just a status code. All four
 *  hostnames resolve, so the only question is which one a caller means, and four
 *  spellings checked at construction beat a URL string they have to get exactly right.
 */

import { describe, expect, it } from 'bun:test';
import { createEngine } from '../../../src/index';
import { resolveDataResidency } from '../../../src/llm/providers/openai/data-residency';

describe('resolveDataResidency', () => {
  it('maps each region to its host', () => {
    expect(resolveDataResidency('global', undefined)).toBe('https://api.openai.com');
    expect(resolveDataResidency('us', undefined)).toBe('https://us.api.openai.com');
    expect(resolveDataResidency('eu', undefined)).toBe('https://eu.api.openai.com');
    expect(resolveDataResidency('ae', undefined)).toBe('https://ae.api.openai.com');
  });

  it('carries no path, so the adapter does not produce /v1/v1/...', () => {
    // The upstream SDK's table includes `/v1`; ours must not, because
    // `completionPath()` supplies it.
    for (const region of ['global', 'us', 'eu', 'ae'] as const) {
      expect(resolveDataResidency(region, undefined)).not.toContain('/v1');
    }
  });

  it('returns nothing when no region was asked for', () => {
    expect(resolveDataResidency(undefined, undefined)).toBeUndefined();
    expect(resolveDataResidency(undefined, 'https://proxy.test')).toBeUndefined();
  });

  it('THROWS when combined with baseURL, instead of picking a winner', () => {
    // Both name the host. Honouring one would silently discard a configuration the
    // caller wrote, and they cannot tell which.
    expect(() => resolveDataResidency('eu', 'https://proxy.test')).toThrow(
      /mutually exclusive/,
    );
  });

  it('refuses a region it does not know', () => {
    // A typo like `'EU'` would otherwise fall through to the default host and send
    // EU-resident data to the global endpoint — the one failure this prevents.
    expect(() => resolveDataResidency('EU' as never, undefined)).toThrow(/Invalid dataResidency/);
  });
});

describe('a client built with a region', () => {
  /** Captures the URL a request goes to, without sending it. */
  async function urlFor(opts: Record<string, unknown>) {
    const urls: string[] = [];
    const engine = createEngine({
      apiKeys: { openai: 'k', anthropic: 'k' },
      registerAsDefault: false,
      fetch: (async (url: string) => {
        urls.push(url);
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
    const llm = engine.createClient(opts as never);
    await llm.complete('hi');
    llm.destroy();
    engine.destroy();
    return urls[0] ?? '';
  }

  it('sends the request to that region', async () => {
    expect(await urlFor({ model: 'openai/gpt-5.4-nano', dataResidency: 'eu' })).toBe(
      'https://eu.api.openai.com/v1/responses',
    );
  });

  it('still reaches the default host when no region is set', async () => {
    // The regression that carries every existing caller.
    expect(await urlFor({ model: 'openai/gpt-5.4-nano' })).toBe(
      'https://api.openai.com/v1/responses',
    );
  });

  it('treats `global` as the default host, not as a fifth one', async () => {
    expect(await urlFor({ model: 'openai/gpt-5.4-nano', dataResidency: 'global' })).toBe(
      'https://api.openai.com/v1/responses',
    );
  });

  it('refuses it on a provider that has no regional hosts', async () => {
    // Silently ignoring it would let someone believe their data was pinned to a
    // region when the option did nothing at all.
    await expect(
      urlFor({ model: 'anthropic/claude-haiku-4.5', dataResidency: 'eu' }),
    ).rejects.toThrow(/OpenAI option/);
  });

  it('refuses it alongside a baseURL', async () => {
    await expect(
      urlFor({
        model: 'openai/gpt-5.4-nano',
        dataResidency: 'eu',
        baseURL: 'https://proxy.test',
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('leaves a plain baseURL working', async () => {
    expect(
      await urlFor({ model: 'openai/gpt-5.4-nano', baseURL: 'https://proxy.test' }),
    ).toBe('https://proxy.test/v1/responses');
  });
});
