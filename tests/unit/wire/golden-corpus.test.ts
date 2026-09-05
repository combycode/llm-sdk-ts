/** Every catalogued chat model still sends what 2.3.0 sent.
 *
 *  The sibling sweep (`every-model-reproduces-its-adapter.test.ts`) compares the
 *  spec against the adapter. That comparison is load-bearing right up until the
 *  adapters are driven by their specs — at which point it compares the spec with
 *  itself, stays green forever, and stops being evidence of anything. It goes blind
 *  at exactly the moment the hand-written path is deleted.
 *
 *  This test does not have that problem. It compares against a corpus frozen from
 *  the hand-written adapters BEFORE the migration
 *  (`tests/fixtures/wire-golden.json`, `scripts/freeze-wire-golden.ts`), so it keeps
 *  asking the only question that matters through the whole 3.0.0 change: is the
 *  request still the one that worked?
 *
 *  A failure here is not "update the fixture". It is either a wire regression, or a
 *  deliberate change that has to be justified in the commit that re-freezes.
 */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog, type ModelInfo } from '../../../src/catalog/catalog';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../../../src/llm/providers/google/interactions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { XAIAdapter } from '../../../src/llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../../../src/llm/providers/xai/responses';
import { OpenRouterAdapter } from '../../../src/llm/providers/openrouter/completions';
import { OpenRouterResponsesAdapter } from '../../../src/llm/providers/openrouter/responses';
import { SHAPES, subjectsFrom, onWire, FLOOR, type Adapterish } from './wire-corpus';
import golden from '../../fixtures/wire-golden.json' with { type: 'json' };

const K = 'k';
const adapters: Record<string, Record<string, Adapterish | undefined>> = {
  anthropic: { messages: new AnthropicAdapter({ apiKey: K }) },
  google: {
    generate: new GoogleAdapter({ apiKey: K }),
    interactions: new GoogleInteractionsAdapter({ apiKey: K }),
  },
  openai: {
    responses: new OpenAIResponsesAdapter({ apiKey: K }),
    completions: new OpenAIAdapter({ apiKey: K }),
  },
  xai: {
    responses: new XAIResponsesAdapter({ apiKey: K }),
    completions: new XAIAdapter({ apiKey: K }),
  },
  openrouter: {
    responses: new OpenRouterResponsesAdapter({ apiKey: K }),
    completions: new OpenRouterAdapter({ apiKey: K }),
  },
};

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();
const subjects = subjectsFrom(catalog.list() as ModelInfo[], adapters);

const bodies = golden.bodies as Record<string, unknown>;
const index = golden.index as Record<string, Record<string, string>>;

/** The frozen body for this model+shape, with the model id put back. */
function frozen(key: string, shape: string, model: string): string | null {
  const hash = index[key]?.[shape];
  if (hash === undefined) return null;
  const body = bodies[hash];
  if (body === undefined) return null;
  return JSON.stringify(body).split('"$MODEL"').join(JSON.stringify(model));
}

