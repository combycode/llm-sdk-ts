/** Universal streaming event types. */

import type { ModerationEntry } from '../moderation/types';
import type { FileOutput, Usage } from './response';

export type MediaStreamType = 'image' | 'audio' | 'video';

export type StreamEvent =
  /** `itemId` identifies WHICH output item a delta belongs to, when the provider reports
   *  one (OpenAI Responses forwards `item_id`; chat-completions has no per-item concept,
   *  so it is absent there). A single turn can interleave deltas from several output
   *  items, so a consumer that reassembles them per item — rather than just concatenating
   *  into one string — needs this to keep them apart. Optional and additive: ignoring it
   *  gives exactly the previous behaviour. */
  | { type: 'text'; text: string; itemId?: string }
  | { type: 'thinking'; text: string; itemId?: string }
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
  /** A hosted (provider-run) builtin tool began executing server-side — e.g. the
   *  model started a web search or code-execution run. `tool` is the unified name
   *  (`'web_search'` | `'code_interpreter'` | …). Informational progress: unlike
   *  `tool_call_*` (a function call the CLIENT must run), the provider runs these
   *  itself, so there is nothing to execute or return. Also collected onto the
   *  streamed final response's `builtinToolCalls`. */
  | { type: 'builtin_tool_start'; tool: string; id?: string }
  /** A hosted builtin tool finished executing server-side. Carries its inputs/outputs
   *  (`code` + `output` for code execution, `query` for web search) — the same payload
   *  the client collects onto `response.builtinToolCalls`. */
  | { type: 'builtin_tool_end'; tool: string; id?: string; code?: string; output?: string; query?: string; url?: string }
  /** A moderation result for the input or output. `source` distinguishes a
   *  provider-native result from a client-emulated one. Emitted by the moderation
   *  option (report-only). */
  | { type: 'moderation'; phase: 'input' | 'output'; result: ModerationEntry; source: 'native' | 'emulated' };
