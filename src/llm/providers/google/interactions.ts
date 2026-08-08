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
import { GOOGLE_INTERACTION_THINKING_LEVELS } from './constants';

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
    // Unlike the penalties above, Interactions DOES accept top_k and seed
    // (live-verified 2026-07-28: both 200). Do not assume this surface mirrors the
    // penalties' rejection — it was probed field by field.
    if (req.topK !== undefined) genConfig.top_k = req.topK;
    if (req.seed !== undefined) genConfig.seed = req.seed;
    // NOTE: the Interactions API does NOT accept presence_penalty / frequency_penalty
    // (live 2026-07-14: 400 "Unknown parameter 'presence_penalty' at 'generation_config'";
    // upstream removed them from the Interactions GenerationConfig in google 2.11). They
    // remain valid on generateContent — do not emit them here.
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

    // Thinking — the Interactions GenerationConfig takes `thinking_level` DIRECTLY
    // (not wrapped in a thinking_config; wrapping 400s "Unknown parameter
    // 'thinking_config'"). It has no token-budget field, so it's thinkingLevel-only.
    if (req.thinking && req.thinking.mode !== 'off') {
      genConfig.thinking_level =
        GOOGLE_INTERACTION_THINKING_LEVELS[req.thinking.effort ?? 'high'] ?? 'high';
    }

    if (Object.keys(genConfig).length > 0) body.generation_config = genConfig;

    // NOTE: `cached_content` was REMOVED from the Interactions request model in google
    // 2.13 (both `CreateModelInteraction` and `Interaction`). We used to forward
    // `providerOptions.cachedContent` here; the endpoint now hard-rejects it — live
    // 2026-07-27: 400 "Unknown parameter 'cached_content'". Explicit cached content
    // remains valid on generateContent, so the passthrough lives there only. Do NOT
    // re-add it here from a stale SDK reference (this is the same trap as the
    // Interactions penalties removed on 2026-07-14).
    // NOTE: the SDK's interactions create params also list `safety_settings` +
    // `labels`, but the Gemini Developer API REJECTS both ("not available on the
    // Gemini API … available on the Gemini Enterprise Agent Platform" — live-verified
    // 2026-07-14). They are Vertex/Enterprise-only, so we do NOT forward them here.

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
    // `queued` joined InteractionStatus in google 2.13 (interaction-api): the
    // interaction was accepted but has not run, so it carries no completion —
    // reporting 'stop' would claim a clean finish that never happened.
    const finishReason = extractFinishReason(toolCalls.length > 0, status, {
      failed: 'error',
      queued: 'pending',
      in_progress: 'pending',
    });

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

  /** Translate one Interactions SSE event to unified events. The 2.10 wire is a
   *  step machine (verified live): `step.start` opens a typed step (`model_output`,
   *  `function_call`, `thought`…), `step.delta` streams its payload (`{type:'text'}`,
   *  `{type:'arguments_delta'}`, `{type:'thought_summary'}`, internal
   *  `thought_signature`), `step.stop` closes it, and `interaction.completed` /
   *  `interaction.failed` finish the turn (usage under `interaction.usage`). A
   *  function call's `arguments_delta` carries no id, so we correlate it to the
   *  currently-open call id held in `state`. */
  private streamEvents(event: SSEEvent, state: InteractionsStreamState): StreamEvent[] {
    const data = JSON.parse(event.data) as Record<string, unknown>;
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
        events.push({ type: 'tool_call_delta', id: state.callId ?? '', arguments: (delta.arguments as string) ?? '' });
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
