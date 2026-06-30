/** OpenAI provider adapter (Chat Completions API). */

import type { SSEEvent } from '../../../network/types';
import { resolveVoice } from '../../audio/voices';
import type { AudioFormat } from '../../types/audio';
import type { ContentPart, MediaOutputPart, TextPart, ToolCallPart } from '../../types/messages';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import {
  emptyUsage,
  type CompletionResponse,
  type Usage,
} from '../../types/response';
import type { StreamEvent } from '../../types/stream';
import { isFunctionTool } from '../../types/tools';
import { buildNativeModeration, parseNativeModeration } from '../../moderation/native';
import { openaiBilledTier, openaiRequestTier } from './tiers';
import { DEFAULT_MAX_TOKENS } from '../_shared/constants';
import { extractFinishReason } from '../_shared/response-utils';

export interface OpenAIAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** OpenAI input_audio accepts only 'wav' | 'mp3'. */
function audioFormat(mimeType: string): 'wav' | 'mp3' {
  return mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3' : 'wav';
}

/** A filename with extension for an inline chat `file` part (API requires one). */
function docFilenameForMime(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'file.pdf';
  if (mimeType === 'text/plain') return 'file.txt';
  return 'file.bin';
}

/** OpenAI chat audio OUTPUT format. Supports wav/mp3/flac/opus/pcm16; aac is not
 *  supported there, so it falls back to wav. */
