/** Batch types — strategy, provider adapter contract, pending job shape.
 *
 *  All BatchProviderAdapter HTTP calls flow through an injected EngineFetch
 *  (NetworkEngine queue) — adapters do not hold their own fetch fn. The
 *  Batcher class threads `engine.fetch` into adapter methods on every call,
 *  so rate-limit, retry, and observability hooks apply uniformly. */

import type { EngineFetch } from '../../network/types';

export interface BatchStrategy {
  collectionWindowMs: number;
  minBatchSize: number;
  maxBatchSize: number;
  shouldBatch(ctx: {
    provider: string;
    markedRequestorsCount: number;
    pendingCount: number;
  }): boolean;
  estimateFirstPoll(batchSize: number): number;
  pollIntervalMs: number;
}

export interface BatchProviderAdapter {
  readonly name: string;
  submit(requests: BatchRequest[], fetch: EngineFetch): Promise<string>;
  getStatus(batchId: string, fetch: EngineFetch): Promise<BatchStatus>;
  getResults(batchId: string, fetch: EngineFetch): Promise<BatchResult[]>;
  cancel(batchId: string, fetch: EngineFetch): Promise<void>;
}

export interface BatchRequest {
  customId: string;
  body: Record<string, unknown>;
}

export interface BatchStatus {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'expired' | 'cancelled';
  total: number;
  completed: number;
  failed: number;
  pending: number;
}

export interface BatchResult {
  customId: string;
  success: boolean;
  response: unknown | null;
  error: string | null;
}

export interface PendingBatchJob {
  batchId: string;
  provider: string;
  createdAt: number;
  requests: Array<{
    customId: string;
    conversationId: string;
    clientId: string;
  }>;
}
