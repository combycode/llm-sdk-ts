/** The named escape hatches `openai.completions.json` calls.
 *
 *  Each delegates to the code the hand-written adapter already runs, so the two
 *  paths cannot disagree while both are live.
 */
import { openaiUsage } from './completions';
import { openaiBilledTier } from './tiers';
import { base64ToBytes } from '../../../util/base64';
import { sniffAudioMime } from '../../../util/audio-mime';
import { parseNativeModeration } from '../../moderation/native';
import { extractCitations } from '../_shared/citations';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';

type Audio = { transcript?: string; data?: string; id?: string; format?: string };

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (
  ctx: Ctx,
): { content: Array<{ type: string; text?: string }>; toolCalls: unknown[] } =>
  (ctx.req as { out: { content: Array<{ type: string; text?: string }>; toolCalls: unknown[] } })
    .out;

const choice = (ctx: Ctx): Record<string, unknown> =>
  (rawOf(ctx).choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
const message = (ctx: Ctx): Record<string, unknown> =>
  (choice(ctx).message as Record<string, unknown>) ?? {};
const audioOf = (ctx: Ctx): Audio | undefined => message(ctx).audio as Audio | undefined;

/** The assistant's words: `message.content`, or the transcript when the reply
 *  was spoken (gpt-audio leaves content null). */
function textOf(ctx: Ctx): string {
  const m = message(ctx);
  return (m.content as string) || audioOf(ctx)?.transcript || '';
}

const FINISH: Record<string, string> = {
  tool_calls: 'tool_use',
  length: 'length',
  content_filter: 'content_filter',
};

export const OPENAI_RESPONSE_REGISTRY: Registry = {
  transforms: {
    /** Omitted entirely when there are no words, so an empty reply yields no
     *  empty text part -- which is what the adapter's `if (text)` does. */
    openaiTextPart: (_arg: unknown, ctx: Ctx) => {
      const text = textOf(ctx);
      return text ? { type: 'text', text } : undefined;
    },

    openaiText: (_arg: unknown, ctx: Ctx) => textOf(ctx),

    /** The spoken bytes. The response carries no `format`, so the container is
     *  read from the bytes; the template is the last resort. */
    openaiAudioPart: (_arg: unknown, ctx: Ctx) => {
      const audio = audioOf(ctx);
      if (!audio?.data) return undefined;
      return {
        type: 'audio_output',
        mediaId: audio.id ?? '',
        mimeType:
          sniffAudioMime(base64ToBytes(audio.data.slice(0, 16))) ??
          `audio/${audio.format ?? 'wav'}`,
        _data: audio.data,
      };
    },

    /** Arguments arrive as a JSON STRING and are parsed, which is the one thing
     *  in this file that can throw on a well-formed provider response. */
    openaiToolCall: (_arg: unknown, ctx: Ctx) => {
      const tc = (ctx.item?.value ?? {}) as Record<string, unknown>;
      const fn = (tc.function as Record<string, unknown>) ?? {};
      return {
        type: 'tool_call',
        id: tc.id as string,
        name: fn.name as string,
        arguments: JSON.parse((fn.arguments as string) ?? '{}'),
      };
    },

    openaiUsageFull: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      return {
        ...openaiUsage(raw.usage as Record<string, unknown> | undefined),
        ...openaiBilledTier(raw.service_tier),
      };
    },

    openaiFinish: (_arg: unknown, ctx: Ctx) =>
      extractFinishReason(
        outOf(ctx).toolCalls.length > 0,
        choice(ctx).finish_reason as string,
        FINISH,
      ),

    openaiCitations: (_arg: unknown, ctx: Ctx) => {
      const c = extractCitations('completions', rawOf(ctx));
      return c.length ? c : undefined;
    },

    /** Chat Completions hides reasoning text; some OpenAI-compatible providers
     *  (DeepSeek, xAI) return it as `reasoning_content`. Null, never absent. */
    openaiThinking: (_arg: unknown, ctx: Ctx) => (message(ctx).reasoning_content as string) ?? null,

    /** Absent unless moderation was requested. */
    openaiModeration: (_arg: unknown, ctx: Ctx) =>
      parseNativeModeration(rawOf(ctx).moderation) ?? undefined,
  },

  builders: {},
  predicates: {},
  effects: {},
};
