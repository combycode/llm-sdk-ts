/** Every catalogued chat model, through its OWN pinned spec, against its real
 *  adapter. All of them, on every CI run.
 *
 *  `catalog-pins.test.ts` proves the pins are well-formed and that Anthropic and
 *  Google models get the thinking shape their traits declare. That is 26 models.
 *  It leaves the other 263 — 224 of them OpenRouter — protected by nothing but
 *  "the pin names a spec that resolves", which a typo satisfies.
 *
 *  This closes that. For each catalogued chat model it builds a corpus of request
 *  shapes twice — once through the hand-written adapter, once by interpreting the
 *  spec THE CATALOG PINS IT TO — and requires the two wire payloads to be
 *  identical.
 *
 *  Reading the pin from the catalog is the point. The migration rehearsal in
 *  `wire-spec-lab` computes the pin from the model's version instead, so it
 *  validates the derivation RULE and would not notice a mistyped `wireSpec` in
 *  the catalog JSON — which is the artifact that actually ships.
 *
 *  The whole sweep is ~4,900 comparisons and runs in well under a second, so
 *  there is no cost argument for sampling it.
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
import type { NormalizedRequest } from '../../../src/llm/types/request';

const K = 'k';
const anthropic = new AnthropicAdapter({ apiKey: K });
const google = new GoogleAdapter({ apiKey: K });
const openaiResponses = new OpenAIResponsesAdapter({ apiKey: K });
const openaiCompletions = new OpenAIAdapter({ apiKey: K });
const xai = new XAIAdapter({ apiKey: K });
const xaiResponses = new XAIResponsesAdapter({ apiKey: K });
const openrouter = new OpenRouterAdapter({ apiKey: K });
const openrouterResponses = new OpenRouterResponsesAdapter({ apiKey: K });

const reg = makeRegistry({
  anthropic,
  google,
  openaiResponses,
  openaiCompletions,
  googleInteractions: new GoogleInteractionsAdapter({ apiKey: K }),
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

/** What the provider actually receives, as a comparable string.
 *
 *  `undefined` is dropped, and OBJECT keys are sorted — the adapter emits fields
 *  in the order its code assigns them, the interpreter in the order the spec
 *  lists its rules, and JSON object order carries no meaning to any of these
 *  APIs. Array order is left alone: `messages` and `tools` are sequences, and
 *  reordering those would be a real defect. */
const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] !== undefined) out[k] = canon(src[k]);
    }
    return out;
  }
  return v;
};
const onWire = (v: unknown) => JSON.stringify(canon(JSON.parse(JSON.stringify(v ?? null))));

// ── the corpus: request shapes that are meaningful for any chat model ────────
const U = [{ role: 'user', content: 'hi' }];
const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
const FN = { type: 'function', name: 'get_weather', description: 'w', parameters: SCHEMA };

const shapes: Array<{ name: string; req: (model: string) => Record<string, unknown> }> = [
  { name: 'minimal', req: (model) => ({ model, messages: U }) },
  {
    name: 'sampling',
    req: (model) => ({
      model,
      messages: U,
      maxTokens: 256,
      temperature: 0.3,
      topP: 0.8,
      topK: 5,
      seed: 7,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stop: ['x'],
    }),
  },
  { name: 'system', req: (model) => ({ model, messages: U, system: 'sys' }) },
  { name: 'tools', req: (model) => ({ model, messages: U, tools: [FN] }) },
  {
    name: 'tools.strict',
    req: (model) => ({ model, messages: U, tools: [{ ...FN, strict: true }] }),
  },
  {
    name: 'tools.builtin',
    req: (model) => ({
      model,
      messages: U,
      tools: [{ type: 'web_search' }, { type: 'code_interpreter' }, { type: 'web_fetch' }],
    }),
  },
  {
    name: 'toolChoice.required',
    req: (model) => ({ model, messages: U, tools: [FN], toolChoice: 'required' }),
  },
  {
    name: 'toolChoice.named',
    req: (model) => ({ model, messages: U, tools: [FN], toolChoice: { name: 'get_weather' } }),
  },
  { name: 'thinking.on', req: (model) => ({ model, messages: U, thinking: { mode: 'on' } }) },
  {
    name: 'thinking.effort',
    req: (model) => ({ model, messages: U, thinking: { mode: 'on', effort: 'high' } }),
  },
  {
    name: 'thinking.hidden',
    req: (model) => ({
      model,
      messages: U,
      thinking: { mode: 'on', visibility: 'hidden', effort: 'low' },
    }),
  },
  { name: 'thinking.off', req: (model) => ({ model, messages: U, thinking: { mode: 'off' } }) },
  {
    name: 'thinking.lowMaxTokens',
    req: (model) => ({
      model,
      messages: U,
      maxTokens: 100,
      thinking: { mode: 'on', effort: 'high' },
    }),
  },
  { name: 'structured', req: (model) => ({ model, messages: U, structured: { schema: SCHEMA } }) },
  {
    name: 'structured+thinking',
    req: (model) => ({
      model,
      messages: U,
      thinking: { mode: 'on', effort: 'medium' },
      structured: { schema: SCHEMA },
    }),
  },
  {
    name: 'cache.auto',
    req: (model) => ({ model, messages: U, system: 'sys', cache: 'auto', tools: [FN] }),
  },
  { name: 'tier', req: (model) => ({ model, messages: U, serviceTier: 'priority' }) },
];

