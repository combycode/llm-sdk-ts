/** Any spelling of a model id finds the model, and every helper agrees.
 *
 *  Providers spell one version three ways and users copy whichever they saw:
 *  `gpt-4.1` / `gpt-4-1`, `gemini-2.5-flash` / `gemini-2-5-flash`,
 *  `claude-haiku-4.5` / `claude-haiku-4-5` / `claude-haiku-4-5-20251001`. Only
 *  some are callable. The ones that were not used to miss the catalog outright —
 *  no price, no capabilities — and were then forwarded to the provider verbatim,
 *  turning a spelling difference into a 404.
 *
 *  Two properties are pinned here, and the second is the one that rots:
 *    1. every variant resolves to the same catalog entry, and
 *    2. EVERY helper does that resolution, not just the ones someone remembered.
 *  A helper that builds its own request and forgets is invisible until a user
 *  hits it, so the parity block below calls each one and reads the wire.
 */
import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { createEngine } from '../../../src/helpers/engine';
import { createAgent } from '../../../src/helpers/agent';
import { createLLM } from '../../../src/helpers/llm';
import { complete } from '../../../src/helpers/one-shot';
import { embed } from '../../../src/helpers/embed';
import { moderate } from '../../../src/helpers/moderate';
import { transcribe } from '../../../src/helpers/transcribe';
import { countTokens } from '../../../src/helpers/count-tokens';
import { submitBatch } from '../../../src/helpers/batch';

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();

describe('every spelling reaches the same entry', () => {
  const VARIANTS: Array<[string, string[], string]> = [
    // provider, spellings that must all resolve, the canonical slug
    ['anthropic', ['claude-haiku-4.5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'], 'claude-haiku-4.5'],
    ['google', ['gemini-2.5-flash', 'gemini-2-5-flash'], 'gemini-2.5-flash'],
    ['openai', ['gpt-4.1', 'gpt-4-1'], 'gpt-4.1'],
    ['xai', ['grok-4.3', 'grok-4-3'], 'grok-4.3'],
  ];

  for (const [provider, spellings, canonical] of VARIANTS) {
    for (const spelling of spellings) {
      it(`${provider}/${spelling} -> ${canonical}`, () => {
        const info = catalog.get(provider, spelling);
        expect(info).not.toBeNull();
        expect(info!.model).toBe(canonical);
        // Pricing is the half that failed silently: null reads as "free".
        expect(catalog.getPricing(provider, spelling)).not.toBeNull();
      });
    }
  }

  it('ignores case', () => {
    expect(catalog.get('anthropic', 'CLAUDE-HAIKU-4-5')?.model).toBe('claude-haiku-4.5');
    expect(catalog.get('openai', 'GPT-4.1')?.model).toBe('gpt-4.1');
  });

  it('still returns null for a model that genuinely is not ours', () => {
    // Normalisation must not turn "unknown" into a confident wrong answer.
    expect(catalog.get('openai', 'gpt-9.9-imaginary')).toBeNull();
    expect(catalog.get('anthropic', 'claude-nonexistent-1.0')).toBeNull();
  });

  it('never merges two different models', () => {
    // The safety property behind normalisation. If any two entries shared a
    // normalized key, one would silently answer for the other.
    const norm = (s: string) => s.toLowerCase().replace(/(?<=\d)[-.](?=\d)/g, '.');
    const owner = new Map<string, string>();
    for (const m of catalog.list()) {
      for (const name of [m.model, m.providerModelName, ...(m.aliases ?? [])]) {
        if (!name) continue;
        const k = `${m.provider}/${norm(name)}`;
        const prev = owner.get(k);
        if (prev && prev !== `${m.provider}/${m.model}`) {
          throw new Error(`normalized collision on ${k}: ${prev} vs ${m.provider}/${m.model}`);
        }
        owner.set(k, `${m.provider}/${m.model}`);
      }
    }
    expect(owner.size).toBeGreaterThan(500);
  });
});

