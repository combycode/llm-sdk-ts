/** The named escape hatches `anthropic.messages.stream.json` calls.
 *
 *  Anthropic is the hardest of the five stream parsers, and all of its
 *  difficulty is in one mechanism: a `server_tool_use` block announces a hosted
 *  tool call, its input JSON arrives in fragments across later events, the block
 *  closes, and only THEN can the input be parsed and filed against the id that
 *  the `*_tool_result` block will later ask for. Three events apart, and none of
 *  them can be understood alone.
 *
 *  That is what the effects below are for. Everything that is a straight mapping
 *  -- text and thinking deltas, the finish reason, usage -- stays in the spec.
 */
import {
  anthropicUsage,
  builtinInputPayload,
  filesFromCodeExecBlock,
  resultStdout,
} from './messages';
import { unifiedBuiltinTool } from '../_shared/builtin-tools';
import { extractFinishReason } from '../_shared/response-utils';
import { anthropicCacheDiagnostics } from '../../cache-diagnostics';
import type { Ctx, Registry } from '../../../wire/interpreter';
import { containerFromWire } from './container';

type Block = Record<string, unknown>;

/** The stream's memory. `current` is the open `server_tool_use`; `pending` holds
 *  finished inputs by id, waiting for the result block that claims them. */
interface StreamOut {
  events: unknown[];
  current: { id: string; tool: string; json: string } | null;
  pending: Record<string, { code?: string; query?: string; url?: string }>;
}

const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
const outOf = (ctx: Ctx): StreamOut => (ctx.req as { out: StreamOut }).out;
const deltaOf = (ctx: Ctx): Record<string, unknown> =>
  (rawOf(ctx).delta as Record<string, unknown>) ?? {};

const FINISH: Record<string, string> = {
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  refusal: 'content_filter',
};

export const ANTHROPIC_STREAM_REGISTRY: Registry = {
  transforms: {
    /** The citation the ANSWER makes, which is not the same as the search
     *  results in the `web_search_tool_result` block: the model retrieves
     *  several pages and cites some of them. Undefined when it carries no url,
     *  which omits the emit entirely. */
    anthropicStreamCitation: (_arg: unknown, ctx: Ctx) => {
      const cite = (deltaOf(ctx).citation as Record<string, unknown>) ?? {};
      const url = cite.url as string | undefined;
      if (!url) return undefined;
      return {
        type: 'citation',
        citation: {
          url,
          ...(cite.title ? { title: cite.title as string } : {}),
          ...(cite.cited_text ? { text: cite.cited_text as string } : {}),
        },
      };
    },

    /** `message_delta` carries the running usage and, at the end, the stop
     *  reason. Either, both or neither may be present. */
    anthropicStreamMessageDelta: (_arg: unknown, ctx: Ctx) => {
      const raw = rawOf(ctx);
      const events: unknown[] = [];
      const usage = raw.usage as Record<string, unknown> | undefined;
      if (usage) events.push({ type: 'usage', usage: anthropicUsage(usage) });
      const sr = deltaOf(ctx).stop_reason as string | undefined;
      if (sr) {
        // The container rides this frame, not the opening one: `message_start`
        // sends `container: null` even when a container is created, and only
        // `message_delta.delta.container` has it.
        const container = containerFromWire(deltaOf(ctx).container);
        events.push({
          type: 'done',
          finishReason: extractFinishReason(sr === 'tool_use', sr, FINISH),
          ...(container ? { container } : {}),
        });
      }
      return events;
    },

    /** The opening frame carries the prompt-side usage. */
    anthropicStreamMessageStart: (_arg: unknown, ctx: Ctx) => {
      const msg = (rawOf(ctx).message as Record<string, unknown>) ?? {};
      const usage = msg.usage as Record<string, unknown> | undefined;
      const events: unknown[] = usage ? [{ type: 'usage', usage: anthropicUsage(usage) }] : [];
      // The diagnosis rides the opening frame, not the closing one -- it is a
      // fact about the REQUEST, known before a token is generated.
      const diagnostics = anthropicCacheDiagnostics(msg.diagnostics);
      if (diagnostics) events.push({ type: 'cache_diagnostics', diagnostics });
      return events;
    },
  },

  builders: {},
  predicates: {},

  effects: {
    /** An input fragment either feeds the open hosted-tool block or, when none
     *  is open, IS a plain function tool call's arguments. Same event type,
     *  opposite meaning, decided entirely by carried state. */
    anthropicStreamJsonDelta: (ctx: Ctx) => {
      const out = outOf(ctx);
      const delta = deltaOf(ctx);
      if (out.current) {
        out.current.json += (delta.partial_json as string) ?? '';
        return;
      }
      out.events.push({
        type: 'tool_call_delta',
        id: '',
        arguments: delta.partial_json as string,
      });
    },

    anthropicStreamBlockStart: (ctx: Ctx) => {
      const out = outOf(ctx);
      const block = (rawOf(ctx).content_block as Block) ?? {};
      const blockType = block.type as string;

      // A regular function tool. Returns immediately in the hand-written parser,
      // so no file extraction runs for it.
      if (blockType === 'tool_use') {
        out.current = null;
        out.events.push({
          type: 'tool_call_start',
          id: block.id as string,
          name: block.name as string,
        });
        return;
      }

      if (blockType === 'server_tool_use') {
        const tool = unifiedBuiltinTool(block.name as string);
        out.current = { id: (block.id as string) ?? '', tool, json: '' };
        out.events.push({
          type: 'builtin_tool_start',
          tool,
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
        });
      } else if (blockType?.endsWith('_tool_result')) {
        const tool = unifiedBuiltinTool(blockType);
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
        const input = id ? out.pending[id] : undefined;
        if (id) delete out.pending[id];
        const output = resultStdout(block.content);
        out.events.push({
          type: 'builtin_tool_end',
          tool,
          ...(id ? { id } : {}),
          ...(input?.code ? { code: input.code } : {}),
          ...(input?.query ? { query: input.query } : {}),
          ...(input?.url ? { url: input.url } : {}),
          ...(output ? { output } : {}),
        });
      }

      // Server-computed code-execution results arrive complete here rather than
      // token-streamed, so their output files are surfaced at the same moment.
      for (const file of filesFromCodeExecBlock(block)) {
        out.events.push({ type: 'file', file });
      }
    },

    /** Close an open hosted-tool block: parse what accumulated and file it by id
     *  for the result block that will ask for it. */
    anthropicStreamBlockStop: (ctx: Ctx) => {
      const out = outOf(ctx);
      if (!out.current) return;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(out.current.json || '{}') as Record<string, unknown>;
      } catch {
        /* partial/invalid JSON -> no payload */
      }
      out.pending[out.current.id] = builtinInputPayload(out.current.tool, input);
      out.current = null;
    },
  },
};
