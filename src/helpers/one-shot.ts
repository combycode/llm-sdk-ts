/** One-shot complete() — single-call helper that hides the ceremony.
 *
 *    const reply = await complete({
 *      provider: 'anthropic',
 *      model: 'claude-haiku-4-5',
 *      apiKey,
 *      system: 'Reply in one sentence.',
 *      prompt: 'What is TypeScript?',
 *      maxTokens: 60,
 *    });
 *    // reply: { text, usage, finishReason, raw }
 *
 *  When `tools` is supplied, the helper internally builds an AgentLoop and
 *  runs the multi-step tool loop. Without tools, it goes through plain
 *  LLMClient.complete. Either way the helper destroys its created client
 *  before returning so callers don't leak. */

import type { AgentTool } from '../agent/types';
import { AgentLoop } from '../agent/loop';
import { parseStructured } from '../llm/client-internal';
import type { LLMClientConfig } from '../llm/client-config';
import type { AudioOptions } from '../llm/types/audio';
import type { ContentPart, Message } from '../llm/types/messages';
import type { CompletionResponse } from '../llm/types/response';
import type { ProviderName } from '../llm/types/provider';
import type { ServiceTier } from '../llm/types/tiers';
import type { BuiltinTool } from '../llm/types/tools';
import { isNamespacedModelId, parseModelId, parseModelTier } from './client-resolver';
import { loadContent } from './content';
import type { EngineHandle } from './engine';
import { coreRegistry } from './engine';
import { estimate } from './estimate';
import type { EstimateBound } from './estimate-types';
import { BudgetExceededError } from './estimate-types';
import { createLLM } from './llm';

export interface CompleteOptions {
  /** Model string. Bare (e.g. `claude-haiku-4-5` — pair with `provider`) or
   *  namespaced (e.g. `anthropic/claude-haiku-4-5`). */
  model: string;
  /** Required when `model` is bare. */
  provider?: ProviderName;
  /** Optional — falls back to `engine.apiKeys[provider]`. */
  apiKey?: string;

  /** Per-call system prompt. */
  system?: string;
  /** Either a string (becomes user message) OR an explicit messages array. */
  prompt: string | ContentPart[] | Message[];
  /** Inline media / file parts to append to the user message. Each entry may be:
   *    - a string path or `http(s)://` URL → auto-loaded as an image part
   *    - a `Uint8Array`                    → auto-loaded as an image part
   *    - a `ContentPart`                   → used as-is
   *  Sugar over `prompt: [...{role:'user', content:[...attachments, {type:'text', text}]}]`. */
  attachments?: Array<string | Uint8Array | ContentPart>;

  /** Tools — if any are passed, the helper runs an AgentLoop. Executable tools
   *  (from `defineTool`) AND bare builtin tools (`{type:'web_search'}` /
   *  `{type:'code_interpreter'}` …) are both accepted; builtins run server-side
   *  so they need no client executor. */
  tools?: Array<AgentTool | BuiltinTool>;

  /** Generation control. */
  maxTokens?: number;
  temperature?: number;
  structured?: { schema: Record<string, unknown>; name?: string };

  /** Output audio controls (voice/format) for audio-capable models. */
  audio?: AudioOptions;
  /** Which output modalities to return. Default ['text']; add 'audio' for a spoken
   *  reply (surfaced as a media part on `response.media`). */
  outputModalities?: Array<'text' | 'audio'>;

  /** Service tier for this call. Also settable as a `model:tier` suffix (e.g.
   *  `anthropic/claude-opus-4.8:priority`); an explicit value here wins. */
  serviceTier?: ServiceTier;

  /** Optional engine to use. Falls back to coreRegistry default. */
  engine?: EngineHandle;
  /** Provider-specific request options (e.g. `{ openrouter: { models: [...] } }`). */
  providerOptions?: Record<string, unknown>;
  /** Extra LLMClient options. */
  client?: Partial<Omit<LLMClientConfig, 'provider' | 'model' | 'apiKey'>>;

  // ─── Pre-dispatch budget guard (opt-in) ─────────────────────────────────
  /** When set, `estimate()` runs BEFORE the request is sent. If the cost for
   *  `budgetBound` exceeds this limit, throws `BudgetExceededError` and never
   *  calls the provider.  OFF by default (no behavior change when absent). */
  maxCostUsd?: number;
  /** Which estimate bound to compare against `maxCostUsd`.
   *  Default: `'expected'`.  Use `'high'` for conservative worst-case gating. */
  budgetBound?: EstimateBound;
}

export interface CompleteResult<T = unknown> {
  text: string;
  /** Auto-parsed JSON result. Present iff `opts.structured.schema` was set;
   *  otherwise `undefined`. The generic on `complete<T>(...)` types this. */
  parsed?: T;
  response: CompletionResponse;
}

