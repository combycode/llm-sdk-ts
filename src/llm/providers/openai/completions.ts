/** OpenAI provider adapter (Chat Completions API). */

import type { SSEEvent } from '../../../network/types';
import { buildFromSpec } from '../../../wire/interpreter';
import { buildResponse } from '../../../wire/response-interpreter';
import { getResponseSpec } from '../../../wire/response-specs';
import { OPENAI_RESPONSE_REGISTRY } from './response-registry';
import type { Registry } from '../../../wire/interpreter';
import { chatSpec } from '../../../wire/chat-specs';
import { makeRegistry } from '../../wire-transforms';
import type { ContentPart, TextPart } from '../../types/messages';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import { emptyUsage, type CompletionResponse, type Usage } from '../../types/response';
import type { StreamEvent } from '../../types/stream';
import { parseNativeModeration } from '../../moderation/native';
import { extractFinishReason } from '../_shared/response-utils';
import { sseJson } from '../_shared/sse';

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

/** Per-stream state threaded through `createStreamParser` — maps a streamed
 *  tool call's `index` to its resolved id (real, or a synthesized `call_<uuid>`
 *  for backends that omit ids), stable across the stream's chunks. */
export interface OpenAIStreamState {
  toolIdByIndex: Map<number, string>;
  /** Open audio output: gpt-audio streams its reply as `delta.audio`, and the
   *  media_start/chunk/end trio has to be paired across events. */
  audio?: { open: boolean; id?: string };
}

/** Token usage, from either Chat Completions or Responses naming. Exported so
 *  the spec-driven parser calls the same code rather than a second copy. */
