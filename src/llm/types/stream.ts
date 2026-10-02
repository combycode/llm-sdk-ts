/** Universal streaming event types. */

import type { ModerationEntry } from '../moderation/types';
import type { AssistantPhase } from './messages';
import type { CacheDiagnostics, Citation, FileOutput, Usage } from './response';
import type { ContainerInfo } from '../providers/anthropic/container';

export type MediaStreamType = 'image' | 'audio' | 'video';

export type StreamEvent =
  /** `itemId` identifies WHICH output item a delta belongs to, when the provider reports
   *  one (OpenAI Responses forwards `item_id`; chat-completions has no per-item concept,
   *  so it is absent there). A single turn can interleave deltas from several output
   *  items, so a consumer that reassembles them per item — rather than just concatenating
   *  into one string — needs this to keep them apart. Optional and additive: ignoring it
   *  gives exactly the previous behaviour. */
  /** `phase` mirrors the buffered `TextPart.phase`: whether this delta is commentary or the answer
   *  proper. Reported only by models that distinguish them (codex family); absent elsewhere. */
  | { type: 'text'; text: string; itemId?: string; phase?: AssistantPhase }
  | { type: 'thinking'; text: string; itemId?: string }
  | { type: 'tool_call_start'; id: string; name: string; _meta?: Record<string, unknown> }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; usage: Usage }
  /** `signatures` is opaque provider state the NEXT request must echo, carried
   *  here rather than as its own event because a caller never reads it and a
   *  stream they do read should not fill with blobs. Collected onto the
   *  streamed final response, exactly as the buffered parse returns it. */
  | {
      type: 'done';
      finishReason: string;
      signatures?: unknown;
      /** Anthropic: the code-execution container this turn ran in. It rides the
       *  TERMINAL frame because that is where the provider sends it -- measured
       *  2026-10-02, `message_start.container` is `null` on every streamed turn and
       *  the real container arrives on `message_delta.delta.container`. Collected
       *  onto the streamed response's `container`, so streaming does not cost you
       *  the id you need to reuse the container. */
      container?: ContainerInfo;
    }
  | { type: 'error'; error: Error }
  | { type: 'media_start'; mediaType: MediaStreamType; mimeType: string }
  | { type: 'media_chunk'; data: string; progress?: number }
  | { type: 'media_end'; mediaId?: string }
  /** A hosted-tool output file (e.g. a code-execution chart/CSV) became available.
   *  Carries the `FileOutput` descriptor (id / url / inline data + name / mimeType),
   *  not the bytes — fetch those via `retrieveFile` / `streamFile`. The same file
   *  is also collected onto the streamed final response's `files`. */
  | { type: 'file'; file: FileOutput }
  /** The answer cited a source. Emitted as the citation arrives, which is NOT
   *  when the search ran: a provider searches early and cites while it writes, so
   *  these interleave with `text` deltas. Distinct from `builtin_tool_end`, which
   *  reports the search itself.
   *
   *  Measured shapes: Anthropic `citations_delta`, OpenAI/xAI Responses
   *  `response.output_text.annotation.added`, chat-completions `delta.annotations`,
   *  Google's populated `groundingMetadata` chunk. Also collected onto the streamed
   *  final response's `citations`, deduped by url. */
  | { type: 'citation'; citation: Citation }
  /** A hosted (provider-run) builtin tool began executing server-side — e.g. the
   *  model started a web search or code-execution run. `tool` is the unified name
   *  (`'web_search'` | `'code_interpreter'` | …). Informational progress: unlike
   *  `tool_call_*` (a function call the CLIENT must run), the provider runs these
   *  itself, so there is nothing to execute or return. Also collected onto the
   *  streamed final response's `builtinToolCalls`. */
  | { type: 'builtin_tool_start'; tool: string; id?: string }
  /** A hosted builtin tool made incremental progress: the model is still composing
   *  what it will run, or the provider is streaming back what it produced.
   *
   *  `code` is a fragment of the input (OpenAI's shell streams the command text a
   *  few characters at a time); `output` is a fragment of stdout/stderr as the
   *  provider's container produces it. Both are fragments to APPEND, exactly like
   *  `text` and `tool_call_delta` -- the complete values arrive again on
   *  `builtin_tool_end`, so a consumer that only wants the result can ignore these.
   *
   *  Measured 2026-10-02: OpenAI emits `response.shell_call_command.{added,delta,done}`
   *  for any shell call and `response.shell_call_output_content.{delta,done}` only when
   *  the tool runs in a container. xAI sends its commands as one JSON arguments string
   *  instead (`response.shell_call_arguments.*`), which is not a fragment of anything a
   *  caller would display, so nothing is emitted for it -- its item already carries the
   *  finished commands. Chopping that JSON into fake `code` deltas would be inventing
   *  progress the provider never reported. */
  | { type: 'builtin_tool_delta'; tool: string; id?: string; code?: string; output?: string }
  /** A hosted builtin tool finished executing server-side. Carries its inputs/outputs
   *  (`code` + `output` for code execution, `query` for web search) — the same payload
   *  the client collects onto `response.builtinToolCalls`. */
  | {
      type: 'builtin_tool_end';
      tool: string;
      id?: string;
      code?: string;
      output?: string;
      query?: string;
      url?: string;
      /** `shell` only -- see `BuiltinToolCall.callId` / `.environment`. Carried on the
       *  event, not just on the buffered call, because `response.builtinToolCalls` is
       *  assembled from these events when streaming: leaving them off would mean the
       *  same turn told you where its commands ran only if you did not stream it. */
      callId?: string;
      environment?: string;
    }
  /** A moderation result for the input or output. `source` distinguishes a
   *  provider-native result from a client-emulated one. Emitted by the moderation
   *  option (report-only). */
  | { type: 'moderation'; phase: 'input' | 'output'; result: ModerationEntry; source: 'native' | 'emulated' }
  /** The prompt-cache diagnosis for THIS request, when `cacheDiagnostics` asked
   *  for one. Both providers send it in the stream as well as in a buffered
   *  reply -- Anthropic on `message_start`, OpenAI inside the response envelope
   *  (measured 2026-09-29) -- and without this the same request answered a
   *  different question depending on how it was fetched. Also collected onto the
   *  streamed final response's `cacheDiagnostics`, for the same reason `file`
   *  and `citation` are. */
  | { type: 'cache_diagnostics'; diagnostics: CacheDiagnostics };
