/** OpenAI realtime adapter (GA `wss://api.openai.com/v1/realtime`).
 *
 *  Wire protocol (extracted from the official `openai/realtime/websocket`):
 *    - Auth via WS subprotocols: ['realtime', 'openai-insecure-api-key.<key>'].
 *    - On open: session.update { session: { type:'realtime', output_modalities } }.
 *    - Send a turn: conversation.item.create (input_text / input_audio) then
 *      response.create.
 *    - Server events keyed by `.type`:
 *        response.output_text.delta   → { text, delta }
 *        response.output_audio.delta  → { audio, base64 delta }
 *        response.done                → turn complete
 *        error                        → error */

import type { EngineConnect, RealtimeFrame, WsRequest } from '../../../network/types';
import { BaseRealtimeSession } from '../../realtime/session';
import { base64ToBytes, bytesToBase64 } from '../../../util/base64';
import type {
  RealtimeInput,
  RealtimeProviderAdapter,
  RealtimeSession,
  RealtimeSessionConfig,
} from '../../realtime/types';
import type { Usage } from '../../types/response';
import { AUDIO_PCM16_SAMPLE_RATE_HZ } from '../_shared/constants';

interface OpenAIRealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens?: number };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

/** Map OpenAI realtime usage (response.done) to the SDK's Usage, splitting audio
 *  from text tokens so each prices at its own catalog rate. */
function mapOpenAIUsage(u: OpenAIRealtimeUsage): Usage {
  const audioIn = u.input_token_details?.audio_tokens ?? 0;
  const audioOut = u.output_token_details?.audio_tokens ?? 0;
  const textIn = u.input_token_details?.text_tokens ?? (u.input_tokens ?? 0) - audioIn;
  const textOut = u.output_token_details?.text_tokens ?? (u.output_tokens ?? 0) - audioOut;
  return {
    inputTokens: Math.max(0, textIn),
    outputTokens: Math.max(0, textOut),
    totalTokens: u.total_tokens ?? 0,
    cachedTokens: u.input_token_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: audioIn,
    audioOutputTokens: audioOut,
  };
}

export interface OpenAIRealtimeAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class OpenAIRealtimeAdapter implements RealtimeProviderAdapter {
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenAIRealtimeAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.openai.com';
  }

  /** The WebSocket descriptor. Separated from `connect` so it can be asserted
   *  without opening a socket. Note the auth: OpenAI carries the key in a
   *  SUBPROTOCOL, not a header or query param, because browsers cannot set
   *  WebSocket headers. */
  buildConnectRequest(config: RealtimeSessionConfig): WsRequest {
    const url = new URL(`${this.baseURL.replace(/\/$/, '')}/v1/realtime`);
    url.protocol = 'wss';
    url.searchParams.set('model', config.model);
    return {
      url: url.toString(),
      protocols: ['realtime', `openai-insecure-api-key.${this.apiKey}`],
      provider: 'openai',
      model: config.model,
    };
  }

  connect(config: RealtimeSessionConfig, connect: EngineConnect): RealtimeSession {
    return new OpenAIRealtimeSession(connect(this.buildConnectRequest(config)), config);
  }
}

// ─── frame builders ──────────────────────────────────────────────────────
//
// A realtime session's outbound side is three artifacts: the connection
// descriptor (built by the adapter above), the handshake frame, and the per-turn
// frames. Building them is separated from sending them, and they are free
// functions rather than session methods, so each can be asserted without a
// socket. Google's equivalents have the same shape.

/** The handshake frame, sent once the socket opens. */
export function buildOpenAISessionUpdate(
  config: Pick<RealtimeSessionConfig, 'modalities' | 'instructions' | 'voice'>,
): Record<string, unknown> {
  const session: Record<string, unknown> = {
    type: 'realtime',
    output_modalities: config.modalities ?? ['text'],
  };
  if (config.instructions) session.instructions = config.instructions;
  if (config.voice) session.audio = { output: { voice: config.voice } };
  return { type: 'session.update', session };
}

/** The frames for one turn. `response.create` is what asks the model to reply,
 *  so `turnComplete: false` withholds it and the turn stays open — where Gemini
 *  carries the same meaning as a field on its single frame. */
export function buildOpenAITurnFrames(
  input: RealtimeInput,
  opts?: { turnComplete?: boolean },
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (input.text != null) content.push({ type: 'input_text', text: input.text });
  if (input.audio) content.push({ type: 'input_audio', audio: bytesToBase64(input.audio) });
  const frames: Array<Record<string, unknown>> = [
    { type: 'conversation.item.create', item: { type: 'message', role: 'user', content } },
  ];
  if (opts?.turnComplete !== false) frames.push({ type: 'response.create' });
  return frames;
}

class OpenAIRealtimeSession extends BaseRealtimeSession {
  private readonly modalities: string[];
  private readonly instructions?: string;
  private readonly voice?: string;

  constructor(
    conn: import('../../../network/types').RealtimeConnection,
    config: RealtimeSessionConfig,
  ) {
    super(conn);
    this.modalities = config.modalities ?? ['text'];
    this.instructions = config.instructions;
    this.voice = config.voice;
  }

  protected onOpen(): void {
    this.sendJSON(
      buildOpenAISessionUpdate({
        modalities: this.modalities as RealtimeSessionConfig['modalities'],
        instructions: this.instructions,
        voice: this.voice,
      }),
    );
    // OpenAI accepts conversation items immediately after the socket opens.
    this.markReady();
  }

  send(input: RealtimeInput, opts?: { turnComplete?: boolean }): void {
    this.whenReady(() => {
      for (const frame of buildOpenAITurnFrames(input, opts)) this.sendJSON(frame);
    });
  }

  protected onFrame(frame: RealtimeFrame): void {
    if (!('text' in frame)) return; // OpenAI realtime frames are JSON text
    let event: { type?: string; delta?: string; response?: { usage?: OpenAIRealtimeUsage } };
    try {
      event = JSON.parse(frame.text);
    } catch {
      return;
    }
    switch (event.type) {
      case 'response.output_text.delta':
        if (event.delta) this.emit({ type: 'text', delta: event.delta });
        break;
      case 'response.output_audio.delta':
        // OpenAI realtime audio is PCM16 mono @ 24kHz.
        if (event.delta) {
          this.emit({
            type: 'audio',
            chunk: base64ToBytes(event.delta),
            mimeType: 'audio/pcm',
            sampleRate: AUDIO_PCM16_SAMPLE_RATE_HZ,
          });
        }
        break;
      case 'response.done': {
        const usage = event.response?.usage;
        if (usage) this.emit({ type: 'usage', usage: mapOpenAIUsage(usage) });
        this.emit({ type: 'turnComplete' });
        break;
      }
      case 'error':
        this.emit({
          type: 'error',
          error: new Error(
            (event as { error?: { message?: string } }).error?.message ?? 'realtime error',
          ),
        });
        break;
    }
  }
}
