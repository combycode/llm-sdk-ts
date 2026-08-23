/** The one definition of "every catalogued chat model, across every request shape".
 *
 *  Three things consume this and they MUST agree, or the guarantee is hollow:
 *
 *    every-model-reproduces-its-adapter.test.ts   spec output === adapter output
 *    scripts/freeze-wire-golden.ts                writes the frozen corpus
 *    golden-corpus.test.ts                        output === what 2.3.0 shipped
 *
 *  If the freeze script and the golden test each defined their own shapes, a shape
 *  present in one and absent from the other would leave a silent hole exactly where
 *  the migration needs cover. So the list lives here, once.
 */

import type { ModelInfo } from '../../../src/catalog/catalog';
import type { NormalizedRequest } from '../../../src/llm/types/request';

export interface Shape {
  name: string;
  req: (model: string) => Record<string, unknown>;
}

const U = [{ role: 'user', content: 'hi' }];
const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
const FN = { type: 'function', name: 'get_weather', description: 'w', parameters: SCHEMA };

/** Request shapes that are meaningful for any chat model, on any provider. */
export const SHAPES: Shape[] = [
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

export interface Adapterish {
  buildRequest: (r: NormalizedRequest) => unknown;
}

export interface Subject {
  provider: string;
  /** The id actually SENT to the provider, not the catalog slug. */
  model: string;
  specId: string;
  flavor?: string;
  adapter: Adapterish;
}

/** Which flavor overlay a provider's requests carry on the OpenAI-shaped specs. */
const FLAVORS: Record<string, string | undefined> = {
  openai: 'openai',
  xai: 'xai',
  openrouter: 'openrouter',
};

/** Every catalogued chat model, paired with the adapter it really runs on.
 *
 *  The adapter comes from `preferredApi`, NEVER from `wireSpec`. Deriving it from
 *  the pin is circular and silently so: mis-pin an OpenRouter model to
 *  `openai/responses` and the adapter moves with it, both sides agree, and the
 *  comparison stays green on a broken pin. It did exactly that on the first draft
 *  of the sweep. `preferredApi` is the catalog's independent statement of which
 *  API the model speaks. */
export function subjectsFrom(
  models: ModelInfo[],
  adapters: Record<string, Record<string, Adapterish | undefined>>,
): Subject[] {
  const out: Subject[] = [];
  for (const m of models) {
    if (m.type !== 'chat' || !m.wireSpec) continue;
    const adapter = adapters[m.provider]?.[m.preferredApi];
    if (!adapter) continue;
    out.push({
      provider: m.provider,
      model: m.providerModelName ?? m.model,
      specId: m.wireSpec,
      flavor: FLAVORS[m.provider],
      adapter,
    });
  }
  return out;
}

/** What the provider actually receives, as a comparable string.
 *
 *  `undefined` is dropped and OBJECT keys are sorted — the adapter emits fields in
 *  the order its code assigns them, the interpreter in the order the spec lists its
 *  rules, and JSON object order carries no meaning to any of these APIs. Array order
 *  is left alone: `messages` and `tools` are sequences, and reordering those would
 *  be a real defect. */
export const canon = (v: unknown): unknown => {
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

export const onWire = (v: unknown): string =>
  JSON.stringify(canon(JSON.parse(JSON.stringify(v ?? null))));

/** Lower bounds per provider, so a sweep cannot pass by covering nothing.
 *
 *  Bounds, not exact counts: the catalog gains models routinely and a test that
 *  fails on a NEW model trains people to edit the number until it stops meaning
 *  anything. It fails on a provider quietly LOSING its models, which is the
 *  accident that would hollow out every check built on this corpus. */
export const FLOOR: Record<string, number> = {
  anthropic: 14,
  google: 12,
  openai: 30,
  xai: 5,
  openrouter: 200,
};
