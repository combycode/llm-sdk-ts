/** What the response corpus IS — the targets, the scenarios, and how to rebuild
 *  the adapter that produced a recording.
 *
 *  Kept as plain data here, like the wire corpus, so the recorder and the
 *  differential cannot disagree about what a case is. The recorder drives real
 *  providers and writes `tests/fixtures/response-golden.json`; the differential
 *  replays those bytes through the same adapters with no network at all.
 *
 *  `adapterFor` mirrors `defaultAdapterFactory` in `src/helpers/llm.ts`. It has
 *  to: `LLMClient.adapter` is private, so the only way to replay a recording is
 *  to construct the same adapter a caller's `createLLM` would have.
 */

import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../../../src/llm/providers/google/interactions';
import { XAIAdapter } from '../../../src/llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../../../src/llm/providers/xai/responses';
import { OpenRouterAdapter } from '../../../src/llm/providers/openrouter/completions';
import { OpenRouterResponsesAdapter } from '../../../src/llm/providers/openrouter/responses';
import { resolveApi } from '../../../src/llm/client-internal';
import type { ApiType, ProviderAdapter } from '../../../src/llm/types/provider';
import type { ExecuteOptions } from '../../../src/llm/types/options';
import type { FunctionTool } from '../../../src/llm/types/tools';

export type ApiKind = 'responses' | 'completions' | 'interactions';

/** One parse implementation under test. */
export interface ResponseTarget {
  key: string;
  provider: 'anthropic' | 'openai' | 'google' | 'xai' | 'openrouter';
  /** OS-keyring account the recorder resolves a key from. Unused when replaying. */
  keyring: string;
  model: string;
  api?: ApiKind;
}

export const RESPONSE_TARGETS: ResponseTarget[] = [
  { key: 'anthropic/messages', provider: 'anthropic', keyring: 'claude', model: 'claude-haiku-4.5' },
  { key: 'openai/responses', provider: 'openai', keyring: 'openai', model: 'gpt-5.4-nano', api: 'responses' },
  { key: 'openai/completions', provider: 'openai', keyring: 'openai', model: 'gpt-5.4-nano', api: 'completions' },
  { key: 'google/generate', provider: 'google', keyring: 'gemini', model: 'gemini-3.1-flash-lite' },
  {
    key: 'google/interactions',
    provider: 'google',
    keyring: 'gemini',
    model: 'gemini-3.1-flash-lite',
    api: 'interactions',
  },
  // xAI's default is the Responses API — the key says so, rather than leaving a
  // reader to assume completions from the name.
  { key: 'xai/responses', provider: 'xai', keyring: 'grok', model: 'grok-4.3' },
  { key: 'openrouter/completions', provider: 'openrouter', keyring: 'openrouter', model: 'openai/gpt-5.4-nano' },
];

/** The key is never used when replaying — the adapter only parses — but the
 *  constructors require one, so replay passes a placeholder that could not be a
 *  real credential if it ever escaped into a request. */
export const REPLAY_KEY = 'replay-no-network';

export function adapterFor(target: ResponseTarget, apiKey: string): ProviderAdapter {
  const cfg = { apiKey };
  // `resolveApi` is the library's own default-picker, not a copy of it. The first
  // version of this file hard-coded "xai -> completions" and recorded six xAI
  // cells through the wrong parser: xAI defaults to the RESPONSES api, so the
  // recorded events were `response.*` and the completions parser returned nothing
  // at all for them.
  const api = resolveApi(target.provider, target.api as ApiType | undefined);
  switch (target.provider) {
    case 'anthropic':
      return new AnthropicAdapter(cfg);
    case 'openai':
      return api === 'responses' ? new OpenAIResponsesAdapter(cfg) : new OpenAIAdapter(cfg);
    case 'google':
      return api === 'interactions' ? new GoogleInteractionsAdapter(cfg) : new GoogleAdapter(cfg);
    case 'xai':
      return api === 'responses' ? new XAIResponsesAdapter(cfg) : new XAIAdapter(cfg);
    case 'openrouter':
      return api === 'responses' ? new OpenRouterResponsesAdapter(cfg) : new OpenRouterAdapter(cfg);
    default:
      throw new Error(`response corpus: no adapter for '${target.provider}'`);
  }
}

const WEATHER_TOOL: FunctionTool = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' as const } },
    required: ['city'],
    additionalProperties: false,
  },
};

/** The SHAPES a parser has to survive, not the features a user cares about. Each
 *  reaches a different branch: usage and finish reason; tool-call assembly; two
 *  calls in one response; schema-constrained text; and the two streaming paths,
 *  where state accumulates across events and a single misread event corrupts
 *  everything after it. */
export interface ResponseScenario {
  name: string;
  streaming: boolean;
  /** `LLMClient.complete(input, options)` — the same two arguments a caller
   *  passes, so a recording exercises the production path and nothing else. */
  input: string;
  options: ExecuteOptions;
}

export const RESPONSE_SCENARIOS: ResponseScenario[] = [
  {
    name: 'text',
    streaming: false,
    input: 'Reply with exactly: OK',
    options: { maxTokens: 16 },
  },
  {
    name: 'tools',
    streaming: false,
    input: 'What is the weather in Paris? Use the tool.',
    options: { tools: [WEATHER_TOOL], maxTokens: 128 },
  },
  {
    name: 'tools.parallel',
    streaming: false,
    input: 'Get the weather for BOTH Paris and Tokyo. Call the tool once per city.',
    options: { tools: [WEATHER_TOOL], maxTokens: 256 },
  },
  {
    name: 'structured',
    streaming: false,
    input: 'Give the city and its country for the Eiffel Tower.',
    options: {
      maxTokens: 128,
      structured: {
        name: 'place',
        strict: true,
        schema: {
          type: 'object',
          properties: { city: { type: 'string' }, country: { type: 'string' } },
          required: ['city', 'country'],
          additionalProperties: false,
        },
      },
    },
  },
  {
    name: 'stream.text',
    streaming: true,
    input: 'Count from 1 to 5, separated by spaces.',
    options: { maxTokens: 64 },
  },
  {
    name: 'stream.tools',
    streaming: true,
    input: 'What is the weather in Paris? Use the tool.',
    options: { tools: [WEATHER_TOOL], maxTokens: 128 },
  },
];

/** One recorded cell. `raw` is the provider's truth; `parsed` is our behaviour at
 *  the moment of recording, which the differential recomputes. */
export interface ResponseCell {
  target: string;
  scenario: string;
  provider: string;
  model: string;
  api?: ApiKind;
  streaming: boolean;
  recordedAt: string;
  raw: unknown;
  parsed: unknown;
}

export const cellId = (target: string, scenario: string) => `${target}::${scenario}`;
