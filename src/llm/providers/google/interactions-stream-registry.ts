/** The named escape hatches `google.interactions.stream.json` calls.
 *
 *  Two things span events: the id of the currently-open function call (its
 *  argument fragments and its close carry only an index), and whether any tool
 *  was called at all, which decides the finish reason at the end.
 */
import { googleInteractionsUsage } from './interactions';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';

interface StreamOut {
  events: unknown[];
  callId: string | null;
  sawToolCall: boolean;
}

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (ctx: Ctx): StreamOut => (ctx.req as { out: StreamOut }).out;
const deltaOf = (ctx: Ctx): Record<string, unknown> =>
  ((rawOf(ctx).delta as Record<string, unknown>) ?? {});

/** Close the open call, if there is one. Shared by `step.stop` and the terminal
 *  frames, which flush defensively in case `step.stop` was omitted. */
function closeOpenCall(out: StreamOut): void {
  if (!out.callId) return;
  out.events.push({ type: 'tool_call_end', id: out.callId });
  out.callId = null;
}

export const GOOGLE_INTERACTIONS_STREAM_REGISTRY: Registry = {
  transforms: {
    /** Argument fragments carry no id; they belong to the open call. */
    gaStreamArgsDelta: (_arg: unknown, ctx: Ctx) => ({
      type: 'tool_call_delta',
      id: outOf(ctx).callId ?? '',
      arguments: (deltaOf(ctx).arguments as string) ?? '',
    }),
  },

  builders: {},
  predicates: {},

  effects: {
    gaStreamStepStart: (ctx: Ctx) => {
      const out = outOf(ctx);
      const step = (rawOf(ctx).step as Record<string, unknown>) ?? {};
      if (step.type !== 'function_call') return;
      const id = (step.id as string) ?? '';
      out.callId = id;
      out.sawToolCall = true;
      out.events.push({ type: 'tool_call_start', id, name: (step.name as string) ?? '' });
      // Args normally stream via arguments_delta; forward an inline object too.
      const args = step.arguments as Record<string, unknown> | undefined;
      if (args && Object.keys(args).length > 0) {
        out.events.push({ type: 'tool_call_delta', id, arguments: JSON.stringify(args) });
      }
    },

    /** step.stop carries only an index, so the open call is what it closes. */
    gaStreamStepStop: (ctx: Ctx) => closeOpenCall(outOf(ctx)),

    gaStreamCompleted: (ctx: Ctx) => {
      const out = outOf(ctx);
      const raw = rawOf(ctx);
      closeOpenCall(out);
      const interaction = (raw.interaction as Record<string, unknown>) ?? {};
      const usage =
        (interaction.usage as Record<string, unknown>) ??
        ((raw.metadata as Record<string, unknown>)?.total_usage as Record<string, unknown>);
      if (usage) out.events.push({ type: 'usage', usage: googleInteractionsUsage(usage) });
      // `queued` is NOT terminal (google 2.13): the interaction is still to run,
      // so it must never close the stream with a `done`.
      const status = interaction.status as string;
      if (status !== 'queued') {
        out.events.push({
          type: 'done',
          finishReason: extractFinishReason(out.sawToolCall, status, { failed: 'error' }),
        });
      }
    },
  },
};
