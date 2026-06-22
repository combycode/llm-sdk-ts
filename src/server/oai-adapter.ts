/** Pure mapping functions between OpenAI Chat Completions shapes and SDK types. */

import type {
  OaiChatMessage,
  OaiChatRequest,
  OaiChatResponse,
  OaiChatStreamChunk,
  OaiContentPart,
  OaiErrorBody,
  OaiFinishReason,
  OaiModelEntry,
} from './oai-types';

export function oaiContentToText(content: OaiChatMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map(partToText).join('');
}

function partToText(part: OaiContentPart): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'image_url') {
    const url = part.image_url?.url ?? '';
    const short = url.length > 80 ? `${url.slice(0, 60)}...` : url;
    return `[image: ${short}]`;
  }
  return '';
}

export function extractLastUserText(messages: OaiChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return oaiContentToText(m.content);
  }
  throw new Error('oai-adapter: request.messages has no "user" entry');
}

export function extractSystemText(messages: OaiChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => oaiContentToText(m.content))
    .filter((t) => t.length > 0)
    .join('\n\n');
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface BuildChatResponseInput {
  model: string;
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: OaiFinishReason;
  id?: string;
}

export function buildChatResponse(input: BuildChatResponseInput): OaiChatResponse {
  const id = input.id ?? `chatcmpl-${crypto.randomUUID().slice(0, 20)}`;
  const created = Math.floor(Date.now() / 1000);
  const promptTokens = input.promptTokens ?? 0;
  const completionTokens = input.completionTokens ?? estimateTokens(input.text);
  return {
    id,
    object: 'chat.completion',
    created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: input.text },
        finish_reason: input.finishReason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export interface BuildStreamChunkInput {
  id: string;
  model: string;
  delta?: { role?: 'assistant'; content?: string };
  finishReason?: OaiFinishReason;
}

export function buildStreamChunk(input: BuildStreamChunkInput): OaiChatStreamChunk {
  return {
    id: input.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta ?? {},
        finish_reason: input.finishReason ?? null,
      },
    ],
  };
}

export function formatSseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_TERMINATOR = 'data: [DONE]\n\n';

export function buildModelsList(ids: string[]): OaiModelEntry[] {
  const created = Math.floor(Date.now() / 1000);
  return ids.map((id) => ({ id, object: 'model' as const, created, owned_by: 'orxa' }));
}

export function buildErrorBody(
  message: string,
  type = 'invalid_request_error',
  code?: string,
): OaiErrorBody {
  const body: OaiErrorBody = { error: { message, type } };
  if (code) body.error.code = code;
  return body;
}

export function validateChatRequest(req: unknown): OaiChatRequest {
  if (!req || typeof req !== 'object') {
    throw new Error('body must be a JSON object');
  }
  const r = req as Record<string, unknown>;
  if (typeof r.model !== 'string' || r.model.length === 0) {
    throw new Error('`model` must be a non-empty string');
  }
  if (!Array.isArray(r.messages) || r.messages.length === 0) {
    throw new Error('`messages` must be a non-empty array');
  }
  for (const m of r.messages as OaiChatMessage[]) {
    if (!m || typeof m !== 'object') throw new Error('each message must be an object');
    if (typeof m.role !== 'string') throw new Error('each message must have a `role`');
  }
  return r as unknown as OaiChatRequest;
}
