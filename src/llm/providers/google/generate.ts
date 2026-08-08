/** Google Gemini provider adapter (generateContent API). */

import type { SSEEvent } from '../../../network/types';
import { resolveVoice } from '../../audio/voices';
import type {
  AudioOutputPart,
  ContentPart,
  ImageOutputPart,
  MediaOutputPart,
  TextPart,
  ToolCallPart,
  VideoOutputPart,
} from '../../types/messages';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import { googleRequestTier, googleBilledTier } from './tiers';
import type { NormalizedRequest } from '../../types/request';
import {
  emptyUsage,
  type BuiltinToolCall,
  type CompletionResponse,
  type FileOutput,
  type Usage,
} from '../../types/response';
import type { StreamEvent } from '../../types/stream';
import { isFunctionTool } from '../../types/tools';
import { AUDIO_PCM16_SAMPLE_RATE_HZ } from '../_shared/constants';
import { extractFinishReason } from '../_shared/response-utils';
import {
  GOOGLE_THINKING_BUDGETS,
  GOOGLE_THINKING_LEVELS,
  googleUsesThinkingBudget,
} from './constants';

export interface GoogleAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** Per-stream state threaded through `createStreamParser`. `codeExec` latches once
 *  a code-execution marker is seen so later inline blobs route to `files`. */
interface GoogleStreamState {
  codeExec: boolean;
  /** web_search (grounding) builtin_tool events emitted once per stream. */
  webSearchEmitted?: boolean;
  /** web_fetch (urlContext) builtin_tool events emitted once per stream. */
  urlFetchEmitted?: boolean;
  /** Code from the last `executableCode` part, to attach to its `builtin_tool_end`. */
  pendingCode?: string;
}

export class GoogleAdapter implements ProviderAdapter {
  readonly name = 'google' as const;
  private readonly apiKey: string;
  private readonly _baseURL?: string;

  constructor(config: GoogleAdapterConfig) {
    this.apiKey = config.apiKey;
    this._baseURL = config.baseURL;
  }

  authHeaders(): Record<string, string> {
    return {
      'x-goog-api-key': this.apiKey,
      'content-type': 'application/json',
    };
  }

  baseURL(): string {
    return this._baseURL ?? 'https://generativelanguage.googleapis.com';
  }

