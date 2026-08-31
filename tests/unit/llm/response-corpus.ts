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
  /** Target keys this scenario applies to. Omitted means every target.
   *
   *  Not every shape exists everywhere: Chat Completions has no hosted web
   *  search, and only `gpt-audio` returns audio. Recording a cell that cannot
   *  exist would fail forever and teach nothing, so the matrix is declared
   *  rather than assumed to be the full cross product. */
  targets?: string[];
  /** Model override. `media.audio` needs `gpt-audio`; the target's own model
   *  cannot produce the shape. */
  model?: string;
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

  // —— the six scenarios above leave most of CompletionResponse unrecorded ——————
  // Measured against the corpus on 2026-08-31: `citations`, `files`,
  // `builtinToolCalls`, `media`, `moderation` and `error` appeared in ZERO
  // buffered cells, and `thinking` in xai/responses alone. Every one of those is
  // an optional field, so a parser that stopped producing it would keep the
  // differential green. These add the missing shapes.

  {
    name: 'builtin.search',
    streaming: false,
    // Hosted web search is the only source of `citations`, and with
    // `builtin.codeexec` one of two sources of `builtinToolCalls` — the durable
    // record of what the provider ran server-side.
    targets: [
      'anthropic/messages',
      'openai/responses',
      'google/generate',
      'google/interactions',
      'xai/responses',
    ],
    input: 'Search the web for the current population of Reykjavik, and cite your source.',
    options: { tools: [{ type: 'web_search' }], maxTokens: 512 },
  },
  {
    name: 'builtin.codeexec',
    streaming: false,
    // The only path that fills `files`: the hosted tool writes an artifact and
    // reports an id to fetch. `filesFromCodeExecBlock` in the Anthropic adapter
    // walks two block-type generations to find it and had no recorded example.
    targets: ['anthropic/messages', 'openai/responses', 'google/generate'],
    input:
      'Use the code tool to compute the first 12 Fibonacci numbers and write them to a CSV file.',
    options: { tools: [{ type: 'code_interpreter' }], maxTokens: 1024 },
  },
  {
    name: 'media.audio',
    streaming: false,
    // The only path that fills `media` on a chat response. gpt-audio returns
    // `message.audio`, whose transcript becomes the text and whose bytes become
    // an audio_output part — `message.content` is null throughout.
    targets: ['openai/completions'],
    model: 'gpt-audio',
    input: 'Say exactly: OK',
    options: {
      maxTokens: 64,
      outputModalities: ['text', 'audio'],
      // mp3, not wav: the parse path is identical (a base64 blob and a mimeType)
      // but an uncompressed wav recording was 577 KB — two thirds of the whole
      // corpus for one cell, in a file every test run reads.
      audio: { voice: 'alloy', format: 'mp3' },
    },
  },
  {
    name: 'thinking',
    streaming: false,
    // `thinking` was recorded for xai/responses only. Each provider puts
    // reasoning somewhere different — an Anthropic `thinking` block, an OpenAI
    // `reasoning` output item — so one recording proved nothing about the others.
    targets: ['anthropic/messages', 'openai/responses', 'google/generate', 'xai/responses'],
    input: 'A farmer has 17 sheep. All but 9 run away. How many are left? Reason it through.',
    options: { thinking: { mode: 'on', effort: 'low' }, maxTokens: 2048 },
  },
  {
    name: 'moderation',
    streaming: false,
    // Report-only: it attaches a ModerationReport and never blocks. Restricted
    // to OpenAI targets because every other provider takes the EMULATED path,
    // which needs a second (OpenAI) key — a recording that depended on two
    // credentials would fail for reasons unrelated to parsing.
    targets: ['openai/completions', 'openai/responses'],
    input: 'Reply with exactly: OK',
    options: { maxTokens: 16, moderation: { input: true, output: true } },
  },
];

/** Does this scenario apply to this target? */
export function appliesTo(scenario: ResponseScenario, target: ResponseTarget): boolean {
  return !scenario.targets || scenario.targets.includes(target.key);
}

/** Every cell the corpus is supposed to hold.
 *
 *  The recorder and the differential both read THIS, so "what is missing" cannot
 *  drift between the thing that writes the corpus and the thing that checks it. */
export function expectedCells(): Array<{ target: ResponseTarget; scenario: ResponseScenario }> {
  const out: Array<{ target: ResponseTarget; scenario: ResponseScenario }> = [];
  for (const target of RESPONSE_TARGETS) {
    for (const scenario of RESPONSE_SCENARIOS) {
      if (appliesTo(scenario, target)) out.push({ target, scenario });
    }
  }
  return out;
}

/** The model a cell records against: the scenario's override, else the target's. */
export const modelFor = (target: ResponseTarget, scenario: ResponseScenario): string =>
  scenario.model ?? target.model;

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