export async function complete<T = unknown>(opts: CompleteOptions): Promise<CompleteResult<T>> {
  const engine = opts.engine ?? coreRegistry.get();
  const resolvedAttachments = await resolveAttachments(opts.attachments);
  const input = buildInput(opts.prompt, resolvedAttachments);

  // Pre-dispatch budget guard — runs only when caller opts in via maxCostUsd.
  if (opts.maxCostUsd !== undefined) {
    await enforceBudget(opts, engine, input);
  }

  // `model:tier` sugar — strip a recognized tier suffix; explicit opts.serviceTier wins.
  const { modelId: model, serviceTier: tierFromModel } = parseModelTier(opts.model);
  const serviceTier = opts.serviceTier ?? tierFromModel;

  // OpenAI processes input audio only via Chat Completions — the Responses API
  // (openai's default here) rejects input_audio. Auto-route audio requests to
  // completions unless the caller pinned an api via `client`.
  const clientOpts: Partial<Omit<LLMClientConfig, 'provider' | 'model' | 'apiKey'>> = {
    ...(opts.client ?? {}),
  };
  if (clientOpts.api == null && providerOf({ ...opts, model }) === 'openai' && hasAudioContent(input)) {
    clientOpts.api = 'completions';
  }

  const llm = createLLM({
    engine,
    provider: opts.provider,
    model,
    apiKey: opts.apiKey,
    ...clientOpts,
  } as Parameters<typeof createLLM>[0]);

  try {
    let res: CompletionResponse;
    if (opts.tools && opts.tools.length > 0) {
      const loop = new AgentLoop({
        client: llm,
        system: opts.system,
        tools: opts.tools.map(toAgentTool),
        hooks: engine.hooks,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
      res = await loop.complete(input, {
        structured: opts.structured,
      });
    } else {
      res = await llm.complete(input, {
        system: opts.system,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        structured: opts.structured,
        providerOptions: opts.providerOptions,
        audio: opts.audio,
        outputModalities: opts.outputModalities,
        serviceTier,
      });
    }

    const result: CompleteResult<T> = { text: res.text, response: res };
    if (opts.structured?.schema) {
      result.parsed = parseStructured<T>(res.text);
    }
    return result;
  } finally {
    llm.destroy();
  }
}

/** Bare builtin tools (`{type:'web_search'}`) run server-side — wrap them as an
 *  AgentTool with a no-op executor (never invoked). Executable tools pass through. */
function toAgentTool(t: AgentTool | BuiltinTool): AgentTool {
  return 'definition' in t ? t : { definition: t, execute: async () => '' };
}

/** Resolve the target provider from opts (explicit or parsed from a namespaced id). */
function providerOf(opts: CompleteOptions): string | undefined {
  if (opts.provider) return opts.provider;
  if (isNamespacedModelId(opts.model)) return parseModelId(opts.model)[0];
  return undefined;
}

/** Whether the built input carries any audio content part. */
function hasAudioContent(input: string | ContentPart[] | Message[]): boolean {
  if (typeof input === 'string' || !Array.isArray(input) || input.length === 0) return false;
  if ('role' in (input[0] as object)) {
    return (input as Message[]).some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'audio'),
    );
  }
  return (input as ContentPart[]).some((p) => p.type === 'audio');
}

async function resolveAttachments(
  raw: Array<string | Uint8Array | ContentPart> | undefined,
): Promise<ContentPart[] | undefined> {
  if (!raw || raw.length === 0) return undefined;
  const out: ContentPart[] = [];
  for (const item of raw) {
    if (typeof item === 'string' || item instanceof Uint8Array) {
      out.push(await loadContent(item)); // image / pdf / audio / video by MIME
    } else {
      out.push(item);
    }
  }
  return out;
}

function buildInput(
  prompt: string | ContentPart[] | Message[],
  attachments: ContentPart[] | undefined,
): string | ContentPart[] | Message[] {
  if (!attachments || attachments.length === 0) return prompt;

  // String prompt → wrap as a user message with attachments before the text.
  if (typeof prompt === 'string') {
    return [
      {
        role: 'user' as const,
        content: [...attachments, { type: 'text' as const, text: prompt }],
      },
    ];
  }
  // ContentPart[] → prepend attachments.
  if (Array.isArray(prompt) && prompt.length > 0 && !('role' in prompt[0])) {
    return [...attachments, ...(prompt as ContentPart[])];
  }
  // Message[] → drop attachments to first user message (or append a new one).
  const messages = prompt as Message[];
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  if (firstUserIdx === -1) {
    return [...messages, { role: 'user' as const, content: attachments as ContentPart[] }];
  }
  const target = messages[firstUserIdx];
  const targetContent = target.content;
  const merged: ContentPart[] =
    typeof targetContent === 'string'
      ? [...attachments, { type: 'text' as const, text: targetContent }]
      : [...attachments, ...(targetContent as ContentPart[])];
  const next = [...messages];
  next[firstUserIdx] = { ...target, content: merged };
  return next;
}

/** Run estimate() and throw BudgetExceededError when the chosen bound exceeds
 *  the caller's maxCostUsd.  Called only when maxCostUsd is set. */
async function enforceBudget(
  opts: CompleteOptions,
  engine: ReturnType<typeof coreRegistry.get>,
  input: string | ContentPart[] | Message[],
): Promise<void> {
  const { modelId: model } = parseModelTier(opts.model);
  const est = await estimate(
    { model, provider: opts.provider, prompt: input, system: opts.system, maxTokens: opts.maxTokens },
    { engine },
  );
  const bound = opts.budgetBound ?? 'expected';
  const costUsd = est.cost[bound];
  if (costUsd > opts.maxCostUsd!) {
    throw new BudgetExceededError({ bound, estimate: est, maxCostUsd: opts.maxCostUsd!, costUsd });
  }
}
