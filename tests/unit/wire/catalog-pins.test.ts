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

describe('the pin agrees with the wire traits', () => {
  /** Drive the pinned spec and read back the shape it chose, so a mismatch
   *  between the two representations fails here rather than in production. */
  const thinkingShapeFromSpec = (m: {
    provider: string;
    wireSpec?: string;
    model: string;
    providerModelName?: string;
  }) => {
    const spec = resolveSpec(m.wireSpec as string, byId);
    const id = m.providerModelName ?? m.model;
    const body = buildFromSpec(spec, req(id, { thinking: { mode: 'on' } }), reg).body as any;
    if (m.provider === 'anthropic') {
      return body.thinking?.type === 'adaptive' ? 'adaptive' : 'budgeted';
    }
    const cfg = body.generationConfig?.thinkingConfig;
    if (!cfg) return undefined;
    return cfg.thinkingBudget !== undefined ? 'budget' : 'level';
  };

  const withThinking = () =>
    chatModels().filter((m) => m.wire?.thinking && (m.provider === 'anthropic' || m.provider === 'google'));

  it('covers a meaningful number of models', () => {
    // Guards against the assertions below passing because the set is empty.
    expect(withThinking().length).toBeGreaterThanOrEqual(26);
  });

  it('the thinking shape the pinned spec produces matches the trait', () => {
    const mismatches: string[] = [];
    for (const m of withThinking()) {
      const fromSpec = thinkingShapeFromSpec(m);
      if (fromSpec !== m.wire?.thinking) {
        mismatches.push(`${m.provider}/${m.model}: trait=${m.wire?.thinking} spec=${fromSpec}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('top_k acceptance matches the trait (anthropic)', () => {
    const mismatches: string[] = [];
    for (const m of chatModels()) {
      if (m.provider !== 'anthropic' || m.wire?.topK === undefined) continue;
      const spec = resolveSpec(m.wireSpec as string, byId);
      const body = buildFromSpec(spec, req(m.providerModelName ?? m.model, { topK: 20 }), reg)
        .body as any;
      const sent = body.top_k !== undefined;
      if (sent !== m.wire.topK) {
        mismatches.push(`${m.provider}/${m.model}: trait=${m.wire.topK} spec=${sent}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
