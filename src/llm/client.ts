/** LLMClient — Layer 2.
 *
 *  Format adapter only. Does NOT own a queue, retry policy, or cache.
 *  Receives `fetch` (and optionally `fetchStream`) as injected functions.
 *  The semantic layer is fixed at construction:
 *    - `provider` + `model` + `apiKey` + `system` are immutable per instance.
 *
 *  Public methods:
 *    - `complete(input, options?)`  → CompletionResponse
 *    - `stream(input, options?)`    → AsyncIterable<StreamEvent>
 *    - `destroy()`                   → emit lifecycle hook
 *
 *  Input shapes (`string | ContentPart[] | Message[]`):
 *    - `string`         → wrap as `[{role:'user', content: string}]`
 *    - `ContentPart[]`  → wrap as `[{role:'user', content: parts}]`
 *    - `Message[]`      → use as the full messages array (REPLACE)
 *
 *  Hooks emitted: onClientCreate (in ctor), onMessageResolve, onBeforeSubmit,
 *  onCompletion, onClientDestroy. */

import type { HookBus } from '../bus/hook-bus';
import { HookBus as HookBusClass } from '../bus/hook-bus';
import type { EngineFetch, EngineFetchStream, HttpRequest, HttpResponse } from '../network/types';
import { ModelCatalog } from '../plugins/model-catalog/catalog';
import type { RequestContext } from '../types/request-context';
import { resolveServerState } from './server-state';
import type { ContentPart, Message } from './types/messages';
import type { ExecuteOptions } from './types/options';
import type { ApiType, ProviderAdapter, ProviderName } from './types/provider';
import type { NormalizedRequest } from './types/request';
import { emptyUsage } from './types/response';
import type { CompletionResponse, FinishReason, Usage } from './types/response';
import type { StreamEvent } from './types/stream';
import type { LLMClientConfig } from './client-config';
import {
  PRIORITY_BACKGROUND,
  PRIORITY_INTERACTIVE,
  buildContext,
  extractSystem,
  normalizeInput,
  parseStructured,
  resolveAdapter,
  resolveApi,
} from './client-internal';

// ─── LLMClient ──────────────────────────────────────────────────────────

export class LLMClient {
  readonly id: string;
  /** Trace session id (from the engine, or self-minted for a standalone client). */
  readonly sessionId: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly system: string | undefined;
  readonly hooks: HookBus;
  readonly api: ApiType;
  readonly mode: 'foreground' | 'background';
  readonly batchable: boolean;

  private readonly adapter: ProviderAdapter;
  private readonly fetchFn: EngineFetch;
  private readonly fetchStreamFn: EngineFetchStream | null;
  private readonly priority: number;
  private readonly queueName: string;
  private readonly configName: string;
  private readonly cacheName: string;
  private readonly cacheKeyFn?: (req: NormalizedRequest, ctx: RequestContext) => string;
  private readonly catalog: ModelCatalog;

  constructor(config: LLMClientConfig) {
    if (!config.provider) throw new Error('LLMClient: provider is required');
    if (!config.model) throw new Error('LLMClient: model is required');
    if (!config.apiKey) throw new Error('LLMClient: apiKey is required');
    if (!config.adapter && !config.fetch) {
      throw new Error('LLMClient: adapter (or factory) is required');
    }
    if (!config.fetch) {
      throw new Error('LLMClient: fetch is required (typically engine.fetch)');
    }

    this.id = crypto.randomUUID();
    this.sessionId = config.sessionId ?? `sess_${crypto.randomUUID().slice(0, 12)}`;
    this.provider = config.provider;
    this.model = config.model;
    this.system = config.system;
    this.hooks = config.hooks ?? new HookBusClass();
    this.fetchFn = config.fetch;
    this.fetchStreamFn = config.fetchStream ?? null;
    this.api = resolveApi(config.provider, config.api);
    this.mode = config.mode ?? 'foreground';
    this.batchable = config.batchable ?? false;
    this.priority =
      config.priority ?? (this.mode === 'background' ? PRIORITY_BACKGROUND : PRIORITY_INTERACTIVE);

    this.adapter = resolveAdapter(config, this.api);

    this.queueName = config.queueName ?? `${config.provider}/${config.model}`;
    this.configName = config.configName ?? `${config.provider}/${config.model}`;
    this.cacheName = config.cacheName ?? 'default';
    this.cacheKeyFn = config.cacheKeyFn;
    this.catalog = config.catalog ?? new ModelCatalog();

    this.hooks.emitSync('onClientCreate', {
      clientId: this.id,
      provider: this.provider,
      model: this.model,
      mode: this.mode,
      batchable: this.batchable,
    });
  }

