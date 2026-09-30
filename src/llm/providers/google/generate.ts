/** Google Gemini provider adapter (generateContent API). */

import type { SSEEvent } from '../../../network/types';
import type { ContentPart, DataSource, VideoProcessing } from '../../types/messages';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import { splitToolResult } from '../_shared/tool-result';
import { buildFromSpec } from '../../../wire/interpreter';
import { buildResponse } from '../../../wire/response-interpreter';
import { getResponseSpec } from '../../../wire/response-specs';
import { GOOGLE_RESPONSE_REGISTRY } from './response-registry';
import { createStreamBuilder } from '../../../wire/stream-interpreter';
import { getStreamSpec } from '../../../wire/stream-specs';
import { GOOGLE_STREAM_REGISTRY } from './stream-registry';
import type { Registry } from '../../../wire/interpreter';
import { chatSpec, isChatSpec } from '../../../wire/chat-specs';
import { pinFor, GOOGLE_GENERATE_PINS } from '../../../wire/pins';
import { makeRegistry } from '../../wire-transforms';
import { googleBilledTier } from './tiers';
import type { NormalizedRequest } from '../../types/request';
import { emptyUsage, type CompletionResponse, type Usage } from '../../types/response';
import type { StreamEvent } from '../../types/stream';

export interface GoogleAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** One media part of a `functionResponse`.
 *
 *  A narrower shape than an ordinary content part: `FunctionResponsePart` holds
 *  `inlineData` or `fileData` and nothing else — no `text`, which is why the
 *  textual half of a tool result stays in `response`. `fileData` is documented
 *  as Vertex-only, so a source we cannot inline yields nothing rather than a
 *  field the Gemini API will reject. */
function functionResponsePart(s: DataSource): Record<string, unknown> | null {
  if (s.type === 'base64') return { inlineData: { mimeType: s.mimeType, data: s.data } };
  return null;
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

/** What a video part claims to be when its source did not say.
 *
 *  A guess, and a deliberate one: `url` and `file` sources carry no mime type
 *  in this library, Google will not accept `media_processing` without a video
 *  one, and it treats the value as a hint rather than a strict claim -- a
 *  YouTube link declared `video/mp4` is accepted and understood. */
const DEFAULT_VIDEO_MIME = 'video/mp4';

const isVideoMime = (m: string | undefined): boolean => typeof m === 'string' && m.startsWith('video/');

/** `processing` -> generateContent's `Part.mediaProcessing` enum.
 *
 *  This surface has two values and nothing else: STATIC (fixed-rate frame
 *  extraction, every frame in context) or AGENTIC (the model navigates). The
 *  object form's `fps` and offsets belong to Interactions and have nowhere to
 *  go here -- so the MODE is taken and the sampling is dropped, which is worth
 *  knowing: a 30-second window of a two-hour video is a request only the
 *  Interactions surface can honour.
 */
function googleMediaProcessing(processing: VideoProcessing | undefined): string | undefined {
  if (processing === undefined) return undefined;
  if (typeof processing === 'string') {
    return processing === 'agentic' ? 'AGENTIC' : processing === 'static' ? 'STATIC' : undefined;
  }
  return processing.type === 'static' ? 'STATIC' : undefined;
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
            let part: Record<string, unknown> | undefined;
            if (s.type === 'base64') part = { inlineData: { mimeType: s.mimeType, data: s.data } };
            else if (s.type === 'url')
              part = { fileData: { fileUri: s.url, mimeType: 'application/octet-stream' } };
            else if (s.type === 'provider_ref')
              part = { fileData: { fileUri: s.refId, mimeType: s.mimeType } };
            else if (s.type === 'file') part = { fileData: { fileUri: s.fileId } };
            // generateContent takes the MODE only -- a screaming-snake enum on
            // the part itself; the object form's sampling has no home here.
            //
            // It also refuses the enum unless the SAME part carries a video
            // mime type: measured 2026-09-30, `media_processing` with no mime
            // is `400 mime_type must be set when media_processing is
            // specified`, and with our `application/octet-stream` default it
            // is `400 media_processing can only be set on video parts`. A
            // `url` or `file` source carries no mime type at all, so one is
            // supplied here -- only for a video that actually asked for
            // processing, leaving every existing request byte-identical.
            if (part && p.type === 'video') {
              const mode = googleMediaProcessing(p.providerOptions?.processing);
              if (mode) {
                part.mediaProcessing = mode;
                const fd = part.fileData as { mimeType?: string } | undefined;
                if (fd && !isVideoMime(fd.mimeType)) fd.mimeType = DEFAULT_VIDEO_MIME;
                const inline = part.inlineData as { mimeType?: string } | undefined;
                if (inline && !isVideoMime(inline.mimeType)) inline.mimeType = DEFAULT_VIDEO_MIME;
              }
            }
            if (part) parts.push(part);
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
            const fr: Record<string, unknown> = { name: fnName, id: p.id };
            if (typeof p.content === 'string') {
              fr.response = { result: p.content };
            } else {
              // `response` is a JSON object, so media cannot live there; the API
              // gives it `functionResponse.parts` instead. Splitting the two
              // also fixes a content-part result being sent as an ARRAY in a
              // field the API defines as an object.
              const { text, media } = splitToolResult(p.content);
              const frParts: Record<string, unknown>[] = [];
              const notes: string[] = [];
              for (const m of media) {
                const fp = functionResponsePart(m.source);
                if (fp) frParts.push(fp);
                // Said out loud rather than dropped: a tool whose media could
                // not travel should leave a mark the model can act on.
                else notes.push(`[${m.type} omitted: a function response takes inline bytes]`);
              }
              fr.response = { result: [text, ...notes].filter(Boolean).join('\n') };
              if (frParts.length > 0) fr.parts = frParts;
            }
            parts.push({ functionResponse: fr });
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

  /** Stateless entry, as the ProviderAdapter interface requires: a fresh spec
   *  run per event, so nothing correlates across events. */
  parseStreamEvent(event: SSEEvent): StreamEvent[] {
    return this.createStreamParser()(event);
  }

  /** Stateful, and the one callers should use. The code-execution flag latches across chunks and decides whether inlineData is an artifact or media. */
  createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    const parse = createStreamBuilder(
      getStreamSpec('google/generate.stream'),
      GOOGLE_STREAM_REGISTRY,
    );
    return (event) => parse(event) as StreamEvent[];
  }
}
