/** Universal streaming event types. */

import type { Usage } from './response';

export type MediaStreamType = 'image' | 'audio' | 'video';

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call_start'; id: string; name: string; _meta?: Record<string, unknown> }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; error: Error }
  | { type: 'media_start'; mediaType: MediaStreamType; mimeType: string }
  | { type: 'media_chunk'; data: string; progress?: number }
  | { type: 'media_end'; mediaId?: string };
