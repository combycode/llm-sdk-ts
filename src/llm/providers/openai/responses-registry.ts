/** The named escape hatches `openai.responses.json` calls.
 *
 *  Responses is the richest of the seven parsers: one `output[]` array carrying
 *  messages, reasoning, function calls, programs, program output and generated
 *  images, plus two things that apply to EVERY item whatever its type (output
 *  files and hosted builtin-tool calls).
 */
import {
  builtinCallFromResponsesItem,
  filesFromResponsesOutputItem,
  fromWireCaller,
  openaiResponsesUsage,
} from './responses';
import { openaiBilledTier } from './tiers';
import { openaiCacheDiagnostics } from '../../cache-diagnostics';
import { parseNativeModeration } from '../../moderation/native';
import { extractCitations } from '../_shared/citations';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';

type Item = Record<string, unknown>;

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (ctx: Ctx): { content: unknown[]; toolCalls: unknown[]; reasoningItems: Item[] } =>
  (ctx.req as { out: { content: unknown[]; toolCalls: unknown[]; reasoningItems: Item[] } }).out;
const itemOf = (ctx: Ctx): Item => (ctx.item?.value ?? {}) as Item;

/** The text a message item contributes, concatenated in output order.
 *
 *  Computed from `raw` rather than from what has been collected, so it does not
 *  depend on which phase asks. */
function textFromMessages(raw: Record<string, unknown>): string {
  let text = '';
  for (const item of (raw.output as Item[] | undefined) ?? []) {
    if (item.type !== 'message') continue;
    for (const c of (item.content as Item[] | undefined) ?? []) {
      if (c.type === 'output_text') text += (c.text as string) ?? '';
    }
  }
  return text;
}

const FINISH: Record<string, string> = {
  incomplete: 'length',
  failed: 'error',
  cancelled: 'error',
  queued: 'pending',
  in_progress: 'pending',
};

