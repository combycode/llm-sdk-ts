/** Anthropic provider adapter (Messages API).
 *
 *  Ported from llm-sdk verbatim. Only change: takes NormalizedRequest instead
 *  of CompletionRequest (same shape, renamed for v2 to reflect it's the
 *  internal normalized form LLMClient hands to the adapter). */

import { isBrowser } from '../../../runtime/runtime';
import { base64ToUtf8 } from '../../../util/base64';
import type { SSEEvent } from '../../../network/types';
import type { ContentPart, TextPart, ToolCallPart } from '../../types/messages';
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
import type { StreamEvent } from '../../types/stream';
import { ensureAdditionalProperties } from '../../types/schema-utils';
import type { ServiceTier } from '../../types/tiers';
import { isFunctionTool } from '../../types/tools';
import { DEFAULT_MAX_TOKENS } from '../_shared/constants';
import { extractFinishReason } from '../_shared/response-utils';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_THINKING_BUDGETS,
  DEFAULT_ANTHROPIC_THINKING_BUDGET,
} from './constants';

export interface AnthropicAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

// ─── service tiers (provider-specific, kept local) ───
//  Anthropic's REQUEST param is allow/forbid priority, not a selector:
//    service_tier: 'auto' (may use priority) | 'standard_only' (force standard).
//  The RESPONSE reports what actually billed: usage.service_tier ∈ standard|priority|batch.
const ANTHROPIC_REQUEST_TIER: Record<string, string> = {
  auto: 'auto',
  standard: 'standard_only',
  priority: 'auto',
  flex: 'standard_only', // no Flex tier → standard
  scale: 'auto', // no Scale tier → auto
};
function anthropicRequestTier(t?: ServiceTier): string | undefined {
  if (!t) return undefined;
  return ANTHROPIC_REQUEST_TIER[t] ?? 'auto';
}
/** Billed tier (response usage.service_tier) → {raw, catalog key}. Identity:
 *  the catalog is keyed by Anthropic's own billed names (standard|priority|batch). */
