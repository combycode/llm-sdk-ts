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
import { ModelCatalog } from '../catalog/catalog';
import type { RequestContext } from '../types/request-context';
import {
  emitModerationZeroCost,
  moderationInputText,
  moderationModel,
  resolveModerationMode,
  runModeration,
  wrapModeratedStream,
} from './moderation/runner';
import type { EmulationConfig, ModerationReport, ModerationRequest } from './moderation/types';
import { MODERATION_DEFAULT_INTERVAL, MODERATION_DEFAULT_STRATEGY } from './moderation/types';
import { retrieveFile as retrieveFileImpl, streamFile as streamFileImpl } from './files/retrieve';
import type { FileStream, RetrieveContext, RetrievedFile } from './files/retrieve';
import { resolveServerState } from './server-state';
import type { ContentPart, Message } from './types/messages';
import type { ExecuteOptions } from './types/options';
import type { ApiType, ProviderAdapter, ProviderHttpRequest, ProviderName } from './types/provider';
import type { NormalizedRequest } from './types/request';
import { emptyUsage } from './types/response';
import type {
  BuiltinToolCall,
  CacheDiagnostics,
  Citation,
  CompletionResponse,
  FileOutput,
  FinishReason,
  Usage,
} from './types/response';
import type { StreamEvent } from './types/stream';
import type { LLMClientConfig } from './client-config';
import { ResponseShapeChecker, type ShapeBook } from './response-shape';
import RESPONSE_SHAPES from './response-shapes.json' with { type: 'json' };
import {
  PRIORITY_BACKGROUND,
  PRIORITY_INTERACTIVE,
  buildAssistantMessage,
  buildContext,
  extractSystem,
  normalizeInput,
  parseStructured,
  toWireStructured,
  toWireTools,
  resolveAdapter,
  resolveApi,
  type ClientRouting,
} from './client-internal';
import type { SchemaSource } from './types/standard-schema';
import { InvalidFinalOutputError } from './output-errors';

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
  /** Present only when the caller asked for the shape check. */
  private readonly shapeChecker?: ResponseShapeChecker;
  private readonly apiKey: string;
  private readonly fetchFn: EngineFetch;
  private readonly fetchStreamFn: EngineFetchStream | null;
  private readonly priority: number;
  private readonly queueName: string;
  private readonly configName: string;
  private readonly cacheName: string;
  /** The routing names this client was configured with, exposed so context
   *  building does not have to cast into the privates above. */
  readonly routing: ClientRouting;
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
    this.apiKey = config.apiKey;
    this.hooks = config.hooks ?? new HookBusClass();
    this.fetchFn = config.fetch;
    this.fetchStreamFn = config.fetchStream ?? null;
    // The bundled catalog, not an empty one: this is where the model's wire-spec
    // pin comes from, and without it every request falls back to deriving the
    // spec from the model id — which is the fallback for models this build has
    // never heard of, not the normal path.
    //
    // Assigned BEFORE `api` is resolved, because the API a model is callable on
    // is one of the things the catalog knows.
    this.catalog = config.catalog ?? ModelCatalog.withProviderDefaults();
    this.api = resolveApi(
      config.provider,
      config.api,
      this.catalog.getPreferredApi(config.provider, config.model),
    );
    this.mode = config.mode ?? 'foreground';
    this.batchable = config.batchable ?? false;
    this.priority =
      config.priority ?? (this.mode === 'background' ? PRIORITY_BACKGROUND : PRIORITY_INTERACTIVE);

    this.adapter = resolveAdapter(config, this.api);
    // One checker per client, because it remembers what it has already reported:
    // the same drift on every request for the rest of the process is how a
    // diagnostic gets ignored by the person it is for.
    this.shapeChecker = config.checkResponseShapes
      ? new ResponseShapeChecker(this.hooks, this.provider, this.api, RESPONSE_SHAPES as ShapeBook)
      : undefined;

    this.queueName = config.queueName ?? `${config.provider}/${config.model}`;
    this.configName = config.configName ?? `${config.provider}/${config.model}`;
    this.cacheName = config.cacheName ?? 'default';
    this.routing = Object.freeze({
      queueName: this.queueName,
      configName: this.configName,
      cacheName: this.cacheName,
    });
    this.cacheKeyFn = config.cacheKeyFn;

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
    return buildAssistantMessage(response, {
      provider: this.provider,
      model: this.model,
      api: this.api,
    });
  }

  // ─── Moderation helpers ───────────────────────────────────────────────

  /** Resolve the OpenAI key the emulated moderation path needs. Reuses the
   *  client's own key when the provider is OpenAI; otherwise requires an explicit
   *  one. Throws when none is resolvable (report-only feature, but the call still
   *  needs a key to reach the moderations endpoint). */
  private resolveModerationKey(mod: ModerationRequest): string {
    const key = mod.apiKey ?? (this.provider === 'openai' ? this.apiKey : undefined);
    if (!key) {
      throw new Error(
        'moderation: emulated moderation requires an OpenAI API key (the only public ' +
          'moderations endpoint). Pass moderation.apiKey, or use the OpenAI provider.',
      );
    }
    return key;
  }

  private moderationConfig(mod: ModerationRequest): EmulationConfig {
    return {
      apiKey: this.resolveModerationKey(mod),
      model: moderationModel(mod),
      fetch: this.fetchFn,
    };
  }

  /** Fold a moderation stream event into the accumulating report. */
  private mergeModeration(
    prev: ModerationReport | undefined,
    phase: 'input' | 'output',
    result: ModerationReport['input'],
    source: 'native' | 'emulated',
  ): ModerationReport {
    const next: ModerationReport = prev && prev.source === source ? { ...prev } : { source };
    if (phase === 'input') next.input = result;
    else next.output = result;
    return next;
  }

  // ─── File retrieval (hosted-tool output files) ─────────────────────────

  private retrieveContext(): RetrieveContext {
    return {
      provider: this.provider,
      apiKey: this.apiKey,
      fetch: this.fetchFn,
      baseURL: this.adapter.baseURL(),
      // A file produced by a turn lives in the Workspace that turn was billed
      // to, so retrieving it has to name the same one. Undefined for every
      // provider that has no such notion, and for an Anthropic client that
      // was given none.
      workspaceId: this.adapter.workspaceId,
    };
  }

  /** Fetch a hosted-tool output file (e.g. a code-execution file from
   *  `response.files`): its bytes as a `Blob` plus `name` / `mimeType` / `size`.
   *  Resolves inline `data`, a `url`, or a provider file `id` — all through this
   *  client's provider + auth + engine. */
  retrieveFile(file: FileOutput): Promise<RetrievedFile> {
    return retrieveFileImpl(file, this.retrieveContext());
  }

  /** Stream a hosted-tool output file: a `ReadableStream<Uint8Array>` plus
   *  best-effort `name` / `mimeType` / `size` (from the response headers). For large
   *  files piped straight to a file / GridFS / HTTP response without buffering. */
  streamFile(file: FileOutput): Promise<FileStream> {
    return streamFileImpl(file, this.retrieveContext());
  }

  /** Submit a request. Returns the parsed CompletionResponse. */
  /** Anything the spec left out on purpose reaches the caller as a warning.
   *  Said once per request; the build already de-duplicates within one. */
  private reportBuildNotes(req: ProviderHttpRequest, ctx: RequestContext): void {
    for (const note of req.notes ?? []) {
      this.hooks.emitSync('onWarning', {
        source: 'llm',
        code: 'request_adjusted',
        message: note,
        details: { provider: this.provider, model: this.model, ctx },
      });
    }
  }

  /** `cacheDiagnostics` is a two-provider feature (Anthropic `diagnostics`,
   *  OpenAI Responses `prompt_cache_options.comparison_response_id`). Asking for
   *  it anywhere else is dropped by the spec that has no field for it, and the
   *  caller would be left watching for a `cacheDiagnostics` that can never
   *  arrive.
   *
   *  Decided on the BUILT body rather than against a list of providers: the
   *  question is whether the request that is about to go out carries the field,
   *  which is the same question after a spec changes. A list would be right
   *  today and quietly wrong later. */
  private noteUnsupportedCacheDiagnostics(
    normalized: NormalizedRequest,
    req: ProviderHttpRequest,
  ): string | null {
    if (!normalized.cacheDiagnostics) return null;
    const body = req.body as Record<string, unknown> | undefined;
    const cacheOptions = body?.prompt_cache_options as { comparison_response_id?: unknown } | undefined;
    const sent =
      body?.diagnostics !== undefined || cacheOptions?.comparison_response_id !== undefined;
    if (sent) return null;
    return (
      `cacheDiagnostics was requested, but ${this.provider} has no field for it on this ` +
      `surface, so it was not sent and the response will carry none. Anthropic messages and ` +
      `OpenAI Responses (gpt-5.6 and later) are the surfaces that report it.`
    );
  }

  /** Drop `thinking: { mode: 'off' }` where the model cannot honour it, and say
   *  so. Returns the note, or null when there was nothing to adjust.
   *
   *  Dropped rather than sent: the wire spec turns `off` into a real field
   *  (`thinkingBudget: 0` on 2.5, `thinkingLevel: MINIMAL` on 3.x), and the
   *  models flagged here answer 400 to it. The caller gets a request that works
   *  plus a warning that their instruction could not be followed, instead of a
   *  failed call — or, worse, the silence this replaced, where `off` was
   *  accepted, nothing was emitted, and the model reasoned anyway. */
  private limitThinking(normalized: NormalizedRequest): string | null {
    if (normalized.thinking?.mode === 'between_tools') return this.limitBetweenTools(normalized);
    if (normalized.thinking?.mode !== 'off') return null;
    if (this.catalog.get(this.provider, this.model)?.reasoning?.canDisable !== false) return null;
    delete (normalized as { thinking?: unknown }).thinking;
    return (
      `${this.provider}/${this.model} cannot switch reasoning off — ` +
      `thinking:{mode:'off'} was dropped and the model will reason as it defaults to.`
    );
  }

  /** `between_tools` is accepted by almost nothing, so it is sent only where the
   *  catalog RECORDS it as accepted.
   *
   *  The inverse of `canDisable`, which gates on an explicit `false` because
   *  almost every model can disable reasoning. Measured 2026-09-29: of thirteen
   *  active Anthropic chat models, one takes `between_tools` and twelve answer
   *  `400 "thinking.type.between_tools" is not supported for this model` --
   *  including claude-opus-5.5. Gating on `false` there would mean twelve
   *  annotations and a surprise 400 for every model nobody had got to yet.
   *
   *  Downgraded rather than refused, which is what Anthropic's own fallback
   *  middleware does with this value when it hops to another model: the caller
   *  gets a request that works, plus a warning saying what was dropped. */
  private limitBetweenTools(normalized: NormalizedRequest): string | null {
    const reasoning = this.catalog.get(this.provider, this.model)?.reasoning;
    if (reasoning?.betweenTools === true) return null;
    delete (normalized as { thinking?: unknown }).thinking;
    return (
      `${this.provider}/${this.model} does not accept thinking:{mode:'between_tools'} — ` +
      `it was dropped and the model will reason as it defaults to. ` +
      `Measured 2026-09-29, anthropic/claude-sonnet-5.5 is the model that takes it.`
    );
  }

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
      wireSpec: this.catalog.get(this.provider, this.model)?.wireSpec,
      messages,
      system: composedSystem,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      seed: options.seed,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      stop: options.stop,
      // Both schemas are converted HERE and nowhere else: a Standard Schema is a
      // public input form, and everything past this line -- the wire specs, the
      // adapters, the strict-mode checks -- reads a plain JSON Schema.
      tools: toWireTools(options.tools),
      toolChoice: options.toolChoice,
      structured: toWireStructured(options.structured),
      thinking: options.thinking,
      cache: options.cache,
      serviceTier: options.serviceTier,
      moderation: options.moderation,
      cacheDiagnostics: options.cacheDiagnostics,
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

    const thinkingNote = this.limitThinking(normalized);
    const providerReq = this.adapter.buildRequest(normalized);
    if (thinkingNote) (providerReq.notes ??= []).push(thinkingNote);
    const cacheDiagNote = this.noteUnsupportedCacheDiagnostics(normalized, providerReq);
    if (cacheDiagNote) (providerReq.notes ??= []).push(cacheDiagNote);
    this.reportBuildNotes(providerReq, ctx);
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

    // Resolve the emulated-moderation key BEFORE the provider call, so a missing
    // key fails fast (the documented contract) and never discards a billed
    // completion or skips onCompletion. The moderation calls themselves run after
    // the response (they need result.text), reusing this config.
    const mod = options.moderation;
    const moderationCfg =
      mod && resolveModerationMode(this.provider, mod) === 'emulate'
        ? this.moderationConfig(mod)
        : undefined;

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
        // Every trace field, not a hand-picked three: `traceparent` rides with the ids,
        // and picking fields here is what left the HTTP spans rooting a trace of their
        // own while the LLM span they belong to had joined the caller's.
        trace: {
          sessionId: ctx.sessionId,
          requestId: ctx.requestId,
          callId: ctx.callId,
          traceparent: ctx.traceparent,
        },
      };
      response = await this.fetchFn(httpReq, {
        queueName: this.queueName,
        priority: this.priority,
        estimatedTokens: estimatedInputTokens,
        ctx: ctx as Record<string, unknown>,
      });
    }
    const latencyMs = performance.now() - start;

    // Before parsing, so a body the parser silently tolerates is still reported.
    this.shapeChecker?.checkResponse(response.body);
    const result = this.adapter.parseResponse(response.body, latencyMs);

    // Emulated inline moderation (non-OpenAI providers, or forced). Native results
    // are already on result.moderation from the adapter. Report-only: attach, never
    // block. Input + output run concurrently (the moderations endpoint is free).
    if (mod && moderationCfg) {
      const cfg = moderationCfg;
      const doInput = mod.input ?? true;
      const doOutput = mod.output ?? true;
      const [inputEntry, outputEntry] = await Promise.all([
        doInput
          ? runModeration(moderationInputText(normalized.messages), cfg)
          : Promise.resolve(undefined),
        doOutput ? runModeration(result.text, cfg) : Promise.resolve(undefined),
      ]);
      if (doInput) emitModerationZeroCost(this.hooks, cfg.model);
      if (doOutput) emitModerationZeroCost(this.hooks, cfg.model);
      result.moderation = {
        source: 'emulated',
        ...(inputEntry ? { input: inputEntry } : {}),
        ...(outputEntry ? { output: outputEntry } : {}),
      };
    }

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
    schema: SchemaSource,
    options: ExecuteOptions = {},
  ): Promise<T> {
    const structured = { ...(options.structured ?? {}), schema };
    const repairAttempts = Math.max(0, structured.repairAttempts ?? 0);
    const messages = normalizeInput(input);

    // Attempt 0 = the original call; each further attempt appends the parse error
    // and re-prompts (opt-in `repairAttempts`, default 0). The typed
    // InvalidFinalOutputError is re-thrown once repairs are exhausted.
    for (let attempt = 0; ; attempt++) {
      const res = await this.complete(messages, { ...options, structured });
      try {
        // The schema travels to the parse as well as to the provider. For a
        // Standard Schema the provider only ever saw the JSON Schema it converts
        // to, so the refinements it carries are checked here or nowhere -- and a
        // failure lands in the repair loop below, which is where a wrong value
        // belongs.
        return parseStructured<T>(res.text, schema);
      } catch (err) {
        if (!(err instanceof InvalidFinalOutputError) || attempt >= repairAttempts) throw err;
        messages.push(
          { role: 'assistant', content: res.text },
          {
            role: 'user',
            content: `Your previous reply was not valid JSON for the required schema (${err.message}). Reply with ONLY the JSON object matching the schema — no prose, no code fences.`,
          },
        );
      }
    }
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
      wireSpec: this.catalog.get(this.provider, this.model)?.wireSpec,
      messages,
      system: composedSystem,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      seed: options.seed,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      stop: options.stop,
      tools: toWireTools(options.tools),
      toolChoice: options.toolChoice,
      thinking: options.thinking,
      cache: options.cache,
      serviceTier: options.serviceTier,
      moderation: options.moderation,
      cacheDiagnostics: options.cacheDiagnostics,
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

    const thinkingNote = this.limitThinking(normalized);
    const providerReq = this.adapter.buildRequest(normalized);
    if (thinkingNote) (providerReq.notes ??= []).push(thinkingNote);
    const cacheDiagNote = this.noteUnsupportedCacheDiagnostics(normalized, providerReq);
    if (cacheDiagNote) (providerReq.notes ??= []).push(cacheDiagNote);
    this.reportBuildNotes(providerReq, ctx);
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
      // Every trace field, not a hand-picked three: `traceparent` rides with the ids,
        // and picking fields here is what left the HTTP spans rooting a trace of their
        // own while the LLM span they belong to had joined the caller's.
        trace: {
          sessionId: ctx.sessionId,
          requestId: ctx.requestId,
          callId: ctx.callId,
          traceparent: ctx.traceparent,
        },
    };

    // Accumulate the stream so we can emit a single onCompletion at the end
    // (same as complete()), so CostCollector + ContextMeasurer price/measure
    // streamed calls too. Usage arrives once near the end (e.g. OpenAI's
    // include_usage final chunk; Anthropic message_delta; Google usageMetadata).
    const start = performance.now();
    let text = '';
    let thinking = '';
    let usage: Usage = emptyUsage();
    let cacheDiagnostics: CacheDiagnostics | undefined;
    let signatures: unknown;
    let finishReason: FinishReason = 'stop';
    let moderationReport: ModerationReport | undefined;
    const files: FileOutput[] = [];
    const builtinToolCalls: BuiltinToolCall[] = [];
    // Deduped by url: Google repeats its grounding chunks on more than one late
    // chunk, and a model that cites one page twice is still one source.
    const citationsByUrl = new Map<string, Citation>();

    // Raw provider events (the unwrapped stream). Output-moderation wrappers and
    // the accumulation loop below both consume from here.
    const fetchStream = this.fetchStreamFn;
    const queueName = this.queueName;
    const priority = this.priority;
    // One parser instance per stream — holds any per-stream state (e.g. Google's
    // code-execution latch) in its closure, isolated from concurrent streams.
    const parseStream = this.adapter.createStreamParser();
    const shapeChecker = this.shapeChecker;
    async function* rawEvents(): AsyncGenerator<StreamEvent> {
      for await (const sseEvent of fetchStream(httpReq, {
        queueName,
        priority,
        ctx: ctx as Record<string, unknown>,
      })) {
        // Per event, and per event TYPE: an event type the parser does not handle
        // is skipped in silence, so the reply is simply missing a piece.
        shapeChecker?.checkStreamEvent(sseEvent);
        for (const ev of parseStream(sseEvent)) yield ev;
      }
    }

    // Emulated path: wrap the output stream with the chosen strategy, and run input
    // moderation up front (emitted before any output). Native moderation needs no
    // wrapping — the adapter emits `moderation` events from the final chunk.
    const mod = options.moderation;
    const emulate = !!mod && resolveModerationMode(this.provider, mod) === 'emulate';
    let eventStream: AsyncIterable<StreamEvent> = rawEvents();

    if (mod && emulate && (mod.output ?? true)) {
      const cfg = this.moderationConfig(mod);
      const hooks = this.hooks;
      const strategy = mod.stream?.strategy ?? MODERATION_DEFAULT_STRATEGY;
      const interval = mod.stream?.interval ?? MODERATION_DEFAULT_INTERVAL;
      eventStream = wrapModeratedStream(eventStream, strategy, interval, async (t) => {
        const r = await runModeration(t, cfg);
        emitModerationZeroCost(hooks, cfg.model);
        return r;
      });
    }

    if (mod && emulate && (mod.input ?? true)) {
      const cfg = this.moderationConfig(mod);
      const inputEntry = await runModeration(moderationInputText(normalized.messages), cfg);
      emitModerationZeroCost(this.hooks, cfg.model);
      moderationReport = this.mergeModeration(moderationReport, 'input', inputEntry, 'emulated');
      yield { type: 'moderation', phase: 'input', result: inputEntry, source: 'emulated' };
    }

    for await (const event of eventStream) {
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
        case 'cache_diagnostics':
          // Same reason as `file` and `citation`: the streamed response must
          // answer what complete() answers, or which call style you used
          // changes the answer.
          cacheDiagnostics = event.diagnostics;
          break;
        case 'done':
          finishReason = event.finishReason as FinishReason;
          // Opaque, provider-bound, and the streamed turn's only chance to keep
          // it: the terminal frame is where it rides out.
          if (event.signatures) signatures = event.signatures;
          break;
        case 'file':
          // Hosted-tool output file (code-execution artifact) — collect for the
          // final response so streamed `response.files` matches complete().
          files.push(event.file);
          break;
        case 'citation':
          // Same reason as `file`: streamed `response.citations` must match what
          // complete() returns, or which call style you used changes the answer.
          citationsByUrl.set(event.citation.url, event.citation);
          break;
        case 'builtin_tool_end':
          // Durable trail of provider-run builtin tools (parity with complete()) —
          // collected on END, which carries the full payload (code/output/query).
          builtinToolCalls.push({
            tool: event.tool,
            ...(event.id ? { id: event.id } : {}),
            ...(event.code ? { code: event.code } : {}),
            ...(event.output ? { output: event.output } : {}),
            ...(event.query ? { query: event.query } : {}),
            ...(event.url ? { url: event.url } : {}),
          });
          break;
        case 'moderation':
          moderationReport = this.mergeModeration(
            moderationReport,
            event.phase,
            event.result,
            event.source,
          );
          break;
      }
      yield event;
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
      ...(files.length ? { files } : {}),
      ...(builtinToolCalls.length ? { builtinToolCalls } : {}),
      ...(citationsByUrl.size ? { citations: [...citationsByUrl.values()] } : {}),
      ...(moderationReport ? { moderation: moderationReport } : {}),
      ...(cacheDiagnostics ? { cacheDiagnostics } : {}),
      ...(signatures ? { signatures } : {}),
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

