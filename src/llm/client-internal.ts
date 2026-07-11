/** LLMClient internals — request normalization, system extraction, context
 *  building, provider/adapter resolution, and structured-output parsing.
 *  Split out of client.ts to keep the class file focused on the public surface. */

import type { RequestContext } from '../types/request-context';
import type { LLMClient } from './client';
import type { LLMClientConfig } from './client-config';
import type { ContentPart, Message } from './types/messages';
import type { ExecuteOptions } from './types/options';
import type { ApiType, ProviderAdapter, ProviderName } from './types/provider';
import type { CompletionResponse } from './types/response';

export const PRIORITY_INTERACTIVE = 1;
export const PRIORITY_BACKGROUND = 2;

/** Build a history assistant message from a response, stamped with provenance
 *  (id, createdAt, origin). On a stateful API (responses / interactions) the origin
 *  carries the server-state id so a later turn can continue server-side instead of
 *  resending the transcript. Shared by `LLMClient.assistantMessage` (manual multi-turn)
 *  and the agent loop (so its tool turns also chain server-side). */
export function buildAssistantMessage(
  response: CompletionResponse,
  origin: { provider: ProviderName; model: string; api: ApiType },
): Message {
  const stateful = origin.api === 'responses' || origin.api === 'interactions';
  return {
    role: 'assistant',
    content: response.content,
    id: response.id || crypto.randomUUID(),
    createdAt: Date.now(),
    origin: {
      provider: origin.provider,
      model: origin.model,
      ...(stateful && response.id ? { serverStateId: response.id } : {}),
    },
  };
}

export function normalizeInput(input: string | ContentPart[] | Message[]): Message[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input) && input.length > 0 && 'role' in input[0]) {
    return input as Message[];
  }
  return [{ role: 'user', content: input as ContentPart[] }];
}

/** Lift any role:'system' messages out of the input array.
 *  Anthropic and some other providers expect `system` as a top-level
 *  parameter, not as a message role. By extracting here in the client we
 *  give callers a single, provider-neutral way to set per-call system text:
 *  either pass `options.system`, or include role:'system' messages in the
 *  input (they get concatenated). Adapters never see role:'system'. */
export function extractSystem(messages: Message[]): { system?: string; messages: Message[] } {
  const systemTexts: string[] = [];
  const rest: Message[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content);
      if (text) systemTexts.push(text);
    } else {
      rest.push(m);
    }
  }
  return {
    system: systemTexts.length ? systemTexts.join('\n\n') : undefined,
    messages: rest,
  };
}

function contentToText(content: ContentPart[]): string {
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Strip leading/trailing markdown fences and JSON.parse. Exported so AgentLoop
 *  + helper can share the same parsing rules. */
export function parseStructured<T>(text: string): T {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(stripped) as T;
}

export function buildContext(client: LLMClient, options: ExecuteOptions): RequestContext {
  const provided = options.ctx ?? {};
  const ctx: RequestContext = {
    ...provided,
    sessionId: provided.sessionId ?? client.sessionId,
    clientId: provided.clientId ?? client.id,
    queueName: provided.queueName ?? (client as unknown as { queueName: string }).queueName,
    configName:
      options.configName ??
      provided.configName ??
      (client as unknown as { configName: string }).configName,
    cacheName:
      options.cacheName ??
      provided.cacheName ??
      (client as unknown as { cacheName: string }).cacheName,
    cacheKey: options.cacheKey ?? provided.cacheKey,
  };
  if (!ctx.callId) ctx.callId = `call_${crypto.randomUUID().slice(0, 8)}`;
  // Mint-if-absent: server/agent set requestId upstream; a direct LLM call mints
  // it here so every request carries one (the request half of the trace id).
  if (!ctx.requestId) ctx.requestId = `req_${crypto.randomUUID().slice(0, 12)}`;
  return ctx;
}

export function resolveApi(provider: ProviderName, api?: ApiType | 'auto'): ApiType {
  if (api && api !== 'auto') return api;
  const defaults: Record<ProviderName, ApiType> = {
    anthropic: 'messages',
    openai: 'responses',
    // generateContent is Google's stable, production-recommended API. The
    // Interactions API (api:'interactions') is Beta with frequent breaking
    // schema changes (e.g. May 2026 turn_list->step_list) — opt in explicitly
    // when you need its server-side state / agentic steps.
    google: 'generate',
    xai: 'responses',
    openrouter: 'completions',
  };
  return defaults[provider] ?? 'completions';
}

export function resolveAdapter(config: LLMClientConfig, api: ApiType): ProviderAdapter {
  const a = config.adapter;
  if (!a) {
    throw new Error('LLMClient: adapter or AdapterFactory must be supplied');
  }
  if (typeof a === 'function') {
    return a(config.provider, config.apiKey, api, config.baseURL);
  }
  return a;
}
