/** Google Gemini provider adapter (generateContent API). */

import type { SSEEvent } from '../../../network/types';
import type { ContentPart } from '../../types/messages';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import { buildFromSpec } from '../../../wire/interpreter';
import { buildResponse } from '../../../wire/response-interpreter';
import { getResponseSpec } from '../../../wire/response-specs';
import { GOOGLE_RESPONSE_REGISTRY } from './response-registry';
import type { Registry } from '../../../wire/interpreter';
import { chatSpec, isChatSpec } from '../../../wire/chat-specs';
import { pinFor, GOOGLE_GENERATE_PINS } from '../../../wire/pins';
import { makeRegistry } from '../../wire-transforms';
import { googleBilledTier } from './tiers';
import type { NormalizedRequest } from '../../types/request';
import { emptyUsage, type CompletionResponse, type Usage } from '../../types/response';
import type { StreamEvent } from '../../types/stream';
import { extractFinishReason } from '../_shared/response-utils';
import { sseJson } from '../_shared/sse';

export interface GoogleAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** Per-stream state threaded through `createStreamParser`. `codeExec` latches once
 *  a code-execution marker is seen so later inline blobs route to `files`. */
interface GoogleStreamState {
  codeExec: boolean;
  /** web_search (grounding) builtin_tool events emitted once per stream. */
  webSearchEmitted?: boolean;
  /** web_fetch (urlContext) builtin_tool events emitted once per stream. */
  urlFetchEmitted?: boolean;
  /** Code from the last `executableCode` part, to attach to its `builtin_tool_end`. */
  pendingCode?: string;
}

/** generateContent token usage. Exported so the spec-driven parser runs this
 *  and not a second copy of it. */
export function googleUsage(u: Record<string, unknown> | undefined): Usage {
  if (!u) return emptyUsage();
  const input = (u.promptTokenCount as number) ?? 0;
  const output = (u.candidatesTokenCount as number) ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: (u.totalTokenCount as number) ?? input + output,
    cachedTokens: (u.cachedContentTokenCount as number) ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: (u.thoughtsTokenCount as number) ?? 0,
    // Billed service tier (output-only `usageMetadata.serviceTier`).
    ...googleBilledTier(u.serviceTier),
  };
}

export class GoogleAdapter implements ProviderAdapter {
  readonly name = 'google' as const;
  private readonly apiKey: string;
  private readonly _baseURL?: string;

  constructor(config: GoogleAdapterConfig) {
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
    return ''; // set dynamically per request (includes model in URL)
  }

  /** Named code the spec cannot express as data — content assembly. */
  private readonly wireRegistry: Registry = makeRegistry({ google: this });

  /** The spec that builds this model's request.
   *
   *  Two nodes, keyed on the one thing that differs on the wire: 2.5 takes a token
   *  `thinkingBudget` and 400s on `thinkingLevel`, 3.x takes the level. Catalog pin
   *  first, then the pin TABLE — data rather than a regex in TypeScript, so the
   *  ports read the same rule. */
  private specIdFor(req: NormalizedRequest): string {
    if (isChatSpec(req.wireSpec) && req.wireSpec.startsWith('google/generate')) return req.wireSpec;
    return pinFor(req.model, GOOGLE_GENERATE_PINS);
  }

  buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    return buildFromSpec(
      chatSpec(this.specIdFor(req)),
      req,
      this.wireRegistry,
    ) as ProviderHttpRequest;
  }

  enableStreaming(providerReq: ProviderHttpRequest, req: NormalizedRequest): void {
    const model = req.model.startsWith('models/') ? req.model : `models/${req.model}`;
    providerReq.path = `/v1beta/${model}:streamGenerateContent?alt=sse`;
  }

  /** Map tool call IDs to function names (Google needs name in functionResponse) */
  private toolCallNames: Map<string, string> = new Map();

  /** Reached through the wire registry while building this adapter's own request. */
  buildContent(msg: { role: string; content: string | ContentPart[] }): Record<string, unknown> {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: unknown[] = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else {
      for (const p of msg.content) {
        switch (p.type) {
          case 'text':
            parts.push({ text: p.text });
            break;
          case 'image':
          case 'audio':
          case 'video':
          case 'document': {
            const s = p.source;
            if (s.type === 'base64')
              parts.push({ inlineData: { mimeType: s.mimeType, data: s.data } });
            else if (s.type === 'url')
              parts.push({ fileData: { fileUri: s.url, mimeType: 'application/octet-stream' } });
            else if (s.type === 'provider_ref')
              parts.push({ fileData: { fileUri: s.refId, mimeType: s.mimeType } });
            else if (s.type === 'file') parts.push({ fileData: { fileUri: s.fileId } });
            break;
          }
          case 'tool_call': {
            this.toolCallNames.set(p.id, p.name);
            const fcPart: Record<string, unknown> = {
              functionCall: { name: p.name, args: p.arguments, id: p.id },
            };
            if (p._meta?.thoughtSignature) fcPart.thoughtSignature = p._meta.thoughtSignature;
            parts.push(fcPart);
            break;
          }
          case 'tool_result': {
            const fnName = this.toolCallNames.get(p.id) ?? '';
            parts.push({
              functionResponse: {
                name: fnName,
                id: p.id,
                response: typeof p.content === 'string' ? { result: p.content } : p.content,
              },
            });
            break;
          }
        }
      }
    }

    return { role, parts };
  }

  parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    // Spec-driven since 3.3.0; see wire/specs/responses/google.generate.json.
    return buildResponse(
      getResponseSpec('google/generate.response'),
      raw,
      GOOGLE_RESPONSE_REGISTRY,
      {
        extra: { latencyMs, raw },
      },
    ) as unknown as CompletionResponse;
  }

  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    // Stateless entry — with no persisted state, inline data can't be known to be
    // a code-execution artifact, so it routes to media (unchanged behavior).
    return this.streamEvents(event, { codeExec: false });
  }

  /** Stateful — Google splits the code-execution marker (`executableCode` /
   *  `codeExecutionResult`) and the produced file (`inlineData`) across parts and
   *  often across SSE events. The closure remembers "code execution began in this
   *  stream" so a later `inlineData` blob is routed to `files` (a code-exec
   *  artifact) rather than `media` (conversational output). */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    const state: GoogleStreamState = { codeExec: false };
    return (event) => this.streamEvents(event, state);
  }

  private streamEvents(event: SSEEvent, state: GoogleStreamState): StreamEvent[] {
    const data = sseJson(event);
    const candidates = (data.candidates as Array<Record<string, unknown>>) ?? [];
    const candidate = candidates[0];

    if (!candidate) {
      if (data.usageMetadata)
        return [
          { type: 'usage', usage: this.parseUsage(data.usageMetadata as Record<string, unknown>) },
        ];
      return [];
    }

    const rawContent = (candidate.content as Record<string, unknown>) ?? {};
    const parts = (rawContent.parts as Array<Record<string, unknown>>) ?? [];
    const events: StreamEvent[] = [];

    // A code-execution marker may share an event with its output file or precede
    // it; latch the flag from all parts first so inlineData routing is correct.
    for (const part of parts) {
      if (part.executableCode || part.codeExecutionResult) state.codeExec = true;
    }

    for (const part of parts) {
      if (part.text !== undefined && !part.thought)
        events.push({ type: 'text', text: part.text as string });
      if (part.thought && part.text) events.push({ type: 'thinking', text: part.text as string });
      // Code-execution builtin: the code to run, then its result. Carry the code +
      // output on the end event (start marks progress).
      if (part.executableCode) {
        const code = (part.executableCode as Record<string, unknown>).code;
        state.pendingCode = typeof code === 'string' ? code : undefined;
        events.push({ type: 'builtin_tool_start', tool: 'code_interpreter' });
      }
      if (part.codeExecutionResult) {
        const output = (part.codeExecutionResult as Record<string, unknown>).output;
        events.push({
          type: 'builtin_tool_end',
          tool: 'code_interpreter',
          ...(state.pendingCode ? { code: state.pendingCode } : {}),
          ...(typeof output === 'string' && output ? { output } : {}),
        });
        state.pendingCode = undefined;
      }
      if (part.inlineData) {
        const inline = part.inlineData as { mimeType: string; data: string };
        const mime = inline.mimeType;
        if (state.codeExec) {
          // Code-execution artifact (e.g. a generated chart) → unified files channel.
          events.push({
            type: 'file',
            file: { data: inline.data, mimeType: mime, source: 'code_execution' },
          });
        } else {
          const mediaType = mime.startsWith('image/')
            ? ('image' as const)
            : mime.startsWith('audio/')
              ? ('audio' as const)
              : ('video' as const);
          events.push({ type: 'media_start', mediaType, mimeType: mime });
          events.push({ type: 'media_chunk', data: inline.data });
          events.push({ type: 'media_end' });
        }
      }
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const meta: Record<string, unknown> = {};
        if (part.thoughtSignature) meta.thoughtSignature = part.thoughtSignature;
        events.push({
          type: 'tool_call_start',
          id: (fc.id as string) ?? '',
          name: fc.name as string,
          ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        });
        if (fc.args)
          events.push({ type: 'tool_call_delta', id: '', arguments: JSON.stringify(fc.args) });
        events.push({ type: 'tool_call_end', id: '' });
      }
    }

    // Grounding chunks arrive on ONE late chunk, not spread across the stream —
    // the first `groundingMetadata` seen is usually `{}`, and the populated one
    // comes near the end. So this reads whichever chunk actually has them rather
    // than latching on first sight the way the start/end pair below does.
    for (const chunk of ((candidate.groundingMetadata as Record<string, unknown>)
      ?.groundingChunks as Array<Record<string, unknown>>) ?? []) {
      const web = (chunk.web as Record<string, unknown>) ?? {};
      if (web.uri) {
        events.push({
          type: 'citation',
          citation: {
            url: web.uri as string,
            ...(web.title ? { title: web.title as string } : {}),
          },
        });
      }
    }

    // Web search (googleSearch grounding) has no per-call stream markers — surface
    // one start/end pair the first time grounding metadata appears in the stream.
    if (candidate.groundingMetadata && !state.webSearchEmitted) {
      state.webSearchEmitted = true;
      const q = (
        (candidate.groundingMetadata as Record<string, unknown>).webSearchQueries as
          | string[]
          | undefined
      )?.[0];
      events.push({ type: 'builtin_tool_start', tool: 'web_search' });
      events.push({
        type: 'builtin_tool_end',
        tool: 'web_search',
        ...(typeof q === 'string' ? { query: q } : {}),
      });
    }

    // web_fetch (urlContext) — like grounding, no per-call markers: emit one
    // start/end pair per retrieved URL the first time the metadata appears.
    const streamUrlMeta = (candidate.urlContextMetadata as Record<string, unknown> | undefined)
      ?.urlMetadata as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(streamUrlMeta) && !state.urlFetchEmitted) {
      state.urlFetchEmitted = true;
      for (const m of streamUrlMeta) {
        const url = m.retrievedUrl as string | undefined;
        events.push({ type: 'builtin_tool_start', tool: 'web_fetch' });
        events.push({
          type: 'builtin_tool_end',
          tool: 'web_fetch',
          ...(typeof url === 'string' ? { url } : {}),
        });
      }
    }

    const fr = candidate.finishReason as string | undefined;
    if (fr)
      events.push({
        type: 'done',
        finishReason: extractFinishReason(false, fr, { MAX_TOKENS: 'length' }),
      });
    if (data.usageMetadata)
      events.push({
        type: 'usage',
        usage: this.parseUsage(data.usageMetadata as Record<string, unknown>),
      });

    return events;
  }

  private parseUsage(u: Record<string, unknown> | undefined): Usage {
    return googleUsage(u);
  }
}