// ── subjects: every chat model, with the adapter it really uses ──────────────
interface Subject {
  provider: string;
  /** The id actually SENT to the provider, not the catalog slug. */
  model: string;
  specId: string;
  flavor?: string;
  adapter: { buildRequest: (r: NormalizedRequest) => unknown };
}

/** The adapter a model really runs on, chosen from `preferredApi` — NEVER from
 *  the pin.
 *
 *  Deriving it from `wireSpec` is circular, and quietly so: mis-pin an OpenRouter
 *  model to `openai/responses` and the adapter silently moves to the Responses
 *  one too, so both sides agree and the sweep stays green on a broken pin. It did
 *  exactly that on the first version of this file. `preferredApi` is the catalog's
 *  independent statement of which API the model speaks, so a wrong pin now shows
 *  up as the disagreement it is. */
const ADAPTERS: Record<string, Partial<Record<string, Subject['adapter']>>> = {
  anthropic: { messages: anthropic },
  google: { generate: google },
  openai: { responses: openaiResponses, completions: openaiCompletions },
  xai: { responses: xaiResponses, completions: xai },
  openrouter: { responses: openrouterResponses, completions: openrouter },
};
const FLAVORS: Record<string, string | undefined> = {
  openai: 'openai',
  xai: 'xai',
  openrouter: 'openrouter',
};

function subjectFor(m: ModelInfo): Subject | null {
  const specId = m.wireSpec;
  if (!specId) return null; // `catalog-pins.test.ts` is what fails on an unpinned model.
  const adapter = ADAPTERS[m.provider]?.[m.preferredApi];
  if (!adapter) return null;
  return {
    provider: m.provider,
    model: m.providerModelName ?? m.model,
    specId,
    flavor: FLAVORS[m.provider],
    adapter,
  };
}

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();
const subjects = catalog
  .list()
  .filter((m) => m.type === 'chat')
  .map(subjectFor)
  .filter((s): s is Subject => s !== null);

const byProvider = (p: string) => subjects.filter((s) => s.provider === p);

/** Lower bounds, not exact counts: the catalog gains models routinely, and a
 *  test that fails on a new model would train people to edit the number. It
 *  fails on a provider quietly LOSING its models, which is the accident that
 *  would make the sweep below pass while covering nothing. */
const FLOOR: Record<string, number> = {
  anthropic: 14,
  google: 12,
  openai: 30,
  xai: 5,
  openrouter: 200,
};

describe('every catalogued chat model reproduces its adapter through its pinned spec', () => {
  it('has subjects for every provider, so the sweep cannot be vacuous', () => {
    const short = Object.entries(FLOOR)
      .filter(([p, n]) => byProvider(p).length < n)
      .map(([p, n]) => `${p}: ${byProvider(p).length} subjects, expected >= ${n}`);
    expect(short).toEqual([]);
  });

  for (const provider of Object.keys(FLOOR)) {
    it(provider, () => {
      const models = byProvider(provider);
      const failures: string[] = [];
      let comparisons = 0;

      for (const s of models) {
        for (const shape of shapes) {
          const req = shape.req(s.model) as unknown as NormalizedRequest;
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
