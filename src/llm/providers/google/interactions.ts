/** Google Interactions API adapter.
 *  Endpoint: POST /v1beta/interactions
 *  Modern API: input, system_instruction, outputs (plural), function_result,
 *  previous_interaction_id for stateful, 72h retention. */

import type { SSEEvent } from '../../../network/types';
import type {
  AudioOutputPart,
  ContentPart,
  ImageOutputPart,
  MediaOutputPart,
  Message,
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

export interface GoogleInteractionsAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class GoogleInteractionsAdapter implements ProviderAdapter {
  readonly name = 'google' as const;
  private readonly apiKey: string;
  private readonly _baseURL?: string;

  constructor(config: GoogleInteractionsAdapterConfig) {
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
    return '/v1beta/interactions';
  }

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const model = req.model.startsWith('models/') ? req.model : `models/${req.model}`;

    // Input is the step_list (post May-2026 schema). The server-state brain has
    // already trimmed `req.messages` to just the new turn(s) when chaining, and
    // set `previousResponseId` to the prior interaction id.
    const input: unknown[] = [];
    for (const msg of req.messages) {
      input.push(...this.buildInputItems(msg));
    }

    const body: Record<string, unknown> = { model, input };
    if (req.previousResponseId) {
      body.previous_interaction_id = req.previousResponseId;
    }

    if (req.system) {
      body.system_instruction = req.system;
    }

    // Generation config
    const genConfig: Record<string, unknown> = {};
    if (req.maxTokens) genConfig.max_output_tokens = req.maxTokens;
    if (req.temperature !== undefined) genConfig.temperature = req.temperature;
    if (req.topP !== undefined) genConfig.top_p = req.topP;
    if (req.stop) genConfig.stop_sequences = req.stop;

    // Tools — only function tools are accepted on this surface.
    if (req.tools?.length) {
      body.tools = req.tools.filter(isFunctionTool).map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    }

    // Thinking
    if (req.thinking && req.thinking.mode !== 'off') {
      genConfig.thinking_config = {
        thinking_level: GOOGLE_THINKING_LEVELS[req.thinking.effort ?? 'high'] ?? 'HIGH',
      };
    }

    if (Object.keys(genConfig).length > 0) body.generation_config = genConfig;

    // Structured output — polymorphic response_format (response_mime_type removed).
    if (req.structured) {
      body.response_format = {
        type: 'text',
        mime_type: 'application/json',
        schema: req.structured.schema,
      };
    }

    return { body };
  }

  // step_list input items (post May-2026): user turns -> {type:'user_input'},
  // assistant turns -> {type:'model_output'}, tool results -> {type:'function_result'}.
  private buildInputItems(msg: Message): unknown[] {
    const items: unknown[] = [];

    if (msg.role === 'user' || msg.role === 'system') {
      if (typeof msg.content === 'string') {
        items.push({ type: 'user_input', content: [{ type: 'text', text: msg.content }] });
      } else {
        const parts: unknown[] = [];
        for (const p of msg.content) {
          if (p.type === 'text') parts.push({ type: 'text', text: p.text });
          else if (p.type === 'image') {
            const s = p.source;
            if (s.type === 'base64')
              parts.push({ type: 'image', mime_type: s.mimeType, data: s.data });
            else if (s.type === 'url') parts.push({ type: 'image', uri: s.url });
          } else if (p.type === 'audio') {
            const s = p.source;
            if (s.type === 'base64')
              parts.push({ type: 'audio', mime_type: s.mimeType, data: s.data });
          } else if (p.type === 'video') {
            const s = p.source;
            if (s.type === 'url') parts.push({ type: 'video', uri: s.url });
          }
        }
        if (parts.length > 0) items.push({ type: 'user_input', content: parts });
      }
    }

    if (msg.role === 'assistant') {
      const parts =
        typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
      const contentItems: unknown[] = [];
      for (const p of parts) {
        if (p.type === 'text' && p.text) contentItems.push({ type: 'text', text: p.text });
        if (p.type === 'tool_call') {
          this.toolCallNames.set(p.id, p.name);
          contentItems.push({
            type: 'function_call',
            id: p.id,
            name: p.name,
            arguments: p.arguments,
          });
        }
      }
      if (contentItems.length > 0) items.push({ type: 'model_output', content: contentItems });
    }

    if (msg.role === 'tool') {
      const parts =
        typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
      for (const p of parts) {
        if (p.type === 'tool_result') {
          items.push({
            type: 'function_result',
            name: this.toolCallNames.get(p.id) ?? '',
            call_id: p.id,
            result: typeof p.content === 'string' ? p.content : JSON.stringify(p.content),
          });
        }
      }
    }

    return items;
  }

  /** Track tool call IDs → names for function_result */
  private toolCallNames = new Map<string, string>();

  enableStreaming(providerReq: ProviderHttpRequest): void {
    (providerReq.body as Record<string, unknown>).stream = true;
  }

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    const r = raw as Record<string, unknown>;

    // Flatten the step_list into typed items. `model_output` steps carry a
    // `content[]` of typed parts (text / function_call / image…); `thought`
    // steps have no content[] and are ignored by the loop below. Falls back to
    // the legacy `outputs` array for older responses.
    const steps =
      (r.steps as Array<Record<string, unknown>>) ??
      (r.outputs as Array<Record<string, unknown>>) ??
      [];
    const outputs: Array<Record<string, unknown>> = [];
    for (const step of steps) {
      if (Array.isArray(step.content))
        outputs.push(...(step.content as Array<Record<string, unknown>>));
      else outputs.push(step);
    }
    const usage = this.parseUsage(r.usage as Record<string, unknown>);

    const content: ContentPart[] = [];
    const toolCalls: ToolCallPart[] = [];
    const media: MediaOutputPart[] = [];
    const thinking: string | null = null;
    let text = '';

    for (const item of outputs) {
      const type = item.type as string;

      if (type === 'text') {
        const t = item.text as string;
        text += t;
        content.push({ type: 'text', text: t });
      }

      if (type === 'function_call') {
        const tc: ToolCallPart = {
          type: 'tool_call',
          id: (item.id as string) ?? crypto.randomUUID(),
          name: item.name as string,
          arguments: (item.arguments as Record<string, unknown>) ?? {},
        };
        this.toolCallNames.set(tc.id, tc.name);
        content.push(tc);
        toolCalls.push(tc);
      }

      // Inline media output (image/audio/video)
      if (type === 'image' || type === 'audio' || type === 'video') {
        const mime = (item.mime_type as string) ?? (item.mimeType as string) ?? '';
        const data = (item.data as string) ?? '';
        if (type === 'image') {
          const p: ImageOutputPart = {
            type: 'image_output',
            mediaId: '',
            mimeType: mime || 'image/png',
            _data: data,
          };
          content.push(p);
          media.push(p);
        } else if (type === 'audio') {
          const p: AudioOutputPart = {
            type: 'audio_output',
            mediaId: '',
            mimeType: mime || 'audio/pcm',
            sampleRate: AUDIO_PCM16_SAMPLE_RATE_HZ,
            _data: data,
          };
          content.push(p);
          media.push(p);
        } else {
          const p: VideoOutputPart = {
            type: 'video_output',
            mediaId: '',
            mimeType: mime || 'video/mp4',
            _data: data,
          };
          content.push(p);
          media.push(p);
        }
      }
    }

    const status = r.status as string;
    const finishReason = extractFinishReason(toolCalls.length > 0, status, { failed: 'error' });

    return {
      id: (r.id as string) ?? crypto.randomUUID(),
      model: '',
      content,
      finishReason,
      usage,
      text,
      toolCalls,
      media,
      thinking,
      latencyMs,
      raw,
    };
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    const type = (data.event_type as string) ?? (data.type as string);
    const events: StreamEvent[] = [];

    if (type === 'content.delta') {
      const delta = data.delta as Record<string, unknown>;
      if (delta?.type === 'text') {
        events.push({ type: 'text', text: delta.text as string });
      }
      if (delta?.type === 'function_call') {
        // Google streams function calls as complete objects in delta
        events.push({
          type: 'tool_call_start',
          id: (delta.id as string) ?? '',
          name: (delta.name as string) ?? '',
        });
        if (delta.arguments) {
          events.push({
            type: 'tool_call_delta',
            id: (delta.id as string) ?? '',
            arguments: JSON.stringify(delta.arguments),
          });
        }
        events.push({ type: 'tool_call_end', id: (delta.id as string) ?? '' });
      }
    }

    if (type === 'interaction.complete') {
      const interaction = (data.interaction as Record<string, unknown>) ?? {};
      const usage = interaction.usage as Record<string, unknown>;
      if (usage) events.push({ type: 'usage', usage: this.parseUsage(usage) });
      events.push({
        type: 'done',
        finishReason: extractFinishReason(false, interaction.status as string, {
          failed: 'error',
        }),
      });
    }

    return events;
  }

  private parseUsage(u: Record<string, unknown> | undefined): Usage {
    if (!u) return emptyUsage();
    const input = (u.total_input_tokens as number) ?? (u.prompt_tokens as number) ?? 0;
    const output = (u.total_output_tokens as number) ?? (u.candidates_tokens as number) ?? 0;
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: (u.total_tokens as number) ?? input + output,
      cachedTokens: (u.total_cached_tokens as number) ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: (u.total_thought_tokens as number) ?? 0,
    };
  }
}
