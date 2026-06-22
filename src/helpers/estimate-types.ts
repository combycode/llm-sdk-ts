/** estimate() — public types and error classes.
 *  Extracted per project convention (no inline types in impl files). */

/** How many output tokens to assume when none are specified.
 *  Callers can override via `opts.expectedOutputTokens`. */
export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 512;

/** Fallback model max-output cap when the catalog does not list one for a
 *  model.  Used only for the `high` (worst-case) bound; deliberately
 *  conservative rather than 0 so callers get a real upper-bound. */
export const FALLBACK_MAX_OUTPUT_TOKENS = 4096;

/** The three cost bounds `estimate()` returns. */
export type EstimateBound = 'low' | 'expected' | 'high';

/** Breakdown of the estimate by cost category (USD). */
export interface EstimateBreakdown {
  /** Cost of the input tokens. */
  inputUsd: number;
  /** Cost of the output tokens (varies by bound). */
  outputUsd: number;
  /** Per-image cost when present (not yet computed — see assumptions). */
  imageUsd?: number;
  /** Audio-input cost when present (not yet computed — see assumptions). */
  audioUsd?: number;
}

/** The full result of `estimate()`. */
export interface EstimateResult {
  model: string;
  /** Input tokens counted (or estimated) from the request. */
  inputTokens: number;
  /** Output tokens used for the `expected` bound. */
  estOutputTokens: number;
  cost: {
    /** 0 output tokens (just input cost). */
    low: number;
    /** `estOutputTokens` output tokens. */
    expected: number;
    /** `maxTokens` or the model's maxOutput cap output tokens. */
    high: number;
  };
  breakdown: EstimateBreakdown;
  currency: 'USD';
  /** Human-readable notes explaining assumptions made during estimation. */
  assumptions: string[];
}

/** Thrown when `estimate()` is called with a model that is not in the catalog.
 *  Distinct from `LLMError` because no network call was made. */
export class UnknownModelError extends Error {
  readonly provider: string;
  readonly model: string;

  constructor(provider: string, model: string) {
    super(
      `estimate: model "${provider}/${model}" is not in the catalog — cannot price. ` +
        `Register the model via catalog.set() or use a known model string.`,
    );
    this.name = 'UnknownModelError';
    this.provider = provider;
    this.model = model;
  }
}

/** Thrown by the budget guard when the estimated cost for the chosen `bound`
 *  exceeds the caller-supplied `maxCostUsd` limit. */
export class BudgetExceededError extends Error {
  /** The bound that was checked ('low' | 'expected' | 'high'). */
  readonly bound: EstimateBound;
  /** The estimate that triggered the guard. */
  readonly estimate: EstimateResult;
  /** The limit that was exceeded (USD). */
  readonly maxCostUsd: number;
  /** The cost for the checked bound (USD). */
  readonly costUsd: number;

  constructor(opts: {
    bound: EstimateBound;
    estimate: EstimateResult;
    maxCostUsd: number;
    costUsd: number;
  }) {
    super(
      `Budget exceeded: estimated ${opts.bound} cost $${opts.costUsd.toFixed(6)} ` +
        `exceeds maxCostUsd $${opts.maxCostUsd.toFixed(6)} ` +
        `for model ${opts.estimate.model}.`,
    );
    this.name = 'BudgetExceededError';
    this.bound = opts.bound;
    this.estimate = opts.estimate;
    this.maxCostUsd = opts.maxCostUsd;
    this.costUsd = opts.costUsd;
  }
}
