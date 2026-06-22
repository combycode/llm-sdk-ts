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
import type { NormalizedRequest } from '../../types/request';
import {
  emptyUsage,
  type CompletionResponse,
  type Usage,
} from '../../types/response';
import type { StreamEvent } from '../../types/stream';
import { isFunctionTool } from '../../types/tools';
import { AUDIO_PCM16_SAMPLE_RATE_HZ } from '../_shared/constants';
import { extractFinishReason } from '../_shared/response-utils';
import { GOOGLE_THINKING_LEVELS } from './constants';

export interface GoogleAdapterConfig {
  apiKey: string;
  baseURL?: string;
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
      (config as Record<string, unknown>).thinkingConfig = {
        thinkingLevel: GOOGLE_THINKING_LEVELS[req.thinking.effort ?? 'high'] ?? 'HIGH',
      };
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
    let thinking: string | null = null;

    for (const part of parts) {
      if (part.text !== undefined && !part.thought) {
        content.push({ type: 'text', text: part.text as string });
      }
      if (part.thought && part.text) {
        thinking = part.text as string;
      }
      // Inline media output (image/audio/video from generateContent)
      if (part.inlineData) {
        const inline = part.inlineData as { mimeType: string; data: string };
        const mime = inline.mimeType;
        if (mime.startsWith('image/')) {
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
      latencyMs,
      raw,
    };
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
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

    for (const part of parts) {
      if (part.text !== undefined && !part.thought)
        events.push({ type: 'text', text: part.text as string });
      if (part.thought && part.text) events.push({ type: 'thinking', text: part.text as string });
      if (part.inlineData) {
        const inline = part.inlineData as { mimeType: string; data: string };
        const mime = inline.mimeType;
        const mediaType = mime.startsWith('image/')
          ? ('image' as const)
          : mime.startsWith('audio/')
            ? ('audio' as const)
            : ('video' as const);
        events.push({ type: 'media_start', mediaType, mimeType: mime });
        events.push({ type: 'media_chunk', data: inline.data });
        events.push({ type: 'media_end' });
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
    };
  }
}
