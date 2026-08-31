/** xAI's response registry: OpenAI's, with one transform replaced.
 *
 *  The parse-side twin of `XAIResponsesAdapter.filesFromOutputItem`. xAI returns
 *  code-execution files INLINE in the `code_interpreter_call` `logs` payload,
 *  not as OpenAI-style container-file annotations, so it needs both extractions
 *  where OpenAI needs one.
 *
 *  This exists because switching the adapter to the spec dropped it: the shared
 *  transform called the OpenAI module function directly and the subclass
 *  override was simply never consulted. No recorded xAI cell runs code
 *  execution, so the response differential stayed green -- a unit test caught it.
 */
import { OPENAI_RESPONSES_REGISTRY } from '../openai/responses-registry';
import { filesFromResponsesOutputItem } from '../openai/responses';
import { xaiCodeExecFiles } from './responses';
import type { Ctx, Registry } from '../../../wire/interpreter';

export const XAI_RESPONSES_REGISTRY: Registry = {
  ...OPENAI_RESPONSES_REGISTRY,
  transforms: {
    ...OPENAI_RESPONSES_REGISTRY.transforms,
    oaiRespFiles: (_arg: unknown, ctx: Ctx) => {
      const item = (ctx.item?.value ?? {}) as Record<string, unknown>;
      return [...filesFromResponsesOutputItem(item), ...xaiCodeExecFiles(item)];
    },
  },
};
