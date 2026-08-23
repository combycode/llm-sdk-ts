/** Every catalogued chat model, through its OWN pinned spec, against its real
 *  adapter. All of them, on every CI run.
 *
 *  `catalog-pins.test.ts` proves the pins are well-formed and that Anthropic and
 *  Google models get the thinking shape their traits declare. That is 26 models.
 *  It leaves the other 263 — 224 of them OpenRouter — protected by nothing but
 *  "the pin names a spec that resolves", which a typo satisfies.
 *
 *  This closes that: for each chat model it builds every shape in the shared corpus
 *  twice — once through the hand-written adapter, once by interpreting the spec THE
 *  CATALOG PINS IT TO — and requires the two wire payloads to be identical.
 *
 *  Reading the pin from the catalog is the point. The migration rehearsal in
 *  `wire-spec-lab` computes the pin from the model's version instead, so it
 *  validates the derivation RULE and would not notice a mistyped `wireSpec` in the
 *  catalog JSON — which is the artifact that actually ships.
 *
 *  ── what this stops proving, and when ──────────────────────────────────────
 *  Once an adapter is driven by its spec, this comparison is the spec against
 *  itself for that adapter: green by construction. `golden-corpus.test.ts` is what
 *  carries the guarantee from there, because it compares against output frozen from
 *  2.3.0 rather than against the other side of the same code.
 */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog, type ModelInfo } from '../../../src/catalog/catalog';
import { WIRE_SPECS } from '../../../src/wire/registry';
import { resolveSpec, type SpecDelta } from '../../../src/wire/inherit';
import { buildFromSpec, type WireSpec } from '../../../src/wire/interpreter';
import { makeRegistry } from '../../../src/wire/transforms';
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

const K = 'k';
const anthropic = new AnthropicAdapter({ apiKey: K });
const google = new GoogleAdapter({ apiKey: K });
const googleInteractions = new GoogleInteractionsAdapter({ apiKey: K });
const openaiResponses = new OpenAIResponsesAdapter({ apiKey: K });
const openaiCompletions = new OpenAIAdapter({ apiKey: K });

const adapters: Record<string, Record<string, Adapterish | undefined>> = {
  anthropic: { messages: anthropic },
  google: { generate: google, interactions: googleInteractions },
  openai: { responses: openaiResponses, completions: openaiCompletions },
  xai: {
    responses: new XAIResponsesAdapter({ apiKey: K }),
    completions: new XAIAdapter({ apiKey: K }),
  },
  openrouter: {
    responses: new OpenRouterResponsesAdapter({ apiKey: K }),
    completions: new OpenRouterAdapter({ apiKey: K }),
  },
};

const reg = makeRegistry({
  anthropic,
  google,
  openaiResponses,
  openaiCompletions,
  googleInteractions,
});

const byId = WIRE_SPECS as unknown as Map<string, SpecDelta>;
const cache = new Map<string, WireSpec>();
const spec = (id: string): WireSpec => {
  let s = cache.get(id);
  if (!s) {
    s = resolveSpec(id, byId);
    cache.set(id, s);
  }
  return s;
};

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();
const subjects = subjectsFrom(catalog.list() as ModelInfo[], adapters);
const byProvider = (p: string) => subjects.filter((s) => s.provider === p);

describe('every catalogued chat model reproduces its adapter through its pinned spec', () => {
  it('has subjects for every provider, so the sweep cannot be vacuous', () => {
    const short = Object.entries(FLOOR)
      .filter(([p, n]) => byProvider(p).length < n)
      .map(([p, n]) => `${p}: ${byProvider(p).length} subjects, expected >= ${n}`);
    expect(short).toEqual([]);
  });

  for (const provider of Object.keys(FLOOR)) {
    it(provider, () => {
      const failures: string[] = [];
      let comparisons = 0;

      for (const s of byProvider(provider)) {
        for (const shape of SHAPES) {
          const req = shape.req(s.model) as never;
          comparisons++;
          let real: string;
          let built: string;
          try {
            real = onWire(s.adapter.buildRequest(req));
          } catch (e) {
            failures.push(`${s.model} ${shape.name}: adapter threw ${(e as Error).message}`);
            continue;
          }
          try {
            built = onWire(buildFromSpec(spec(s.specId), req, reg, s.flavor));
          } catch (e) {
            failures.push(`${s.model} ${shape.name}: spec ${s.specId} threw ${(e as Error).message}`);
            continue;
          }
          if (real !== built) {
            failures.push(
              `${s.model} ${shape.name} (${s.specId}):\n    adapter: ${real}\n    spec:    ${built}`,
            );
          }
        }
      }

      // Report at most a few: one systemic gap otherwise prints thousands of lines.
      expect({ ran: comparisons > 0, failures: failures.slice(0, 5) }).toEqual({
        ran: true,
        failures: [],
      });
    });
  }
});
