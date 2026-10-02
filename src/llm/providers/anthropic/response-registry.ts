/** The named escape hatches `anthropic.messages.json` calls.
 *
 *  A response spec expresses SHAPE. These are the four things that are not
 *  shape: a fold over what was collected, a usage object with a billed tier
 *  merged in, a finish-reason decision that depends on whether any tool was
 *  called, and a citation walk. Each one delegates to the function the
 *  hand-written adapter already uses, so there is one implementation and the
 *  spec cannot drift from it.
 *
 *  It lives beside the adapter rather than under `wire/` on purpose: `wire/`
 *  must not import from `providers/`, or the request interpreter and every
 *  provider become one cycle.
 */
import {
  anthropicBilledTier,
  anthropicUsage,
  builtinInputPayload,
  filesFromCodeExecBlock,
  resultStdout,
} from './messages';
import { anthropicCacheDiagnostics } from '../../cache-diagnostics';
import { extractCitations } from '../_shared/citations';
import { unifiedBuiltinTool } from '../_shared/builtin-tools';
import { extractFinishReason } from '../_shared/response-utils';
import type { Ctx, Registry } from '../../../wire/interpreter';
import { containerFromWire } from './container';

type Block = Record<string, unknown>;
type Out = {
  content: Array<{ type: string; text?: string }>;
  toolCalls: unknown[];
  builtinToolCalls: Array<{ id?: string; output?: string }>;
};

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (ctx: Ctx): Out => (ctx.req as { out: Out }).out;
const blockOf = (ctx: Ctx): Block => (ctx.item?.value ?? {}) as Block;

/** `stop_reason` values that are NOT a clean finish.
 *
 *  `model_context_window_exceeded` (anthropic-ts 0.115) means the prompt itself
 *  overflowed, a truncation like max_tokens. `refusal` is a safety decline and
 *  lines up with every other provider's block signal. */
const FINISH: Record<string, string> = {
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  refusal: 'content_filter',
};

export const ANTHROPIC_RESPONSE_REGISTRY: Registry = {
  transforms: {
    /** The code-execution container this turn ran in, or nothing when it ran no
     *  code -- `container: null` is the normal answer then, not a problem. */
    anthropicContainer: (_arg: unknown, ctx: Ctx) =>
      containerFromWire((ctx.req as { raw?: Record<string, unknown> }).raw?.container),

    /** A provider-run tool call, with the code or query it was given. */
    anthropicBuiltinCall: (_arg: unknown, ctx: Ctx) => {
      const b = blockOf(ctx);
      const tool = unifiedBuiltinTool(b.name as string);
      return {
        tool,
        ...(typeof b.id === 'string' ? { id: b.id } : {}),
        ...builtinInputPayload(tool, b.input as Record<string, unknown> | undefined),
      };
    },

    /** Output files from one code-execution result block; often none. */
    anthropicCodeExecFiles: (_arg: unknown, ctx: Ctx) => filesFromCodeExecBlock(blockOf(ctx)),

    /** `text` is the concatenation of the text parts, so it cannot be computed
     *  until every block has been classified. */
    anthropicText: (_arg: unknown, ctx: Ctx) =>
      outOf(ctx)
        .content.filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join(''),

    anthropicUsageFull: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const u = raw.usage as Record<string, unknown> | undefined;
      return { ...anthropicUsage(u), ...anthropicBilledTier(u?.service_tier) };
    },

    /** Depends on the collected tool calls: a turn that called a tool finished
     *  for that reason whatever `stop_reason` says. */
    anthropicFinish: (_arg: unknown, ctx: Ctx) =>
      extractFinishReason(
        outOf(ctx).toolCalls.length > 0,
        rawOf(ctx).stop_reason as string,
        FINISH,
      ),

    /** Absent when the provider said nothing -- which on Anthropic covers a
     *  cache HIT as well as an undiagnosed request. See cache-diagnostics.ts. */
    anthropicCacheDiagnostics: (_arg: unknown, ctx: Ctx) =>
      anthropicCacheDiagnostics(rawOf(ctx).diagnostics),

    /** Absent, not empty, when the model cited nothing. Returning undefined is
     *  how a `$call` tells the interpreter to omit the key. */
    anthropicCitations: (_arg: unknown, ctx: Ctx) => {
      const c = extractCitations('messages', rawOf(ctx));
      return c.length ? c : undefined;
    },
  },

  builders: {},
  predicates: {},

  effects: {
    /** Attach a tool result's stdout to the call it belongs to. */
    anthropicAttachToolOutput: (ctx: Ctx) => {
      const b = blockOf(ctx);
      if (typeof b.type !== 'string' || !b.type.endsWith('_tool_result')) return;
      const output = resultStdout(b.content);
      if (!output) return;
      const call = outOf(ctx).builtinToolCalls.find((c) => c.id === (b.tool_use_id as string));
      if (call) call.output = output;
    },
  },
};