describe('the frozen corpus is intact', () => {
  it('was frozen from a released version', () => {
    expect(golden.frozenAt).toBe('2.3.0');
  });

  it('covers the same shapes the corpus defines', () => {
    // A shape added to wire-corpus.ts but missing from the freeze would be an
    // untested shape that still reports green.
    expect(golden.shapes).toEqual(SHAPES.map((s) => s.name));
  });

  it('every index entry points at a body that exists', () => {
    const dangling: string[] = [];
    for (const [key, shapes] of Object.entries(index)) {
      for (const [shape, hash] of Object.entries(shapes)) {
        if (bodies[hash] === undefined) dangling.push(`${key} ${shape} -> ${hash}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('has an entry for every catalogued chat model, and enough of them', () => {
    const missing = subjects.map((s) => s.key).filter((k) => !index[k]);
    expect(missing).toEqual([]);
    const short = Object.entries(FLOOR)
      .filter(([p, n]) => subjects.filter((s) => s.provider === p).length < n)
      .map(([p, n]) => `${p}: expected >= ${n}`);
    expect(short).toEqual([]);
  });
});

/** Both ways a spec-driven adapter can pick its spec must land on the same wire.
 *
 *  `pinned`   the catalog resolved `wireSpec` and the client put it on the request.
 *  `unpinned` no catalog, or a model newer than ours: the adapter derives the band
 *             from the model id, exactly as it did before the specs existed.
 *
 *  Checking only the pinned path would leave the fallback — the route every
 *  uncatalogued model takes — entirely unmeasured, and it is the half more likely
 *  to be wrong. */
const ROUTES = [
  { name: 'unpinned', pin: false },
  { name: 'pinned', pin: true },
] as const;

/** Deliberate departures from what 2.3.0 sent.
 *
 *  A frozen corpus answers "did this change?" — never "should it have?". When the
 *  answer is yes-and-on-purpose the deviation is recorded HERE rather than by
 *  re-freezing the corpus: a re-freeze would absorb every UNnoticed change in the
 *  same pass, which is the single thing this corpus exists to prevent.
 *
 *  Entries are checked in both directions. A waiver whose cells no longer differ
 *  is itself a failure — otherwise a stale waiver silently covers the next real
 *  drift through the same cell. */
const INTENTIONAL: Array<{ match: RegExp; reason: string }> = [
  {
    match: /^openrouter\/.+ audio\.out \[/,
    reason:
      'Audio OUTPUT was silently dropped. openai-completions gated `modalities` on ' +
      '`hasAudioInput`, so `outputModalities: [text, audio]` travelled all the way to ' +
      'the wire builder and died there; gpt-audio then refused the call with "this model ' +
      'requires that either input content or output modality contain audio". Fixed ' +
      '2026-08-31 by widening the guard to fire on audio in OR audio out. OpenRouter ' +
      'inherits the openai-completions spec, so every model routed through it now ' +
      'forwards the audio request the caller actually made instead of discarding it.',
  },
  {
    match: /^google\/.+ thinking\.off \[/,
    reason:
      '`thinking: { mode: off }` used to send NOTHING. The thinkingConfig block was ' +
      'gated on `mode !== off`, so the option type-checked, produced no field, and ' +
      'Google applied its own default — which is to think. Measured 2026-09-05 before ' +
      'the fix: 387 thought tokens on gemini-2.5-flash and 684 on 2.5-pro for requests ' +
      'that had asked for none. The wire form differs by family and both halves were ' +
      'measured against the live v1beta API: 2.5 takes `thinkingBudget: 0` (the value ' +
      "the official SDK documents as DISABLED) and rejects thinkingLevel outright; 3.x " +
      'takes `thinkingLevel: MINIMAL`, because 3.5-flash-lite, 3.6-flash and the ' +
      'gemma-4 models answer 400 to a budget. Models that cannot disable at all — ' +
      '2.5-pro, 3.1-pro, 3.7-flash — are marked `reasoning.canDisable: false` in the ' +
      'catalog and the client drops the request with a warning before it is built, ' +
      'which is why the pro rows in this corpus show a field their live requests never ' +
      'carry: the corpus builds bodies through the adapter, below that guard.',
  },
];

/** Which waivers actually fired, so an obsolete one cannot go unnoticed. */
const waiverHits = new Set<number>();

describe('every catalogued chat model still sends what 2.3.0 sent', () => {
  for (const provider of Object.keys(FLOOR)) {
    it(provider, () => {
      const mine = subjects.filter((s) => s.provider === provider);
      const drift: string[] = [];
      let compared = 0;

      for (const s of mine) {
        const key = s.key;
        for (const shape of SHAPES) {
          const was = frozen(key, shape.name, s.model);
          if (was === null) {
            drift.push(`${key} ${shape.name}: not in the frozen corpus`);
            continue;
          }
          for (const route of ROUTES) {
            compared++;
            const req = route.pin
              ? { ...shape.req(s.model), wireSpec: s.specId }
              : shape.req(s.model);
            let now: string;
            try {
              now = onWire(s.adapter.buildRequest(req as never));
            } catch (e) {
              drift.push(`${key} ${shape.name} [${route.name}]: threw ${(e as Error).message}`);
              continue;
            }
            if (now !== was) {
              const id = `${key} ${shape.name} [${route.name}]`;
              const waived = INTENTIONAL.findIndex((w) => w.match.test(id));
              if (waived >= 0) {
                waiverHits.add(waived);
                continue;
              }
              drift.push(`${id}:\n    2.3.0: ${was}\n    now:   ${now}`);
            }
          }
        }
      }

      // Cap the report: one systemic change otherwise prints thousands of lines.
      expect({ compared: compared > 0, drift: drift.slice(0, 5) }).toEqual({
        compared: true,
        drift: [],
      });
    });
  }

  // Registered last, so every provider case above has already run and recorded
  // which waivers fired.
  it('every waiver still describes a real difference', () => {
    const stale = INTENTIONAL.filter((_, i) => !waiverHits.has(i)).map((w) => String(w.match));
    expect(stale).toEqual([]);
  });
});