function anthropicBilledTier(raw: unknown): { serviceTier?: string; pricingTier?: string } {
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
function filesFromCodeExecBlock(block: Record<string, unknown>): FileOutput[] {
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
function builtinInputPayload(
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
function resultStdout(content: unknown): string | undefined {
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

  completionPath(): string {
    return '/v1/messages';
  }

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    // cache:'auto' also caches the conversation prefix by putting a breakpoint on
    // the LAST message's last block (Anthropic caches everything up to it) — this
    // covers a large trailing user / RAG context, not just system + tools.
    const cacheAutoLast = req.cache === 'auto';
    const lastIdx = req.messages.length - 1;
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: req.messages.map((m, i) =>
        this.buildMessage(m, req, cacheAutoLast && i === lastIdx),
      ),
    };

    if (req.system) {
      const shouldCache =
        req.cache === 'auto' || (typeof req.cache === 'object' && req.cache.system);
      body.system = shouldCache
        ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
        : req.system;
    }

    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stop) body.stop_sequences = req.stop;
    const tier = anthropicRequestTier(req.serviceTier);
    if (tier) body.service_tier = tier;

    if (req.tools?.length) {
      const shouldCacheTools =
        req.cache === 'auto' || (typeof req.cache === 'object' && req.cache.tools);
      body.tools = req.tools
        .map((t, i) => {
          // Map unified builtins to Anthropic's hosted server tools. web_search is GA;
          // code_execution is a BETA feature — it needs the beta endpoint (`?beta=true`,
          // set below) for its file outputs to surface. Unsupported builtins are skipped.
          if (!isFunctionTool(t)) {
            if (t.type === 'web_search') {
              // Current GA version. Unlike 20250305, it defaults to *programmatic*
              // tool calling (via code execution), which many chat models (e.g. haiku)
              // reject — so default allowed_callers to ['direct'] to preserve the classic
              // direct-call behaviour. Forward the unified params (allowed_domains,
              // blocked_domains, user_location, response_inclusion, max_uses,
              // allowed_callers) verbatim like the OpenAI adapter; the caller overrides
              // any default.
              return {
                type: 'web_search_20260318',
                name: 'web_search',
                max_uses: 5,
                allowed_callers: ['direct'],
                ...t.params,
              };
            }
            if (t.type === 'web_fetch') {
              // Current GA version. Like web_search it defaults to programmatic tool
              // calling, so default allowed_callers to ['direct']; forward params
              // (allowed_domains, blocked_domains, citations, max_content_tokens, max_uses).
              return {
                type: 'web_fetch_20260318',
                name: 'web_fetch',
                allowed_callers: ['direct'],
                ...t.params,
              };
            }
            if (t.type === 'code_interpreter') {
              return { type: 'code_execution_20260521', name: 'code_execution' };
            }
            return null;
          }
          const tool: Record<string, unknown> = {
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          };
          if (t.strict) tool.strict = true;
          if ((t.cache || shouldCacheTools) && i === req.tools!.length - 1) {
            tool.cache_control = { type: 'ephemeral' };
          }
          return tool;
        })
        .filter((t): t is Record<string, unknown> => t !== null);
    }

    if (req.toolChoice) {
      if (req.toolChoice === 'auto') body.tool_choice = { type: 'auto' };
      else if (req.toolChoice === 'none') body.tool_choice = { type: 'none' };
      else if (req.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else body.tool_choice = { type: 'tool', name: req.toolChoice.name };
    }

    if (req.thinking) {
      if (req.thinking.mode === 'off') {
        /* no thinking param */
      } else {
        // Extended thinking. Use enabled+budget — works on ALL thinking-capable
        // models (incl. Haiku); `adaptive` is only on newer models. Map the
        // unified effort to a token budget.
        const budget = req.thinking.effort
          ? (ANTHROPIC_THINKING_BUDGETS[req.thinking.effort] ?? DEFAULT_ANTHROPIC_THINKING_BUDGET)
          : DEFAULT_ANTHROPIC_THINKING_BUDGET;
        body.thinking = { type: 'enabled', budget_tokens: budget };
        // Anthropic requires max_tokens > budget_tokens — lift it transparently.
        if ((body.max_tokens as number) <= budget) body.max_tokens = budget + 1024;
      }
    }

    if (req.structured) {
      body.output_config = {
        ...((body.output_config as Record<string, unknown>) ?? {}),
        format: { type: 'json_schema', schema: ensureAdditionalProperties(req.structured.schema) },
      };
    }

    // Check if any content part uses file references — need beta header
    const hasFileRef = req.messages.some((m) => {
      if (typeof m.content === 'string') return false;
      return m.content.some((p) => {
        const s = (p as { source?: { type?: string } }).source;
        return s?.type === 'provider_ref' || s?.type === 'file';
      });
    });

    const headers: Record<string, string> = {};
    if (hasFileRef) headers['anthropic-beta'] = 'files-api-2025-04-14';

    // user_profile_id: forward a providerOptions.userProfileId to the
    // `anthropic-user-profile-id` header (identifies the end user a request acts on
    // behalf of; needs the account-level `user-profiles` beta). Mirrors the official
    // SDK, which sets only this header.
    const userProfileId = req.providerOptions?.userProfileId;
    if (typeof userProfileId === 'string' && userProfileId) {
      headers['anthropic-user-profile-id'] = userProfileId;
    }

    // Hosted code execution is a beta feature: its output files (container files,
    // returned as bash_code_execution_output.file_id) only surface on the beta
    // endpoint. `client.beta.messages` hits `/v1/messages?beta=true`; mirror that
    // when the code_interpreter builtin is used.
    const usesCodeExec = req.tools?.some(
      (t) => !isFunctionTool(t) && t.type === 'code_interpreter',
    );

    return { body, headers, ...(usesCodeExec ? { path: '/v1/messages?beta=true' } : {}) };
  }

  enableStreaming(providerReq: ProviderHttpRequest, _req: NormalizedRequest): void {
    (providerReq.body as Record<string, unknown>).stream = true;
  }

  private buildMessage(
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
    const r = raw as Record<string, unknown>;
    const contentBlocks = (r.content as Array<Record<string, unknown>>) ?? [];
    const usage = this.parseUsage(r.usage as Record<string, unknown>);
    Object.assign(usage, anthropicBilledTier((r.usage as Record<string, unknown>)?.service_tier));

    const content: ContentPart[] = [];
    let thinking: string | null = null;
    const toolCalls: ToolCallPart[] = [];
    const files: FileOutput[] = [];
    const builtinToolCalls: BuiltinToolCall[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text as string });
      } else if (block.type === 'thinking') {
        thinking = block.thinking as string;
      } else if (block.type === 'tool_use') {
        const tc: ToolCallPart = {
          type: 'tool_call',
          id: block.id as string,
          name: block.name as string,
          arguments: block.input as Record<string, unknown>,
        };
        content.push(tc);
        toolCalls.push(tc);
      } else if (block.type === 'server_tool_use') {
        // Provider-run builtin tool (web search / code execution) — durable trail
        // with its input (code / query).
        const tool = unifiedBuiltinTool(block.name as string);
        builtinToolCalls.push({
          tool,
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
          ...builtinInputPayload(tool, block.input as Record<string, unknown>),
        });
      } else {
        // `*_tool_result`: attach its stdout to the matching call (by tool_use_id).
        if (typeof block.type === 'string' && block.type.endsWith('_tool_result')) {
          const output = resultStdout(block.content);
          if (output) {
            const call = builtinToolCalls.find((c) => c.id === (block.tool_use_id as string));
            if (call) call.output = output;
          }
        }
        // Hosted code-execution output files (fetch bytes by file_id via the Files API).
        files.push(...filesFromCodeExecBlock(block));
      }
    }

    const finishReason = extractFinishReason(toolCalls.length > 0, r.stop_reason as string, {
      max_tokens: 'length',
    });

    return {
      id: r.id as string,
      model: r.model as string,
      content,
      finishReason,
      usage,
      text: content
        .filter((p): p is TextPart => p.type === 'text')
        .map((p) => p.text)
        .join(''),
      toolCalls,
      media: [],
      ...(files.length ? { files } : {}),
      ...(builtinToolCalls.length ? { builtinToolCalls } : {}),
      thinking,
      latencyMs,
      raw,
    };
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
    const data = JSON.parse(event.data) as Record<string, unknown>;
    const type = data.type as string;

    if (type === 'content_block_delta') {
      const delta = data.delta as Record<string, unknown>;
      if (delta.type === 'text_delta') return [{ type: 'text', text: delta.text as string }];
      if (delta.type === 'thinking_delta')
        return [{ type: 'thinking', text: delta.thinking as string }];
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
          finishReason: extractFinishReason(sr === 'tool_use', sr, { max_tokens: 'length' }),
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
}