export function openaiUsage(u: Record<string, unknown> | undefined): Usage {
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
    cacheWriteTokens: (details.cache_write_tokens as number) ?? 0,
    reasoningTokens: (outDetails.reasoning_tokens as number) ?? 0,
  };
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

  /** Named code the spec cannot express as data — message/input assembly. Carries
   *  `this`, so a subclass drives the same rules with its own overrides. */
  protected readonly wireRegistry: Registry = makeRegistry({ openaiCompletions: this });

  /** Which flavor overlay patches the shared spec. Subclasses for
   *  OpenAI-compatible backends override this and nothing else. */
  protected readonly wireFlavor: string = 'openai';

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    return buildFromSpec(
      chatSpec('openai/chat-completions'),
      req,
      this.wireRegistry,
      this.wireFlavor,
    ) as ProviderHttpRequest;
  }

  /** One universal message can become SEVERAL chat-completions messages.
   *
   *  Parallel tool calls are the case that matters: the loop answers a round of calls
   *  with ONE tool message carrying a `tool_result` part per call, but this API wants a
   *  separate `{role:'tool'}` message per `tool_call_id`. Emitting only the first left
   *  the rest unanswered and the provider rejected the whole request with
   *  "No tool output found for function call <id>" — so parallel tools were broken on
   *  every chat-completions backend. */
  /** Reached through the wire registry while building the request. */
  buildMessages(msg: { role: string; content: string | ContentPart[] }): Record<string, unknown>[] {
    if (msg.role === 'tool') {
      const parts =
        typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
      const results = parts.filter((p) => p.type === 'tool_result');
      if (results.length > 0) {
        return results.map((result) => ({
          role: 'tool',
          tool_call_id: result.id,
          content:
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        }));
      }
    }
    return [this.buildMessage(msg)];
  }

  private buildMessage(msg: {
    role: string;
    content: string | ContentPart[];
  }): Record<string, unknown> {
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

  /** The response spec this adapter parses with. Overridden by OpenRouter,
   *  which is Chat Completions plus one rule. */
  protected responseSpecId(): string {
    return 'openai/completions.response';
  }

  protected responseRegistry(): Registry {
    return OPENAI_RESPONSE_REGISTRY;
  }

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    // Spec-driven since 3.3.0; see wire/specs/responses/openai.completions.json.
    return buildResponse(getResponseSpec(this.responseSpecId()), raw, this.responseRegistry(), {
      extra: { latencyMs, raw },
    }) as unknown as CompletionResponse;
  }

  parseStreamEvent(event: SSEEvent, state?: OpenAIStreamState): StreamEvent[] {
    const data = sseJson(event);

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

    // gpt-audio streams its reply as `delta.audio`, which was ignored entirely.
    // A streamed audio turn therefore produced NO text, NO media and — because
    // these chunks never carry a finish_reason — no terminal event either, so a
    // caller awaiting `done` waited forever. Measured on a real stream: the
    // transcript arrives once up front, the bytes in fragments, and a final
    // `expires_at`-only delta closes it.
    const audio = delta.audio as
      | { id?: string; transcript?: string; data?: string; expires_at?: number }
      | undefined;
    if (audio) {
      // Degrades the same way the tool-id map does when no state is threaded.
      const av = state ? (state.audio ??= { open: false }) : { open: false };
      if (audio.id && !av.id) av.id = audio.id;
      if (audio.transcript) events.push({ type: 'text', text: audio.transcript });
      if (audio.data) {
        if (!av.open) {
          av.open = true;
          // Streamed audio from Chat Completions is ALWAYS pcm16: the API
          // refuses any other `audio.format` when stream=true. Raw PCM carries
          // no magic bytes, so it cannot be sniffed as the buffered path does.
          events.push({ type: 'media_start', mediaType: 'audio', mimeType: 'audio/pcm' });
        }
        events.push({ type: 'media_chunk', data: audio.data });
      }
      if (audio.expires_at !== undefined && av.open) {
        av.open = false;
        events.push({ type: 'media_end', ...(av.id ? { mediaId: av.id } : {}) });
        // The only terminal signal an audio stream gives.
        events.push({ type: 'done', finishReason: 'stop' });
      }
    }

    // Measured on OpenRouter `:online`: annotations arrive on their own chunks,
    // one per chunk, BEFORE the text that cites them. `url_citation.content` is
    // the whole scraped page and is deliberately not mapped to `text`, which
    // elsewhere means the short passage the source supports.
    for (const note of (delta.annotations as Array<Record<string, unknown>>) ?? []) {
      const detail = ((note.url_citation as Record<string, unknown>) ?? note) as Record<
        string,
        unknown
      >;
      if (note.type === 'url_citation' && detail.url) {
        events.push({
          type: 'citation',
          citation: {
            url: detail.url as string,
            ...(detail.title ? { title: detail.title as string } : {}),
          },
        });
      }
    }

    // Correlate streamed tool-call fragments by `index` (the wire id, when present,
    // only arrives on the first delta; arg fragments omit it). OpenAI-compatible
    // backends (some OpenRouter routes, LiteLLM/Bedrock) may omit the id entirely —
    // synthesize a stable `call_<uuid>` ONCE per index so parallel id-less calls
    // don't collide into one. Assigned on first sighting and never changed.
    const toolIdByIndex = state?.toolIdByIndex ?? new Map<number, string>();
    const toolCalls = (delta.tool_calls as Array<Record<string, unknown>>) ?? [];
    for (const tc of toolCalls) {
      const index = (tc.index as number) ?? 0;
      let id = toolIdByIndex.get(index);
      if (id === undefined) {
        id = (tc.id as string) || `call_${crypto.randomUUID()}`;
        toolIdByIndex.set(index, id);
      }
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn?.name) {
        events.push({ type: 'tool_call_start', id, name: fn.name as string });
      }
      if (fn?.arguments) {
        events.push({ type: 'tool_call_delta', id, arguments: fn.arguments as string });
      }
    }

    const fr = choice.finish_reason as string | null;
    if (fr) {
      events.push({
        type: 'done',
        finishReason: extractFinishReason(false, fr, {
          tool_calls: 'tool_use',
          length: 'length',
          content_filter: 'content_filter',
        }),
      });
    }

    if (data.usage) {
      events.push({ type: 'usage', usage: this.parseUsage(data.usage as Record<string, unknown>) });
    }

    return events;
  }

  /** Per-stream: correlates streamed tool-call fragments by index and synthesizes
   *  a stable id for backends that omit tool-call ids (see `parseStreamEvent`). */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    const state: OpenAIStreamState = { toolIdByIndex: new Map() };
    return (event) => this.parseStreamEvent(event, state);
  }

  private parseUsage(u: Record<string, unknown> | undefined): Usage {
    return openaiUsage(u);
  }
}
