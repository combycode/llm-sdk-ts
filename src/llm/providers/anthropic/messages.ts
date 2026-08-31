/** Anthropic provider adapter (Messages API).
 *
 *  Ported from llm-sdk verbatim. Only change: takes NormalizedRequest instead
 *  of CompletionRequest (same shape, renamed for v2 to reflect it's the
 *  internal normalized form LLMClient hands to the adapter). */

import { isBrowser } from '../../../runtime/runtime';
import { base64ToUtf8 } from '../../../util/base64';
import type { SSEEvent } from '../../../network/types';
import type { ContentPart } from '../../types/messages';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import {
  emptyUsage,
  type CompletionResponse,
  type FileOutput,
  type Usage,
} from '../../types/response';
import { buildFromSpec } from '../../../wire/interpreter';
import { buildResponse } from '../../../wire/response-interpreter';
import { getResponseSpec } from '../../../wire/response-specs';
import { ANTHROPIC_RESPONSE_REGISTRY } from './response-registry';
import type { Registry } from '../../../wire/interpreter';
import { chatSpec, isChatSpec } from '../../../wire/chat-specs';
import { pinFor, ANTHROPIC_MESSAGE_PINS } from '../../../wire/pins';
import { makeRegistry } from '../../wire-transforms';
import { unifiedBuiltinTool } from '../_shared/builtin-tools';
import type { StreamEvent } from '../../types/stream';
import { extractFinishReason } from '../_shared/response-utils';
import { ANTHROPIC_API_VERSION } from './constants';
import { sseJson } from '../_shared/sse';

export interface AnthropicAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

// ─── service tiers (provider-specific, kept local) ───
//  The REQUEST mapping moved into the spec: Anthropic's param is allow/forbid
//  priority rather than a selector, and that is a table, which is data.
//  The RESPONSE side stays here — it reads what actually billed
//  (usage.service_tier ∈ standard|priority|batch), which no spec describes.
/** Billed tier (response usage.service_tier) → {raw, catalog key}. Identity:
 *  the catalog is keyed by Anthropic's own billed names (standard|priority|batch). */
export function anthropicBilledTier(raw: unknown): { serviceTier?: string; pricingTier?: string } {
  return typeof raw === 'string' && raw ? { serviceTier: raw, pricingTier: raw } : {};
}

/** Extract hosted code-execution output files from one content block. Shared by
 *  the buffered (`parseResponse`) and streamed (`content_block_start`) paths so
 *  both surface the exact same `FileOutput[]`. The current tool
 *  (code_execution_20260521) emits `bash_code_execution_tool_result` →
 *  `bash_code_execution_result` → `content[]` of `bash_code_execution_output`;
 *  older tool versions emit the `code_execution_*` equivalents. Both carry
 *  `file_id`. (`text_editor_code_execution_tool_result` blocks are file
 *  create/view/edit markers with no downloadable id, so they are not surfaced.) */
export function filesFromCodeExecBlock(block: Record<string, unknown>): FileOutput[] {
  if (
    block.type !== 'bash_code_execution_tool_result' &&
    block.type !== 'code_execution_tool_result'
  ) {
    return [];
  }
  const result = block.content as Record<string, unknown> | undefined;
  if (
    !result ||
    (result.type !== 'bash_code_execution_result' && result.type !== 'code_execution_result') ||
    !Array.isArray(result.content)
  ) {
    return [];
  }
  const files: FileOutput[] = [];
  for (const out of result.content as Array<Record<string, unknown>>) {
    if (
      (out.type === 'bash_code_execution_output' || out.type === 'code_execution_output') &&
      typeof out.file_id === 'string'
    ) {
      files.push({ id: out.file_id, source: 'code_execution' });
    }
  }
  return files;
}

/** Builtin-tool payload from a `server_tool_use` input: the code (code execution)
 *  or the query (web search). Shared by the buffered + streamed paths. */
export function builtinInputPayload(
  tool: string,
  input: Record<string, unknown> | undefined,
): { code?: string; query?: string; url?: string } {
  if (!input) return {};
  if (tool === 'code_interpreter') {
    const code = input.code ?? input.command;
    return typeof code === 'string' ? { code } : {};
  }
  if (tool === 'web_search') {
    return typeof input.query === 'string' ? { query: input.query } : {};
  }
  if (tool === 'web_fetch') {
    return typeof input.url === 'string' ? { url: input.url } : {};
  }
  return {};
}

/** stdout from a code-execution `*_tool_result` block's content, if present. */
export function resultStdout(content: unknown): string | undefined {
  const c = content as Record<string, unknown> | undefined;
  return c && typeof c.stdout === 'string' ? c.stdout : undefined;
}

/** Per-stream state threaded through `createStreamParser`. */
interface AnthropicStreamState {
  /** The currently-open `server_tool_use` block whose input JSON is being accumulated. */
  current?: { id: string; tool: string; json: string };
  /** Finalized server_tool_use inputs (code / query), by id, awaiting their result. */
  pending: Map<string, { code?: string; query?: string; url?: string }>;
}

