/** Every catalogued chat model points at a wire spec, and the pin agrees with the
 *  model's wire traits.
 *
 *  Two representations of the same knowledge now exist: `ModelInfo.wire` (the
 *  traits today's hand-written adapters read) and `ModelInfo.wireSpec` (the spec
 *  that will build the request in 3.0.0). Two representations drift — that is
 *  what happened between `complete()` and `stream()`, and between the adapters
 *  and the model-id regexes before that.
 *
 *  So this test refuses to let them: it drives the PINNED SPEC and asserts the
 *  request it produces matches what the traits say the model takes. When the
 *  adapters become spec-driven, `wire` disappears and only the pin remains — and
 *  this test is what makes that swap safe.
 */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { WIRE_SPECS } from '../../../src/wire/registry';
import { resolveSpec, type SpecDelta } from '../../../src/wire/inherit';
import { buildFromSpec } from '../../../src/wire/interpreter';
import { makeRegistry } from '../../../src/llm/wire-transforms';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const K = 'k';
const reg = makeRegistry({
  anthropic: new AnthropicAdapter({ apiKey: K }),
  google: new GoogleAdapter({ apiKey: K }),
  openaiResponses: new OpenAIResponsesAdapter({ apiKey: K }),
  openaiCompletions: new OpenAIAdapter({ apiKey: K }),
});

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();

const byId = WIRE_SPECS as unknown as Map<string, SpecDelta>;

const chatModels = () =>
  catalog.list().filter((m) => m.type === 'chat');

const req = (model: string, extra: Record<string, unknown> = {}): NormalizedRequest =>
  ({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }) as unknown as NormalizedRequest;

describe('catalog wire-spec pins', () => {
  it('every catalogued chat model is pinned', () => {
    const unpinned = chatModels()
      .filter((m) => !m.wireSpec)
      .map((m) => `${m.provider}/${m.model}`);
    expect(unpinned).toEqual([]);
  });

  it('every pin names a spec that ships', () => {
    const dangling = [
      ...new Set(
        chatModels()
          .filter((m) => m.wireSpec && !WIRE_SPECS.has(m.wireSpec))
          .map((m) => m.wireSpec as string),
      ),
    ];
    expect(dangling).toEqual([]);
  });

  it('every pinned spec resolves through its chain', () => {
    for (const id of new Set(chatModels().map((m) => m.wireSpec as string))) {
      expect(() => resolveSpec(id, byId)).not.toThrow();
    }
  });

  it('pins only the specs that are actually reachable, and all of them', () => {
    const used = new Set(chatModels().map((m) => m.wireSpec as string));
    // The chat specs the SDK ships. `@4.0` is reachable: the two retired 4.0 ids.
    expect([...used].sort()).toEqual([
      'anthropic/messages@4.0',
      'anthropic/messages@4.1',
      'anthropic/messages@4.6',
      'anthropic/messages@4.7',
      'google/generate@2.5',
      'google/generate@3',
      'openai/chat-completions',
      'openai/responses',
    ]);
  });
});

/** What each chain node promises, written out.
 *
 *  This block used to compare the pin against `ModelInfo.wire` — a second copy of
 *  the same knowledge. With the traits gone there is only one representation, so
 *  the independent side has to be an explicit table: drive every catalogued
 *  model's PINNED spec and require the node it lands on to produce the shape that
 *  node is defined to produce.
 */
const NODE_SHAPE: Record<string, { thinking: 'adaptive' | 'budgeted'; topK: boolean }> = {
  'anthropic/messages@4.0': { thinking: 'budgeted', topK: false },
  'anthropic/messages@4.1': { thinking: 'budgeted', topK: true },
  'anthropic/messages@4.6': { thinking: 'adaptive', topK: true },
  'anthropic/messages@4.7': { thinking: 'adaptive', topK: false },
};
const GOOGLE_NODE: Record<string, 'budget' | 'level'> = {
  'google/generate@2.5': 'budget',
  'google/generate@3': 'level',
};

describe('every pinned model lands on a node that behaves as that node should', () => {
  const anthropicModels = () => chatModels().filter((m) => m.provider === 'anthropic');
  const googleModels = () => chatModels().filter((m) => m.provider === 'google');

  it('covers a meaningful number of models', () => {
    // Guards against the assertions below passing over an empty set.
    expect(anthropicModels().length + googleModels().length).toBeGreaterThanOrEqual(26);
  });

  it('anthropic: thinking shape and top_k match the pinned node', () => {
    const mismatches: string[] = [];
    for (const m of anthropicModels()) {
      const want = NODE_SHAPE[m.wireSpec as string];
      if (!want) {
        mismatches.push(`${m.model}: pinned to ${m.wireSpec}, which this table does not describe`);
        continue;
      }
      const spec = resolveSpec(m.wireSpec as string, byId);
      const id = m.providerModelName ?? m.model;
      const think = (buildFromSpec(spec, req(id, { thinking: { mode: 'on' } }), reg).body as any)
        .thinking;
      const got = think?.type === 'adaptive' ? 'adaptive' : 'budgeted';
      if (got !== want.thinking) {
        mismatches.push(`${m.model} (${m.wireSpec}): want ${want.thinking}, got ${JSON.stringify(think)}`);
      }
      const sent =
        (buildFromSpec(spec, req(id, { topK: 20 }), reg).body as any).top_k !== undefined;
      if (sent !== want.topK) {
        mismatches.push(`${m.model} (${m.wireSpec}): top_k want ${want.topK}, got ${sent}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('google: the thinking control matches the pinned node', () => {
    const mismatches: string[] = [];
    for (const m of googleModels()) {
      const want = GOOGLE_NODE[m.wireSpec as string];
      if (!want) {
        mismatches.push(`${m.model}: pinned to ${m.wireSpec}, which this table does not describe`);
        continue;
      }
      const spec = resolveSpec(m.wireSpec as string, byId);
      const cfg = (
        buildFromSpec(spec, req(m.providerModelName ?? m.model, { thinking: { mode: 'on' } }), reg)
          .body as any
      ).generationConfig?.thinkingConfig;
      const got = cfg?.thinkingBudget !== undefined ? 'budget' : 'level';
      if (got !== want) {
        mismatches.push(`${m.model} (${m.wireSpec}): want ${want}, got ${JSON.stringify(cfg)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
