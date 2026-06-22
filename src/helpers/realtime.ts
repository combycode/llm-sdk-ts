/** createRealtime — open a unified realtime/live session using the current
 *  EngineHandle (engine.connect transport + engine.apiKeys). Resolves a default
 *  per-provider RealtimeProviderAdapter (openai/google). Mirrors createLLM. */

import { resolveVoice } from '../llm/audio/voices';
import { OpenAIRealtimeAdapter } from '../llm/providers/openai/realtime';
import { GoogleRealtimeAdapter } from '../llm/providers/google/realtime';
import type { AudioOptions } from '../llm/types/audio';
import type {
  RealtimeModality,
  RealtimeProviderAdapter,
  RealtimeSession,
} from '../llm/realtime/types';
import type { ProviderName } from '../llm/types/provider';
import type { CompletionResponse, Usage } from '../llm/types/response';
import type { CompletionContext } from '../bus/hook-map';
import type { RequestContext } from '../types/request-context';
import { resolveModel } from './client-resolver';
import type { EngineHandle } from './engine';
import { coreRegistry } from './engine';

export interface CreateRealtimeOptions {
  /** Model string. Bare (`gpt-realtime` — pair with `provider`) or namespaced
   *  (`openai/gpt-realtime`). */
  model: string;
  /** Required when `model` is bare. Ignored when namespaced. */
  provider?: ProviderName;
  /** Falls back to `engine.apiKeys[provider]` when omitted. */
  apiKey?: string;
  modalities?: RealtimeModality[];
  /** Output audio controls (voice/format). `audio.voice` accepts a provider voice
   *  id or a unified alias. Takes precedence over the legacy `voice` field. */
  audio?: AudioOptions;
  /** @deprecated use `audio.voice`. */
  voice?: string;
  instructions?: string;
  engine?: EngineHandle;
}

export function createRealtime(opts: CreateRealtimeOptions): RealtimeSession {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider, model } = resolveModel(opts.model, opts.provider, 'createRealtime');
  const apiKey = opts.apiKey ?? engine.apiKeys[provider];
  if (!apiKey) {
    throw new Error(
      `createRealtime: no API key for provider "${provider}". ` +
        `Pass apiKey directly or set engine.apiKeys["${provider}"] via createEngine.`,
    );
  }
  const adapter = resolveAdapter(provider, apiKey);
  const voice = resolveVoice(provider, opts.audio?.voice ?? opts.voice);
  const session = adapter.connect(
    { model, modalities: opts.modalities, voice, instructions: opts.instructions },
    engine.connect,
  );

  // Meter realtime usage through the standard cost pipeline: each provider
  // 'usage' event (openai response.done / gemini usageMetadata) is emitted as an
  // onCompletion so the CostCollector tallies + prices it like any other call.
  session.on('usage', (e) => {
    void engine.hooks
      .emit('onCompletion', realtimeCompletionContext(provider, model, e.usage))
      .catch(() => {});
  });

  return session;
}

/** Minimal CompletionContext so the CostCollector can record realtime usage. */
function realtimeCompletionContext(
  provider: ProviderName,
  model: string,
  usage: Usage,
): CompletionContext {
  const response: CompletionResponse = {
    id: '',
    model,
    content: [],
    finishReason: 'stop',
    usage,
    text: '',
    toolCalls: [],
    thinking: null,
    media: [],
    latencyMs: 0,
    raw: usage,
  };
  return {
    provider,
    model,
    response,
    request: { estimatedInputTokens: 0, inputChars: 0, messageCount: 0, hasTools: false },
    ctx: {} as RequestContext,
  };
}

function resolveAdapter(provider: ProviderName, apiKey: string): RealtimeProviderAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAIRealtimeAdapter({ apiKey });
    case 'google':
      return new GoogleRealtimeAdapter({ apiKey });
    default:
      throw new Error(
        `createRealtime: no realtime adapter for provider "${provider}" ` +
          `(supported: openai, google).`,
      );
  }
}
