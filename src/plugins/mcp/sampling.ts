/** Sampling (P3): when an MCP server sends `sampling/createMessage`, it is asking
 *  US to run an LLM completion on its behalf. We fulfill it with our own engine —
 *  so the server borrows our multi-provider brain. The caller either supplies a
 *  custom handler or a model id to auto-wire. */

import type { EngineHandle } from '../../helpers/engine';
import { complete } from '../../helpers/one-shot';
import type { Content } from '../../llm/types/messages';
import type { ProviderName } from '../../llm/types/provider';
import type { Message } from '../../llm/types/messages';
import type { McpCreateMessageParams, McpCreateMessageResult, McpSamplingMessage } from './types';

export type McpSamplingHandler = (params: McpCreateMessageParams) => Promise<McpCreateMessageResult>;

/** Auto-wire sampling to our LLM. */
export interface McpSamplingViaLLM {
  model: string;
  provider?: ProviderName;
  engine?: EngineHandle;
}

export type McpSamplingConfig = McpSamplingHandler | McpSamplingViaLLM;

/** MCP sampling messages -> our Message[]. */
function toInternalMessages(msgs: McpSamplingMessage[]): Message[] {
  return msgs.map((m) => {
    const b = m.content;
    let content: Content = '';
    if (b.type === 'text') content = (b as { text: string }).text;
    else if (b.type === 'image') {
      const im = b as { data: string; mimeType: string };
      content = [{ type: 'image', source: { type: 'base64', mimeType: im.mimeType, data: im.data } }];
    } else if (b.type === 'audio') {
      const au = b as { data: string; mimeType: string };
      content = [{ type: 'audio', source: { type: 'base64', mimeType: au.mimeType, data: au.data } }];
    }
    return { role: m.role, content };
  });
}

/** Map our finish reason to an MCP stopReason. */
function toStopReason(finish: string): string {
  if (finish === 'length') return 'maxTokens';
  if (finish === 'stop') return 'endTurn';
  return finish;
}

/** Build a sampling handler: pass-through a custom function, or auto-wire a model. */
export function samplingHandler(config: McpSamplingConfig): McpSamplingHandler {
  if (typeof config === 'function') return config;
  return async (params) => {
    const result = await complete({
      model: config.model,
      provider: config.provider,
      engine: config.engine,
      system: params.systemPrompt,
      prompt: toInternalMessages(params.messages),
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    });
    return {
      role: 'assistant',
      content: { type: 'text', text: result.text },
      model: result.response.model,
      stopReason: toStopReason(result.response.finishReason),
    };
  };
}
