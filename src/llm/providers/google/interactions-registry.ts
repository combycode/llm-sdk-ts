/** The named escape hatches `google.interactions.json` calls.
 *
 *  Interactions differs from generateContent in one structural way: the items
 *  are not a field of the response, they are the FLATTENING of `step_list`.
 *  A `model_output` step carries a `content[]` of typed parts; a `thought` step
 *  has no content and stands for itself. So the spec flattens first, into an
 *  internal accumulator, and collects over that.
 */
import { googleInteractionsUsage } from './interactions';
import { AUDIO_PCM16_SAMPLE_RATE_HZ } from '../_shared/constants';
import { extractCitations } from '../_shared/citations';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';

type Item = Record<string, unknown>;

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (
  ctx: Ctx,
): { content: Array<{ type: string; text?: string }>; toolCalls: unknown[] } =>
  (ctx.req as { out: { content: Array<{ type: string; text?: string }>; toolCalls: unknown[] } })
    .out;
const itemOf = (ctx: Ctx): Item => (ctx.item?.value ?? {}) as Item;

/** Default mime per media kind, used when the item declares none. */
const DEFAULT_MIME: Record<string, string> = {
  image: 'image/png',
  audio: 'audio/pcm',
  video: 'video/mp4',
};
const PART_TYPE: Record<string, string> = {
  image: 'image_output',
  audio: 'audio_output',
  video: 'video_output',
};

const FINISH: Record<string, string> = {
  failed: 'error',
  // `queued` joined InteractionStatus in google 2.13: accepted but not yet run,
  // so it carries no completion and 'stop' would claim a finish that never was.
  queued: 'pending',
  in_progress: 'pending',
};

export const GOOGLE_INTERACTIONS_REGISTRY: Registry = {
  transforms: {
    /** `steps` (or the legacy `outputs`) flattened into typed items. */
    gaFlatten: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const steps = (raw.steps as Item[] | undefined) ?? (raw.outputs as Item[] | undefined) ?? [];
      const items: Item[] = [];
      for (const step of steps) {
        if (Array.isArray(step.content)) items.push(...(step.content as Item[]));
        else items.push(step);
      }
      return items;
    },

    gaTextPart: (_arg: unknown, ctx: Ctx) => ({ type: 'text', text: itemOf(ctx).text as string }),

    gaToolCall: (_arg: unknown, ctx: Ctx) => {
      const item = itemOf(ctx);
      return {
        type: 'tool_call',
        id: (item.id as string) ?? crypto.randomUUID(),
        name: item.name as string,
        arguments: (item.arguments as Record<string, unknown>) ?? {},
      };
    },

    gaMediaPart: (_arg: unknown, ctx: Ctx) => {
      const item = itemOf(ctx);
      const kind = item.type as string;
      const mime = (item.mime_type as string) ?? (item.mimeType as string) ?? '';
      const part: Record<string, unknown> = {
        type: PART_TYPE[kind],
        mediaId: '',
        mimeType: mime || DEFAULT_MIME[kind],
        _data: (item.data as string) ?? '',
      };
      if (kind === 'audio') part.sampleRate = AUDIO_PCM16_SAMPLE_RATE_HZ;
      return part;
    },

    gaId: (_arg: unknown, ctx: Ctx) => (rawOf(ctx).id as string) ?? crypto.randomUUID(),

    gaText: (_arg: unknown, ctx: Ctx) =>
      outOf(ctx)
        .content.filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join(''),

    gaUsage: (_arg: unknown, ctx: Ctx) =>
      googleInteractionsUsage(rawOf(ctx).usage as Record<string, unknown> | undefined),

    gaFinish: (_arg: unknown, ctx: Ctx) =>
      extractFinishReason(outOf(ctx).toolCalls.length > 0, rawOf(ctx).status as string, FINISH),

    /** Steps that carry a `signature`, kept verbatim so the next turn can send
     *  them back exactly as they arrived.
     *
     *  Matched on the PRESENCE of a signature rather than on a list of step
     *  types: `thought` is the one seen today, and `processing_call`,
     *  `processing_result`, `retrieval_call` and `retrieval_result` all declare
     *  one too (google-ts) and are all accepted as input types -- the live API
     *  enumerates them when it rejects an unknown one. A type list here would
     *  need editing every time Google adds a signed step, and until someone did,
     *  the signature would go missing with nothing to show for it. */
    gaSignatures: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const steps = (raw.steps as Item[] | undefined) ?? (raw.outputs as Item[] | undefined) ?? [];
      const signed = steps.filter((s) => typeof s.signature === 'string' && s.signature);
      return signed.length ? signed : undefined;
    },

    /** `Interaction.errors[]` -- "diagnostic faults / platform errors recorded on
     *  the interaction", per google-ts. A failed interaction used to arrive as
     *  `finishReason: 'error'` and nothing else: an empty answer, no exception to
     *  catch, and no way to tell a content refusal from a platform fault.
     *
     *  Read only on a FAILED interaction. The field is output-only and Google
     *  documents it as diagnostics rather than as the cause, so putting it on
     *  `error` for a completed turn would report a successful call as failed. On
     *  a completed one it stays reachable through `response.raw`. */
    gaError: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      if (raw.status !== 'failed') return undefined;
      const errors = Array.isArray(raw.errors) ? (raw.errors as Array<Record<string, unknown>>) : [];
      const first = errors[0];
      const code = typeof first?.code === 'string' ? first.code : undefined;
      // Every message, not just the first: a platform fault can record several,
      // and the one that explains it is not reliably the first.
      const message = errors
        .map((e) => (typeof e.message === 'string' ? e.message : ''))
        .filter(Boolean)
        .join('; ');
      if (!code && !message) return { message: 'The interaction failed and reported no detail.' };
      return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
    },

    gaCitations: (_arg: unknown, ctx: Ctx) => {
      const c = extractCitations('interactions', rawOf(ctx));
      return c.length ? c : undefined;
    },
  },

  builders: {},
  predicates: {},
  effects: {},
};