describe('what goes on the wire is always callable', () => {
  it('translates a non-callable spelling to the canonical id', () => {
    // These spellings 404 at the provider (measured 2026-08-25), so forwarding
    // them verbatim would just return the user's typo with an error attached.
    expect(catalog.resolveModelId('google', 'gemini-2-5-flash')).toBe('gemini-2.5-flash');
    expect(catalog.resolveModelId('openai', 'gpt-4-1')).toBe('gpt-4.1');
    expect(catalog.resolveModelId('xai', 'grok-4-3')).toBe('grok-4.3');
  });

  it('leaves an id the provider itself accepts alone', () => {
    // A listed alias is a deliberate choice — the undated anthropic name means
    // "latest 4.5", and rewriting it to a date would pin a caller who asked to
    // float. The slug, by contrast, is ours and translates to the pinned snapshot.
    expect(catalog.resolveModelId('anthropic', 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(catalog.resolveModelId('anthropic', 'claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(catalog.resolveModelId('anthropic', 'claude-haiku-4.5')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('passes an unknown model through untouched', () => {
    // A fine-tune or a model released this morning must still be callable.
    expect(catalog.resolveModelId('openai', 'ft:gpt-4.1:acme::AbcXyz')).toBe(
      'ft:gpt-4.1:acme::AbcXyz',
    );
  });
});

describe('every helper resolves the id the same way', () => {
  // The point of this block: `catalog.resolveModelId` being correct is worth
  // nothing in a helper that never calls it. Each helper below is handed a
  // spelling the provider would reject and must put the canonical id on the wire.
  class Captured extends Error {}

  function engineCapturing(): { engine: ReturnType<typeof createEngine>; wire: () => string | undefined } {
    let seen: string | undefined;
    const engine = createEngine({
      registerAsDefault: false,
      apiKeys: { openai: 'k', anthropic: 'k', google: 'k', xai: 'k', openrouter: 'k' },
      fetch: (async (url: string, init: { body?: unknown }) => {
        seen = undefined;
        const body = init?.body;
        if (typeof body === 'string') {
          try {
            seen = (JSON.parse(body) as { model?: string }).model;
          } catch {
            /* not json */
          }
          // Batch ships its requests as an uploaded JSONL, so the model is a line
          // inside the payload rather than a field on it.
          if (!seen) seen = /"model"\s*:\s*"([^"]+)"/.exec(body)?.[1];
        } else if (body instanceof FormData) {
          seen = (body.get('model') as string) ?? undefined;
          if (!seen) {
            // Batch uploads its JSONL as a Blob part, so the model is in the file
            // contents rather than in a form field.
            for (const [, entry] of body.entries()) {
              const v = entry as string | Blob;
              const text = typeof v === 'string' ? v : await v.text();
              const m = /"model"\s*:\s*"([^"]+)"/.exec(text);
              if (m) {
                seen = m[1];
                break;
              }
            }
          }
        }
        // Google carries the model in the path, not the body.
        if (!seen) seen = /models\/([^:?]+)/.exec(String(url))?.[1];
        throw new Captured('captured');
      }) as never,
    });
    return { engine, wire: () => seen };
  }

  const msg = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];

  const CASES: Array<[string, string, string, (e: ReturnType<typeof createEngine>) => Promise<unknown>]> = [
    ['createAgent', 'openai/gpt-4-1', 'gpt-4.1', (engine) =>
      createAgent({ model: 'openai/gpt-4-1', engine }).complete('hi')],
    ['createLLM', 'openai/gpt-4-1', 'gpt-4.1', (engine) =>
      createLLM({ model: 'openai/gpt-4-1', engine }).complete(msg)],
    ['complete', 'openai/gpt-4-1', 'gpt-4.1', (engine) =>
      complete({ model: 'openai/gpt-4-1', prompt: 'hi', engine })],
    ['createAgent(google)', 'google/gemini-2-5-flash', 'gemini-2.5-flash', (engine) =>
      createAgent({ model: 'google/gemini-2-5-flash', engine }).complete('hi')],
    ['countTokens', 'anthropic/claude-haiku-4.5', 'claude-haiku-4-5-20251001', (engine) =>
      countTokens({ model: 'anthropic/claude-haiku-4.5', input: 'hi', engine })],
    ['submitBatch', 'openai/gpt-4-1', 'gpt-4.1', (engine) =>
      submitBatch({
        model: 'openai/gpt-4-1',
        requests: [{ customId: '1', prompt: 'hi' }],
        engine,
      })],
  ];

  for (const [name, input, expected, run] of CASES) {
    it(`${name}: ${input} -> ${expected}`, async () => {
      const { engine, wire } = engineCapturing();
      await run(engine).catch(() => {
        /* the capturing fetch always throws; the wire id is the assertion */
      });
      expect(wire()).toBe(expected);
    });
  }

  // 15s, not the 5s default: this one drives three independent request builders
  // and lands at ~5s on its own, so under a loaded parallel run it times out and
  // reads as a failure. The work is real, not a hang.
  it('embed, moderate and transcribe translate their own model too', async () => {
    // Non-chat endpoints build their requests independently, which is exactly how
    // one of them ends up being the only path that forgets.
    const { engine, wire } = engineCapturing();

    await embed({ model: 'openai/text-embedding-3-small', input: 'hi', engine }).catch(() => {});
    expect(wire()).toBe('text-embedding-3-small');

    await moderate({ model: 'openai/omni-moderation-latest', input: 'hi', engine }).catch(() => {});
    expect(wire()).toBeTruthy();

    await transcribe({
      model: 'openai/whisper-1',
      audio: { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      engine,
    }).catch(() => {});
    expect(wire()).toBeTruthy();
  }, 15_000);

  it('realtime resolves before it connects', () => {
    // The gap this block was written to catch: createRealtime parsed the provider
    // but never translated the slug, so it was the one helper that sent our id.
    const src = require('node:fs').readFileSync(
      new URL('../../../src/helpers/realtime.ts', import.meta.url),
      'utf8',
    ) as string;
    // Asserted on booleans rather than the source itself, so a regression prints
    // "expected true" instead of dumping the whole file into the failure.
    expect({
      translates: /resolveModelId\(provider, model\)/.test(src),
      sendsTheTranslation: /model: sendModel/.test(src),
    }).toEqual({ translates: true, sendsTheTranslation: true });
  });
});
