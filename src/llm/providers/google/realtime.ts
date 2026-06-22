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

import type {
  EngineConnect,
  RealtimeConnection,
  RealtimeFrame,
  WsRequest,
} from '../../../network/types';
import { BaseRealtimeSession } from '../../realtime/session';
import { base64ToBytes, bytesToBase64 } from '../../../util/base64';
import type { Usage } from '../../types/response';
import type {
  RealtimeInput,
  RealtimeModality,
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

  connect(config: RealtimeSessionConfig, connect: EngineConnect): RealtimeSession {
    const url =
      `${this.base}/ws/google.ai.generativelanguage.${API_VERSION}` +
      `.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
    const req: WsRequest = { url, provider: 'google', model: config.model };
    return new GoogleRealtimeSession(connect(req), config);
  }
}

/** Map our modalities to Gemini's response-modality enum strings. */
function toResponseModalities(mods: RealtimeModality[] | undefined): string[] {
  return (mods ?? ['text']).map((m) => (m === 'audio' ? 'AUDIO' : 'TEXT'));
}

class GoogleRealtimeSession extends BaseRealtimeSession {
  private readonly setupFrame: Record<string, unknown>;

  constructor(conn: RealtimeConnection, config: RealtimeSessionConfig) {
    super(conn);
    const voice = config.voice;
    const setup: Record<string, unknown> = {
      model: config.model.startsWith('models/') ? config.model : `models/${config.model}`,
      generationConfig: {
        responseModalities: toResponseModalities(config.modalities),
        ...(voice
          ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
          : {}),
      },
    };
    if (config.instructions) {
      setup.systemInstruction = { parts: [{ text: config.instructions }] };
    }
    this.setupFrame = { setup };
  }

  protected onOpen(): void {
    // Send setup; readiness is deferred until the server's `setupComplete`.
    this.sendJSON(this.setupFrame);
  }

  send(input: RealtimeInput, opts?: { turnComplete?: boolean }): void {
    this.whenReady(() => {
      const parts: Array<Record<string, unknown>> = [];
      if (input.text != null) parts.push({ text: input.text });
      if (input.audio) {
        parts.push({ inlineData: { mimeType: 'audio/pcm', data: bytesToBase64(input.audio) } });
      }
      this.sendJSON({
        clientContent: {
          turns: [{ role: 'user', parts }],
          turnComplete: opts?.turnComplete !== false,
        },
      });
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
    if (sc.turnComplete) this.emit({ type: 'turnComplete' });
  }
}

interface GoogleServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
    };
    turnComplete?: boolean;
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
