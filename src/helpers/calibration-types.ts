/** calibration-types.ts — types and constants for the adaptive output-token
 *  calibration layer used by Estimator.
 *
 *  All tuneable values live here as named constants (no magic numbers). */

// ─── Bucket boundaries ────────────────────────────────────────────────────────

/** Upper edges (exclusive) for input-token size buckets.
 *  E.g. edge 500 means the bucket covers [prev-edge, 500).
 *  The last bucket is open-ended: [32000, +inf). */
export const INPUT_SIZE_BUCKET_EDGES = [500, 2_000, 8_000, 32_000] as const;

/** Human-readable labels, one per bucket (including the final open bucket). */
export const INPUT_SIZE_BUCKET_LABELS = [
  '0-500',
  '500-2000',
  '2000-8000',
  '8000-32000',
  '32000+',
] as const;

export type InputBucketLabel = (typeof INPUT_SIZE_BUCKET_LABELS)[number];

// ─── EWMA tuning ─────────────────────────────────────────────────────────────

/** Smoothing factor for the exponentially weighted moving average of output
 *  tokens.  Higher = faster adaptation; lower = smoother, less noisy.
 *  Range: (0, 1). */
export const CALIBRATION_EWMA_ALPHA = 0.15;

// ─── p90 histogram tuning ─────────────────────────────────────────────────────

/** Number of fixed bins in the output-token histogram used to estimate p90.
 *  More bins = higher resolution but more memory per key.
 *  Each bin represents a contiguous token-count range of P90_BIN_WIDTH. */
export const P90_HISTOGRAM_BIN_COUNT = 32;

/** Width of each histogram bin in output tokens. */
export const P90_HISTOGRAM_BIN_WIDTH = 256;

/** The quantile to track as the "high" calibrated bound. */
export const CALIBRATION_HIGH_QUANTILE = 0.9;

// ─── Persistence key prefix ───────────────────────────────────────────────────

export const OUTPUT_CALIBRATION_KEY_PREFIX = 'output-calibration:';

// ─── Per-key calibration state (serializable) ─────────────────────────────────

/** Compact per-key running state stored in persistence. */
export interface OutputCalibrationEntry {
  /** Learning key: `provider/model#inputBucket` */
  key: string;
  /** EWMA-smoothed mean of observed output tokens. */
  ewmaMean: number;
  /** Fixed-count histogram of output token observations.
   *  Index i covers [i * P90_HISTOGRAM_BIN_WIDTH, (i+1) * P90_HISTOGRAM_BIN_WIDTH).
   *  The last bin is open-ended (captures all values >= (BIN_COUNT-1) * BIN_WIDTH). */
  histogram: number[];
  /** Total observations recorded. */
  count: number;
  /** Timestamp of the most recent update. */
  lastUpdated: number;
}

// ─── Calibration store config ─────────────────────────────────────────────────

export interface OutputCalibrationConfig {
  /** EWMA smoothing alpha; defaults to CALIBRATION_EWMA_ALPHA. */
  ewmaAlpha?: number;
}

// ─── Estimator options ────────────────────────────────────────────────────────

export interface CalibrationStoreConfig {
  /** 'file' persists to disk via FilePersistence. 'memory' is in-process only. */
  store: 'file' | 'memory';
  /** Required when store='file'. Directory for the FilePersistence JSON files. */
  path?: string;
}

export interface EstimatorOptions {
  /** When provided, enables adaptive calibration. Without this field the
   *  Estimator behaves identically to the static estimate() function. */
  calibration?: CalibrationStoreConfig;
}

// ─── Observation passed to the recorder ──────────────────────────────────────

export interface CalibrationObservation {
  /** Provider string, e.g. 'anthropic'. */
  provider: string;
  /** Model string, e.g. 'claude-haiku-4-5'. */
  model: string;
  /** Input-token count for this completion (used to map to bucket). */
  inputTokens: number;
  /** Actual output tokens observed. */
  outputTokens: number;
}