export function anthropicUsage(u: Record<string, unknown> | undefined): Usage {
  if (!u) return emptyUsage();
  const inputTokens = (u.input_tokens as number) ?? 0;
  const outputTokens = (u.output_tokens as number) ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: (u.cache_read_input_tokens as number) ?? 0,
    cacheWriteTokens: (u.cache_creation_input_tokens as number) ?? 0,
    reasoningTokens: 0,
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic' as const;
  protected readonly apiKey: string;
  protected readonly _baseURL?: string;

  constructor(config: AnthropicAdapterConfig) {
    this.apiKey = config.apiKey;
    this._baseURL = config.baseURL;
  }

  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
    };
    // Anthropic's CORS preflight rejects browser-origin requests unless this
    // opt-in header is present. Send it only in the browser (BYOK direct calls);
    // harmless to omit on Node/Bun. See runtime.isBrowser().
    if (isBrowser()) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return headers;
  }

  baseURL(): string {
    return this._baseURL ?? 'https://api.anthropic.com';
  }

  /** Named code the spec cannot express as data — message and content assembly.
   *  Built once, carrying only this adapter, since only Anthropic rules run. */
  private readonly wireRegistry: Registry = makeRegistry({ anthropic: this });

  completionPath(): string {
    return '/v1/messages';
  }

  /** The spec that builds this model's request.
   *
   *  The catalog pin decides when there is one. Without it — an engine running
   *  with no catalog, or a model released after this build — the band comes from
   *  the pin TABLE, which is data (`src/wire/pins/`) rather than version
   *  arithmetic in TypeScript, so the Python and Rust ports derive the same node
   *  from the same file instead of each re-implementing it. */
  private specIdFor(req: NormalizedRequest): string {
    if (isChatSpec(req.wireSpec) && req.wireSpec.startsWith('anthropic/')) return req.wireSpec;
    return pinFor(req.model, ANTHROPIC_MESSAGE_PINS);
  }

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    return buildFromSpec(
      chatSpec(this.specIdFor(req)),
      req,
      this.wireRegistry,
    ) as ProviderHttpRequest;
  }

  enableStreaming(providerReq: ProviderHttpRequest, _req: NormalizedRequest): void {
    (providerReq.body as Record<string, unknown>).stream = true;
  }

  /** Reached through the wire registry while building this adapter's own request. */
  buildMessage(
    msg: { role: string; content: string | ContentPart[]; cache?: boolean },
    _req: NormalizedRequest,
    forceCache = false,
  ): Record<string, unknown> {
    const role = msg.role === 'tool' ? 'user' : msg.role;
    const parts =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content.map((p) => this.buildContentPart(p));

    if (msg.cache || forceCache) {
      const last = parts[parts.length - 1];
      if (last) (last as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }

    return { role, content: parts };
  }

  private buildContentPart(part: ContentPart): Record<string, unknown> {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text };
      case 'image': {
        const s = part.source;
        if (s.type === 'base64')
          return {
            type: 'image',
            source: { type: 'base64', media_type: s.mimeType, data: s.data },
          };
        if (s.type === 'url') return { type: 'image', source: { type: 'url', url: s.url } };
        if (s.type === 'provider_ref')
          return { type: 'image', source: { type: 'file', file_id: s.refId } };
        if (s.type === 'file')
          return { type: 'image', source: { type: 'file', file_id: s.fileId } };
        return { type: 'image', source: {} };
      }
      case 'document': {
        const s = part.source;
        const block: Record<string, unknown> = { type: 'document' };
        if (s.type === 'base64') {
          // Anthropic plain-text documents use a `text` source (the raw text);
          // base64 sources are only for binary docs like application/pdf.
          if (s.mimeType === 'text/plain') {
            block.source = { type: 'text', media_type: 'text/plain', data: base64ToUtf8(s.data) };
          } else {
            block.source = { type: 'base64', media_type: s.mimeType, data: s.data };
          }
        } else if (s.type === 'url') block.source = { type: 'url', url: s.url };
        else if (s.type === 'provider_ref') block.source = { type: 'file', file_id: s.refId };
        else if (s.type === 'file') block.source = { type: 'file', file_id: s.fileId };
        if (part.citations) block.citations = { enabled: true };
        return block;
      }
      case 'tool_call':
        return { type: 'tool_use', id: part.id, name: part.name, input: part.arguments };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: part.id,
          content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
        };
      default:
        return { type: 'text', text: `[unsupported: ${(part as ContentPart).type}]` };
    }
  }

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    // Spec-driven since 3.3.0. The block-by-block walk this replaced is in
    // `wire/specs/responses/anthropic.messages.json`, and the differential over
    // every recorded Anthropic body asserts the two produce the same object.
    return buildResponse(
      getResponseSpec('anthropic/messages.response'),
      raw,
      ANTHROPIC_RESPONSE_REGISTRY,
      {
        extra: { latencyMs, raw },
      },
    ) as unknown as CompletionResponse;
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    // Stateless entry — the per-event primitive; no server_tool_use input correlation.
    return this.streamEvents(event, { pending: new Map() });
  }

  /** Stateful — Anthropic streams `server_tool_use` input via `input_json_delta`
   *  (empty at block start) and returns the result in a separate `*_tool_result`
   *  block. The closure accumulates each call's input (code / query) and attaches it
   *  to the matching `builtin_tool_end`. */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    const state: AnthropicStreamState = { pending: new Map() };
    return (event) => this.streamEvents(event, state);
  }

  private streamEvents(event: SSEEvent, state: AnthropicStreamState): StreamEvent[] {
    if (event.event === 'ping') return [];
    const data = sseJson(event);
    const type = data.type as string;

    if (type === 'content_block_delta') {
      const delta = data.delta as Record<string, unknown>;
      if (delta.type === 'text_delta') return [{ type: 'text', text: delta.text as string }];
      if (delta.type === 'thinking_delta')
        return [{ type: 'thinking', text: delta.thinking as string }];
      if (delta.type === 'citations_delta') {
        // The citation the ANSWER makes, which is not the same as the search
        // results in the `web_search_tool_result` block: the model retrieves
        // several pages and cites some of them.
        const cite = (delta.citation as Record<string, unknown>) ?? {};
        const url = cite.url as string | undefined;
        return url
          ? [
              {
                type: 'citation',
                citation: {
                  url,
                  ...(cite.title ? { title: cite.title as string } : {}),
                  ...(cite.cited_text ? { text: cite.cited_text as string } : {}),
                },
              },
            ]
          : [];
      }
      if (delta.type === 'input_json_delta') {
        // A server_tool_use input is accumulated (attached to builtin_tool_end); a
        // regular function tool_use streams its arguments as tool_call_delta.
        if (state.current) {
          state.current.json += (delta.partial_json as string) ?? '';
          return [];
        }
        return [{ type: 'tool_call_delta', id: '', arguments: delta.partial_json as string }];
      }
    }

    if (type === 'content_block_start') {
      const block = data.content_block as Record<string, unknown>;
      if (block.type === 'tool_use') {
        state.current = undefined;
        return [{ type: 'tool_call_start', id: block.id as string, name: block.name as string }];
      }
      const events: StreamEvent[] = [];
      const blockType = block.type as string;
      // Provider-run builtin tool: `server_tool_use` is the call (its input streams in
      // via input_json_delta), `*_tool_result` its completion (carrying output +
      // any code-execution files).
      if (blockType === 'server_tool_use') {
        const tool = unifiedBuiltinTool(block.name as string);
        state.current = { id: (block.id as string) ?? '', tool, json: '' };
        events.push({
          type: 'builtin_tool_start',
          tool,
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
        });
      } else if (blockType?.endsWith('_tool_result')) {
        const tool = unifiedBuiltinTool(blockType);
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
        const input = id ? state.pending.get(id) : undefined;
        if (id) state.pending.delete(id);
        const output = resultStdout(block.content);
        events.push({
          type: 'builtin_tool_end',
          tool,
          ...(id ? { id } : {}),
          ...(input?.code ? { code: input.code } : {}),
          ...(input?.query ? { query: input.query } : {}),
          ...(input?.url ? { url: input.url } : {}),
          ...(output ? { output } : {}),
        });
      }
      // Server-computed code-execution result blocks arrive complete in
      // content_block_start (not token-streamed) — surface their output files.
      for (const file of filesFromCodeExecBlock(block)) events.push({ type: 'file', file });
      return events;
    }

    if (type === 'content_block_stop') {
      // Finalize an accumulated server_tool_use input → payload keyed by id, ready
      // for its *_tool_result.
      if (state.current) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(state.current.json || '{}') as Record<string, unknown>;
        } catch {
          /* partial/invalid JSON → no payload */
        }
        state.pending.set(state.current.id, builtinInputPayload(state.current.tool, input));
        state.current = undefined;
      }
    }

    if (type === 'message_delta') {
      const delta = data.delta as Record<string, unknown>;
      const usage = data.usage as Record<string, unknown> | undefined;
      const events: StreamEvent[] = [];
      if (usage) events.push({ type: 'usage', usage: this.parseUsage(usage) });
      const sr = delta.stop_reason as string;
      if (sr)
        events.push({
          type: 'done',
          finishReason: extractFinishReason(sr === 'tool_use', sr, {
            max_tokens: 'length',
            model_context_window_exceeded: 'length',
            refusal: 'content_filter',
          }),
        });
      return events;
    }

    if (type === 'message_start') {
      const msg = data.message as Record<string, unknown>;
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage) return [{ type: 'usage', usage: this.parseUsage(usage) }];
    }

    return [];
  }

  private parseUsage(u: Record<string, unknown> | undefined): Usage {
    return anthropicUsage(u);
  }
}
