/** Default batch strategy. */

import type { BatchStrategy } from './types';

export class DefaultBatchStrategy implements BatchStrategy {
  collectionWindowMs: number;
  minBatchSize: number;
  maxBatchSize: number;
  pollIntervalMs: number;

  constructor(
    opts?: Partial<{
      collectionWindowMs: number;
      minBatchSize: number;
      maxBatchSize: number;
      pollIntervalMs: number;
    }>,
  ) {
    this.collectionWindowMs = opts?.collectionWindowMs ?? 10_000;
    this.minBatchSize = opts?.minBatchSize ?? 3;
    this.maxBatchSize = opts?.maxBatchSize ?? 50_000;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 30_000;
  }

  shouldBatch(ctx: {
    provider: string;
    markedRequestorsCount: number;
    pendingCount: number;
  }): boolean {
    return ctx.markedRequestorsCount >= this.minBatchSize;
  }

  estimateFirstPoll(batchSize: number): number {
    if (batchSize < 10) return 30_000;
    if (batchSize < 100) return 60_000;
    if (batchSize < 1000) return 300_000;
    return 600_000;
  }
}
