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
  /** A shape that CANNOT be obtained from a live provider on demand.
   *
   *  A provider does not fail to order, and provoking a real 200-with-failure
   *  means either abusing a safety filter or waiting for an outage. The parse
   *  branches for it are real and were completely uncovered, so the body is
   *  CONSTRUCTED — from the target's own recorded envelope, with only the
   *  failure fields changed, and every changed field traceable to the official
   *  SDK type named in `provenance`.
   *
   *  These cells are marked `synthetic: true` in the corpus so nothing mistakes
   *  them for evidence of what a provider actually sent. */
  synthetic?: {
    /** Scenario whose RECORDED raw envelope this starts from. Using a real
     *  envelope means every field except the failure itself is genuine, and it
     *  tracks the provider when that recording is refreshed. */
    from: string;
    /** Where the constructed fields come from. Cite a type, not a belief. */
    provenance: string;
    /** Per-target transform of the recorded envelope. */
    build: Record<string, (raw: Record<string, unknown>) => unknown>;
  };
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
    /** The prompt-cache diagnosis, which only two providers report and which no
     *  other cell carries. Recorded against an id that cannot exist, because
     *  that is the one outcome a recorder can produce ON DEMAND: a hit needs a
     *  prior request inside the cache window, and a miss needs a prior request
     *  that differs in a chosen way. Both providers answer HTTP 200 to an
     *  unknown id (measured 2026-09-29), so this is a normal response body and
     *  not an error path.
     *
     *  It also pins the field Anthropic now sends on EVERY response:
     *  `diagnostics`, null unless asked for. Without a cell that carries it,
     *  `checkResponseShapes` reports it as a new field forever. */
    name: 'cache.diagnostics',
    streaming: false,
    targets: ['anthropic/messages'],
    input: 'Reply with exactly: OK',
    options: {
      maxTokens: 16,
      cacheDiagnostics: { compareWith: 'msg_01DoesNotExistAtAll000000' },
    },
  },
  {
    /** Same shape, declared separately because the model differs: OpenAI gates
     *  diagnostics to gpt-5.6 and later. Measured on the corpus's own
     *  gpt-5.4-nano, the identical request answers `unavailable` -- which would
     *  have recorded a cell that proves nothing and reads as a working one. */
    name: 'cache.diagnostics',
    streaming: false,
    targets: ['openai/responses'],
    model: 'gpt-5.6-luna',
    input: 'Reply with exactly: OK',
    options: {
      maxTokens: 16,
      cacheDiagnostics: { compareWith: 'resp_000000000000000000000000000000000000000000000000' },
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
      // OpenRouter's `:online` search leaves no tool-call item -- url_citation
      // annotations are the only signal it ran -- so the rule that reads them
      // was unproven until this target was added. Deleting that rule left the
      // whole differential green.
      'openrouter/completions',
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

  // —— streaming variants of the shapes above ——————————
  // Measured on 2026-09-01: the 14 streaming cells produced only `usage`, `done`,
  // `text`, `tool_call_*` and `thinking`. NINE of the sixteen StreamEvent types
  // had no coverage at all — media_start/chunk/end, file, citation,
  // builtin_tool_start/end, error and moderation — and those are exactly the
  // STATEFUL branches: the accumulate-then-pair machines, the emit-once-per-stream
  // flags, the three-event media reassembly. A stream parser is where sequencing
  // bugs live, and none of that sequencing was being watched.

  {
    name: 'stream.builtin.search',
    streaming: true,
    // builtin_tool_start/end, and the citation events the answer emits as it goes.
    targets: [
      'anthropic/messages',
      'openai/responses',
      'google/generate',
      'google/interactions',
      'xai/responses',
      // OpenRouter's `:online` search leaves no tool-call item -- url_citation
      // annotations are the only signal it ran -- so the rule that reads them
      // was unproven until this target was added. Deleting that rule left the
      // whole differential green.
      'openrouter/completions',
    ],
    input: 'Search the web for the current population of Reykjavik, and cite your source.',
    options: { tools: [{ type: 'web_search' }], maxTokens: 512 },
  },
  {
    name: 'stream.builtin.codeexec',
    streaming: true,
    // The hardest path in any of the parsers: a server_tool_use whose input JSON
    // arrives in fragments, is parsed at content_block_stop, keyed by id, and then
    // paired with a *_tool_result block that may also carry `file` events.
    targets: ['anthropic/messages', 'openai/responses', 'google/generate'],
    input:
      'Use the code tool to compute the first 12 Fibonacci numbers and write them to a CSV file.',
    options: { tools: [{ type: 'code_interpreter' }], maxTokens: 1024 },
  },
  {
    name: 'stream.media.audio',
    streaming: true,
    // media_start / media_chunk / media_end. The sandbox reassembles a data: URL
    // from these three and renders it; nothing has ever tested the sequence.
    targets: ['openai/completions'],
    model: 'gpt-audio',
    input: 'Say exactly: OK',
    options: {
      maxTokens: 64,
      outputModalities: ['text', 'audio'],
      // pcm16, not mp3: OpenAI refuses anything else when stream=true
      // ("'audio.format' does not support 'mp3' when stream=true"). The buffered
      // cell above asks for mp3 on purpose — the two formats take different
      // branches, and neither was recorded before.
      audio: { voice: 'alloy', format: 'pcm16' },
    },
  },
  {
    name: 'stream.thinking',
    streaming: true,
    targets: ['anthropic/messages', 'openai/responses', 'google/generate', 'xai/responses'],
    input: 'A farmer has 17 sheep. All but 9 run away. How many are left? Reason it through.',
    options: { thinking: { mode: 'on', effort: 'low' }, maxTokens: 2048 },
  },
  {
    name: 'stream.moderation',
    streaming: true,
    targets: ['openai/completions', 'openai/responses'],
    input: 'Reply with exactly: OK',
    options: { maxTokens: 16, moderation: { input: true, output: true } },
  },

  {
    /** The miss branch of both mappers, each in its provider's own vocabulary.
     *  `system_changed` stands for Anthropic's four `*_changed` values, which
     *  share one shape; OpenAI's `input_changed` is one of nine and carries a
     *  second token count nobody else reports. */
    name: 'cache.diagnostics.miss',
    streaming: false,
    targets: ['anthropic/messages', 'openai/responses'],
    input: '(synthetic)',
    options: {},
    synthetic: {
      from: 'cache.diagnostics',
      provenance: 'Bodies MEASURED on 2026-09-29, not read out of a type: claude-haiku-4-5 on GA /v1/messages and gpt-5.6-luna on /v1/responses, each with a ~10k-token cached prefix. Synthetic only because one recorded cell is ONE request, and a hit or a chosen miss needs a prior request to compare against.',
      build: {
        'anthropic/messages': (raw) => ({
          ...raw,
          diagnostics: {
            cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 9197 },
          },
        }),
        'openai/responses': (raw) => ({
          ...raw,
          prompt_cache_diagnostics: {
            type: 'cache_miss',
            reason: 'input_changed',
            cache_missed_tokens: 10052,
            comparison_reusable_tokens: 10052,
          },
        }),
      },
    },
  },
  {
    /** OpenAI only. Anthropic reports a hit by saying nothing at all, which every
     *  other recorded cell already shows. */
    name: 'cache.diagnostics.hit',
    streaming: false,
    targets: ['openai/responses'],
    input: '(synthetic)',
    options: {},
    synthetic: {
      from: 'cache.diagnostics',
      provenance: 'Bodies MEASURED on 2026-09-29, not read out of a type: claude-haiku-4-5 on GA /v1/messages and gpt-5.6-luna on /v1/responses, each with a ~10k-token cached prefix. Synthetic only because one recorded cell is ONE request, and a hit or a chosen miss needs a prior request to compare against.',
      build: {
        'openai/responses': (raw) => ({ ...raw, prompt_cache_diagnostics: { type: 'cache_hit' } }),
      },
    },
  },
  {
    /** "I have nothing to diagnose" -- the common answer when the prompt is too
     *  small to cache, and on OpenAI also what a model before gpt-5.6 always
     *  returns. Measured on gpt-5.4-nano, which answers this to every request. */
    name: 'cache.diagnostics.unavailable',
    streaming: false,
    targets: ['anthropic/messages', 'openai/responses'],
    input: '(synthetic)',
    options: {},
    synthetic: {
      from: 'cache.diagnostics',
      provenance: 'Bodies MEASURED on 2026-09-29, not read out of a type: claude-haiku-4-5 on GA /v1/messages and gpt-5.6-luna on /v1/responses, each with a ~10k-token cached prefix. Synthetic only because one recorded cell is ONE request, and a hit or a chosen miss needs a prior request to compare against.',
      build: {
        'anthropic/messages': (raw) => ({
          ...raw,
          diagnostics: { cache_miss_reason: { type: 'unavailable' } },
        }),
        'openai/responses': (raw) => ({
          ...raw,
          prompt_cache_diagnostics: { type: 'unavailable' },
        }),
      },
    },
  },
  {
    name: 'error',
    streaming: false,
    // Both adapters carry a branch for a failure reported INSIDE a 200, where
    // there is no exception to catch: OpenAI Responses maps `status:'failed'` to
    // finishReason 'error' and lifts `response.error` into `CompletionResponse.error`;
    // Google Interactions maps its own `status:'failed'` the same way. Without
    // this the caller sees an empty success.
    targets: ['openai/responses', 'google/interactions'],
    input: '(synthetic)',
    options: {},
    synthetic: {
      from: 'text',
      provenance:
        'openai-ts 7.4.0 `ResponseError` (code is a closed enum; `server_error` is a member) ' +
        'with `Response.status: ResponseStatus` = failed. google/interactions status per our ' +
        'own adapter mapping, matching the recorded envelope key `status`. Its `errors[]` is ' +
        'google-ts `Interaction.errors: Array<ErrorT>` with `ErrorT {code?, message?}` -- ' +
        'TYPE-DERIVED, not measured: a platform fault cannot be provoked on demand.',
      build: {
        'openai/responses': (raw) => ({
          ...raw,
          status: 'failed',
          error: { code: 'server_error', message: 'The model failed to generate a response.' },
          incomplete_details: null,
          output: [],
        }),
        // `errors[]` is what a failed interaction records; without it the
        // caller gets `finishReason: 'error'` and no reason at all.
        'google/interactions': (raw) => ({
          ...raw,
          status: 'failed',
          steps: [],
          errors: [
            {
              code: 'https://developers.google.com/errors/internal',
              message: 'The model failed to generate a response.',
            },
          ],
        }),
      },
    },
  },
  {
    name: 'error.content_filter',
    streaming: false,
    // A DIFFERENT branch: `status:'incomplete'` with `incomplete_details.reason`
    // of 'content_filter' must not be reported as a length truncation, which is
    // what the shared finish-reason table would otherwise do.
    targets: ['openai/responses'],
    input: '(synthetic)',
    options: {},
    synthetic: {
      from: 'text',
      provenance:
        'openai-ts 7.4.0 `Response.incomplete_details` + `Response.status` = incomplete. ' +
        'Distinguished from max_output_tokens, which maps to length.',
      build: {
        'openai/responses': (raw) => ({
          ...raw,
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
          error: null,
          output: [],
        }),
      },
    },
  },
  {
    name: 'error.misalignment',
    streaming: false,
    // The richest error body the Responses API sends, and the one that used to
    // arrive emptiest: a numeric code was dropped for not being a string, and
    // `misalignment` was not read at all -- so a safety block that explained
    // itself, and offered a continuation, reached the caller as a bare message.
    targets: ['openai/responses'],
    input: '(synthetic)',
    options: {},
    synthetic: {
      from: 'text',
      provenance:
        'openai-ts 7.4.0 `ResponseError.misalignment` + the `misalignment_policy_violation` ' +
        'code member, both added 2026-09. `error_type` is documented as open ("clients must ' +
        'accept additional values"). TYPE-DERIVED, not measured: provoking a real safety ' +
        'block to record one is neither reliable nor something to automate.',
      build: {
        'openai/responses': (raw) => ({
          ...raw,
          status: 'failed',
          error: {
            code: 'misalignment_policy_violation',
            message: 'Blocked by the safety systems.',
            misalignment: {
              detailed_explanation: 'The requested action would have sent private file contents to an external address.',
              error_type: 'potentially_unintended_data_transfer',
              steer: { message: 'Confirm the recipient with the user before sending anything.' },
            },
          },
          incomplete_details: null,
          output: [],
        }),
      },
    },
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
  /** Present and true only for CONSTRUCTED bodies. Absent means a provider sent
   *  these exact bytes. */
  synthetic?: true;
  /** For synthetic cells: what was changed and on whose authority. */
  provenance?: string;
  raw: unknown;
  parsed: unknown;
}

export const cellId = (target: string, scenario: string) => `${target}::${scenario}`;
