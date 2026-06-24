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
  type CompletionResponse,
  type FileOutput,
  type Usage,
} from '../../types/response';
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
          // Map unified builtins to Anthropic's hosted server tools (GA on Messages,
          // no beta header - same as web_search). Unsupported builtins are skipped.
          if (!isFunctionTool(t)) {
            if (t.type === 'web_search') {
              return { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
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

    return { body, headers };
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
      } else if (block.type === 'code_execution_tool_result') {
        // Hosted code-execution output: collect produced file refs (fetch by id).
        const result = block.content as Record<string, unknown> | undefined;
        if (result?.type === 'code_execution_result') {
          for (const out of (result.content as Array<Record<string, unknown>>) ?? []) {
            if (out.type === 'code_execution_output' && typeof out.file_id === 'string') {
              files.push({ id: out.file_id, source: 'code_execution' });
            }
          }
        }
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
      thinking,
      latencyMs,
      raw,
    };
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    if (event.event === 'ping') return [];
    const data = JSON.parse(event.data) as Record<string, unknown>;
    const type = data.type as string;

    if (type === 'content_block_delta') {
      const delta = data.delta as Record<string, unknown>;
      if (delta.type === 'text_delta') return [{ type: 'text', text: delta.text as string }];
      if (delta.type === 'thinking_delta')
        return [{ type: 'thinking', text: delta.thinking as string }];
      if (delta.type === 'input_json_delta') {
        return [{ type: 'tool_call_delta', id: '', arguments: delta.partial_json as string }];
      }
    }

    if (type === 'content_block_start') {
      const block = data.content_block as Record<string, unknown>;
      if (block.type === 'tool_use') {
        return [{ type: 'tool_call_start', id: block.id as string, name: block.name as string }];
      }
    }

    if (type === 'content_block_stop') {
      // Could be tool_call_end but we don't have the ID here; accumulate at client level
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
