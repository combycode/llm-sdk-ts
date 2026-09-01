/** OpenAI Responses API adapter.
 *  Endpoint: POST /v1/responses
 *  Modern API: input (not messages), instructions (not system role),
 *  output items (not choices), function_call/function_call_output for tools. */

import type { SSEEvent } from '../../../network/types';
import type { Message, TextPart, ToolCaller } from '../../types/messages';
import { buildFromSpec } from '../../../wire/interpreter';
import { buildResponse } from '../../../wire/response-interpreter';
import { getResponseSpec } from '../../../wire/response-specs';
import { OPENAI_RESPONSES_REGISTRY } from './responses-registry';
import { createStreamBuilder } from '../../../wire/stream-interpreter';
import { getStreamSpec } from '../../../wire/stream-specs';
import { OPENAI_RESPONSES_STREAM_REGISTRY } from './responses-stream-registry';
import type { Registry } from '../../../wire/interpreter';
import { chatSpec } from '../../../wire/chat-specs';
import { makeRegistry } from '../../wire-transforms';
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

export interface OpenAIResponsesAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** `caller` on the wire uses `caller_id`; our facade uses `callerId`. The type value is
 *  passed through unchanged — it is an open union on our side (R1), and the API rejects
 *  a value it does not know (`'teleport'` → 400 naming `input[n].caller.type`), so an
 *  unknown value fails loudly at the provider rather than being dropped here. */
function toWireCaller(caller: ToolCaller): Record<string, unknown> {
  return {
    type: caller.type,
    ...(caller.callerId !== undefined ? { caller_id: caller.callerId } : {}),
  };
}