function toOpenAIAudioFormat(format: AudioFormat | undefined): string {
  if (!format || format === 'aac') return 'wav';
  return format;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly name: ProviderAdapter['name'] = 'openai';
  protected readonly apiKey: string;
  protected readonly _baseURL?: string;

  constructor(config: OpenAIAdapterConfig) {
    this.apiKey = config.apiKey;
    this._baseURL = config.baseURL;
  }

  authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };
  }

  baseURL(): string {
    return this._baseURL ?? 'https://api.openai.com';
  }

  completionPath(): string {
    return '/v1/chat/completions';
  }

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const messages: Record<string, unknown>[] = [];

    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }

    for (const msg of req.messages) {
      messages.push(this.buildMessage(msg));
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    };

    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stop) body.stop = req.stop;
    const tier = openaiRequestTier(req.serviceTier);
    if (tier) body.service_tier = tier;

    // Inline moderation — native passthrough (skip when the caller forced emulation).
    if (req.moderation && req.moderation.mode !== 'emulate') {
      body.moderation = buildNativeModeration(req.moderation);
    }

    // Audio input (gpt-audio): the model only *processes* input audio when audio
    // output is also enabled, so we always enable it here. Voice/format come from
    // req.audio (alias-resolved); the spoken reply + transcript arrive on
    // `message.audio` (parsed + surfaced as media in parseResponse).
    const hasAudioInput = req.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'audio'),
    );
    if (hasAudioInput) {
      body.modalities = ['text', 'audio'];
      body.audio = {
        voice: resolveVoice('openai', req.audio?.voice) ?? 'alloy',
        format: toOpenAIAudioFormat(req.audio?.format),
      };
    }

    if (req.tools?.length) {
      // Chat Completions only supports function tools; skip BuiltinTool entries.
      body.tools = req.tools.filter(isFunctionTool).map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          ...(t.strict ? { strict: true } : {}),
        },
      }));
    }

    if (req.toolChoice) {
      if (typeof req.toolChoice === 'string') body.tool_choice = req.toolChoice;
      else body.tool_choice = { type: 'function', function: { name: req.toolChoice.name } };
    }

    if (req.thinking && req.thinking.mode !== 'off') {
      body.reasoning = { effort: req.thinking.effort ?? 'medium' };
    }

    if (req.structured) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.structured.name ?? 'response',
          schema: req.structured.schema,
          strict: req.structured.strict ?? true,
        },
      };
    }

    return { body };
  }

  private buildMessage(msg: {
    role: string;
    content: string | ContentPart[];
  }): Record<string, unknown> {
    if (msg.role === 'tool') {
      const parts =
        typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
      const result = parts.find((p) => p.type === 'tool_result');
      if (result && result.type === 'tool_result') {
        return {
          role: 'tool',
          tool_call_id: result.id,
          content:
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        };
      }
    }

    if (msg.role === 'assistant') {
      const parts =
        typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
      const toolCalls = parts.filter((p) => p.type === 'tool_call');
      if (toolCalls.length > 0) {
        return {
          role: 'assistant',
          content:
            parts
              .filter((p) => p.type === 'text')
              .map((p) => (p as TextPart).text)
              .join('') || null,
          tool_calls: toolCalls.map((tc) => {
            if (tc.type !== 'tool_call') return {};
            return {
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            };
          }),
        };
      }
    }

    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    const content = msg.content.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      if (p.type === 'image') {
        const s = p.source;
        const url =
          s.type === 'base64'
            ? `data:${s.mimeType};base64,${s.data}`
            : s.type === 'url'
              ? s.url
              : '';
        return { type: 'image_url', image_url: { url, detail: p.detail ?? 'auto' } };
      }
      if (p.type === 'audio') {
        const s = p.source;
        if (s.type === 'base64') {
          return {
            type: 'input_audio',
            input_audio: { data: s.data, format: audioFormat(s.mimeType) },
          };
        }
        return { type: 'text', text: '[unsupported audio source]' };
      }
      if (p.type === 'document') {
        // OpenAI-compatible chat file input (pdf/text). OpenRouter relies on this.
        const s = p.source;
        if (s.type === 'provider_ref') return { type: 'file', file: { file_id: s.refId } };
        if (s.type === 'base64') {
          return {
            type: 'file',
            file: {
              filename: docFilenameForMime(s.mimeType),
              file_data: `data:${s.mimeType};base64,${s.data}`,
            },
          };
        }
        return { type: 'text', text: '[unsupported document source]' };
      }
      return { type: 'text', text: `[unsupported: ${p.type}]` };
    });

    // gpt-audio requires the text instruction to PRECEDE the input_audio part
    // (audio-first yields "please play the audio"). Keep audio parts last.
    const ordered = content.some((p) => (p as { type?: string }).type === 'input_audio')
      ? [
          ...content.filter((p) => (p as { type?: string }).type !== 'input_audio'),
          ...content.filter((p) => (p as { type?: string }).type === 'input_audio'),
        ]
      : content;

    return { role: msg.role, content: ordered };
  }

  enableStreaming(providerReq: ProviderHttpRequest, _req: NormalizedRequest): void {
    const body = providerReq.body as Record<string, unknown>;
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    const r = raw as Record<string, unknown>;
    const choices = (r.choices as Array<Record<string, unknown>>) ?? [];
    const choice = choices[0] ?? {};
    const message = (choice.message as Record<string, unknown>) ?? {};
    const usage = this.parseUsage(r.usage as Record<string, unknown>);
    Object.assign(usage, openaiBilledTier(r.service_tier));

    const content: ContentPart[] = [];
    const toolCalls: ToolCallPart[] = [];

    // gpt-audio replies with audio; the spoken words land in message.audio.transcript
    // (message.content is null in that case). Surface the transcript as the text AND
    // the spoken audio bytes as a media part (no longer discarded).
    const audio = message.audio as
      | { transcript?: string; data?: string; id?: string; format?: string }
      | undefined;
    const text = (message.content as string) || audio?.transcript || '';
    if (text) content.push({ type: 'text', text });

    const media: MediaOutputPart[] = [];
    if (audio?.data) {
      const part: MediaOutputPart = {
        type: 'audio_output',
        mediaId: audio.id ?? '',
        mimeType: `audio/${audio.format ?? 'wav'}`,
        _data: audio.data,
      };
      content.push(part);
      media.push(part);
    }

    const rawToolCalls = (message.tool_calls as Array<Record<string, unknown>>) ?? [];
    for (const tc of rawToolCalls) {
      const fn = tc.function as Record<string, unknown>;
      const parsed: ToolCallPart = {
        type: 'tool_call',
        id: tc.id as string,
        name: fn.name as string,
        arguments: JSON.parse(fn.arguments as string),
      };
      content.push(parsed);
      toolCalls.push(parsed);
    }

    const finishReason = extractFinishReason(
      toolCalls.length > 0,
      choice.finish_reason as string,
      { tool_calls: 'tool_use', length: 'length', content_filter: 'content_filter' },
    );

    // OpenAI Chat Completions hides reasoning text (only token count available).
    // But some OpenAI-compatible providers (DeepSeek, xAI) return it as reasoning_content.
    const reasoningContent = (message.reasoning_content as string) ?? null;

    const moderation = parseNativeModeration(r.moderation);

    return {
      id: r.id as string,
      model: r.model as string,
      content,
      finishReason,
      usage,
      text,
      toolCalls,
      media,
      thinking: reasoningContent,
      ...(moderation ? { moderation } : {}),
      latencyMs,
      raw,
    };
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    const data = JSON.parse(event.data) as Record<string, unknown>;

    // Native moderation arrives on a dedicated chunk (choices empty/absent).
    if (data.moderation) {
      const report = parseNativeModeration(data.moderation);
      const out: StreamEvent[] = [];
      if (report?.input)
        out.push({ type: 'moderation', phase: 'input', result: report.input, source: 'native' });
      if (report?.output)
        out.push({ type: 'moderation', phase: 'output', result: report.output, source: 'native' });
      if (out.length) return out;
    }

    const choices = (data.choices as Array<Record<string, unknown>>) ?? [];
    const choice = choices[0];
    if (!choice) {
      // Usage-only chunk (stream_options: include_usage)
      if (data.usage)
        return [{ type: 'usage', usage: this.parseUsage(data.usage as Record<string, unknown>) }];
      return [];
    }

    const delta = (choice.delta as Record<string, unknown>) ?? {};
    const events: StreamEvent[] = [];

    // reasoning_content from OpenAI-compatible providers (DeepSeek, xAI via Chat Completions)
    if (delta.reasoning_content) {
      events.push({ type: 'thinking', text: delta.reasoning_content as string });
    }

    if (delta.content) {
      events.push({ type: 'text', text: delta.content as string });
    }

    const toolCalls = (delta.tool_calls as Array<Record<string, unknown>>) ?? [];
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn?.name) {
        events.push({
          type: 'tool_call_start',
          id: (tc.id as string) ?? '',
          name: fn.name as string,
        });
      }
      if (fn?.arguments) {
        events.push({
          type: 'tool_call_delta',
          id: (tc.id as string) ?? '',
          arguments: fn.arguments as string,
        });
      }
    }

    const fr = choice.finish_reason as string | null;
    if (fr) {
      events.push({
        type: 'done',
        finishReason: extractFinishReason(false, fr, { tool_calls: 'tool_use', length: 'length' }),
      });
    }

    if (data.usage) {
      events.push({ type: 'usage', usage: this.parseUsage(data.usage as Record<string, unknown>) });
    }

    return events;
  }

  private parseUsage(u: Record<string, unknown> | undefined): Usage {
    if (!u) return emptyUsage();
    const input = (u.prompt_tokens as number) ?? (u.input_tokens as number) ?? 0;
    const output = (u.completion_tokens as number) ?? (u.output_tokens as number) ?? 0;
    const details =
      (u.prompt_tokens_details as Record<string, unknown>) ??
      (u.input_tokens_details as Record<string, unknown>) ??
      {};
    const outDetails =
      (u.completion_tokens_details as Record<string, unknown>) ??
      (u.output_tokens_details as Record<string, unknown>) ??
      {};
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      cachedTokens: (details.cached_tokens as number) ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: (outDetails.reasoning_tokens as number) ?? 0,
    };
  }
}
