/** Anthropic provider adapter (Messages API).
 *
 *  Ported from llm-sdk verbatim. Only change: takes NormalizedRequest instead
 *  of CompletionRequest (same shape, renamed for v2 to reflect it's the
 *  internal normalized form LLMClient hands to the adapter). */

import { isBrowser } from '../../../runtime/runtime';
import { base64ToUtf8 } from '../../../util/base64';
import type { SSEEvent } from '../../../network/types';
import type { ContentPart, ToolResultPart } from '../../types/messages';
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
import { createStreamBuilder } from '../../../wire/stream-interpreter';
import { getStreamSpec } from '../../../wire/stream-specs';
import { ANTHROPIC_STREAM_REGISTRY } from './stream-registry';
import type { Registry } from '../../../wire/interpreter';
import { chatSpec, isChatSpec } from '../../../wire/chat-specs';
import { pinFor, ANTHROPIC_MESSAGE_PINS } from '../../../wire/pins';
import { makeRegistry } from '../../wire-transforms';
import type { StreamEvent } from '../../types/stream';
import { ANTHROPIC_API_VERSION } from './constants';

export interface AnthropicAdapterConfig {
  apiKey: string;
  baseURL?: string;
  /** Workspace this client acts in, sent as `anthropic-workspace-id`.
   *
   *  Only meaningful for a credential that can act on more than one Workspace;
   *  one scoped to a single Workspace may omit it, and if sent it must match.
   *  Worth setting because Workspace is where spend, rate limits and retention
   *  are accounted: a multi-workspace key that omits it does not fail, it bills
   *  the wrong place silently. `providerOptions.workspaceId` overrides it for a
   *  single request. */
  workspaceId?: string;
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
  readonly workspaceId?: string;

  constructor(config: AnthropicAdapterConfig) {
    this.apiKey = config.apiKey;
    this._baseURL = config.baseURL;
    this.workspaceId = config.workspaceId;
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
    // The client-wide default. A per-request `providerOptions.workspaceId`
    // lands in the spec envelope, and the client spreads those AFTER these, so
    // the request wins -- which is the order a caller would expect.
    if (this.workspaceId) headers['anthropic-workspace-id'] = this.workspaceId;
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
        const source =
          s.type === 'base64'
            ? { type: 'base64', media_type: s.mimeType, data: s.data }
            : s.type === 'url'
              ? { type: 'url', url: s.url }
              : s.type === 'provider_ref'
                ? { type: 'file', file_id: s.refId }
                : s.type === 'file'
                  ? { type: 'file', file_id: s.fileId }
                  : {};
        // Per-image, and only when asked for: the server's default is to
        // downsize an oversized image silently, and restating that default on
        // every block would freeze it into requests that never chose it.
        const transformations = part.providerOptions?.transformations;
        return {
          type: 'image',
          source,
          ...(transformations && Object.keys(transformations).length > 0 ? { transformations } : {}),
        };
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
          content: this.buildToolResultContent(part.content),
        };
      default:
        return { type: 'text', text: `[unsupported: ${(part as ContentPart).type}]` };
    }
  }

  /** What a tool handed back, in the slot Anthropic gives it.
   *
   *  `tool_result.content` takes a string OR a block array, and the block array
   *  accepts the same `text`/`image`/`document` blocks a user message does — so
   *  an image a tool produced needs no separate message and no re-encoding. A
   *  plain string result still sends the string, byte for byte as before.
   *
   *  Audio and video have no block form here; `buildContentPart` renders those
   *  as an `[unsupported: …]` note, which is the honest outcome — better a
   *  visible gap than base64 silently billed as prose. */
  private buildToolResultContent(
    content: ToolResultPart['content'],
  ): string | Record<string, unknown>[] {
    if (typeof content === 'string') return content;
    return content.map((p) => this.buildContentPart(p));
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

  /** Stateless entry, as the ProviderAdapter interface requires: a fresh spec
   *  run per event, so nothing correlates across events. */
  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    return createStreamBuilder(
      getStreamSpec('anthropic/messages.stream'),
      ANTHROPIC_STREAM_REGISTRY,
    )(event) as StreamEvent[];
  }

  /** Stateful, and the one callers should use. Anthropic streams a
   *  `server_tool_use` input via `input_json_delta` and returns the result in a
   *  separate `*_tool_result` block, so the input has to be carried between
   *  them; the spec's `state` is where that lives now. */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    const parse = createStreamBuilder(
      getStreamSpec('anthropic/messages.stream'),
      ANTHROPIC_STREAM_REGISTRY,
    );
    return (event) => parse(event) as StreamEvent[];
  }
}