  destroy(): void {
    this.hooks.emitSync('onClientDestroy', {
      clientId: this.id,
      provider: this.provider,
      model: this.model,
    });
  }

  /** Build an assistant history message from a response, stamped with provenance
   *  (id, createdAt, origin). On a stateful API (responses / interactions) the
   *  origin carries the server-state id so a later turn can continue server-side
   *  instead of resending the transcript. Push the result into your messages
   *  array between turns:
   *
   *    const r1 = await llm.complete(messages);
   *    messages.push(llm.assistantMessage(r1));
   *    messages.push({ role: 'user', content: 'follow-up' });
   *    const r2 = await llm.complete(messages); // sends id + only the new turn
   */
  assistantMessage(response: CompletionResponse): Message {
    const stateful = this.api === 'responses' || this.api === 'interactions';
    return {
      role: 'assistant',
      content: response.content,
      id: response.id || crypto.randomUUID(),
      createdAt: Date.now(),
      origin: {
        provider: this.provider,
        model: this.model,
        ...(stateful && response.id ? { serverStateId: response.id } : {}),
      },
    };
  }

  /** Submit a request. Returns the parsed CompletionResponse. */
  async complete(
    input: string | ContentPart[] | Message[],
    options: ExecuteOptions = {},
  ): Promise<CompletionResponse> {
    const rawMessages = normalizeInput(input);
    // Universal normalization: pull any role:'system' messages out of the
    // input array and merge them into the top-level system field. Some
    // providers (Anthropic) reject role:'system' in the messages array; this
    // makes per-call system prompts work across all providers.
    const { system: systemFromMessages, messages } = extractSystem(rawMessages);
    const composedSystem =
      [options.system, systemFromMessages, this.system]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n\n') || undefined;
    const ctx = buildContext(this, options);

    // Build the normalized internal request from fixed config + per-call options.
    const normalized: NormalizedRequest = {
      model: this.model,
      messages,
      system: composedSystem,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      stop: options.stop,
      tools: options.tools,
      toolChoice: options.toolChoice,
      structured: options.structured,
      thinking: options.thinking,
      cache: options.cache,
      serviceTier: options.serviceTier,
      providerOptions: options.providerOptions,
      audio: options.audio,
      outputModalities: options.outputModalities,
      previousResponseId: options.previousResponseId,
      timeout: options.timeout,
      signal: options.signal,
    };

    // Let plugins (FilesRegistry, ContextGuard) mutate messages / abort.
    const resolveCtx = {
      provider: this.provider,
      model: this.model,
      messages: normalized.messages,
      system: normalized.system,
      history: options.history,
      abort: undefined as boolean | undefined,
      abortReason: undefined as string | undefined,
    };
    await this.hooks.emit('onMessageResolve', resolveCtx);
    if (resolveCtx.abort) {
      throw new Error(
        `Request aborted by onMessageResolve handler${
          resolveCtx.abortReason ? `: ${resolveCtx.abortReason}` : ''
        }`,
      );
    }
    // Handlers may have mutated messages / system in place. Re-anchor the
    // normalized request to the final values.
    normalized.messages = resolveCtx.messages;
    normalized.system = resolveCtx.system;

    // Server-state: unless the caller passed an explicit previousResponseId
    // (manual mode) or opted out (stateful:false), decide whether to continue
    // server-side (send id + only the new turn) or resend full history.
    if (!normalized.previousResponseId && options.stateful !== false) {
      const decision = resolveServerState({
        messages: normalized.messages,
        provider: this.provider,
        model: this.model,
        catalog: this.catalog,
        stateful: true,
        now: Date.now(),
      });
      normalized.previousResponseId = decision.previousResponseId;
      normalized.messages = decision.messages;
    }

    const providerReq = this.adapter.buildRequest(normalized);
    const url = this.adapter.baseURL() + (providerReq.path ?? this.adapter.completionPath());

    // Compute cacheKey if a custom builder was provided.
    if (this.cacheKeyFn) {
      ctx.cacheKey = ctx.cacheKey ?? this.cacheKeyFn(normalized, ctx);
    }

    // Cache plugin (or batcher) may intercept and short-circuit here.
    const submitCtx = {
      provider: this.provider,
      model: this.model,
      clientId: this.id,
      mode: this.mode,
      batchable: this.batchable,
      request: providerReq.body,
      ctx,
      intercepted: false as boolean | undefined,
      resultPromise: undefined as Promise<unknown> | undefined,
    };
    await this.hooks.emit('onBeforeSubmit', submitCtx);

    const inputChars = JSON.stringify(normalized.messages).length;
    const estimatedInputTokens = Math.ceil(inputChars / 4);
    const start = performance.now();

    let response: HttpResponse;
    if (submitCtx.intercepted && submitCtx.resultPromise) {
      const rawResult = await submitCtx.resultPromise;
      response = { status: 200, headers: {}, body: rawResult };
    } else {
      const httpReq: HttpRequest = {
        url,
        headers: { ...this.adapter.authHeaders(), ...providerReq.headers },
        body: providerReq.body,
        timeout: options.timeout,
        signal: options.signal,
        provider: this.provider,
        model: this.model,
        trace: { sessionId: ctx.sessionId, requestId: ctx.requestId, callId: ctx.callId },
      };
      response = await this.fetchFn(httpReq, {
        queueName: this.queueName,
        priority: this.priority,
        estimatedTokens: estimatedInputTokens,
        ctx: ctx as Record<string, unknown>,
      });
    }
    const latencyMs = performance.now() - start;

    const result = this.adapter.parseResponse(response.body, latencyMs);

    await this.hooks.emit('onCompletion', {
      provider: this.provider,
      model: this.model,
      response: result,
      request: {
        estimatedInputTokens,
        inputChars,
        messageCount: normalized.messages.length,
        hasTools: (normalized.tools?.length ?? 0) > 0,
      },
      requestBody: providerReq.body,
      responseBody: response.body,
      ctx,
    });

    return result;
  }

