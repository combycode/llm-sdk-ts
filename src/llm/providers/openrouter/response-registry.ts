/** OpenRouter's response registry: OpenAI's, plus the one thing it adds.
 *
 *  Composed rather than redefined, mirroring the adapter -- `OpenRouterAdapter
 *  extends OpenAIAdapter` and its `parseResponse` calls `super` first.
 */
import { OPENAI_RESPONSE_REGISTRY } from '../openai/response-registry';
import type { Ctx, Registry } from '../../../wire/interpreter';

/** `:online` search leaves no tool-call item, only `url_citation` annotations. */
function hasUrlCitation(annotations: unknown): boolean {
  return (
    Array.isArray(annotations) &&
    annotations.some((a) => (a as Record<string, unknown>)?.type === 'url_citation')
  );
}

export const OPENROUTER_RESPONSE_REGISTRY: Registry = {
  ...OPENAI_RESPONSE_REGISTRY,
  transforms: {
    ...OPENAI_RESPONSE_REGISTRY.transforms,
    /** Undefined -- so the emit is skipped -- when the search did not run. */
    openrouterWebSearchCall: (_arg: unknown, ctx: Ctx) => {
      const raw = (ctx.req as { raw: Record<string, unknown> }).raw ?? {};
      const choices = raw.choices as Array<Record<string, unknown>> | undefined;
      const annotations = (choices?.[0]?.message as Record<string, unknown> | undefined)
        ?.annotations;
      return hasUrlCitation(annotations) ? { tool: 'web_search' } : undefined;
    },
  },
};
