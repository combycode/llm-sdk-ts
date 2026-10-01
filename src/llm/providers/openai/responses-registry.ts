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
import { base64ToBytes } from '../../../util/base64';
import { sniffImageMime } from '../../../util/image-mime';
import { openaiBilledTier } from './tiers';
import { openaiCacheDiagnostics } from '../../cache-diagnostics';
import { parseNativeModeration } from '../../moderation/native';
import { extractCitations } from '../_shared/citations';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';
import type { CompletionResponse } from '../../types/response';

type Item = Record<string, unknown>;

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (ctx: Ctx): { content: unknown[]; toolCalls: unknown[]; reasoningItems: Item[] } =>
  (ctx.req as { out: { content: unknown[]; toolCalls: unknown[]; reasoningItems: Item[] } }).out;
const itemOf = (ctx: Ctx): Item => (ctx.item?.value ?? {}) as Item;

/** What a safety block said about itself, if it said anything.
 *
 *  OpenAI added this in 2026-09 beside the `misalignment_policy_violation`
 *  code. `message` only reports that the turn was blocked; this reports what
 *  about it looked wrong and, when the provider offers one, a continuation to
 *  send instead. Returned wrapped so the caller can spread it: an error with no
 *  misalignment must not grow an `undefined` key.
 *
 *  `errorType` is passed through whatever it is -- the provider documents four
 *  values and says in as many words that clients must accept more, so
 *  validating against the four would drop exactly the ones worth knowing about.
 *
 *  Exported because the same object rides the Responses WebSocket error event.
 */
export function openaiMisalignment(
  value: unknown,
): { misalignment: NonNullable<CompletionResponse['error']>['misalignment'] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const m = value as { detailed_explanation?: unknown; error_type?: unknown; steer?: unknown };
  const steerMessage = (m.steer as { message?: unknown } | null | undefined)?.message;
  const out = {
    ...(typeof m.detailed_explanation === 'string' ? { detailedExplanation: m.detailed_explanation } : {}),
    ...(typeof m.error_type === 'string' ? { errorType: m.error_type } : {}),
    ...(typeof steerMessage === 'string' ? { steer: { message: steerMessage } } : {}),
  };
  // An empty object is not a report; `misalignment: {}` would read as "a safety
  // system explained itself" when nothing did.
  return Object.keys(out).length > 0 ? { misalignment: out } : undefined;
}

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

    /** A stored configuration update, if one ever arrives in `response.output`.
     *
     *  Measured 2026-10-01 it does NOT: four turns that set one on `gpt-5.6-sol`
     *  and `gpt-5.6-luna` returned `output: [message]` every time, and the item
     *  was found only through `GET /v1/conversations/{id}/items`. It is parsed
     *  anyway because OpenAI's own types put it in the output union, and the cost
     *  of being wrong runs one way: dropping a configuration item from history
     *  would silently revert the effort on the next turn, which is a change in
     *  how much the model thinks with nothing to point at. */
    oaiRespConfigurationUpdate: (_arg: unknown, ctx: Ctx) => {
      const item = itemOf(ctx);
      const effort = (item.reasoning as { effort?: unknown } | undefined)?.effort;
      if (typeof effort !== 'string') return undefined;
      return {
        type: 'configuration_update',
        reasoning: { effort },
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
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
      const declared =
        fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : fmt === 'png' ? 'image/png' : undefined;
      return {
        type: 'image_output',
        mediaId: '',
        // The provider's own word first; its BYTES second; PNG only when neither
        // says. The default alone was wrong for xAI, which returns JPEG from the
        // `image_generation` chat tool and no `output_format` at all (measured
        // 2026-10-01) -- so every generated image came back labeled `image/png`
        // with JPEG inside it. A caller writing the file gets the wrong extension,
        // and a strict validator downstream (Google Veo compares the declared mime
        // against the bytes) answers 400. The same correction already existed one
        // layer over, for xAI's image API; this path had been left out of it.
        mimeType: declared ?? sniffImageMime(base64ToBytes(data.slice(0, 16))) ?? 'image/png',
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
     *  catch and this is the only signal the caller gets.
     *
     *  A numeric `code` counts. The field was read only when it was already a
     *  string, so a number was dropped and the caller saw a failure with no
     *  code at all -- and OpenAI does send both, which is why openai-py 3.14
     *  began coercing it the same way.
     *
     *  `misalignment` is what a safety block says about itself (2026-09,
     *  alongside the `misalignment_policy_violation` code). It is kept because
     *  `steer.message` is a continuation the caller can act on: without it the
     *  only thing an agent learns is that it was stopped. */
    oaiRespError: (_arg: unknown, ctx: Ctx) => {
      const e = rawOf(ctx).error as
        | { code?: unknown; message?: unknown; misalignment?: unknown }
        | null
        | undefined;
      if (!e || (e.code === undefined && e.message === undefined)) return undefined;
      const code = typeof e.code === 'string' ? e.code : typeof e.code === 'number' ? String(e.code) : undefined;
      return {
        ...(code !== undefined ? { code } : {}),
        ...(typeof e.message === 'string' ? { message: e.message } : {}),
        ...(openaiMisalignment(e.misalignment) ?? {}),
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
