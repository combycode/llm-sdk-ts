/** The named escape hatches `google.generate.stream.json` calls.
 *
 *  Google's parts carry no type tag, so each rule guards itself by returning
 *  undefined when the part is not its kind -- the same shape as the buffered
 *  google registry, and the same shape as the hand-written run of `if`s.
 *
 *  Three things span events, and all three are why this provider needs state at
 *  all: a code-execution marker may share a chunk with its output file OR
 *  precede it, so the flag is latched before the parts are walked; the code from
 *  an `executableCode` part belongs on the `builtin_tool_end` of a LATER part;
 *  and grounding metadata has no per-call markers, so the start/end pair is
 *  emitted once per stream.
 */
import { googleUsage } from './generate';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';

type Part = Record<string, unknown>;

interface StreamOut {
  events: unknown[];
  codeExec: boolean;
  pendingCode: string | null;
  webSearchEmitted: boolean;
  urlFetchEmitted: boolean;
}

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (ctx: Ctx): StreamOut => (ctx.req as { out: StreamOut }).out;
const partOf = (ctx: Ctx): Part => (ctx.item?.value ?? {}) as Part;
const candidateOf = (ctx: Ctx): Record<string, unknown> =>
  ((rawOf(ctx).candidates as Array<Record<string, unknown>> | undefined)?.[0] ?? {});