  completionPath(): string {
    return ''; // set dynamically per request (includes model in URL)
  }

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const model = req.model.startsWith('models/') ? req.model : `models/${req.model}`;
    const contents: unknown[] = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') continue; // handled via systemInstruction
      contents.push(this.buildContent(msg));
    }

    const config: Record<string, unknown> = {};
    if (req.maxTokens) config.maxOutputTokens = req.maxTokens;
    if (req.temperature !== undefined) config.temperature = req.temperature;
    if (req.topP !== undefined) config.topP = req.topP;
    if (req.topK !== undefined) config.topK = req.topK;
    if (req.seed !== undefined) config.seed = req.seed;
    if (req.presencePenalty !== undefined) config.presencePenalty = req.presencePenalty;
    if (req.frequencyPenalty !== undefined) config.frequencyPenalty = req.frequencyPenalty;
    if (req.stop) config.stopSequences = req.stop;

    // Audio output (when requested via outputModalities): generateContent returns
    // inline audio with responseModalities:['AUDIO'] + an optional speechConfig voice.
    if (req.outputModalities?.includes('audio')) {
      config.responseModalities = ['AUDIO'];
      const voice = resolveVoice('google', req.audio?.voice);
      if (voice) {
        config.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
      }
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: config,
    };

    // Service tier — top-level request field (Google accepts flex|standard|priority).
    const tier = googleRequestTier(req.serviceTier);
    if (tier) body.serviceTier = tier;

    if (req.system) {
      body.systemInstruction = { parts: [{ text: req.system }] };
    }

    if (req.tools?.length) {
      const fnTools = req.tools.filter(isFunctionTool);
      const tools: Record<string, unknown>[] = [];
      if (fnTools.length) {
        tools.push({
          functionDeclarations: fnTools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        });
      }
      // Unified web_search builtin → Gemini grounded search.
      if (req.tools.some((t) => !isFunctionTool(t) && t.type === 'web_search')) {
        tools.push({ googleSearch: {} });
      }
      // Unified code_interpreter builtin → Gemini code execution.
      if (req.tools.some((t) => !isFunctionTool(t) && t.type === 'code_interpreter')) {
        tools.push({ codeExecution: {} });
      }
      // Unified web_fetch builtin → Gemini URL context (reads user-provided URLs).
      if (req.tools.some((t) => !isFunctionTool(t) && t.type === 'web_fetch')) {
        tools.push({ urlContext: {} });
      }
      if (tools.length) body.tools = tools;
    }

    if (req.toolChoice) {
      const mode =
        req.toolChoice === 'auto'
          ? 'AUTO'
          : req.toolChoice === 'none'
            ? 'NONE'
            : req.toolChoice === 'required'
              ? 'ANY'
              : 'AUTO';
      body.toolConfig = { functionCallingConfig: { mode } };
    }

    if (req.thinking && req.thinking.mode !== 'off') {
      const effort = req.thinking.effort ?? 'high';
      // Gemini 2.5 only accepts a token `thinkingBudget` (it 400s on thinkingLevel);
      // 3.x+ uses `thinkingLevel`. `hidden` stops thoughts being returned.
      const thinkingConfig: Record<string, unknown> = {
        includeThoughts: req.thinking.visibility !== 'hidden',
      };
      if (googleUsesThinkingBudget(req.model)) {
        thinkingConfig.thinkingBudget = GOOGLE_THINKING_BUDGETS[effort] ?? GOOGLE_THINKING_BUDGETS.high;
      } else {
        thinkingConfig.thinkingLevel = GOOGLE_THINKING_LEVELS[effort] ?? 'HIGH';
      }
      (config as Record<string, unknown>).thinkingConfig = thinkingConfig;
    }

    if (req.structured) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = req.structured.schema;
    }

    // Provider-specific options passthrough (e.g. responseModalities for image/audio gen)
    if (req.providerOptions) {
      if (req.providerOptions.responseModalities) {
        config.responseModalities = req.providerOptions.responseModalities;
      }
      if (req.providerOptions.speechConfig) {
        config.speechConfig = req.providerOptions.speechConfig;
      }
      if (req.providerOptions.imageConfig) {
        config.imageConfig = req.providerOptions.imageConfig;
      }
      if (req.providerOptions.translationConfig) {
        config.translationConfig = req.providerOptions.translationConfig;
      }
      // Explicit context cache (`cachedContents/…`). Top-level on the request body, NOT
      // inside generationConfig. This passthrough used to live on the Interactions adapter,
      // but google 2.13 removed `cached_content` from the Interactions request model and the
      // endpoint now 400s "Unknown parameter" — while generateContent still accepts and
      // validates it (live 2026-07-27: a bogus name returns 403 "CachedContent not found",
      // i.e. the field is recognised). See interactions.ts for the removal note.
      const cachedContent = req.providerOptions.cachedContent;
      if (typeof cachedContent === 'string' && cachedContent) body.cachedContent = cachedContent;
    }

    return {
      body,
      path: `/v1beta/${model}:generateContent`,
    };
  }

  enableStreaming(providerReq: ProviderHttpRequest, req: NormalizedRequest): void {
    const model = req.model.startsWith('models/') ? req.model : `models/${req.model}`;
    providerReq.path = `/v1beta/${model}:streamGenerateContent?alt=sse`;
  }

  /** Map tool call IDs to function names (Google needs name in functionResponse) */
  private toolCallNames: Map<string, string> = new Map();

  private buildContent(msg: {
    role: string;
    content: string | ContentPart[];
  }): Record<string, unknown> {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: unknown[] = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else {
      for (const p of msg.content) {
        switch (p.type) {
          case 'text':
            parts.push({ text: p.text });
            break;
          case 'image':
          case 'audio':
          case 'video':
          case 'document': {
            const s = p.source;
            if (s.type === 'base64')
              parts.push({ inlineData: { mimeType: s.mimeType, data: s.data } });
            else if (s.type === 'url')
              parts.push({ fileData: { fileUri: s.url, mimeType: 'application/octet-stream' } });
            else if (s.type === 'provider_ref')
              parts.push({ fileData: { fileUri: s.refId, mimeType: s.mimeType } });
            else if (s.type === 'file') parts.push({ fileData: { fileUri: s.fileId } });
            break;
          }
          case 'tool_call': {
            this.toolCallNames.set(p.id, p.name);
            const fcPart: Record<string, unknown> = {
              functionCall: { name: p.name, args: p.arguments, id: p.id },
            };
            if (p._meta?.thoughtSignature) fcPart.thoughtSignature = p._meta.thoughtSignature;
            parts.push(fcPart);
            break;
          }
          case 'tool_result': {
            const fnName = this.toolCallNames.get(p.id) ?? '';
            parts.push({
              functionResponse: {
                name: fnName,
                id: p.id,
                response: typeof p.content === 'string' ? { result: p.content } : p.content,
              },
            });
            break;
          }
        }
      }
    }

    return { role, parts };
  }

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    const r = raw as Record<string, unknown>;
    const candidates = (r.candidates as Array<Record<string, unknown>>) ?? [];
    const candidate = candidates[0] ?? {};
    const rawContent = (candidate.content as Record<string, unknown>) ?? {};
    const parts = (rawContent.parts as Array<Record<string, unknown>>) ?? [];
    const usage = this.parseUsage(r.usageMetadata as Record<string, unknown>);

    const content: ContentPart[] = [];
    const toolCalls: ToolCallPart[] = [];
    const media: MediaOutputPart[] = [];
    const files: FileOutput[] = [];
    let thinking: string | null = null;

    // When the model ran hosted code execution, its inlineData blobs are file
    // artifacts (e.g. a generated chart) → route them to the unified files channel
    // rather than treating them as conversational media.
    const hasCodeExec = parts.some((p) => p.executableCode || p.codeExecutionResult);

    for (const part of parts) {
      if (part.text !== undefined && !part.thought) {
        content.push({ type: 'text', text: part.text as string });
      }
      if (part.thought && part.text) {
        thinking = part.text as string;
      }
      // Inline media output (image/audio/video from generateContent), OR a
      // code-execution file artifact when the turn used code execution.
      if (part.inlineData) {
        const inline = part.inlineData as { mimeType: string; data: string };
        const mime = inline.mimeType;
        if (hasCodeExec) {
          files.push({ data: inline.data, mimeType: mime, source: 'code_execution' });
        } else if (mime.startsWith('image/')) {
          const p: ImageOutputPart = {
            type: 'image_output',
            mediaId: '',
            mimeType: mime,
            _data: inline.data,
          };
          content.push(p);
          media.push(p);
        } else if (mime.startsWith('audio/')) {
          const p: AudioOutputPart = {
            type: 'audio_output',
            mediaId: '',
            mimeType: mime,
            sampleRate: AUDIO_PCM16_SAMPLE_RATE_HZ,
            _data: inline.data,
          };
          content.push(p);
          media.push(p);
        } else if (mime.startsWith('video/')) {
          const p: VideoOutputPart = {
            type: 'video_output',
            mediaId: '',
            mimeType: mime,
            _data: inline.data,
          };
          content.push(p);
          media.push(p);
        }
      }
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const meta: Record<string, unknown> = {};
        if (part.thoughtSignature) meta.thoughtSignature = part.thoughtSignature;
        const tc: ToolCallPart = {
          type: 'tool_call',
          id: (fc.id as string) ?? crypto.randomUUID(),
          name: fc.name as string,
          arguments: (fc.args as Record<string, unknown>) ?? {},
          ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        };
        content.push(tc);
        toolCalls.push(tc);
      }
    }

    const finishReason = extractFinishReason(
      toolCalls.length > 0,
      candidate.finishReason as string,
      { MAX_TOKENS: 'length', SAFETY: 'content_filter' },
    );

    // Provider-run builtin tools — durable trail. Google has no call ids for these:
    // code execution is `executableCode` (code) + `codeExecutionResult` (output)
    // parts (paired in order); web search (googleSearch grounding) carries its query
    // in candidate.groundingMetadata.webSearchQueries.
    const builtinToolCalls: BuiltinToolCall[] = [];
    const codes = parts
      .filter((p) => (p.executableCode as Record<string, unknown>)?.code)
      .map((p) => (p.executableCode as Record<string, unknown>).code as string);
    const outputs = parts
      .filter((p) => p.codeExecutionResult)
      .map((p) => String((p.codeExecutionResult as Record<string, unknown>).output ?? ''));
    if (codes.length) {
      codes.forEach((code, i) => {
        builtinToolCalls.push({
          tool: 'code_interpreter',
          code,
          ...(outputs[i] ? { output: outputs[i] } : {}),
        });
      });
    } else if (hasCodeExec) {
      builtinToolCalls.push({ tool: 'code_interpreter', ...(outputs[0] ? { output: outputs[0] } : {}) });
    }
    const grounding = candidate.groundingMetadata as Record<string, unknown> | undefined;
    if (grounding) {
      const q = (grounding.webSearchQueries as string[] | undefined)?.[0];
      builtinToolCalls.push({ tool: 'web_search', ...(typeof q === 'string' ? { query: q } : {}) });
    }
    // web_fetch (urlContext): one entry per fetched URL from urlContextMetadata.
    const urlCtx = candidate.urlContextMetadata as Record<string, unknown> | undefined;
    const urlMeta = urlCtx?.urlMetadata as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(urlMeta)) {
      for (const m of urlMeta) {
        const url = m.retrievedUrl as string | undefined;
        builtinToolCalls.push({ tool: 'web_fetch', ...(typeof url === 'string' ? { url } : {}) });
      }
    }

    return {
      id: crypto.randomUUID(), // Google doesn't return a response ID in generateContent
      model: '',
      content,
      finishReason,
      usage,
      text: content
        .filter((p): p is TextPart => p.type === 'text')
        .map((p) => p.text)
        .join(''),
      toolCalls,
      thinking,
      media,
      ...(files.length ? { files } : {}),
      ...(builtinToolCalls.length ? { builtinToolCalls } : {}),
      latencyMs,
      raw,
    };
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    // Stateless entry — with no persisted state, inline data can't be known to be
    // a code-execution artifact, so it routes to media (unchanged behavior).
    return this.streamEvents(event, { codeExec: false });
  }

  /** Stateful — Google splits the code-execution marker (`executableCode` /
   *  `codeExecutionResult`) and the produced file (`inlineData`) across parts and
   *  often across SSE events. The closure remembers "code execution began in this
   *  stream" so a later `inlineData` blob is routed to `files` (a code-exec
   *  artifact) rather than `media` (conversational output). */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    const state: GoogleStreamState = { codeExec: false };
    return (event) => this.streamEvents(event, state);
  }

  private streamEvents(event: SSEEvent, state: GoogleStreamState): StreamEvent[] {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    const candidates = (data.candidates as Array<Record<string, unknown>>) ?? [];
    const candidate = candidates[0];

    if (!candidate) {
      if (data.usageMetadata)
        return [
          { type: 'usage', usage: this.parseUsage(data.usageMetadata as Record<string, unknown>) },
        ];
      return [];
    }

    const rawContent = (candidate.content as Record<string, unknown>) ?? {};
    const parts = (rawContent.parts as Array<Record<string, unknown>>) ?? [];
    const events: StreamEvent[] = [];

    // A code-execution marker may share an event with its output file or precede
    // it; latch the flag from all parts first so inlineData routing is correct.
    for (const part of parts) {
      if (part.executableCode || part.codeExecutionResult) state.codeExec = true;
    }

    for (const part of parts) {
      if (part.text !== undefined && !part.thought)
        events.push({ type: 'text', text: part.text as string });
      if (part.thought && part.text) events.push({ type: 'thinking', text: part.text as string });
      // Code-execution builtin: the code to run, then its result. Carry the code +
      // output on the end event (start marks progress).
      if (part.executableCode) {
        const code = (part.executableCode as Record<string, unknown>).code;
        state.pendingCode = typeof code === 'string' ? code : undefined;
        events.push({ type: 'builtin_tool_start', tool: 'code_interpreter' });
      }
      if (part.codeExecutionResult) {
        const output = (part.codeExecutionResult as Record<string, unknown>).output;
        events.push({
          type: 'builtin_tool_end',
          tool: 'code_interpreter',
          ...(state.pendingCode ? { code: state.pendingCode } : {}),
          ...(typeof output === 'string' && output ? { output } : {}),
        });
        state.pendingCode = undefined;
      }
      if (part.inlineData) {
        const inline = part.inlineData as { mimeType: string; data: string };
        const mime = inline.mimeType;
        if (state.codeExec) {
          // Code-execution artifact (e.g. a generated chart) → unified files channel.
          events.push({
            type: 'file',
            file: { data: inline.data, mimeType: mime, source: 'code_execution' },
          });
        } else {
          const mediaType = mime.startsWith('image/')
            ? ('image' as const)
            : mime.startsWith('audio/')
              ? ('audio' as const)
              : ('video' as const);
          events.push({ type: 'media_start', mediaType, mimeType: mime });
          events.push({ type: 'media_chunk', data: inline.data });
          events.push({ type: 'media_end' });
        }
      }
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const meta: Record<string, unknown> = {};
        if (part.thoughtSignature) meta.thoughtSignature = part.thoughtSignature;
        events.push({
          type: 'tool_call_start',
          id: (fc.id as string) ?? '',
          name: fc.name as string,
          ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        });
        if (fc.args)
          events.push({ type: 'tool_call_delta', id: '', arguments: JSON.stringify(fc.args) });
        events.push({ type: 'tool_call_end', id: '' });
      }
    }

    // Web search (googleSearch grounding) has no per-call stream markers — surface
    // one start/end pair the first time grounding metadata appears in the stream.
    if (candidate.groundingMetadata && !state.webSearchEmitted) {
      state.webSearchEmitted = true;
      const q = ((candidate.groundingMetadata as Record<string, unknown>).webSearchQueries as
        | string[]
        | undefined)?.[0];
      events.push({ type: 'builtin_tool_start', tool: 'web_search' });
      events.push({
        type: 'builtin_tool_end',
        tool: 'web_search',
        ...(typeof q === 'string' ? { query: q } : {}),
      });
    }

    // web_fetch (urlContext) — like grounding, no per-call markers: emit one
    // start/end pair per retrieved URL the first time the metadata appears.
    const streamUrlMeta = (candidate.urlContextMetadata as Record<string, unknown> | undefined)
      ?.urlMetadata as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(streamUrlMeta) && !state.urlFetchEmitted) {
      state.urlFetchEmitted = true;
      for (const m of streamUrlMeta) {
        const url = m.retrievedUrl as string | undefined;
        events.push({ type: 'builtin_tool_start', tool: 'web_fetch' });
        events.push({
          type: 'builtin_tool_end',
          tool: 'web_fetch',
          ...(typeof url === 'string' ? { url } : {}),
        });
      }
    }

    const fr = candidate.finishReason as string | undefined;
    if (fr)
      events.push({
        type: 'done',
        finishReason: extractFinishReason(false, fr, { MAX_TOKENS: 'length' }),
      });
    if (data.usageMetadata)
      events.push({
        type: 'usage',
        usage: this.parseUsage(data.usageMetadata as Record<string, unknown>),
      });

    return events;
  }

  private parseUsage(u: Record<string, unknown> | undefined): Usage {
    if (!u) return emptyUsage();
    const input = (u.promptTokenCount as number) ?? 0;
    const output = (u.candidatesTokenCount as number) ?? 0;
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: (u.totalTokenCount as number) ?? input + output,
      cachedTokens: (u.cachedContentTokenCount as number) ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: (u.thoughtsTokenCount as number) ?? 0,
      // Billed service tier (output-only `usageMetadata.serviceTier`).
      ...googleBilledTier(u.serviceTier),
    };
  }
}
