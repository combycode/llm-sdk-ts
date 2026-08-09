/** OpenAI Responses API adapter.
 *  Endpoint: POST /v1/responses
 *  Modern API: input (not messages), instructions (not system role),
 *  output items (not choices), function_call/function_call_output for tools. */

import type { SSEEvent } from '../../../network/types';
import type {
  AssistantPhase,
  ContentPart,
  ImageOutputPart,
  MediaOutputPart,
  Message,
  ProgramResultPart,
  TextPart,
  ToolCallPart,
  ToolCaller,
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

function fromWireCaller(raw: unknown): ToolCaller | undefined {
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

    // Build input array from messages. `toolNames` accumulates call_id → tool name as assistant
    // turns go past, so a later tool result can name the tool that produced it: the API wants
    // `name` on `function_call_output`, and only the matching call knows what it was.
    const toolNames = new Map<string, string>();
    for (const msg of req.messages) {
      input.push(...this.buildInputItems(msg, toolNames));
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
    // The Responses API has NO seed on OpenAI (live 2026-07-28: 400 "Unknown parameter:
    // 'seed'") but xAI's Responses surface accepts it. Gate to xAI only — OpenRouter's
    // Responses surface is unverified, so it is left out rather than guessed at.
    if (this.name === 'xai' && req.seed !== undefined) body.seed = req.seed;
    // No top_k on any Responses surface.
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

  /** Convert a universal Message to Responses API input items.
   *  `toolNames` is threaded across messages so a tool result can name its originating call. */
  private buildInputItems(msg: Message, toolNames = new Map<string, string>()): unknown[] {
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

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    const r = raw as Record<string, unknown>;
    const output = (r.output as Array<Record<string, unknown>>) ?? [];
    const usage = this.parseUsage(r.usage as Record<string, unknown>);
    Object.assign(usage, openaiBilledTier(r.service_tier));

    const content: ContentPart[] = [];
    const toolCalls: ToolCallPart[] = [];
    const reasoningItems: Record<string, unknown>[] = [];
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
        // `phase` distinguishes narration from the answer on codex-family models. Carried onto the
        // text part so a caller (and our agent loop) can tell them apart; absent on every other
        // model, where the text is simply the answer.
        const phase = typeof item.phase === 'string' ? (item.phase as AssistantPhase) : undefined;
        for (const c of itemContent) {
          if (c.type === 'output_text') {
            const t = c.text as string;
            // `text` stays the full concatenation: narrowing it to final_answer here would silently
            // change what every existing caller reads. Consumers that want only the answer can
            // filter the parts by phase.
            text += t;
            content.push({ type: 'text', text: t, ...(phase !== undefined ? { phase } : {}) });
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
        const caller = fromWireCaller(item.caller);
        const tc: ToolCallPart = {
          type: 'tool_call',
          id: (item.call_id as string) ?? (item.id as string),
          name: item.name as string,
          arguments:
            typeof item.arguments === 'string'
              ? JSON.parse(item.arguments as string)
              : ((item.arguments as Record<string, unknown>) ?? {}),
          ...(caller ? { caller } : {}),
        };
        content.push(tc);
        toolCalls.push(tc);
      }

      // Programmatic tool calling. `reasoningItems` collects the reasoning items seen
      // earlier in this same output, because the program cannot be sent back without
      // them — see buildInputItems.
      if (type === 'reasoning') reasoningItems.push(item);

      if (type === 'program') {
        content.push({
          type: 'program_call',
          id: (item.call_id as string) ?? (item.id as string),
          code: (item.code as string) ?? '',
          fingerprint: (item.fingerprint as string) ?? '',
          _meta: {
            ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
            ...(reasoningItems.length > 0 ? { boundItems: [...reasoningItems] } : {}),
          },
        });
      }

      if (type === 'program_output') {
        content.push({
          type: 'program_result',
          id: (item.call_id as string) ?? (item.id as string),
          result: (item.result as string) ?? '',
          ...(typeof item.status === 'string'
            ? { status: item.status as ProgramResultPart['status'] }
            : {}),
          // Required on the way back in, unlike every other item we echo.
          ...(typeof item.id === 'string' ? { _meta: { itemId: item.id } } : {}),
        });
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

  parseStreamEvent(event: SSEEvent, phaseByItem?: Map<string, AssistantPhase>): StreamEvent[] {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    const type = data.type as string;
    const events: StreamEvent[] = [];

    if (type === 'response.output_text.delta') {
      // `item_id` says WHICH output item this delta belongs to — a turn can interleave
      // deltas from several items, so pass it through for consumers that reassemble
      // per item instead of concatenating (openai-agents 0.13.5 surfaces the same).
      const itemId = data.item_id as string | undefined;
      const phase = itemId ? phaseByItem?.get(itemId) : undefined;
      events.push({
        type: 'text',
        text: data.delta as string,
        ...(itemId ? { itemId } : {}),
        ...(phase !== undefined ? { phase } : {}),
      });
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
      // Remember this item's phase so its text deltas can carry it (the deltas themselves
      // carry only `item_id`).
      if (item?.type === 'message' && typeof item.phase === 'string') {
        const itemId = (data.item_id as string) ?? (item.id as string);
        if (itemId) phaseByItem?.set(itemId, item.phase as AssistantPhase);
      }
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
        const reasoningItemId = (item.id as string) ?? (data.item_id as string | undefined);
        if (text)
          events.push({
            type: 'thinking',
            text,
            ...(reasoningItemId ? { itemId: reasoningItemId } : {}),
          });
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
    // `phase` is announced once, on `response.output_item.added`, but belongs on every text delta
    // of that item — so it has to be remembered per stream. Scoped to this parser instance so
    // concurrent streams cannot leak phases into each other.
    const phaseByItem = new Map<string, AssistantPhase>();
    return (event) => this.parseStreamEvent(event, phaseByItem);
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
