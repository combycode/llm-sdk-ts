/** ContextMeasurer plugin types — calibration shapes + measurer config. */

import type { ContentClass } from '../../agent/types';

// ─── Calibration ────────────────────────────────────────────────────────────

export interface CalibrationEntry {
  provider: string;
  model: string;
  contentClass?: ContentClass;
  charsPerToken: number;
  samples: number;
  confidence: number;
  lastUpdated: number;
}

export interface CalibrationStore {
  get(
    provider: string,
    model: string,
    contentClass?: ContentClass,
  ): Promise<CalibrationEntry | null>;
  update(entry: Omit<CalibrationEntry, 'lastUpdated' | 'confidence'>): Promise<CalibrationEntry>;
  list(opts?: { provider?: string; model?: string }): Promise<CalibrationEntry[]>;
  reset(opts?: { provider?: string; model?: string }): Promise<void>;
}

// ─── Measurer subsystem config ──────────────────────────────────────────────

export interface ContextThresholds {
  /** Percentage (0-1) at which to warn. Default 0.80. */
  warn: number;
  /** Percentage (0-1) at which to upgrade to exact measurement. Default 0.90. */
  exact: number;
}

export interface CalibrationConfig {
  /** EMA weight for new samples (0-1). Default 0.2. */
  emaAlpha: number;
  /** Samples needed to reach full confidence. Default 10. */
  minSamplesForConfidence: number;
}

export const CONTEXT_DEFAULTS = {
  thresholds: { warn: 0.8, exact: 0.9 } as ContextThresholds,
  calibration: { emaAlpha: 0.2, minSamplesForConfidence: 10 } as CalibrationConfig,
  charsPerTokenFallback: 4.0,
} as const;
