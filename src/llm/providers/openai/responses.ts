/** OpenAI Responses API adapter.
 *  Endpoint: POST /v1/responses
 *  Modern API: input (not messages), instructions (not system role),
 *  output items (not choices), function_call/function_call_output for tools. */

import type { SSEEvent } from '../../../network/types';
import type {
  ContentPart,
  ImageOutputPart,
  MediaOutputPart,
  Message,
  TextPart,
  ToolCallPart,
} from '../../types/messages';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import {
  emptyUsage,
  type CompletionResponse,
  type Usage,
} from '../../types/response';
import { ensureAdditionalProperties } from '../../types/schema-utils';
import type { StreamEvent } from '../../types/stream';
import { isFunctionTool } from '../../types/tools';
import { buildNativeModeration, parseNativeModeration } from '../../moderation/native';
import { openaiBilledTier, openaiRequestTier } from './tiers';
import { extractFinishReason } from '../_shared/response-utils';

export interface OpenAIResponsesAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** A filename (with extension) for an inline input_file — required by the API. */
function filenameForMime(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'file.pdf';
  if (mimeType === 'text/plain') return 'file.txt';
  if (mimeType.startsWith('image/')) return `file.${mimeType.slice('image/'.length)}`;
  return 'file.bin';
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly name: ProviderAdapter['name'] = 'openai';
  protected readonly apiKey: string;
  protected readonly _baseURL?: string;

  constructor(config: OpenAIResponsesAdapterConfig) {
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
    return '/v1/responses';
  }

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const input: unknown[] = [];

    // Build input array from messages
    for (const msg of req.messages) {
      input.push(...this.buildInputItems(msg));
    }

    const body: Record<string, unknown> = {
      model: req.model,
      input,
    };

    // System prompt → instructions
    if (req.system) {
      body.instructions = req.system;
    }

    // Chain continuation — provider reconstructs context from its stored state.
    if (req.previousResponseId) {
      body.previous_response_id = req.previousResponseId;
    }

    if (req.maxTokens) body.max_output_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    const tier = openaiRequestTier(req.serviceTier);
    if (tier) body.service_tier = tier;

    // Inline moderation — native passthrough (skip when the caller forced emulation).
    if (req.moderation && req.moderation.mode !== 'emulate') {
      body.moderation = buildNativeModeration(req.moderation);
    }

    // Tools — function tools (flat format, strict) + built-in tools (passthrough)
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => {
        if (isFunctionTool(t)) {
          return {
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: ensureAdditionalProperties(t.parameters),
            strict: t.strict ?? true,
          };
        }
        // Built-in tool: pass type + params directly. code_interpreter needs a
        // container; default to an auto (ephemeral) one when none is supplied.
        const builtin: Record<string, unknown> = { type: t.type, ...t.params };
        if (t.type === 'code_interpreter' && builtin.container === undefined) {
          builtin.container = { type: 'auto' };
        }
        return builtin;
      });
    }

    if (req.toolChoice) {
      if (typeof req.toolChoice === 'string') {
        body.tool_choice = req.toolChoice;
      } else {
        body.tool_choice = { type: 'function', name: req.toolChoice.name };
      }
    }

    // Structured output → text.format
    if (req.structured) {
      body.text = {
        format: {
          type: 'json_schema',
          name: req.structured.name ?? 'response',
          schema: ensureAdditionalProperties(req.structured.schema),
          strict: req.structured.strict ?? true,
        },
      };
    }

    // Reasoning
    if (req.thinking && req.thinking.mode !== 'off') {
      body.reasoning = {
        effort: req.thinking.effort ?? 'medium',
        summary: 'auto',
        // Cross-turn reasoning persistence (gpt-5/o-series, Responses only).
        ...(req.thinking.context ? { context: req.thinking.context } : {}),
      };
    }

    return { body };
  }

  /** Convert a universal Message to Responses API input items */
  private buildInputItems(msg: Message): unknown[] {
    const items: unknown[] = [];

    if (msg.role === 'user' || msg.role === 'system') {
      // Simple text
      if (typeof msg.content === 'string') {
        items.push({ role: msg.role, content: msg.content });
      } else {
        // Content parts → convert to input format
        const parts: unknown[] = [];
        for (const p of msg.content) {
          if (p.type === 'text') parts.push({ type: 'input_text', text: p.text });
          else if (p.type === 'image') {
            const s = p.source;
            if (s.type === 'base64')
              parts.push({
                type: 'input_image',
                image_url: `data:${s.mimeType};base64,${s.data}`,
              });
            else if (s.type === 'url') parts.push({ type: 'input_image', image_url: s.url });
            else if (s.type === 'provider_ref')
              parts.push({ type: 'input_file', file_id: s.refId });
          } else if (p.type === 'document') {
            const s = p.source;
            if (s.type === 'provider_ref') parts.push({ type: 'input_file', file_id: s.refId });
            else if (s.type === 'base64')
              parts.push({
                type: 'input_file',
                // Inline file_data REQUIRES a filename (with the right extension)
                // or the Responses API rejects the request.
                filename: filenameForMime(s.mimeType),
                file_data: `data:${s.mimeType};base64,${s.data}`,
              });
            else if (s.type === 'url') parts.push({ type: 'input_file', url: s.url });
          }
        }
        if (parts.length > 0) items.push({ role: msg.role, content: parts });
      }
    }

    if (msg.role === 'assistant') {
      const parts =
        typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;

      // Text content as message output item
      const textParts = parts.filter((p) => p.type === 'text');
      if (textParts.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: textParts.map((p) => ({
            type: 'output_text',
            text: (p as TextPart).text,
          })),
        });
      }

      // Tool calls as function_call items
      for (const p of parts) {
        if (p.type === 'tool_call') {
          items.push({
            type: 'function_call',
            id: `fc_${p.id}`,
            call_id: p.id,
            name: p.name,
            arguments: JSON.stringify(p.arguments),
          });
        }
      }
    }

    if (msg.role === 'tool') {
      const parts =
        typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;

      for (const p of parts) {
        if (p.type === 'tool_result') {
          items.push({
            type: 'function_call_output',
            call_id: p.id,
            output: typeof p.content === 'string' ? p.content : JSON.stringify(p.content),
          });
        }
      }
    }

    return items;
  }

  enableStreaming(providerReq: ProviderHttpRequest): void {
    (providerReq.body as Record<string, unknown>).stream = true;
  }

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    const r = raw as Record<string, unknown>;
    const output = (r.output as Array<Record<string, unknown>>) ?? [];
    const usage = this.parseUsage(r.usage as Record<string, unknown>);
    Object.assign(usage, openaiBilledTier(r.service_tier));

    const content: ContentPart[] = [];
    const toolCalls: ToolCallPart[] = [];
    const media: MediaOutputPart[] = [];
    let thinking: string | null = null;
    let text = '';

    for (const item of output) {
      const type = item.type as string;

      if (type === 'message') {
        const itemContent = (item.content as Array<Record<string, unknown>>) ?? [];
        for (const c of itemContent) {
          if (c.type === 'output_text') {
            const t = c.text as string;
            text += t;
            content.push({ type: 'text', text: t });
          }
        }
      }

      if (type === 'reasoning') {
        const summary = (item.summary as Array<Record<string, unknown>>) ?? [];
        const summaryText = summary
          .filter((s) => s.type === 'summary_text')
          .map((s) => s.text as string)
          .join('\n');
        if (summaryText) thinking = summaryText;
      }

      if (type === 'function_call') {
        const tc: ToolCallPart = {
          type: 'tool_call',
          id: (item.call_id as string) ?? (item.id as string),
          name: item.name as string,
          arguments:
            typeof item.arguments === 'string'
              ? JSON.parse(item.arguments as string)
              : ((item.arguments as Record<string, unknown>) ?? {}),
        };
        content.push(tc);
        toolCalls.push(tc);
      }

      // Built-in image generation tool output
      if (type === 'image_generation_call') {
        const resultData = item.result as string; // base64
        if (resultData) {
          const p: ImageOutputPart = {
            type: 'image_output',
            mediaId: '',
            mimeType:
              (item.output_format as string) === 'jpeg'
                ? 'image/jpeg'
                : (item.output_format as string) === 'webp'
                  ? 'image/webp'
                  : 'image/png',
            revisedPrompt: item.revised_prompt as string | undefined,
            _data: resultData,
          };
          content.push(p);
          media.push(p);
        }
      }
    }

    const status = r.status as string;
    const finishReason = extractFinishReason(toolCalls.length > 0, status, {
      incomplete: 'length',
    });

    // Use output_text convenience if available
    if (!text && typeof r.output_text === 'string') {
      text = r.output_text as string;
      if (text && content.length === 0) content.push({ type: 'text', text });
    }

    const moderation = parseNativeModeration(r.moderation);

    return {
      id: r.id as string,
      model: (r.model as string) ?? '',
      content,
      finishReason,
      usage,
      text,
      toolCalls,
      thinking,
      media,
      ...(moderation ? { moderation } : {}),
      latencyMs,
      raw,
    };
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    const type = data.type as string;
    const events: StreamEvent[] = [];

    if (type === 'response.output_text.delta') {
      events.push({ type: 'text', text: data.delta as string });
    }

    if (type === 'response.function_call_arguments.delta') {
      events.push({
        type: 'tool_call_delta',
        id: (data.call_id as string) ?? '',
        arguments: data.delta as string,
      });
    }

    if (type === 'response.output_item.added') {
      const item = data.item as Record<string, unknown>;
      if (item?.type === 'function_call') {
        events.push({
          type: 'tool_call_start',
          id: (item.call_id as string) ?? '',
          name: (item.name as string) ?? '',
        });
      }
      if (item?.type === 'image_generation_call') {
        events.push({ type: 'media_start', mediaType: 'image', mimeType: 'image/png' });
      }
    }

    // Partial image streaming (OpenAI image_generation tool with partial_images > 0)
    if (type === 'response.image_generation_call.partial_image') {
      events.push({
        type: 'media_chunk',
        data: (data.partial_image as string) ?? '',
        progress: data.partial_image_index as number | undefined,
      });
    }

    if (type === 'response.output_item.done') {
      const item = data.item as Record<string, unknown>;
      if (item?.type === 'function_call') {
        events.push({ type: 'tool_call_end', id: (item.call_id as string) ?? '' });
      }
      if (item?.type === 'image_generation_call') {
        events.push({ type: 'media_end' });
      }
      if (item?.type === 'reasoning') {
        const summary = (item.summary as Array<Record<string, unknown>>) ?? [];
        const text = summary
          .filter((s) => s.type === 'summary_text')
          .map((s) => s.text as string)
          .join('\n');
        if (text) events.push({ type: 'thinking', text });
      }
    }

    if (type === 'response.completed') {
      const response = (data.response as Record<string, unknown>) ?? data;
      // Native moderation rides on the final response object — surface it (input
      // first, then output) before the terminal usage/done events.
      const moderation = parseNativeModeration(response.moderation);
      if (moderation?.input)
        events.push({ type: 'moderation', phase: 'input', result: moderation.input, source: 'native' });
      if (moderation?.output)
        events.push({ type: 'moderation', phase: 'output', result: moderation.output, source: 'native' });
      const usage = response.usage as Record<string, unknown>;
      if (usage) events.push({ type: 'usage', usage: this.parseUsage(usage) });
      events.push({
        type: 'done',
        finishReason: extractFinishReason(false, response.status as string, {
          incomplete: 'length',
        }),
      });
    }

    return events;
  }

  protected parseUsage(u: Record<string, unknown> | undefined): Usage {
    if (!u) return emptyUsage();
    const input = (u.input_tokens as number) ?? 0;
    const output = (u.output_tokens as number) ?? 0;
    const inputDetails = (u.input_tokens_details as Record<string, unknown>) ?? {};
    const outputDetails = (u.output_tokens_details as Record<string, unknown>) ?? {};
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: (u.total_tokens as number) ?? input + output,
      cachedTokens: (inputDetails.cached_tokens as number) ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: (outputDetails.reasoning_tokens as number) ?? 0,
    };
  }
}
