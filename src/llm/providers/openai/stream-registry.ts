/** The named escape hatches `openai.completions.stream.json` calls.
 *
 *  Chat Completions streams are not a discriminated union of event types the way
 *  Anthropic's are: every chunk has the same shape and the meaning is in which
 *  fields of `choices[0].delta` are populated. So the spec is one ordered list of
 *  self-guarding rules, which is exactly what the hand-written parser is.
 *
 *  Two things carry across events and are therefore effects: tool-call fragments
 *  correlate by `index` because only the first fragment carries an id, and audio
 *  needs to know whether its media block is already open.
 */
import { openaiUsage } from './completions';
import { parseNativeModeration } from '../../moderation/native';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';

interface StreamOut {
  events: unknown[];
  toolIdByIndex: Record<string, string>;
  audio: { open: boolean; id?: string };
}

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (ctx: Ctx): StreamOut => (ctx.req as { out: StreamOut }).out;
const choiceOf = (ctx: Ctx): Record<string, unknown> =>
  ((rawOf(ctx).choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {});
const deltaOf = (ctx: Ctx): Record<string, unknown> =>
  ((choiceOf(ctx).delta as Record<string, unknown>) ?? {});

const FINISH: Record<string, string> = {
  tool_calls: 'tool_use',
  length: 'length',
  content_filter: 'content_filter',
};

export const OPENAI_STREAM_REGISTRY: Registry = {
  transforms: {
    /** Native moderation arrives on its own chunk, with no choices. */
    openaiStreamModeration: (_arg: unknown, ctx: Ctx) => {
      const report = parseNativeModeration(rawOf(ctx).moderation);
      const out: unknown[] = [];
      if (report?.input) {
        out.push({ type: 'moderation', phase: 'input', result: report.input, source: 'native' });
      }
      if (report?.output) {
        out.push({ type: 'moderation', phase: 'output', result: report.output, source: 'native' });
      }
      return out;
    },

    /** Empty unless this chunk carries usage, which lets the same rule serve the
     *  usage-only chunk and the trailing usage on a normal one. */
    openaiStreamUsage: (_arg: unknown, ctx: Ctx) => {
      const usage = rawOf(ctx).usage as Record<string, unknown> | undefined;
      return usage ? [{ type: 'usage', usage: openaiUsage(usage) }] : [];
    },

    /** OpenRouter `:online` sends annotations on their own chunks, one per chunk,
     *  BEFORE the text that cites them. `url_citation.content` is the whole
     *  scraped page and is deliberately not mapped to `text`, which elsewhere
     *  means the short passage the source supports. */
    openaiStreamCitations: (_arg: unknown, ctx: Ctx) => {
      const out: unknown[] = [];
      for (const note of (deltaOf(ctx).annotations as Array<Record<string, unknown>>) ?? []) {
        const detail = ((note.url_citation as Record<string, unknown>) ?? note) as Record<
          string,
          unknown
        >;
        if (note.type === 'url_citation' && detail.url) {
          out.push({
            type: 'citation',
            citation: {
              url: detail.url as string,
              ...(detail.title ? { title: detail.title as string } : {}),
            },
          });
        }
      }
      return out;
    },

    openaiStreamDone: (_arg: unknown, ctx: Ctx) => {
      const fr = choiceOf(ctx).finish_reason as string | null;
      if (!fr) return undefined;
      return { type: 'done', finishReason: extractFinishReason(false, fr, FINISH) };
    },
  },

  builders: {},

  predicates: {
    /** The early return only fires when moderation actually produced entries. */
    openaiStreamHasModeration: (ctx: Ctx) => {
      const report = parseNativeModeration(rawOf(ctx).moderation);
      return Boolean(report?.input || report?.output);
    },
  },

  effects: {
    /** Correlate streamed tool-call fragments by `index`: the wire id, when
     *  present, only arrives on the first delta and the argument fragments omit
     *  it. Some OpenAI-compatible backends omit it entirely, so a stable
     *  `call_<uuid>` is synthesised ONCE per index -- assigned on first sighting
     *  and never changed, or parallel id-less calls collide into one. */
    openaiStreamToolCalls: (ctx: Ctx) => {
      const out = outOf(ctx);
      for (const tc of (deltaOf(ctx).tool_calls as Array<Record<string, unknown>>) ?? []) {
        const index = String((tc.index as number) ?? 0);
        let id = out.toolIdByIndex[index];
        if (id === undefined) {
          id = (tc.id as string) || `call_${crypto.randomUUID()}`;
          out.toolIdByIndex[index] = id;
        }
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn?.name) out.events.push({ type: 'tool_call_start', id, name: fn.name as string });
        if (fn?.arguments) {
          out.events.push({ type: 'tool_call_delta', id, arguments: fn.arguments as string });
        }
      }
    },

    /** gpt-audio streams its reply as `delta.audio`: the transcript once up
     *  front, the bytes in fragments, and a final `expires_at`-only delta that
     *  closes it. These chunks never carry a finish_reason, so that closing
     *  delta is the ONLY terminal signal the stream gives. */
    openaiStreamAudio: (ctx: Ctx) => {
      const out = outOf(ctx);
      const audio = deltaOf(ctx).audio as
        | { id?: string; transcript?: string; data?: string; expires_at?: number }
        | undefined;
      if (!audio) return;
      if (audio.id && !out.audio.id) out.audio.id = audio.id;
      if (audio.transcript) out.events.push({ type: 'text', text: audio.transcript });
      if (audio.data) {
        if (!out.audio.open) {
          out.audio.open = true;
          // Always pcm16 -- the API refuses any other format when stream=true --
          // and raw PCM has no magic bytes, so the mime is stated not sniffed.
          out.events.push({ type: 'media_start', mediaType: 'audio', mimeType: 'audio/pcm' });
        }
        out.events.push({ type: 'media_chunk', data: audio.data });
      }
      if (audio.expires_at !== undefined && out.audio.open) {
        out.audio.open = false;
        out.events.push({
          type: 'media_end',
          ...(out.audio.id ? { mediaId: out.audio.id } : {}),
        });
        out.events.push({ type: 'done', finishReason: 'stop' });
      }
    },
  },
};
