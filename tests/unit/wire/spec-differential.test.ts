/** The wire specs must agree with the hand-written adapters, on every CI run.
 *
 *  The specs are data describing HOW to talk to each provider API, shipped so the
 *  Python and Rust ports consume the same artifact instead of re-deriving it.
 *  Data that is never executed rots, so this test executes it: each case builds
 *  the request twice — once through the real adapter, once by interpreting the
 *  spec — and requires the two to be identical.
 *
 *  This began outside the repo, in `wire-spec-lab`, where it could only be run by
 *  hand. Moving it here is the point: a provider change that updates an adapter
 *  and forgets the spec now fails the build.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../../../src/llm/providers/google/interactions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { XAIAdapter } from '../../../src/llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../../../src/llm/providers/xai/responses';
import { OpenRouterAdapter } from '../../../src/llm/providers/openrouter/completions';
import { OpenRouterResponsesAdapter } from '../../../src/llm/providers/openrouter/responses';
import { buildFromSpec, type WireSpec } from '../../../src/wire/interpreter';
import { resolveSpec, type SpecDelta } from '../../../src/wire/inherit';
import { makeRegistry } from '../../../src/wire/transforms';
import { WIRE_SPECS } from '../../../src/wire/registry';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const K = 'k';
const anthropic = new AnthropicAdapter({ apiKey: K });
const google = new GoogleAdapter({ apiKey: K });
const googleInteractions = new GoogleInteractionsAdapter({ apiKey: K });
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
  googleInteractions,
});

const spec = (id: string): WireSpec =>
  resolveSpec(id, WIRE_SPECS as unknown as Map<string, SpecDelta>);

/** JSON round-trip: `undefined` and key order never reach the wire. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

const U = [{ role: 'user', content: 'hi' }];
const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
const FN = { type: 'function', name: 'get_weather', description: 'w', parameters: SCHEMA };
const req = (extra: Record<string, unknown>): NormalizedRequest =>
  ({ messages: U, ...extra }) as unknown as NormalizedRequest;

interface Case {
  name: string;
  adapter: { buildRequest: (r: NormalizedRequest) => unknown };
  specId: string;
  flavor?: string;
  req: NormalizedRequest;
}

/** One representative case per spec rule family. The exhaustive corpus — 116
 *  cases plus 289 catalogued models across 17 request shapes — lives in
 *  `wire-spec-lab`; this is the subset that guards the contract on every run. */
