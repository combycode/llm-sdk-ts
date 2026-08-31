/** Google Interactions API adapter.
 *  Endpoint: POST /v1beta/interactions
 *  Modern API: input, system_instruction, outputs (plural), function_result,
 *  previous_interaction_id for stateful, 72h retention. */

import type { SSEEvent } from '../../../network/types';
import type { Message } from '../../types/messages';
import { buildFromSpec } from '../../../wire/interpreter';
import { buildResponse } from '../../../wire/response-interpreter';
import { getResponseSpec } from '../../../wire/response-specs';
import { GOOGLE_INTERACTIONS_REGISTRY } from './interactions-registry';
import type { Registry } from '../../../wire/interpreter';
import { chatSpec } from '../../../wire/chat-specs';
import { makeRegistry } from '../../wire-transforms';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import { emptyUsage, type CompletionResponse, type Usage } from '../../types/response';
import type { StreamEvent } from '../../types/stream';
import { extractFinishReason } from '../_shared/response-utils';
import { sseJson } from '../_shared/sse';

export interface GoogleInteractionsAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** Per-stream state for the Interactions step machine: the id of the currently
 *  open `function_call` step (to attach its id-less `arguments_delta`) and whether
 *  any tool call occurred (to pick the `done` finish reason). */
interface InteractionsStreamState {
  callId?: string;
  sawToolCall: boolean;
}

/** Interactions token usage. Exported so the spec-driven parser runs this and
 *  not a second copy of it. */
export function googleInteractionsUsage(u: Record<string, unknown> | undefined): Usage {
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

  /** Named code the spec cannot express as data — input-item assembly. */
  private readonly wireRegistry: Registry = makeRegistry({ googleInteractions: this });

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    // One shape, no chain: the Interactions wire does not vary by model version,
    // so there is nothing for a pin to choose between.
    return buildFromSpec(
      chatSpec('google/interactions'),
      req,
      this.wireRegistry,
    ) as ProviderHttpRequest;
  }

  // step_list input items (post May-2026): user turns -> {type:'user_input'},
  // assistant turns -> {type:'model_output'}, tool results -> {type:'function_result'}.
  /** Reached through the wire registry while building the request. */
  buildInputItems(msg: Message): unknown[] {
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
    // Spec-driven since 3.3.0; see wire/specs/responses/google.interactions.json.
    const result = buildResponse(
      getResponseSpec('google/interactions.response'),
      raw,
      GOOGLE_INTERACTIONS_REGISTRY,
      { extra: { latencyMs, raw } },
    ) as unknown as CompletionResponse;

    // The one thing the spec cannot own. `buildRequest` names a tool RESULT by
    // looking its call id up here, so a parse that does not record the names
    // sends the next request with an empty `name` -- silently, and only on the
    // turn AFTER the tool call. Re-fed from the built result, which carries the
    // same ids the hand-written loop used to set one at a time.
    for (const tc of result.toolCalls) this.toolCallNames.set(tc.id, tc.name);
    return result;
  }

  /** Translate one Interactions SSE event to unified events. The 2.10 wire is a
   *  step machine (verified live): `step.start` opens a typed step (`model_output`,
   *  `function_call`, `thought`…), `step.delta` streams its payload (`{type:'text'}`,
   *  `{type:'arguments_delta'}`, `{type:'thought_summary'}`, internal
   *  `thought_signature`), `step.stop` closes it, and `interaction.completed` /
   *  `interaction.failed` finish the turn (usage under `interaction.usage`). A
   *  function call's `arguments_delta` carries no id, so we correlate it to the
   *  currently-open call id held in `state`. */
  private streamEvents(event: SSEEvent, state: InteractionsStreamState): StreamEvent[] {
    const data = sseJson(event);
    const type = (data.event_type as string) ?? (data.type as string);
    const events: StreamEvent[] = [];

    if (type === 'step.start') {
      const step = (data.step as Record<string, unknown>) ?? {};
      if (step.type === 'function_call') {
        const id = (step.id as string) ?? '';
        state.callId = id;
        state.sawToolCall = true;
        events.push({ type: 'tool_call_start', id, name: (step.name as string) ?? '' });
        // Args normally stream via arguments_delta; forward any inline object too.
        const args = step.arguments as Record<string, unknown> | undefined;
        if (args && Object.keys(args).length > 0) {
          events.push({ type: 'tool_call_delta', id, arguments: JSON.stringify(args) });
        }
      }
      return events;
    }

    if (type === 'step.delta') {
      const delta = (data.delta as Record<string, unknown>) ?? {};
      const dtype = delta.type as string;
      if (dtype === 'text') {
        events.push({ type: 'text', text: (delta.text as string) ?? '' });
      } else if (dtype === 'thought_summary') {
        events.push({ type: 'thinking', text: (delta.text as string) ?? '' });
      } else if (dtype === 'arguments_delta') {
        // arguments already a JSON string fragment; belongs to the open call.
        events.push({
          type: 'tool_call_delta',
          id: state.callId ?? '',
          arguments: (delta.arguments as string) ?? '',
        });
      }
      // thought_signature and other delta kinds are internal → no unified event.
      return events;
    }

    if (type === 'step.stop') {
      // step.stop carries only an index; close the currently-open function call.
      if (state.callId) {
        events.push({ type: 'tool_call_end', id: state.callId });
        state.callId = undefined;
      }
      return events;
    }

    if (type === 'interaction.completed' || type === 'interaction.failed') {
      // Defensive: flush a still-open call if step.stop was omitted.
      if (state.callId) {
        events.push({ type: 'tool_call_end', id: state.callId });
        state.callId = undefined;
      }
      const interaction = (data.interaction as Record<string, unknown>) ?? {};
      const usage =
        (interaction.usage as Record<string, unknown>) ??
        ((data.metadata as Record<string, unknown>)?.total_usage as Record<string, unknown>);
      if (usage) events.push({ type: 'usage', usage: this.parseUsage(usage) });
      // `queued` is NOT terminal (google 2.13) — the interaction is still to run,
      // so it must never close the stream with a `done`.
      const status = interaction.status as string;
      if (status !== 'queued') {
        events.push({
          type: 'done',
          finishReason: extractFinishReason(state.sawToolCall, status, { failed: 'error' }),
        });
      }
      return events;
    }

    // interaction.created / interaction.status_update / interaction.requires_action → no unified event.
    return events;
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    // Stateless single-event entry (no cross-event correlation of tool-call args).
    return this.streamEvents(event, { sawToolCall: false });
  }

  /** Per-stream stateful parser — correlates a function call's streamed arguments
   *  and end to the call opened by its `step.start`. */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    const state: InteractionsStreamState = { sawToolCall: false };
    return (event) => this.streamEvents(event, state);
  }

  private parseUsage(u: Record<string, unknown> | undefined): Usage {
    return googleInteractionsUsage(u);
  }
}
