/** OpenRouter's stream registry: OpenAI's, plus the one thing it adds.
 *
 *  `:online` web search leaves no tool-call item in the stream; `url_citation`
 *  annotations are the only signal it ran, so their first appearance IS the
 *  builtin call, emitted once per stream.
 */
import { OPENAI_STREAM_REGISTRY } from '../openai/stream-registry';
import type { Ctx, Registry } from '../../../wire/interpreter';

interface StreamOut {
  events: unknown[];
  webSearchEmitted: boolean;
}

function hasUrlCitation(annotations: unknown): boolean {
  return (
    Array.isArray(annotations) &&
    annotations.some((a) => (a as Record<string, unknown>)?.type === 'url_citation')
  );
}

export const OPENROUTER_STREAM_REGISTRY: Registry = {
  ...OPENAI_STREAM_REGISTRY,
  effects: {
    ...OPENAI_STREAM_REGISTRY.effects,
    openrouterStreamWebSearch: (ctx: Ctx) => {
      const out = (ctx.req as { out: StreamOut }).out;
      if (out.webSearchEmitted) return;
      const raw = (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
      const choice = (raw.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const annotations =
        (choice?.delta as Record<string, unknown> | undefined)?.annotations ??
        (choice?.message as Record<string, unknown> | undefined)?.annotations;
      if (!hasUrlCitation(annotations)) return;
      out.webSearchEmitted = true;
      out.events.push({ type: 'builtin_tool_start', tool: 'web_search' });
      out.events.push({ type: 'builtin_tool_end', tool: 'web_search' });
    },
  },
};