const cases: Case[] = [
  // ── anthropic/messages, across the version chain ────────────────────────
  {
    name: 'anthropic minimal',
    adapter: anthropic,
    specId: 'anthropic/messages@4.7',
    req: req({ model: 'claude-sonnet-5' }),
  },
  {
    name: 'anthropic sampling + tier',
    adapter: anthropic,
    specId: 'anthropic/messages@4.7',
    req: req({
      model: 'claude-sonnet-5',
      maxTokens: 999,
      temperature: 0.4,
      topP: 0.9,
      stop: ['x'],
      serviceTier: 'priority',
    }),
  },
  {
    name: 'anthropic tools + toolChoice',
    adapter: anthropic,
    specId: 'anthropic/messages@4.7',
    req: req({ model: 'claude-sonnet-5', tools: [FN], toolChoice: 'required' }),
  },
  {
    name: 'anthropic builtins + cache breakpoints',
    adapter: anthropic,
    specId: 'anthropic/messages@4.7',
    req: req({
      model: 'claude-sonnet-5',
      cache: 'auto',
      system: 'sys',
      tools: [FN, { type: 'web_search' }],
    }),
  },
  {
    name: 'anthropic adaptive thinking',
    adapter: anthropic,
    specId: 'anthropic/messages@4.7',
    req: req({ model: 'claude-sonnet-5', thinking: { mode: 'on', effort: 'high' } }),
  },
  {
    name: 'anthropic budgeted thinking (@4.1)',
    adapter: anthropic,
    specId: 'anthropic/messages@4.1',
    req: req({ model: 'claude-haiku-4-5', thinking: { mode: 'on', effort: 'max' } }),
  },
  {
    name: 'anthropic top_k accepted (@4.6)',
    adapter: anthropic,
    specId: 'anthropic/messages@4.6',
    req: req({ model: 'claude-opus-4-6', topK: 20 }),
  },
  {
    name: 'anthropic structured + thinking share output_config',
    adapter: anthropic,
    specId: 'anthropic/messages@4.7',
    req: req({
      model: 'claude-sonnet-5',
      thinking: { mode: 'on', effort: 'medium' },
      structured: { schema: SCHEMA },
    }),
  },

  // ── google/generate, both thinking shapes ───────────────────────────────
  {
    name: 'google minimal',
    adapter: google,
    specId: 'google/generate@3',
    req: req({ model: 'gemini-3-flash' }),
  },
  {
    name: 'google thinkingLevel',
    adapter: google,
    specId: 'google/generate@3',
    req: req({ model: 'gemini-3-flash', thinking: { mode: 'on', effort: 'medium' } }),
  },
  {
    name: 'google thinkingBudget (@2.5)',
    adapter: google,
    specId: 'google/generate@2.5',
    req: req({ model: 'gemini-2.5-flash', thinking: { mode: 'on', effort: 'low' } }),
  },
  {
    name: 'google tools + structured',
    adapter: google,
    specId: 'google/generate@3',
    req: req({
      model: 'gemini-3-flash',
      tools: [FN, { type: 'web_search' }],
      structured: { schema: SCHEMA },
    }),
  },
  {
    name: 'google providerOptions passthrough',
    adapter: google,
    specId: 'google/generate@3',
    req: req({
      model: 'gemini-3-flash',
      providerOptions: { responseModalities: ['TEXT'], cachedContent: 'cc-1' },
    }),
  },

  // ── google/interactions ─────────────────────────────────────────────────
  {
    name: 'interactions minimal',
    adapter: googleInteractions,
    specId: 'google/interactions',
    req: req({ model: 'gemini-3.1-pro' }),
  },
  {
    name: 'interactions everything',
    adapter: googleInteractions,
    specId: 'google/interactions',
    req: req({
      model: 'gemini-3.1-pro',
      system: 'sys',
      maxTokens: 128,
      temperature: 0.1,
      tools: [FN],
      thinking: { mode: 'on', effort: 'medium' },
      structured: { schema: SCHEMA },
    }),
  },

  // ── openai responses + completions, and the flavor overlays ─────────────
  {
    name: 'openai responses tools',
    adapter: openaiResponses,
    specId: 'openai/responses',
    flavor: 'openai',
    req: req({ model: 'gpt-5', tools: [FN, { type: 'code_interpreter' }] }),
  },
  {
    name: 'openai responses reasoning',
    adapter: openaiResponses,
    specId: 'openai/responses',
    flavor: 'openai',
    req: req({
      model: 'gpt-5',
      thinking: { mode: 'on', visibility: 'summary' },
      providerOptions: { reasoningMode: 'pro' },
    }),
  },
  {
    name: 'openai completions structured',
    adapter: openaiCompletions,
    specId: 'openai/chat-completions',
    flavor: 'openai',
    req: req({ model: 'gpt-5', structured: { schema: SCHEMA } }),
  },
  {
    name: 'xai completions overlay',
    adapter: xai,
    specId: 'openai/chat-completions',
    flavor: 'xai',
    req: req({ model: 'grok-4', maxTokens: 222, topK: 7, thinking: { mode: 'on' } }),
  },
  {
    name: 'xai responses overlay',
    adapter: xaiResponses,
    specId: 'openai/responses',
    flavor: 'xai',
    req: req({
      model: 'grok-4',
      system: 'sys',
      seed: 5,
      thinking: { mode: 'on' },
      serviceTier: 'flex',
    }),
  },
  {
    name: 'openrouter completions overlay',
    adapter: openrouter,
    specId: 'openai/chat-completions',
    flavor: 'openrouter',
    req: req({
      model: 'openai/gpt-5',
      maxTokens: 333,
      tools: [{ type: 'web_search' }],
      providerOptions: { openrouter: { provider: { order: ['a'] } } },
    }),
  },
  {
    name: 'openrouter responses overlay',
    adapter: openrouterResponses,
    specId: 'openai/responses',
    flavor: 'openrouter',
    req: req({ model: 'openai/gpt-5', providerOptions: { openrouter: { transforms: ['x'] } } }),
  },
];

describe('wire specs reproduce the adapters', () => {
  for (const c of cases) {
    it(c.name, () => {
      const real = wire(c.adapter.buildRequest(c.req));
      const built = wire(buildFromSpec(spec(c.specId), c.req, reg, c.flavor));
      expect(built).toEqual(real);
    });
  }
});

describe('the shipped spec set is intact', () => {
  it('every spec resolves, including through its inheritance chain', () => {
    for (const id of WIRE_SPECS.keys()) {
      expect(() => spec(id)).not.toThrow();
    }
  });

  it('ships the whole set, so a dropped file is a failure not a silent gap', () => {
    expect(WIRE_SPECS.size).toBe(71);
  });
});
