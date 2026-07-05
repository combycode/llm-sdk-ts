/** Universal streaming event types. */

import type { ModerationEntry } from '../moderation/types';
import type { FileOutput, Usage } from './response';

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
  | { type: 'media_end'; mediaId?: string }
  /** A hosted-tool output file (e.g. a code-execution chart/CSV) became available.
   *  Carries the `FileOutput` descriptor (id / url / inline data + name / mimeType),
   *  not the bytes — fetch those via `retrieveFile` / `streamFile`. The same file
   *  is also collected onto the streamed final response's `files`. */
  | { type: 'file'; file: FileOutput }
  /** A moderation result for the input or output. `source` distinguishes a
   *  provider-native result from a client-emulated one. Emitted by the moderation
   *  option (report-only). */
  | { type: 'moderation'; phase: 'input' | 'output'; result: ModerationEntry; source: 'native' | 'emulated' };
