/** createRealtime — open a unified realtime/live session using the current
 *  EngineHandle (engine.connect transport + engine.apiKeys). Resolves a default
 *  per-provider RealtimeProviderAdapter (openai/google). Mirrors createLLM. */

import { isOwnedVoice, resolveVoice } from '../llm/audio/voices';
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
  /** Turn the session into a live translator.
   *
   *  **Google only.** Without this the catalogued `gemini-3.5-live-translate`
   *  could be connected to and not actually asked to translate anything --
   *  a model we advertise and could not configure.
   *
   *  `echoTargetLanguage` decides what happens when the target language is
   *  ALREADY being spoken: `true` parrots it back, `false` stays silent. For a
   *  two-way conversation that is the difference between hearing yourself
   *  repeated and not. */
  translation?: { targetLanguageCode?: string; echoTargetLanguage?: boolean };
  /** Let the model read the room -- detect emotion in the speaker and answer
   *  accordingly (frustration gets a more patient reply). Google only. */
  affectiveDialog?: boolean;
  /** How the session transcribes what it HEARS, as opposed to what it says.
   *  `'VERBATIM'` keeps the disfluencies; `'SMART'` cleans them up. Google
   *  only, and honoured only on a model that implements it -- see the
   *  transcription notes in the guide. */
  inputTranscription?: { mode?: 'VERBATIM' | 'SMART' };
  engine?: EngineHandle;
}

export function createRealtime(opts: CreateRealtimeOptions): RealtimeSession {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider, model } = resolveModel(opts.model, opts.provider, 'createRealtime');
  // The same catalog translation every other helper does. Without it, a realtime
  // session was the one path where our slug reached the provider unconverted.
  const sendModel = engine.catalog.resolveModelId(provider, model);
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
    {
      model: sendModel,
      modalities: opts.modalities,
      voice,
      // `voiceOwned` rides alongside the resolved id so the spec can pick the
      // wire field without re-deriving ownership. Same rule as TTS: a catalog
      // name keeps `prebuiltVoiceConfig`, an owned id takes the flat `voice`.
      voiceOwned: isOwnedVoice(opts.audio?.voice),
      instructions: opts.instructions,
      translation: opts.translation,
      affectiveDialog: opts.affectiveDialog,
      inputTranscription: opts.inputTranscription,
    },
    engine.connect,
  );

  // Meter realtime usage through the standard cost pipeline: each provider
  // 'usage' event (openai response.done / gemini usageMetadata) is emitted as an
  // onCompletion so the CostCollector tallies + prices it like any other call.
  session.on('usage', (e) => {
    void engine.hooks
      .emit('onCompletion', realtimeCompletionContext(provider, sendModel, e.usage))
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
