/** Realtime / live session — the provider-agnostic DX surface.
 *
 *  A RealtimeSession normalizes two very different provider protocols (OpenAI's
 *  typed event stream, Google's turn-based bidi) onto one event model. Provider
 *  adapters own the wire mapping; the engine owns the WebSocket transport
 *  (engine.connect — queue-exempt). */

import type { EngineConnect } from '../../network/types';
import type { Usage } from '../types/response';

export type RealtimeModality = 'text' | 'audio';

export interface RealtimeSessionConfig {
  /** Bare model id (provider is fixed by the adapter). */
  model: string;
  /** Desired output modalities. Default `['text']`. Note: some models are
   *  audio-native (Gemini Live streams audio regardless). */
  modalities?: RealtimeModality[];
  /** Voice id for audio output, where the provider supports selection. */
  voice?: string;
  /** System instructions for the session. */
  instructions?: string;
}

/** One input turn (or partial turn) from the user. */
export interface RealtimeInput {
  text?: string;
  /** Raw audio bytes (provider-specific encoding, e.g. PCM16). */
  audio?: Uint8Array;
}

/** Normalized session events. Adapters map provider frames onto these. */
export type RealtimeEvent =
  | { type: 'open' }
  | { type: 'text'; delta: string }
  | { type: 'audio'; chunk: Uint8Array; mimeType: string; sampleRate?: number }
  | { type: 'turnComplete' }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: Error }
  | { type: 'close' };

export type RealtimeEventType = RealtimeEvent['type'];

export interface RealtimeSession {
  /** Send an input turn. `turnComplete` defaults to true (commit + request a
   *  response now); pass false to stream a turn across multiple sends. */
  send(input: RealtimeInput, opts?: { turnComplete?: boolean }): void;
  /** Subscribe to a normalized event. Returns an unsubscribe function. */
  on<E extends RealtimeEventType>(
    type: E,
    cb: (e: Extract<RealtimeEvent, { type: E }>) => void,
  ): () => void;
  /** Close the underlying socket. */
  close(): void;
}

/** Per-provider realtime adapter. Mirrors ProviderAdapter for request/response. */
export interface RealtimeProviderAdapter {
  connect(config: RealtimeSessionConfig, connect: EngineConnect): RealtimeSession;
}
