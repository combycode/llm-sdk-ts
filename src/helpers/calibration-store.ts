/** calibration-store.ts — per-key output-token running statistics.
 *
 *  Maintains an EWMA mean and a fixed-bin histogram for p90 estimation.
 *  State is serialized via the Persistence interface (FilePersistence or
 *  MemoryPersistence) so it survives process restarts when configured. */

import type { Persistence } from '../plugins/persistence/types';
import {
  CALIBRATION_EWMA_ALPHA,
  CALIBRATION_HIGH_QUANTILE,
  INPUT_SIZE_BUCKET_EDGES,
  type InputBucketLabel,
  INPUT_SIZE_BUCKET_LABELS,
  OUTPUT_CALIBRATION_KEY_PREFIX,
  P90_HISTOGRAM_BIN_COUNT,
  P90_HISTOGRAM_BIN_WIDTH,
  type CalibrationObservation,
  type OutputCalibrationConfig,
  type OutputCalibrationEntry,
} from './calibration-types';

// ─── Bucket helpers ───────────────────────────────────────────────────────────

/** Map an input-token count to its named bucket label. */
export function inputBucketLabel(inputTokens: number): InputBucketLabel {
  for (let i = 0; i < INPUT_SIZE_BUCKET_EDGES.length; i++) {
    if (inputTokens < INPUT_SIZE_BUCKET_EDGES[i]) {
      return INPUT_SIZE_BUCKET_LABELS[i];
    }
  }
  return INPUT_SIZE_BUCKET_LABELS[INPUT_SIZE_BUCKET_LABELS.length - 1];
}

/** Build the persistence key for a provider/model + bucket. */
export function calibrationKey(provider: string, model: string, bucket: InputBucketLabel): string {
  return `${OUTPUT_CALIBRATION_KEY_PREFIX}${provider}/${model}#${bucket}`;
}

// ─── Histogram helpers ────────────────────────────────────────────────────────

function emptyHistogram(): number[] {
  return Array.from({ length: P90_HISTOGRAM_BIN_COUNT }, () => 0);
}

function binIndex(outputTokens: number): number {
  const idx = Math.floor(outputTokens / P90_HISTOGRAM_BIN_WIDTH);
  return Math.min(idx, P90_HISTOGRAM_BIN_COUNT - 1);
}

/** Compute the p-th quantile (0-1) from a histogram. */
function histogramQuantile(histogram: number[], p: number): number {
  const total = histogram.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 0;
  const target = p * total;
  let cumulative = 0;
  for (let i = 0; i < histogram.length; i++) {
    cumulative += histogram[i];
    if (cumulative >= target) {
      // Return the midpoint of the bin (or the lower edge for the last bin).
      return (i + 0.5) * P90_HISTOGRAM_BIN_WIDTH;
    }
  }
  return (histogram.length - 0.5) * P90_HISTOGRAM_BIN_WIDTH;
}

// ─── OutputCalibrationStore ────────────────────────────────────────────────────

export class OutputCalibrationStore {
  private readonly persistence: Persistence;
  private readonly alpha: number;

  constructor(persistence: Persistence, config?: OutputCalibrationConfig) {
    this.persistence = persistence;
    this.alpha = config?.ewmaAlpha ?? CALIBRATION_EWMA_ALPHA;
  }

  /** Record one observed completion, updating EWMA mean and histogram. */
  async record(obs: CalibrationObservation): Promise<void> {
    const bucket = inputBucketLabel(obs.inputTokens);
    const key = calibrationKey(obs.provider, obs.model, bucket);
    const existing = await this.persistence.get<OutputCalibrationEntry>(key);

    const entry = existing
      ? this.updateEntry(existing, obs.outputTokens)
      : this.newEntry(key, obs.outputTokens);

    await this.persistence.set(key, entry);
  }

  /** Retrieve the calibration entry for a provider/model + input-token count.
   *  Returns null when no data exists for that key. */
  async get(
    provider: string,
    model: string,
    inputTokens: number,
  ): Promise<OutputCalibrationEntry | null> {
    const bucket = inputBucketLabel(inputTokens);
    const key = calibrationKey(provider, model, bucket);
    return this.persistence.get<OutputCalibrationEntry>(key);
  }

  /** Compute the p90 output-token estimate from a stored entry. */
  p90(entry: OutputCalibrationEntry): number {
    return histogramQuantile(entry.histogram, CALIBRATION_HIGH_QUANTILE);
  }

  /** List all stored keys (for testing/introspection). */
  async listKeys(): Promise<string[]> {
    return this.persistence.list(OUTPUT_CALIBRATION_KEY_PREFIX);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private newEntry(key: string, outputTokens: number): OutputCalibrationEntry {
    const histogram = emptyHistogram();
    histogram[binIndex(outputTokens)]++;
    return {
      key,
      ewmaMean: outputTokens,
      histogram,
      count: 1,
      lastUpdated: Date.now(),
    };
  }

  private updateEntry(
    existing: OutputCalibrationEntry,
    outputTokens: number,
  ): OutputCalibrationEntry {
    const ewmaMean = this.alpha * outputTokens + (1 - this.alpha) * existing.ewmaMean;

    const histogram = existing.histogram.length === P90_HISTOGRAM_BIN_COUNT
      ? [...existing.histogram]
      : emptyHistogram();
    histogram[binIndex(outputTokens)]++;

    return {
      key: existing.key,
      ewmaMean,
      histogram,
      count: existing.count + 1,
      lastUpdated: Date.now(),
    };
  }
}
