/** xAI's stream registry: OpenAI Responses', with file extraction replaced.
 *
 *  The stream twin of `xai/responses-registry.ts`, and it exists for the same
 *  reason: xAI returns code-execution files INLINE in the `code_interpreter_call`
 *  `logs` payload rather than as container-file annotations. On the buffered side
 *  calling the OpenAI module function directly is exactly how this override got
 *  silently dropped, and no recorded xAI cell runs code execution, so the
 *  differential would not have noticed here either.
 */
import { OPENAI_RESPONSES_STREAM_REGISTRY } from '../openai/responses-stream-registry';
import { filesFromResponsesOutputItem } from '../openai/responses';
import { xaiCodeExecFiles } from './responses';
import type { Ctx, Registry } from '../../../wire/interpreter';

export const XAI_STREAM_REGISTRY: Registry = {
  ...OPENAI_RESPONSES_STREAM_REGISTRY,
  transforms: {
    ...OPENAI_RESPONSES_STREAM_REGISTRY.transforms,
    oaiRespStreamFiles: (_arg: unknown, ctx: Ctx) => {
      const item = ((ctx.req as { raw: Record<string, unknown> }).raw?.item ?? {}) as Record<
        string,
        unknown
      >;
      return [...filesFromResponsesOutputItem(item), ...xaiCodeExecFiles(item)].map((file) => ({
        type: 'file',
        file,
      }));
    },
  },
};
