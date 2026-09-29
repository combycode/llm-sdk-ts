/** Google Gemini Live adapter (Bidi over WebSocket).
 *
 *  Wire protocol (extracted from `@google/genai` live.ts):
 *    - URL: wss://generativelanguage.googleapis.com/ws/
 *           google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<key>
 *    - On open: send { setup: { model: 'models/<model>', generationConfig:
 *      { responseModalities } , systemInstruction? } }. Server replies
 *      { setupComplete: {} } → only then is the session ready for content.
 *    - Send a turn: { clientContent: { turns: [{role:'user',parts:[{text}]}],
 *      turnComplete } }.
 *    - Server: { serverContent: { modelTurn: { parts: [{text}|{inlineData:
 *      {mimeType,data(base64)}}] }, turnComplete? } }.
 *
 *  Gemini Live models are audio-native: with responseModalities ['AUDIO'] the
 *  parts carry inlineData audio, not text. */

import { buildConnection, buildFrames } from '../../../wire/interpreter';
import { serviceSpec } from '../../../wire/service-specs';
import { makeRegistry } from '../../wire-transforms';
import type {
  EngineConnect,
  RealtimeConnection,
  RealtimeFrame,
  WsRequest,
} from '../../../network/types';

const RT_REGISTRY = makeRegistry({});
import { BaseRealtimeSession } from '../../realtime/session';
import { base64ToBytes } from '../../../util/base64';
import type { Usage } from '../../types/response';
import type {
  RealtimeInput,
  RealtimeProviderAdapter,
  RealtimeSession,
  RealtimeSessionConfig,
} from '../../realtime/types';
import { AUDIO_PCM16_SAMPLE_RATE_HZ } from '../_shared/constants';

const GOOGLE_WS_BASE = 'wss://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

export interface GoogleRealtimeAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class GoogleRealtimeAdapter implements RealtimeProviderAdapter {
  private readonly apiKey: string;
  private readonly base: string;

  constructor(config: GoogleRealtimeAdapterConfig) {
    this.apiKey = config.apiKey;
    this.base = (config.baseURL ?? GOOGLE_WS_BASE).replace(/^http/, 'ws').replace(/\/$/, '');
  }

  /** The WebSocket descriptor. Separated from `connect` so it can be asserted
   *  without opening a socket. Gemini authenticates with a query-string key and
   *  does NOT name the model in the URL — that goes in the setup frame. */
  buildConnectRequest(config: RealtimeSessionConfig): WsRequest {
    // The spec names these `wsBase` / `apiVersion`: the host is already ws:// by
    // the time it gets here, and the API version is part of the RPC path rather
    // than a prefix, so neither is the plain `baseURL` other specs read.
    const conn = buildConnection(serviceSpec('google/realtime'), 'connect', config, RT_REGISTRY, {
      wsBase: this.base,
      apiVersion: API_VERSION,
      apiKey: this.apiKey,
    });
    return { ...conn, provider: 'google', model: config.model };
  }

  connect(config: RealtimeSessionConfig, connect: EngineConnect): RealtimeSession {
    return new GoogleRealtimeSession(connect(this.buildConnectRequest(config)), config);
  }
}

/** The handshake frame. Pure: a function of the session config, so it can be
 *  asserted without opening a socket. Gemini Live names the model HERE rather
 *  than in the URL, which is the opposite of OpenAI. */
export function buildGoogleSetupFrame(config: RealtimeSessionConfig): Record<string, unknown> {
  return buildFrames(serviceSpec('google/realtime'), 'open', config, RT_REGISTRY)[0] as Record<
    string,
    unknown
  >;
}

/** The frames for one turn. Gemini carries turn completion as a FIELD, where
 *  OpenAI signals it by sending a second frame. */
export function buildGoogleTurnFrames(
  input: RealtimeInput,
  opts?: { turnComplete?: boolean },
): Array<Record<string, unknown>> {
  return buildFrames(
    serviceSpec('google/realtime'),
    'send',
    { ...input, turnComplete: opts?.turnComplete },
    RT_REGISTRY,
  ) as Array<Record<string, unknown>>;
}

