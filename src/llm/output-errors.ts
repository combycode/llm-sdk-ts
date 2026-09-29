/** Typed errors for abnormal agent-run / structured-output outcomes.
 *
 *  `AgentRunError` is the shared base so callers can differentiate the failure
 *  reason (`error.reason` or `instanceof`). Today only `invalid_final_output` is an
 *  exception; `max_steps` / `model_refusal` remain returned results (differentiated
 *  by `finishReason` / `AgentRunReport.reason`). A future run-error-handler config
 *  can add `MaxStepsError` / `ModelRefusalError` under this base without a break. */

export class AgentRunError extends Error {
  /** Machine-readable failure reason (e.g. `'invalid_final_output'`). */
  readonly reason: string;
  constructor(reason: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentRunError';
    this.reason = reason;
  }
}

/** The model's final output could not be parsed / validated against the requested
 *  JSON schema. Carries the raw text so a caller can inspect, log, or retry. */
export class InvalidFinalOutputError extends AgentRunError {
  readonly reason = 'invalid_final_output' as const;
  /** The raw model output that failed to parse. */
  readonly rawText: string;
  constructor(rawText: string, options?: { cause?: unknown }) {
    super(
      'invalid_final_output',
      `Model final output did not match the requested schema: ${
        options?.cause instanceof Error ? options.cause.message : 'parse failed'
      }`,
      options,
    );
    this.name = 'InvalidFinalOutputError';
    this.rawText = rawText;
  }
}

/** A pre-fed approval decision did not belong to the tool call it was about to
 *  be applied to.
 *
 *  Resuming from an approval re-runs the model step (the pending record holds the
 *  call's metadata, not the execution), so the call that comes back carries the
 *  same `callId` and may carry DIFFERENT arguments -- or, with a reused id, a
 *  different tool. Applying the stored decision then authorizes an invocation
 *  nobody approved, which is the whole point of asking.
 *
 *  So the decision is bound to the invocation it was made about: the tool name
 *  plus a digest of its canonical arguments. A mismatch raises this rather than
 *  falling through to the approver -- the human already answered a different
 *  question, and asking again in the same breath would present their old answer
 *  as consent.
 *
 *  `reason` distinguishes WHAT changed, because the two mean different things: a
 *  different tool under the same id is a provider or transport fault, while
 *  different arguments are the model having reconsidered. */
export class ApprovalMismatchError extends AgentRunError {
  readonly reason: 'tool_name_mismatch' | 'arguments_mismatch';
  readonly callId: string;
  /** What was approved. */
  readonly approved: { toolName: string; digest: string };
  /** What the re-run produced. */
  readonly attempted: { toolName: string; digest: string };
  constructor(
    reason: 'tool_name_mismatch' | 'arguments_mismatch',
    callId: string,
    approved: { toolName: string; digest: string },
    attempted: { toolName: string; digest: string },
  ) {
    super(
      reason,
      reason === 'tool_name_mismatch'
        ? `Approval for call ${callId} was given for tool "${approved.toolName}" and the resumed ` +
            `run asked for "${attempted.toolName}". The decision was not applied.`
        : `Approval for call ${callId} (${approved.toolName}) was given for different arguments ` +
            `than the resumed run produced (${approved.digest} vs ${attempted.digest}). ` +
            'The decision was not applied.',
    );
    this.name = 'ApprovalMismatchError';
    this.reason = reason;
    this.callId = callId;
    this.approved = approved;
    this.attempted = attempted;
  }
}
