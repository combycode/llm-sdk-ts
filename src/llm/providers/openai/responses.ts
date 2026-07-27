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
  type BuiltinToolCall,
  type CompletionResponse,
  type FileOutput,
  type Usage,
} from '../../types/response';
import { unifiedBuiltinTool } from '../_shared/builtin-tools';
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

/** Code-interpreter stdout/logs. OpenAI logs are plain text `{type:'logs', logs}`;
 *  xAI wraps stdout in a JSON envelope in the same field — pull stdout from either. */
function codeOutputFromResponsesItem(item: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const out of (item.outputs as Array<Record<string, unknown>>) ?? []) {
    if (out.type !== 'logs' || typeof out.logs !== 'string') continue;
    try {
      const j = JSON.parse(out.logs) as Record<string, unknown>;
      if (typeof j.stdout === 'string') {
        parts.push(j.stdout);
        continue;
      }
    } catch {
      /* not JSON → plain logs */
    }
    parts.push(out.logs);
  }
  return parts.length ? parts.join('') : undefined;
}

/** web_search_call carries a query under `action` for a `search` step
 *  (`.queries[]`, or the deprecated scalar `.query`), or a `url` for an
 *  `open_page` / `find` step (the page it read). */
function searchActionPayload(item: Record<string, unknown>): { query?: string; url?: string } {
  const action = item.action as Record<string, unknown> | undefined;
  if (!action) return {};
  const out: { query?: string; url?: string } = {};
  // OpenAI deprecated the singular `action.query` in favour of `action.queries[]`.
  // Prefer the array; fall back to the legacy scalar for older/streamed items.
  if (Array.isArray(action.queries) && typeof action.queries[0] === 'string')
    out.query = action.queries[0];
  else if (typeof action.query === 'string') out.query = action.query;
  if (typeof action.url === 'string') out.url = action.url;
  return out;
}

/** Hosted builtin-tool output items (provider-run) → a unified `BuiltinToolCall`
 *  (with its code/output/query payload), or null for non-builtin items. Shared by
 *  the buffered and streamed paths. */
const RESPONSES_BUILTIN_ITEMS = new Set(['web_search_call', 'code_interpreter_call']);
function builtinCallFromResponsesItem(item: Record<string, unknown>): BuiltinToolCall | null {
  const type = item.type as string;
  if (!RESPONSES_BUILTIN_ITEMS.has(type)) return null;
  const call: BuiltinToolCall = { tool: unifiedBuiltinTool(type) };
  if (typeof item.id === 'string') call.id = item.id;
  if (type === 'code_interpreter_call') {
    if (typeof item.code === 'string') call.code = item.code;
    const output = codeOutputFromResponsesItem(item);
    if (output) call.output = output;
  } else if (type === 'web_search_call') {
    const { query, url } = searchActionPayload(item);
    if (query) call.query = query;
    if (url) call.url = url;
  }
  return call;
}

