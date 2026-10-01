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
  /** Signed steps rebuilt from their deltas, to ride out on `done`. */
  signatures?: unknown[];
  /** The step type currently open, so a signature delta knows what it signs. */
  openStep?: string;
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
      // Remembered for the signature delta: `step.start` names the type, and the
      // delta that carries the signature names only itself.
      out.openStep = typeof step.type === 'string' ? step.type : undefined;
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

    /** A signature reaches a streamed turn ONLY here.
     *
     *  Measured 2026-09-29: `step.start` announces `{type:'thought'}` with no
     *  signature, the signature arrives as its own `step.delta`
     *  (`delta.type === 'thought_signature'`), and the terminal
     *  `interaction.completed` carries the envelope WITHOUT steps. So a stream
     *  that ignores this delta loses the signature outright -- which is what the
     *  spec's old note, calling the delta "internal", assumed was harmless.
     *
     *  Rebuilt into the step shape the buffered path returns, because that is
     *  the shape the API accepts back. */
    gaStreamSignature: (ctx: Ctx) => {
      const out = outOf(ctx);
      const signature = deltaOf(ctx).signature;
      if (typeof signature !== 'string' || !signature) return;
      (out.signatures ??= []).push({ type: out.openStep ?? 'thought', signature });
    },

    /** step.stop carries only an index, so the open call is what it closes. */
    gaStreamStepStop: (ctx: Ctx) => {
      closeOpenCall(outOf(ctx));
      outOf(ctx).openStep = undefined;
    },

    gaStreamCompleted: (ctx: Ctx) => {
      const out = outOf(ctx);
      const raw = rawOf(ctx);
      closeOpenCall(out);
      const interaction = (raw.interaction as Record<string, unknown>) ?? {};
      // `interaction.usage`, and nothing else. There used to be a fallback to
      // `metadata.total_usage`; google 2.25 deleted `StreamMetadata{total_usage}`
      // from every event type, and the wire agrees -- measured 2026-10-01 by
      // streaming a real interaction with each read removed in turn: without the
      // fallback usage still arrives, and with ONLY the fallback no usage event
      // fires at all. A branch that provably never executes is a line that
      // misdescribes the wire to whoever reads it next.
      const usage = interaction.usage as Record<string, unknown>;
      if (usage) out.events.push({ type: 'usage', usage: googleInteractionsUsage(usage) });
      // `queued` is NOT terminal (google 2.13): the interaction is still to run,
      // so it must never close the stream with a `done`.
      const status = interaction.status as string;
      if (status !== 'queued') {
        out.events.push({
          type: 'done',
          finishReason: extractFinishReason(out.sawToolCall, status, { failed: 'error' }),
          // Once, at the end, rather than as its own event: an opaque blob the
          // caller never reads is noise in a stream they do.
          ...(out.signatures?.length ? { signatures: out.signatures } : {}),
        });
      }
    },
  },
};
