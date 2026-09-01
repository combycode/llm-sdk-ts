/** The named escape hatches `openai.responses.stream.json` calls.
 *
 *  The Responses stream is a clean discriminated union of event types, so most
 *  of it is `cases`. Only one thing spans events: `phase` is announced once on
 *  `response.output_item.added` but belongs on every text delta of that item,
 *  and the deltas carry only `item_id`.
 *
 *  `oaiRespStreamFiles` is a rule of its own rather than part of the
 *  item-done effect on purpose: xAI overrides file extraction, and on the
 *  buffered side calling the module function directly is exactly how its
 *  override got silently dropped.
 */
import { builtinCallFromResponsesItem, filesFromResponsesOutputItem, openaiResponsesUsage } from './responses';
import { parseNativeModeration } from '../../moderation/native';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';

type Item = Record<string, unknown>;

interface StreamOut {
  events: unknown[];
  /** item id -> the phase announced when that item was added. */
  phaseByItem: Record<string, string>;
}

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (ctx: Ctx): StreamOut => (ctx.req as { out: StreamOut }).out;
const itemOf = (ctx: Ctx): Item => ((rawOf(ctx).item as Item) ?? {});

/** Mirrors the adapter's `builtinEndPayload`: the code, query or url a hosted
 *  tool ran, carried on its end event. */
function endPayload(call: { code?: string; query?: string; url?: string; output?: string; id?: string }) {
  return {
    ...(call.id ? { id: call.id } : {}),
    ...(call.code ? { code: call.code } : {}),
    ...(call.query ? { query: call.query } : {}),
    ...(call.url ? { url: call.url } : {}),
    ...(call.output ? { output: call.output } : {}),
  };
}

export const OPENAI_RESPONSES_STREAM_REGISTRY: Registry = {
  transforms: {
    oaiRespStreamCitation: (_arg: unknown, ctx: Ctx) => {
      const note = (rawOf(ctx).annotation as Item) ?? {};
      if (note.type !== 'url_citation' || !note.url) return undefined;
      return {
        type: 'citation',
        citation: {
          url: note.url as string,
          ...(note.title ? { title: note.title as string } : {}),
        },
      };
    },

    /** `item_id` says WHICH output item this delta belongs to -- a turn can
     *  interleave deltas from several items, so it is passed through for
     *  consumers that reassemble per item instead of concatenating. */
    oaiRespStreamTextDelta: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const itemId = raw.item_id as string | undefined;
      const phase = itemId ? outOf(ctx).phaseByItem[itemId] : undefined;
      return {
        type: 'text',
        text: raw.delta as string,
        ...(itemId ? { itemId } : {}),
        ...(phase !== undefined ? { phase } : {}),
      };
    },

    /** Emitted as items complete, and overridden by xAI, which returns its
     *  code-execution files inline in the `logs` payload instead.
     *
     *  Returns STREAM EVENTS, not bare files: the unified event wraps the file
     *  as `{ type: 'file', file }`, and returning the payload unwrapped spliced
     *  raw FileOutputs into the event list. */
    oaiRespStreamFiles: (_arg: unknown, ctx: Ctx) =>
      filesFromResponsesOutputItem(itemOf(ctx)).map((file) => ({ type: 'file', file })),

    /** The terminal frame: moderation first, then usage, then done. */
    oaiRespStreamCompleted: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const response = (raw.response as Record<string, unknown>) ?? raw;
      const events: unknown[] = [];
      const moderation = parseNativeModeration(response.moderation);
      if (moderation?.input) {
        events.push({
          type: 'moderation',
          phase: 'input',
          result: moderation.input,
          source: 'native',
        });
      }
      if (moderation?.output) {
        events.push({
          type: 'moderation',
          phase: 'output',
          result: moderation.output,
          source: 'native',
        });
      }
      const usage = response.usage as Record<string, unknown> | undefined;
      if (usage) events.push({ type: 'usage', usage: openaiResponsesUsage(usage) });
      events.push({
        type: 'done',
        finishReason: extractFinishReason(false, response.status as string, {
          incomplete: 'length',
        }),
      });
      return events;
    },
  },

  builders: {},
  predicates: {},

  effects: {
    oaiRespStreamItemAdded: (ctx: Ctx) => {
      const out = outOf(ctx);
      const raw = rawOf(ctx);
      const item = itemOf(ctx);

      // Remember this item's phase: its text deltas carry only `item_id`.
      if (item.type === 'message' && typeof item.phase === 'string') {
        const itemId = (raw.item_id as string) ?? (item.id as string);
        if (itemId) out.phaseByItem[itemId] = item.phase;
      }
      if (item.type === 'function_call') {
        out.events.push({
          type: 'tool_call_start',
          id: (item.call_id as string) ?? '',
          name: (item.name as string) ?? '',
        });
      }
      if (item.type === 'image_generation_call') {
        out.events.push({ type: 'media_start', mediaType: 'image', mimeType: 'image/png' });
      }
      const builtin = builtinCallFromResponsesItem(item);
      if (builtin) {
        out.events.push({
          type: 'builtin_tool_start',
          tool: builtin.tool,
          ...(builtin.id ? { id: builtin.id } : {}),
        });
      }
    },

    oaiRespStreamItemDone: (ctx: Ctx) => {
      const out = outOf(ctx);
      const raw = rawOf(ctx);
      const item = itemOf(ctx);

      const builtin = builtinCallFromResponsesItem(item);
      if (builtin) {
        out.events.push({ type: 'builtin_tool_end', tool: builtin.tool, ...endPayload(builtin) });
      }
      if (item.type === 'function_call') {
        out.events.push({ type: 'tool_call_end', id: (item.call_id as string) ?? '' });
      }
      if (item.type === 'image_generation_call') out.events.push({ type: 'media_end' });
      if (item.type === 'reasoning') {
        const summary = (item.summary as Item[]) ?? [];
        const text = summary
          .filter((s) => s.type === 'summary_text')
          .map((s) => s.text as string)
          .join('\n');
        const itemId = (item.id as string) ?? (raw.item_id as string | undefined);
        if (text) {
          out.events.push({ type: 'thinking', text, ...(itemId ? { itemId } : {}) });
        }
      }
    },
  },
};
