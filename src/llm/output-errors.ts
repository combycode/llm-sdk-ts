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
