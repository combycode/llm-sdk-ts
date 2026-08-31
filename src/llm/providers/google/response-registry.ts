/** The named escape hatches `google.generate.json` calls.
 *
 *  Google's `parts[]` has no type tag: a part IS a text part because it has a
 *  `text` key, and a tool call because it has `functionCall`. So every rule here
 *  returns undefined when the part is not its kind, and the spec lists them all
 *  against the same array -- which is exactly what the hand-written loop does
 *  with a run of independent `if`s.
 */
import { googleUsage } from './generate';
import { AUDIO_PCM16_SAMPLE_RATE_HZ } from '../_shared/constants';
import { extractCitations } from '../_shared/citations';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';

type Part = Record<string, unknown>;

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (
  ctx: Ctx,
): { content: Array<{ type: string; text?: string }>; toolCalls: unknown[] } =>
  (ctx.req as { out: { content: Array<{ type: string; text?: string }>; toolCalls: unknown[] } })
    .out;
const partOf = (ctx: Ctx): Part => (ctx.item?.value ?? {}) as Part;

const candidate = (raw: Record<string, unknown>): Record<string, unknown> =>
  (raw.candidates as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
const partsOf = (raw: Record<string, unknown>): Part[] =>
  ((candidate(raw).content as Record<string, unknown> | undefined)?.parts as Part[]) ?? [];

/** When the turn ran hosted code execution its inlineData blobs are ARTIFACTS
 *  (a generated chart), not conversational media. That is a property of the
 *  whole parts array, so it cannot be decided from one part. */
const hasCodeExec = (raw: Record<string, unknown>): boolean =>
  partsOf(raw).some((p) => p.executableCode || p.codeExecutionResult);

const FINISH: Record<string, string> = {
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  // Verified in google-ts src/types.ts:510. Unmapped it fell through to `stop`,
  // so a turn that failed to produce a usable tool call looked like a clean
  // finish with no content.
  MALFORMED_FUNCTION_CALL: 'malformed_tool_call',
};

export const GOOGLE_RESPONSE_REGISTRY: Registry = {
  transforms: {
    /** `text !== undefined`, not truthiness: an empty string is still a text part. */
    googleTextPart: (_arg: unknown, ctx: Ctx) => {
      const p = partOf(ctx);
      if (p.text === undefined || p.thought) return undefined;
      return { type: 'text', text: p.text as string };
    },

    /** A part flagged `thought` carries the reasoning rather than the answer. */
    googleThinking: (_arg: unknown, ctx: Ctx) => {
      const p = partOf(ctx);
      return p.thought && p.text ? (p.text as string) : undefined;
    },

    googleInlineFile: (_arg: unknown, ctx: Ctx) => {
      const p = partOf(ctx);
      if (!p.inlineData || !hasCodeExec(rawOf(ctx))) return undefined;
      const inline = p.inlineData as { mimeType: string; data: string };
      return { data: inline.data, mimeType: inline.mimeType, source: 'code_execution' };
    },

    googleInlineMedia: (_arg: unknown, ctx: Ctx) => {
      const p = partOf(ctx);
      if (!p.inlineData || hasCodeExec(rawOf(ctx))) return undefined;
      const inline = p.inlineData as { mimeType: string; data: string };
      const mime = inline.mimeType;
      const base = { mediaId: '', mimeType: mime, _data: inline.data };
      if (mime.startsWith('image/')) return { type: 'image_output', ...base };
      if (mime.startsWith('audio/')) {
        return { type: 'audio_output', ...base, sampleRate: AUDIO_PCM16_SAMPLE_RATE_HZ };
      }
      if (mime.startsWith('video/')) return { type: 'video_output', ...base };
      return undefined;
    },

    googleToolCall: (_arg: unknown, ctx: Ctx) => {
      const p = partOf(ctx);
      if (!p.functionCall) return undefined;
      const fc = p.functionCall as Record<string, unknown>;
      const meta: Record<string, unknown> = {};
      if (p.thoughtSignature) meta.thoughtSignature = p.thoughtSignature;
      return {
        type: 'tool_call',
        id: (fc.id as string) ?? crypto.randomUUID(),
        name: fc.name as string,
        arguments: (fc.args as Record<string, unknown>) ?? {},
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      };
    },

    /** Hosted tools, all decided from the whole parts array and the candidate
     *  metadata rather than from any single part: Google issues no call ids. */
    googleBuiltinCalls: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const parts = partsOf(raw);
      const cand = candidate(raw);
      const calls: Array<Record<string, unknown>> = [];

      const codes = parts
        .filter((p) => (p.executableCode as Record<string, unknown>)?.code)
        .map((p) => (p.executableCode as Record<string, unknown>).code as string);
      const outputs = parts
        .filter((p) => p.codeExecutionResult)
        .map((p) => String((p.codeExecutionResult as Record<string, unknown>).output ?? ''));
      if (codes.length) {
        codes.forEach((code, i) => {
          calls.push({
            tool: 'code_interpreter',
            code,
            ...(outputs[i] ? { output: outputs[i] } : {}),
          });
        });
      } else if (hasCodeExec(raw)) {
        calls.push({ tool: 'code_interpreter', ...(outputs[0] ? { output: outputs[0] } : {}) });
      }

      const grounding = cand.groundingMetadata as Record<string, unknown> | undefined;
      if (grounding) {
        const q = (grounding.webSearchQueries as string[] | undefined)?.[0];
        calls.push({ tool: 'web_search', ...(typeof q === 'string' ? { query: q } : {}) });
      }

      const urlMeta = (cand.urlContextMetadata as Record<string, unknown> | undefined)
        ?.urlMetadata as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(urlMeta)) {
        for (const m of urlMeta) {
          const url = m.retrievedUrl as string | undefined;
          calls.push({ tool: 'web_fetch', ...(typeof url === 'string' ? { url } : {}) });
        }
      }
      return calls;
    },

    /** generateContent DOES return an id -- `responseId`. The fallback stays for
     *  older payloads, but minting one unconditionally made the parse
     *  non-deterministic: the same bytes produced a different id every time. */
    googleId: (_arg: unknown, ctx: Ctx) => (rawOf(ctx).responseId as string) ?? crypto.randomUUID(),

    googleText: (_arg: unknown, ctx: Ctx) =>
      outOf(ctx)
        .content.filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join(''),

    googleUsageFull: (_arg: unknown, ctx: Ctx) =>
      googleUsage(rawOf(ctx).usageMetadata as Record<string, unknown> | undefined),

    googleFinish: (_arg: unknown, ctx: Ctx) =>
      extractFinishReason(
        outOf(ctx).toolCalls.length > 0,
        candidate(rawOf(ctx)).finishReason as string,
        FINISH,
      ),

    googleCitations: (_arg: unknown, ctx: Ctx) => {
      const c = extractCitations('generate', rawOf(ctx));
      return c.length ? c : undefined;
    },
  },

  builders: {},
  predicates: {},
  effects: {},
};
