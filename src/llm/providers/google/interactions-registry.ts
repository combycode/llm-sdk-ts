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
const outOf = (ctx: Ctx): { content: Array<{ type: string; text?: string }>; toolCalls: unknown[] } =>
  (ctx.req as { out: { content: Array<{ type: string; text?: string }>; toolCalls: unknown[] } }).out;
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

    gaCitations: (_arg: unknown, ctx: Ctx) => {
      const c = extractCitations('interactions', rawOf(ctx));
      return c.length ? c : undefined;
    },
  },

  builders: {},
  predicates: {},
  effects: {},
};