export function fromWireCaller(raw: unknown): ToolCaller | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { type?: unknown; caller_id?: unknown };
  if (typeof r.type !== 'string') return undefined;
  return {
    type: r.type,
    ...(typeof r.caller_id === 'string' ? { callerId: r.caller_id } : {}),
  };
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
export function builtinCallFromResponsesItem(
  item: Record<string, unknown>,
): BuiltinToolCall | null {
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
function _builtinEndPayload(call: BuiltinToolCall): Record<string, string> {
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
export function filesFromResponsesOutputItem(item: Record<string, unknown>): FileOutput[] {
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

/** Responses-API token usage. Exported so the spec-driven parser runs this and
 *  not a second copy of it. */
export function openaiResponsesUsage(u: Record<string, unknown> | undefined): Usage {
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

  /** Named code the spec cannot express as data — message/input assembly. Carries
   *  `this`, so a subclass drives the same rules with its own overrides. */
  protected readonly wireRegistry: Registry = makeRegistry({ openaiResponses: this });

  /** Which flavor overlay patches the shared spec. Subclasses for
   *  OpenAI-compatible backends override this and nothing else. */
  protected readonly wireFlavor: string = 'openai';

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    return buildFromSpec(
      chatSpec('openai/responses'),
      req,
      this.wireRegistry,
      this.wireFlavor,
    ) as ProviderHttpRequest;
  }

  /** Convert a universal Message to Responses API input items.
   *  `toolNames` is threaded across messages so a tool result can name its originating call. */
  /** Reached through the wire registry while building the request. */
  buildInputItems(msg: Message, toolNames = new Map<string, string>()): unknown[] {
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

      // Text content as message output items. `phase` lives on the MESSAGE, so consecutive text
      // parts sharing a phase become one item and a change of phase starts a new one — grouping by
      // phase globally would reorder commentary against the answer it precedes.
      const textParts = parts.filter((p): p is TextPart => p.type === 'text');
      let run: TextPart[] = [];
      const flush = () => {
        if (run.length === 0) return;
        const phase = run[0]?.phase;
        items.push({
          type: 'message',
          role: 'assistant',
          content: run.map((p) => ({ type: 'output_text', text: p.text })),
          ...(phase !== undefined ? { phase } : {}),
        });
        run = [];
      };
      for (const p of textParts) {
        if (run.length > 0 && run[0]?.phase !== p.phase) flush();
        run.push(p);
      }
      flush();

      // Programmatic tool calling: the program the model wrote, plus whatever provider
      // items it is bound to. OpenAI rejects a `program` item whose `reasoning` item is
      // missing ("provided without its required 'reasoning' item"), and DROPPING the
      // program instead is worse than an error — the model silently re-emits it and runs
      // the whole thing again. Both verified on the wire 2026-08-09.
      for (const p of parts) {
        if (p.type === 'program_call') {
          const meta = (p._meta ?? {}) as { itemId?: string; boundItems?: unknown[] };
          for (const bound of meta.boundItems ?? []) items.push(bound);
          items.push({
            type: 'program',
            ...(meta.itemId ? { id: meta.itemId } : {}),
            call_id: p.id,
            code: p.code,
            fingerprint: p.fingerprint,
          });
        }
      }

      // Tool calls as function_call items
      for (const p of parts) {
        if (p.type === 'tool_call') {
          toolNames.set(p.id, p.name);
          items.push({
            type: 'function_call',
            id: `fc_${p.id}`,
            call_id: p.id,
            name: p.name,
            arguments: JSON.stringify(p.arguments),
            ...(p.caller ? { caller: toWireCaller(p.caller) } : {}),
          });
        }
      }

      // The program's own return value, once it finished.
      for (const p of parts) {
        if (p.type === 'program_result') {
          // `id` is REQUIRED here — unlike function_call_output, which needs none. A
          // completed programmatic run replayed as history 400s without it
          // ("Missing required parameter: 'input[n].id'"), so a follow-up question
          // fails on a conversation that succeeded a moment earlier.
          const itemId = (p._meta as { itemId?: string } | undefined)?.itemId;
          items.push({
            type: 'program_output',
            ...(itemId ? { id: itemId } : {}),
            call_id: p.id,
            result: p.result,
            ...(p.status !== undefined ? { status: p.status } : {}),
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
          // `name`/`namespace` identify the tool that produced the output (openai-ts 7.x).
          // Probe-verified 2026-08-06: accepted, and a non-string `namespace` is rejected, so the
          // fields are validated rather than ignored. The name comes from the matching call — we
          // never invent one, so a result with no matching call simply omits it.
          const name = toolNames.get(p.id);
          items.push({
            type: 'function_call_output',
            call_id: p.id,
            output: typeof p.content === 'string' ? p.content : JSON.stringify(p.content),
            ...(name !== undefined ? { name } : {}),
            ...(p.namespace !== undefined ? { namespace: p.namespace } : {}),
            ...(p.caller ? { caller: toWireCaller(p.caller) } : {}),
          });
        }
      }
    }

    return items;
  }

  enableStreaming(providerReq: ProviderHttpRequest): void {
    (providerReq.body as Record<string, unknown>).stream = true;
  }

  /** Overridden by xAI, whose Responses API is this one. */
  protected responseSpecId(): string {
    return 'openai/responses.response';
  }

  /** Overridden alongside the spec id: xAI extends file extraction, so its
   *  registry supplies a different `oaiRespFiles` -- the parse-side twin of its
   *  `filesFromOutputItem` override. */
  protected responseRegistry(): Registry {
    return OPENAI_RESPONSES_REGISTRY;
  }

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    // Spec-driven since 3.3.0; see wire/specs/responses/openai.responses.json.
    return buildResponse(getResponseSpec(this.responseSpecId()), raw, this.responseRegistry(), {
      extra: { latencyMs, raw },
    }) as unknown as CompletionResponse;
  }

  /** Stateless — each output item finalizes with all its file annotations in a
   *  single response.output_item.done event. */
  /** Stateless entry, as the ProviderAdapter interface requires: a fresh spec
   *  run per event, so nothing correlates across events. */
  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    return this.createStreamParser()(event);
  }

  /** Stateful, and the one callers should use. `phase` is announced once when an item is added but belongs on every text delta of that item, and the spec's state is where that is remembered. */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    const parse = createStreamBuilder(getStreamSpec(this.streamSpecId()), this.streamRegistry());
    return (event) => parse(event) as StreamEvent[];
  }

  /** Overridden by xAI, which extends file extraction. */
  protected streamSpecId(): string {
    return 'openai/responses.stream';
  }

  protected streamRegistry(): Registry {
    return OPENAI_RESPONSES_STREAM_REGISTRY;
  }

  /** Hosted code-execution output files from one output item. Overridable so
   *  Responses-compatible providers with a different file shape (e.g. xAI, which
   *  embeds files in the code-interpreter `logs` payload) can extend it. */
  protected filesFromOutputItem(item: Record<string, unknown>): FileOutput[] {
    return filesFromResponsesOutputItem(item);
  }

  protected parseUsage(u: Record<string, unknown> | undefined): Usage {
    return openaiResponsesUsage(u);
  }
}