  /** Run `complete` with a JSON Schema enforced via `structured`. Strips any
   *  leading/trailing markdown fences from the model reply, then JSON.parses
   *  to T. Throws if the parse fails — callers should catch + retry. */
  async structuredComplete<T = unknown>(
    input: string | ContentPart[] | Message[],
    schema: Record<string, unknown>,
    options: ExecuteOptions = {},
  ): Promise<T> {
    const res = await this.complete(input, {
      ...options,
      structured: { ...(options.structured ?? {}), schema },
    });
    return parseStructured<T>(res.text);
  }

  async *stream(
    input: string | ContentPart[] | Message[],
    options: ExecuteOptions = {},
  ): AsyncIterable<StreamEvent> {
    if (!this.fetchStreamFn) {
      throw new Error('LLMClient.stream: no fetchStream function configured');
    }
    const rawMessages = normalizeInput(input);
    const { system: systemFromMessages, messages } = extractSystem(rawMessages);
    const composedSystem =
      [options.system, systemFromMessages, this.system]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n\n') || undefined;
    const ctx = buildContext(this, options);

    const normalized: NormalizedRequest = {
      model: this.model,
      messages,
      system: composedSystem,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      stop: options.stop,
      tools: options.tools,
      toolChoice: options.toolChoice,
      thinking: options.thinking,
      cache: options.cache,
      serviceTier: options.serviceTier,
      providerOptions: options.providerOptions,
      audio: options.audio,
      outputModalities: options.outputModalities,
      previousResponseId: options.previousResponseId,
      timeout: options.timeout,
      signal: options.signal,
    };

    const resolveCtx = {
      provider: this.provider,
      model: this.model,
      messages: normalized.messages,
      system: normalized.system,
      history: options.history,
      abort: undefined as boolean | undefined,
      abortReason: undefined as string | undefined,
    };
    await this.hooks.emit('onMessageResolve', resolveCtx);
    if (resolveCtx.abort) {
      throw new Error(
        `Stream aborted by onMessageResolve handler${
          resolveCtx.abortReason ? `: ${resolveCtx.abortReason}` : ''
        }`,
      );
    }
    normalized.messages = resolveCtx.messages;
    normalized.system = resolveCtx.system;

    const providerReq = this.adapter.buildRequest(normalized);
    this.adapter.enableStreaming?.(providerReq, normalized);
    const url = this.adapter.baseURL() + (providerReq.path ?? this.adapter.completionPath());

    const httpReq: HttpRequest = {
      url,
      headers: { ...this.adapter.authHeaders(), ...providerReq.headers },
      body: providerReq.body,
      timeout: options.timeout,
      signal: options.signal,
      stream: true,
      provider: this.provider,
      model: this.model,
      trace: { sessionId: ctx.sessionId, requestId: ctx.requestId, callId: ctx.callId },
    };

    // Accumulate the stream so we can emit a single onCompletion at the end
    // (same as complete()), so CostCollector + ContextMeasurer price/measure
    // streamed calls too. Usage arrives once near the end (e.g. OpenAI's
    // include_usage final chunk; Anthropic message_delta; Google usageMetadata).
    const start = performance.now();
    let text = '';
    let thinking = '';
    let usage: Usage = emptyUsage();
    let finishReason: FinishReason = 'stop';

    for await (const sseEvent of this.fetchStreamFn(httpReq, {
      queueName: this.queueName,
      priority: this.priority,
      ctx: ctx as Record<string, unknown>,
    })) {
      const events = this.adapter.parseStreamEvent(sseEvent);
      for (const event of events) {
        switch (event.type) {
          case 'text':
            text += event.text;
            break;
          case 'thinking':
            thinking += event.text;
            break;
          case 'usage':
            usage = event.usage;
            break;
          case 'done':
            finishReason = event.finishReason as FinishReason;
            break;
        }
        yield event;
      }
    }

    // Normal completion (no throw): emit onCompletion. Aborted/errored streams
    // throw out of the loop above and emit nothing (a cost = a completed call).
    const inputChars = JSON.stringify(normalized.messages).length;
    const response: CompletionResponse = {
      id: `stream_${crypto.randomUUID().slice(0, 12)}`,
      model: this.model,
      content: text ? [{ type: 'text', text }] : [],
      finishReason,
      usage,
      text,
      toolCalls: [],
      thinking: thinking || null,
      media: [],
      latencyMs: performance.now() - start,
      raw: null,
    };
    await this.hooks.emit('onCompletion', {
      provider: this.provider,
      model: this.model,
      response,
      request: {
        estimatedInputTokens: Math.ceil(inputChars / 4),
        inputChars,
        messageCount: normalized.messages.length,
        hasTools: (normalized.tools?.length ?? 0) > 0,
      },
      requestBody: providerReq.body,
      responseBody: null,
      ctx,
    });
  }
}