class GoogleRealtimeSession extends BaseRealtimeSession {
  private readonly setupFrame: Record<string, unknown>;

  constructor(conn: RealtimeConnection, config: RealtimeSessionConfig) {
    super(conn);
    this.setupFrame = buildGoogleSetupFrame(config);
  }

  protected onOpen(): void {
    // Send setup; readiness is deferred until the server's `setupComplete`.
    this.sendJSON(this.setupFrame);
  }

  send(input: RealtimeInput, opts?: { turnComplete?: boolean }): void {
    this.whenReady(() => {
      for (const frame of buildGoogleTurnFrames(input, opts)) this.sendJSON(frame);
    });
  }

  protected onFrame(frame: RealtimeFrame): void {
    // Gemini Live sends JSON wrapped in BINARY WebSocket frames (not text frames
    // like OpenAI), so decode bytes → UTF-8 → JSON. setupComplete and the audio
    // serverContent both arrive this way.
    const raw = 'text' in frame ? frame.text : new TextDecoder().decode(frame.binary);
    let msg: GoogleServerMessage;
    try {
      msg = JSON.parse(raw) as GoogleServerMessage;
    } catch {
      return;
    }
    if (msg.setupComplete) {
      this.markReady();
      return;
    }
    if (msg.usageMetadata) this.emit({ type: 'usage', usage: mapGoogleUsage(msg.usageMetadata) });
    const sc = msg.serverContent;
    if (!sc) return;
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.text) this.emit({ type: 'text', delta: part.text });
      if (part.inlineData?.data) {
        // Gemini Live audio is PCM @ 24kHz; the mimeType (e.g. "audio/pcm;rate=24000")
        // comes back on inlineData.
        this.emit({
          type: 'audio',
          chunk: base64ToBytes(part.inlineData.data),
          mimeType: part.inlineData.mimeType ?? 'audio/pcm',
          sampleRate: AUDIO_PCM16_SAMPLE_RATE_HZ,
        });
      }
    }
    if (isInteractionComplete(sc)) this.emit({ type: 'turnComplete' });
  }
}

/** Has the turn actually ended?
 *
 *  `turnComplete` alone does not say so any more. `interactionStatus` is sent
 *  alongside it, and `IN_PROGRESS` means the server is still working -- "more
 *  model output may follow". Ending the turn on `turnComplete` therefore cut
 *  responses short as soon as Google started sending the field.
 *
 *  This mirrors `_is_interaction_complete` in google-py's live.py exactly,
 *  including the part that is easy to get wrong from the enum docs alone:
 *  `REQUIRES_ACTION` is documented as "deprecated, use IDLE", but upstream
 *  completes the turn ONLY on `IDLE`, so a deprecated value does not end it
 *  either. A server that sends no status at all, or `UNSPECIFIED`, falls back to
 *  `turnComplete` -- which is every server that predates the field.
 */
function isInteractionComplete(sc: {
  turnComplete?: boolean;
  interactionStatus?: string;
}): boolean {
  const status = sc.interactionStatus;
  if (status !== undefined && status !== '' && status !== 'INTERACTION_STATUS_UNSPECIFIED') {
    return status === 'IDLE';
  }
  return Boolean(sc.turnComplete);
}

interface GoogleServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
    };
    turnComplete?: boolean;
    /** The session's activity status. Always sent alongside `turnComplete`. */
    interactionStatus?: string;
  };
  usageMetadata?: GoogleUsageMetadata;
}

interface GoogleUsageMetadata {
  promptTokenCount?: number;
  responseTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

/** Map Gemini Live usageMetadata to the SDK's Usage. */
function mapGoogleUsage(u: GoogleUsageMetadata): Usage {
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.responseTokenCount ?? u.candidatesTokenCount ?? 0,
    totalTokens: u.totalTokenCount ?? 0,
    cachedTokens: u.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}