/** Spread a `BuiltinToolCall`'s optional payload into a `builtin_tool_end` event. */
function builtinEndPayload(call: BuiltinToolCall): Record<string, string> {
  return {
    ...(call.id ? { id: call.id } : {}),
    ...(call.code ? { code: call.code } : {}),
    ...(call.output ? { output: call.output } : {}),
    ...(call.query ? { query: call.query } : {}),
    ...(call.url ? { url: call.url } : {}),
  };
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

interface Citation {
  fileId: string;
  filename?: string;
  containerId?: string;
  /** `[start_index, end_index]` of the text this citation anchors to. */
  span: [number, number];
}

/** A container_file_citation that is OpenAI's matplotlib auto-display artifact
 *  (`plt.show()`), NOT an explicitly-saved file. Verified across scenarios: it is
 *  named after its own id, is an image, and its citation is zero-width (not anchored
 *  to any text — real saves are anchored to the `sandbox:` link). All three hold for
 *  auto-displays and never for saved files. */
function isDisplayArtifact(c: Citation): boolean {
  if (!c.filename) return false;
  const ext = fileExt(c.filename);
  return c.filename === `${c.fileId}.${ext}` && IMAGE_EXTS.has(ext) && c.span[0] === c.span[1];
}

/** Extract hosted code-execution output files from one Responses output item.
 *  Shared by the buffered (`parseResponse`) and streamed (`response.output_item.done`)
 *  paths so both surface the exact same `FileOutput[]`. Two sources:
 *    - `message` items → `container_file_citation` annotations (downloadable
 *      container files, fetched by file id from `/v1/containers/{cid}/files/{id}`);
 *    - `code_interpreter_call` items → image outputs returned by URL.
 *
 *  Dedup: `plt.show()` makes OpenAI emit an auto-display container file ALONGSIDE the
 *  explicitly-saved one. When the same image was also saved, we drop the display
 *  duplicate (matches ChatGPT's own UI); a display-only run keeps its sole figure. */
function filesFromResponsesOutputItem(item: Record<string, unknown>): FileOutput[] {
  const files: FileOutput[] = [];
  const type = item.type as string;
  if (type === 'message') {
    const citations: Citation[] = [];
    for (const c of (item.content as Array<Record<string, unknown>>) ?? []) {
      if (c.type !== 'output_text') continue;
      for (const a of (c.annotations as Array<Record<string, unknown>>) ?? []) {
        if (a.type === 'container_file_citation' && typeof a.file_id === 'string') {
          citations.push({
            fileId: a.file_id,
            filename: typeof a.filename === 'string' ? a.filename : undefined,
            containerId: typeof a.container_id === 'string' ? a.container_id : undefined,
            span: [Number(a.start_index) || 0, Number(a.end_index) || 0],
          });
        }
      }
    }
    // A saved (non-artifact) image citation → its auto-display twin is a duplicate.
    const hasSavedImage = citations.some(
      (c) => !isDisplayArtifact(c) && IMAGE_EXTS.has(fileExt(c.filename ?? '')),
    );
    for (const c of citations) {
      if (hasSavedImage && isDisplayArtifact(c)) continue; // drop the display duplicate
      files.push({
        id: c.fileId,
        ...(c.filename ? { name: c.filename } : {}),
        ...(c.containerId ? { ref: { containerId: c.containerId } } : {}),
        source: 'code_execution',
      });
    }
  }
  if (type === 'code_interpreter_call') {
    for (const out of (item.outputs as Array<Record<string, unknown>>) ?? []) {
      if (out.type === 'image' && typeof out.url === 'string') {
        files.push({ url: out.url, source: 'code_execution' });
      }
    }
  }
  return files;
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
    // `providerOptions.moderationPolicy` opts into OpenAI server-side blocking and
    // can ride even without a unified `moderation` request.
    const modPolicy = req.providerOptions?.moderationPolicy;
    if ((req.moderation && req.moderation.mode !== 'emulate') || modPolicy) {
      body.moderation = buildNativeModeration(req.moderation, modPolicy);
    }

    // Explicit prompt caching (gpt-5.6+). OpenAI caches IMPLICITLY by default, so
    // the unified `cache` config already "just works" here — this passthrough is
    // for manual control (`{ mode:'explicit'|'implicit', ttl:'30m' }` + per-part
    // breakpoints). True-OpenAI only; xai/openrouter inherit this builder.
    if (this.name === 'openai' && req.providerOptions?.promptCacheOptions) {
      body.prompt_cache_options = req.providerOptions.promptCacheOptions;
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
            // Programmatic tool calling (Responses): who may call it + return schema.
            ...(t.allowedCallers ? { allowed_callers: t.allowedCallers } : {}),
            ...(t.outputSchema ? { output_schema: t.outputSchema } : {}),
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
      const visibility = req.thinking.visibility ?? 'full';
      // `summary` controls how much reasoning is surfaced: full -> 'auto' (fullest
      // the model offers), summary -> 'concise', hidden -> omit it entirely.
      const summary = visibility === 'hidden' ? null : visibility === 'summary' ? 'concise' : 'auto';
      // Execution mode (standard | pro) is Responses-only — chat-completions rejects
      // it — so it's a providerOptions passthrough, not a unified ThinkingConfig knob.
      const mode = req.providerOptions?.reasoningMode as 'standard' | 'pro' | undefined;
      body.reasoning = {
        effort: req.thinking.effort ?? 'medium',
        ...(summary !== null ? { summary } : {}),
        ...(mode ? { mode } : {}),
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
    const files: FileOutput[] = [];
    const builtinToolCalls: BuiltinToolCall[] = [];
    let thinking: string | null = null;
    let text = '';

    for (const item of output) {
      const type = item.type as string;

      // Hosted code-execution output files (container-file annotations on a
      // message, or code-interpreter image URLs) — shared with the stream path.
      files.push(...this.filesFromOutputItem(item));

      // Hosted builtin-tool calls (web search / code interpreter) — durable trail.
      const builtinCall = builtinCallFromResponsesItem(item);
      if (builtinCall) builtinToolCalls.push(builtinCall);

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
    // `status: 'incomplete'` carries a sub-reason: `content_filter` (a moderation/
    // safety block) or `max_output_tokens` (a token cap). Surface content_filter
    // distinctly instead of mislabelling a block as a length truncation.
    const incompleteReason = (r.incomplete_details as { reason?: string } | undefined)?.reason;
    // A Responses call can FAIL inside a 200 (`status:'failed'` + `response.error`) — there
    // is no transport error to catch, so mapping it to 'stop' silently returned an empty
    // success. `queued`/`in_progress` are non-terminal (background mode) and `cancelled`
    // ended without a result; none of them is a clean finish.
    const finishReason =
      incompleteReason === 'content_filter'
        ? 'content_filter'
        : extractFinishReason(toolCalls.length > 0, status, {
            incomplete: 'length',
            failed: 'error',
            cancelled: 'error',
            queued: 'pending',
            in_progress: 'pending',
          });
    // `error.code` gained `data_residency_mismatch` in openai 6.49 (GA + beta).
    const rawError = r.error as { code?: unknown; message?: unknown } | null | undefined;
    const error =
      rawError && (rawError.code !== undefined || rawError.message !== undefined)
        ? {
            ...(typeof rawError.code === 'string' ? { code: rawError.code } : {}),
            ...(typeof rawError.message === 'string' ? { message: rawError.message } : {}),
          }
        : undefined;

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
      ...(files.length ? { files } : {}),
      ...(builtinToolCalls.length ? { builtinToolCalls } : {}),
      ...(moderation ? { moderation } : {}),
      ...(error ? { error } : {}),
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
      const builtin = builtinCallFromResponsesItem(item ?? {});
      if (builtin) {
        events.push({ type: 'builtin_tool_start', tool: builtin.tool, ...(builtin.id ? { id: builtin.id } : {}) });
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
      // Code-execution output files finalize with their output item — same
      // extraction as the buffered path, emitted as they complete.
      for (const file of this.filesFromOutputItem(item)) events.push({ type: 'file', file });
      const builtin = builtinCallFromResponsesItem(item ?? {});
      if (builtin) {
        events.push({ type: 'builtin_tool_end', tool: builtin.tool, ...builtinEndPayload(builtin) });
      }
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

  /** Stateless — each output item finalizes with all its file annotations in a
   *  single response.output_item.done event. */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    return (event) => this.parseStreamEvent(event);
  }

  /** Hosted code-execution output files from one output item. Overridable so
   *  Responses-compatible providers with a different file shape (e.g. xAI, which
   *  embeds files in the code-interpreter `logs` payload) can extend it. */
  protected filesFromOutputItem(item: Record<string, unknown>): FileOutput[] {
    return filesFromResponsesOutputItem(item);
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
      cacheWriteTokens: (inputDetails.cache_write_tokens as number) ?? 0,
      reasoningTokens: (outputDetails.reasoning_tokens as number) ?? 0,
    };
  }
}