export const OPENAI_RESPONSES_REGISTRY: Registry = {
  transforms: {
    /** Applies to every item: container-file annotations and code-interpreter
     *  images, whatever the item's type. */
    oaiRespFiles: (_arg: unknown, ctx: Ctx) => filesFromResponsesOutputItem(itemOf(ctx)),

    /** Also every item: the hosted-tool trail. Null when this item is not one. */
    oaiRespBuiltinCall: (_arg: unknown, ctx: Ctx) =>
      builtinCallFromResponsesItem(itemOf(ctx)) ?? undefined,

    /** A message contributes one text part per `output_text`, carrying `phase`
     *  where the model sets it (codex-family narration vs the answer). */
    oaiRespMessageParts: (_arg: unknown, ctx: Ctx) => {
      const item = itemOf(ctx);
      const phase = typeof item.phase === 'string' ? item.phase : undefined;
      const parts: unknown[] = [];
      for (const c of (item.content as Item[] | undefined) ?? []) {
        if (c.type !== 'output_text') continue;
        parts.push({
          type: 'text',
          text: c.text as string,
          ...(phase !== undefined ? { phase } : {}),
        });
      }
      return parts;
    },

    /** The reasoning summary, when the model returned one. Undefined leaves the
     *  previous value alone, matching `if (summaryText) thinking = summaryText`. */
    oaiRespThinking: (_arg: unknown, ctx: Ctx) => {
      const summary = (itemOf(ctx).summary as Item[] | undefined) ?? [];
      const text = summary
        .filter((s) => s.type === 'summary_text')
        .map((s) => s.text as string)
        .join('\n');
      return text || undefined;
    },

    /** Kept so a `program` item can carry the reasoning that preceded it. */
    oaiRespSelf: (_arg: unknown, ctx: Ctx) => itemOf(ctx),

    oaiRespToolCall: (_arg: unknown, ctx: Ctx) => {
      const item = itemOf(ctx);
      const caller = fromWireCaller(item.caller);
      return {
        type: 'tool_call',
        id: (item.call_id as string) ?? (item.id as string),
        name: item.name as string,
        arguments:
          typeof item.arguments === 'string'
            ? JSON.parse(item.arguments as string)
            : ((item.arguments as Record<string, unknown>) ?? {}),
        ...(caller ? { caller } : {}),
      };
    },

    oaiRespProgram: (_arg: unknown, ctx: Ctx) => {
      const item = itemOf(ctx);
      const bound = outOf(ctx).reasoningItems;
      return {
        type: 'program_call',
        id: (item.call_id as string) ?? (item.id as string),
        code: (item.code as string) ?? '',
        fingerprint: (item.fingerprint as string) ?? '',
        _meta: {
          ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
          ...(bound.length > 0 ? { boundItems: [...bound] } : {}),
        },
      };
    },

    oaiRespProgramResult: (_arg: unknown, ctx: Ctx) => {
      const item = itemOf(ctx);
      return {
        type: 'program_result',
        id: (item.call_id as string) ?? (item.id as string),
        result: (item.result as string) ?? '',
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        // Required on the way back in, unlike every other item we echo.
        ...(typeof item.id === 'string' ? { _meta: { itemId: item.id } } : {}),
      };
    },

    oaiRespImage: (_arg: unknown, ctx: Ctx) => {
      const item = itemOf(ctx);
      const data = item.result as string;
      if (!data) return undefined;
      const fmt = item.output_format as string;
      return {
        type: 'image_output',
        mediaId: '',
        mimeType: fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png',
        revisedPrompt: item.revised_prompt as string | undefined,
        _data: data,
      };
    },

    /** The `output_text` convenience field, used only when no message produced
     *  text AND nothing else landed in content. */
    oaiRespFallbackTextPart: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      if (textFromMessages(raw)) return undefined;
      const ot = raw.output_text;
      if (typeof ot !== 'string' || !ot) return undefined;
      if (outOf(ctx).content.length !== 0) return undefined;
      return { type: 'text', text: ot };
    },

    oaiRespText: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const text = textFromMessages(raw);
      if (text) return text;
      return typeof raw.output_text === 'string' ? raw.output_text : '';
    },

    oaiRespUsage: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      return {
        ...openaiResponsesUsage(raw.usage as Record<string, unknown> | undefined),
        ...openaiBilledTier(raw.service_tier),
      };
    },

    /** `incomplete` carries a sub-reason, and only one of the four means what
     *  `length` means. The clone's enum is
     *  `max_output_tokens | max_messages | content_filter | steered`; everything
     *  but `content_filter` used to arrive as `length`, i.e. "your output was cut
     *  off by the token limit" -- which is wrong for a MESSAGE cap, and actively
     *  misleading for `steered`, where the turn was superseded and a successor
     *  `response.created` follows it automatically.
     *
     *  The distinct values ride the open `FinishReason` union (R1). The raw
     *  provider value stays reachable on `response.raw`. */
    oaiRespFinish: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const reason = (raw.incomplete_details as { reason?: string } | undefined)?.reason;
      const bySubReason: Record<string, string> = {
        content_filter: 'content_filter',
        max_output_tokens: 'length',
        max_messages: 'max_messages',
        steered: 'steered',
      };
      if (reason && bySubReason[reason]) return bySubReason[reason];
      return extractFinishReason(outOf(ctx).toolCalls.length > 0, raw.status as string, FINISH);
    },

    /** Present only when the request asked for it via `cacheDiagnostics`; the
     *  provider answers `unavailable` when there was too little to cache. */
    oaiRespCacheDiagnostics: (_arg: unknown, ctx: Ctx) =>
      openaiCacheDiagnostics(rawOf(ctx).prompt_cache_diagnostics),

    /** A Responses call can fail INSIDE a 200, so there is no exception to
     *  catch and this is the only signal the caller gets. */
    oaiRespError: (_arg: unknown, ctx: Ctx) => {
      const e = rawOf(ctx).error as { code?: unknown; message?: unknown } | null | undefined;
      if (!e || (e.code === undefined && e.message === undefined)) return undefined;
      return {
        ...(typeof e.code === 'string' ? { code: e.code } : {}),
        ...(typeof e.message === 'string' ? { message: e.message } : {}),
      };
    },

    oaiRespCitations: (_arg: unknown, ctx: Ctx) => {
      const c = extractCitations('responses', rawOf(ctx));
      return c.length ? c : undefined;
    },

    oaiRespModeration: (_arg: unknown, ctx: Ctx) =>
      parseNativeModeration(rawOf(ctx).moderation) ?? undefined,
  },

  builders: {},
  predicates: {},
  effects: {},
};
