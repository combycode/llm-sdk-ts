/** The shell builtin tool: joining its two halves, and saying when it is waiting.
 *
 *  The shell tool behaves unlike every other builtin, in two ways that a caller
 *  cannot be expected to work out from an empty answer.
 *
 *  1. A container-run call arrives as TWO output items -- the `shell_call` with the
 *     commands, then a `shell_call_output` with stdout/stderr -- linked by `call_id`.
 *     Reported as-is, one tool call looks like two. The streamed path joins them with
 *     its own state, in event order; the buffered path has the whole list at once and
 *     joins it here, so both report the same single call.
 *
 *  2. A LOCAL call is not a finished tool call at all: the model only asks, and
 *     whoever called has to run the commands and feed the output back. The turn then
 *     ends with `finishReason: 'stop'` and empty text -- measured 2026-10-02,
 *     `text: ""`, `toolCalls: []`, no warning -- which is indistinguishable from a
 *     model that simply had nothing to say. That silence is what `shellAwaitingNote`
 *     exists to break.
 */

import type { BuiltinToolCall } from './types/response';

/** One call per shell invocation, with its output folded in.
 *
 *  Keyed on `callId` rather than position: the two items are adjacent in every
 *  response measured so far, but `call_id` is what the provider actually uses to
 *  link them, and a pairing that relies on order breaks silently the first time a
 *  turn interleaves two shell calls. A half with no partner is left alone -- an
 *  output whose call never arrived is still worth reporting. */
export function mergeShellCalls(calls: BuiltinToolCall[]): BuiltinToolCall[] {
  if (!calls.some((c) => c.tool === 'shell' && c.callId)) return calls;
  const out: BuiltinToolCall[] = [];
  const byCallId = new Map<string, BuiltinToolCall>();
  for (const call of calls) {
    const key = call.tool === 'shell' ? call.callId : undefined;
    const open = key ? byCallId.get(key) : undefined;
    if (!open) {
      const copy = { ...call };
      if (key) byCallId.set(key, copy);
      out.push(copy);
      continue;
    }
    // Merge into the half already reported. Only fill what is missing: the call
    // half owns the commands and the environment, the output half owns the output,
    // and neither should overwrite a value the other established.
    if (call.output && !open.output) open.output = call.output;
    if (call.code && !open.code) open.code = call.code;
    if (call.environment && !open.environment) open.environment = call.environment;
    if (call.id && !open.id) open.id = call.id;
  }
  return out;
}

/** The warning owed when the model asked the caller to run something, or
 *  `undefined` when it did not.
 *
 *  Deliberately a pure function returning the note, with the client emitting it --
 *  the same shape as `openaiTierDecision`, for the same reason: an adapter has no
 *  business owning a hook. */
export function shellAwaitingNote(calls: BuiltinToolCall[] | undefined): string | undefined {
  const waiting = (calls ?? []).filter((c) => c.tool === 'shell' && c.environment === 'local');
  if (waiting.length === 0) return undefined;
  const commands = waiting
    .map((c) => c.code)
    .filter((c): c is string => Boolean(c))
    .join('; ');
  return (
    `The model asked to run ${waiting.length === 1 ? 'a shell command' : `${waiting.length} shell commands`} ` +
    'and is waiting on you: the `shell` tool was enabled with a local environment, so nothing ran ' +
    'and this turn ends with no answer. Run the commands in `builtinToolCalls[].code`' +
    (commands ? ` (${commands})` : '') +
    ', then send the result back addressed to `callId`; or set ' +
    "`params.environment = { type: 'container_auto' }` to have OpenAI run them for you."
  );
}
