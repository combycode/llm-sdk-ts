/** PersistenceCalibrationStore — EMA-backed persistence of token rates. */

import type { ContentClass } from '../../../agent/types';
import type { Persistence } from '../../persistence/types';
import type { CalibrationStore, CalibrationEntry, CalibrationConfig } from '../types';
import { CONTEXT_DEFAULTS } from '../types';

const KEY_PREFIX = 'calibration:';

function keyFor(provider: string, model: string, contentClass?: ContentClass): string {
  return `${KEY_PREFIX}${provider}/${model}${contentClass ? `:${contentClass}` : ''}`;
}

function prefixFor(opts?: { provider?: string; model?: string }): string {
  if (!opts?.provider) return KEY_PREFIX;
  if (!opts.model) return `${KEY_PREFIX}${opts.provider}/`;
  return `${KEY_PREFIX}${opts.provider}/${opts.model}`;
}

export class PersistenceCalibrationStore implements CalibrationStore {
  private config: CalibrationConfig;

  constructor(
    private readonly persistence: Persistence,
    config?: Partial<CalibrationConfig>,
  ) {
    this.config = { ...CONTEXT_DEFAULTS.calibration, ...config };
  }

  async get(
    provider: string,
    model: string,
    contentClass?: ContentClass,
  ): Promise<CalibrationEntry | null> {
    return this.persistence.get<CalibrationEntry>(keyFor(provider, model, contentClass));
  }

  async update(
    input: Omit<CalibrationEntry, 'lastUpdated' | 'confidence'>,
  ): Promise<CalibrationEntry> {
    const existing = await this.get(input.provider, input.model, input.contentClass);
    const alpha = this.config.emaAlpha;

    const newCharsPerToken = existing
      ? alpha * input.charsPerToken + (1 - alpha) * existing.charsPerToken
      : input.charsPerToken;

    const samples = (existing?.samples ?? 0) + input.samples;
    const confidence = Math.min(1, samples / this.config.minSamplesForConfidence);

    const entry: CalibrationEntry = {
      provider: input.provider,
      model: input.model,
      contentClass: input.contentClass,
      charsPerToken: newCharsPerToken,
      samples,
      confidence,
      lastUpdated: Date.now(),
    };

    await this.persistence.set(keyFor(input.provider, input.model, input.contentClass), entry);
    return entry;
  }

  async list(opts?: { provider?: string; model?: string }): Promise<CalibrationEntry[]> {
    const keys = await this.persistence.list(prefixFor(opts));
    const entries: CalibrationEntry[] = [];
    for (const k of keys) {
      const e = await this.persistence.get<CalibrationEntry>(k);
      if (e) entries.push(e);
    }
    return entries;
  }

  async reset(opts?: { provider?: string; model?: string }): Promise<void> {
    const keys = await this.persistence.list(prefixFor(opts));
    await Promise.all(keys.map((k) => this.persistence.delete(k)));
  }
}