export const GOOGLE_STREAM_REGISTRY: Registry = {
  transforms: {
    /** Empty unless this chunk carries usage, so the same rule serves the
     *  candidate-less chunk and the trailing usage on a normal one. */
    googleStreamUsage: (_arg: unknown, ctx: Ctx) => {
      const u = rawOf(ctx).usageMetadata as Record<string, unknown> | undefined;
      return u ? [{ type: 'usage', usage: googleUsage(u) }] : [];
    },

    /** `text !== undefined`, not truthiness: an empty string is still text. */
    googleStreamText: (_arg: unknown, ctx: Ctx) => {
      const p = partOf(ctx);
      if (p.text === undefined || p.thought) return undefined;
      return { type: 'text', text: p.text as string };
    },

    googleStreamThinking: (_arg: unknown, ctx: Ctx) => {
      const p = partOf(ctx);
      return p.thought && p.text ? { type: 'thinking', text: p.text as string } : undefined;
    },

    /** Grounding chunks arrive on ONE late chunk rather than spread across the
     *  stream -- the first `groundingMetadata` seen is usually `{}` and the
     *  populated one comes near the end. So this reads whichever chunk actually
     *  has them instead of latching on first sight the way the pair below does. */
    googleStreamCitations: (_arg: unknown, ctx: Ctx) => {
      const chunks =
        ((candidateOf(ctx).groundingMetadata as Record<string, unknown> | undefined)
          ?.groundingChunks as Array<Record<string, unknown>>) ?? [];
      const out: unknown[] = [];
      for (const chunk of chunks) {
        const web = (chunk.web as Record<string, unknown>) ?? {};
        if (web.uri) {
          out.push({
            type: 'citation',
            citation: {
              url: web.uri as string,
              ...(web.title ? { title: web.title as string } : {}),
            },
          });
        }
      }
      return out;
    },

    googleStreamDone: (_arg: unknown, ctx: Ctx) => {
      const fr = candidateOf(ctx).finishReason as string | undefined;
      if (!fr) return undefined;
      return { type: 'done', finishReason: extractFinishReason(false, fr, { MAX_TOKENS: 'length' }) };
    },
  },

  builders: {},
  predicates: {},

  effects: {
    /** Latch the code-execution flag from ALL parts before any is handled: the
     *  marker may share a chunk with its output file or precede it, and it
     *  decides whether inlineData is an artifact or conversational media. */
    googleStreamLatchCodeExec: (ctx: Ctx) => {
      const out = outOf(ctx);
      const parts =
        (((candidateOf(ctx).content as Record<string, unknown> | undefined)?.parts as Part[]) ?? []);
      for (const p of parts) {
        if (p.executableCode || p.codeExecutionResult) out.codeExec = true;
      }
    },

    /** The code to run, then its result. The code is carried on the END event,
     *  which belongs to a different part than the one that announced it. */
    googleStreamCodeExec: (ctx: Ctx) => {
      const out = outOf(ctx);
      const p = partOf(ctx);
      if (p.executableCode) {
        const code = (p.executableCode as Record<string, unknown>).code;
        out.pendingCode = typeof code === 'string' ? code : null;
        out.events.push({ type: 'builtin_tool_start', tool: 'code_interpreter' });
      }
      if (p.codeExecutionResult) {
        const output = (p.codeExecutionResult as Record<string, unknown>).output;
        out.events.push({
          type: 'builtin_tool_end',
          tool: 'code_interpreter',
          ...(out.pendingCode ? { code: out.pendingCode } : {}),
          ...(typeof output === 'string' && output ? { output } : {}),
        });
        out.pendingCode = null;
      }
    },

    /** An artifact when the turn ran code, three media events otherwise. */
    googleStreamInline: (ctx: Ctx) => {
      const out = outOf(ctx);
      const p = partOf(ctx);
      if (!p.inlineData) return;
      const inline = p.inlineData as { mimeType: string; data: string };
      const mime = inline.mimeType;
      if (out.codeExec) {
        out.events.push({
          type: 'file',
          file: { data: inline.data, mimeType: mime, source: 'code_execution' },
        });
        return;
      }
      const mediaType = mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('audio/')
          ? 'audio'
          : 'video';
      out.events.push({ type: 'media_start', mediaType, mimeType: mime });
      out.events.push({ type: 'media_chunk', data: inline.data });
      out.events.push({ type: 'media_end' });
    },

    /** Google streams a function call whole rather than in fragments, so the
     *  start/delta/end triple is emitted from one part. */
    googleStreamToolCall: (ctx: Ctx) => {
      const out = outOf(ctx);
      const p = partOf(ctx);
      if (!p.functionCall) return;
      const fc = p.functionCall as Record<string, unknown>;
      const meta: Record<string, unknown> = {};
      if (p.thoughtSignature) meta.thoughtSignature = p.thoughtSignature;
      out.events.push({
        type: 'tool_call_start',
        id: (fc.id as string) ?? '',
        name: fc.name as string,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      });
      if (fc.args) {
        out.events.push({ type: 'tool_call_delta', id: '', arguments: JSON.stringify(fc.args) });
      }
      out.events.push({ type: 'tool_call_end', id: '' });
    },

    /** Web search has no per-call markers: one pair, the first time grounding
     *  metadata appears anywhere in the stream. */
    googleStreamWebSearch: (ctx: Ctx) => {
      const out = outOf(ctx);
      const cand = candidateOf(ctx);
      if (!cand.groundingMetadata || out.webSearchEmitted) return;
      out.webSearchEmitted = true;
      const q = ((cand.groundingMetadata as Record<string, unknown>).webSearchQueries as
        | string[]
        | undefined)?.[0];
      out.events.push({ type: 'builtin_tool_start', tool: 'web_search' });
      out.events.push({
        type: 'builtin_tool_end',
        tool: 'web_search',
        ...(typeof q === 'string' ? { query: q } : {}),
      });
    },

    /** Same for urlContext: one pair per retrieved URL, once. */
    googleStreamUrlFetch: (ctx: Ctx) => {
      const out = outOf(ctx);
      const meta = (candidateOf(ctx).urlContextMetadata as Record<string, unknown> | undefined)
        ?.urlMetadata as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(meta) || out.urlFetchEmitted) return;
      out.urlFetchEmitted = true;
      for (const m of meta) {
        const url = m.retrievedUrl as string | undefined;
        out.events.push({ type: 'builtin_tool_start', tool: 'web_fetch' });
        out.events.push({
          type: 'builtin_tool_end',
          tool: 'web_fetch',
          ...(typeof url === 'string' ? { url } : {}),
        });
      }
    },
  },
};
