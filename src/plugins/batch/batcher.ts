/** Batcher — transparent batch optimization layer.
 *  Intercepts batchable requests via onBeforeSubmit, collects into batches,
 *  polls via Scheduler, delivers results back through the intercepted Promise. */

import type { HookBus } from '../../bus/hook-bus';
import type { BeforeSubmitContext } from '../../bus/hook-map';
import type { EngineFetch } from '../../network/types';
import type { Persistence } from '../persistence/types';
import type { Scheduler } from '../scheduler/scheduler';
import type { BatchProviderAdapter, BatchRequest, BatchStrategy, PendingBatchJob } from './types';

interface CollectedRequest {
  customId: string;
  conversationId: string;
  clientId: string;
  provider: string;
  body: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export interface BatcherConfig {
  hooks: HookBus;
  persistence: Persistence;
  scheduler: Scheduler;
  strategy: BatchStrategy;
  providers: Map<string, BatchProviderAdapter>;
  /** Engine fetch — every adapter HTTP call dispatches through this so it
   *  inherits NetworkEngine queue semantics (rate limits, retry, hooks). */
  fetch: EngineFetch;
}

export class Batcher {
  private hooks: HookBus;
  private persistence: Persistence;
  private scheduler: Scheduler;
  private strategy: BatchStrategy;
  private providers: Map<string, BatchProviderAdapter>;
  private fetch: EngineFetch;

  /** Tracking requestors (agents + standalone LLMs) for shouldBatch decisions. */
  private requestors = new Map<string, { provider: string; batchable: boolean }>();

  /** Per-provider collection buffer with optional flush timer. */
  private collecting = new Map<
    string,
    { requests: CollectedRequest[]; timer: ReturnType<typeof setTimeout> | null }
  >();

  /** Resolvers awaiting batch results. Lost on restart — restored runs route
   *  results to conversations via hooks instead of resolving Promises. */
  private pendingResolvers = new Map<string, CollectedRequest[]>();

  private unsubs: Array<() => void> = [];

  constructor(config: BatcherConfig) {
    this.hooks = config.hooks;
    this.persistence = config.persistence;
    this.scheduler = config.scheduler;
    this.strategy = config.strategy;
    this.providers = config.providers;
    this.fetch = config.fetch;

    // Lifecycle hooks for requestor counting.
    this.unsubs.push(
      this.hooks.on('onClientCreate', (ctx) => {
        if (ctx.batchable) {
          this.requestors.set(`client:${ctx.clientId}`, {
            provider: ctx.provider,
            batchable: true,
          });
        }
      }),
      this.hooks.on('onClientDestroy', (ctx) => {
        this.requestors.delete(`client:${ctx.clientId}`);
      }),
      this.hooks.on('onAgentCreate', (ctx) => {
        if (ctx.batchable) {
          this.requestors.set(`agent:${ctx.agentId}`, {
            provider: ctx.provider,
            batchable: true,
          });
          this.requestors.delete(`client:${ctx.clientId}`);
        }
      }),
      this.hooks.on('onAgentDestroy', (ctx) => {
        this.requestors.delete(`agent:${ctx.agentId}`);
      }),
      this.hooks.on('onBeforeSubmit', (ctx) => {
        this.handleBeforeSubmit(ctx);
      }),
    );

    // Register poll task with scheduler.
    this.scheduler.register('batchPoll', (args) => this.poll(args.batchId as string));
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const c of this.collecting.values()) {
      if (c.timer) clearTimeout(c.timer);
    }
    this.collecting.clear();
  }

  /** Restore pending batches from persistence. Call on startup after scheduler.start(). */
  async restore(): Promise<void> {
    const keys = await this.persistence.list('batch:');
    for (const key of keys) {
      const job = await this.persistence.get<PendingBatchJob>(key);
      if (job) {
        await this.scheduler.after(5000, 'batchPoll', { batchId: job.batchId });
      }
    }
  }

  async poll(batchId: string): Promise<void> {
    const job = await this.persistence.get<PendingBatchJob>(`batch:${batchId}`);
    if (!job) return;

    const adapter = this.providers.get(job.provider);
    if (!adapter) return;

    const status = await adapter.getStatus(batchId, this.fetch);

    this.hooks.emitSync('onWarning', {
      source: 'plugin',
      code: 'batch_poll',
      message: `Batch ${batchId}: ${status.status} (${status.completed}/${status.total})`,
      details: { batchId, ...status },
    });

    if (
      status.status === 'completed' ||
      status.status === 'failed' ||
      status.status === 'expired'
    ) {
      await this.handleBatchComplete(job, adapter);
    } else {
      await this.scheduler.after(this.strategy.pollIntervalMs, 'batchPoll', { batchId });
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private handleBeforeSubmit(ctx: BeforeSubmitContext): void {
    if (!ctx.batchable || ctx.mode !== 'background') return;
    if (!this.providers.has(ctx.provider)) return;

    const markedCount = this.countBatchableRequestors(ctx.provider);
    if (
      !this.strategy.shouldBatch({
        provider: ctx.provider,
        markedRequestorsCount: markedCount,
        pendingCount: this.getPendingCount(ctx.provider),
      })
    ) {
      return;
    }

    ctx.intercepted = true;
    ctx.resultPromise = new Promise<unknown>((resolve, reject) => {
      this.addToCollection(ctx.provider, {
        customId: `req_${crypto.randomUUID().slice(0, 12)}`,
        conversationId: (ctx.ctx.conversationId as string) ?? '',
        clientId: ctx.clientId,
        provider: ctx.provider,
        body: ctx.request,
        resolve,
        reject,
      });
    });
  }

  private addToCollection(provider: string, request: CollectedRequest): void {
    let collection = this.collecting.get(provider);
    if (!collection) {
      collection = { requests: [], timer: null };
      this.collecting.set(provider, collection);
    }

    collection.requests.push(request);

    if (!collection.timer) {
      collection.timer = setTimeout(
        () => this.flushCollection(provider),
        this.strategy.collectionWindowMs,
      );
    }

    if (collection.requests.length >= this.strategy.maxBatchSize) {
      this.flushCollection(provider);
    }
  }

  private async flushCollection(provider: string): Promise<void> {
    const collection = this.collecting.get(provider);
    if (!collection || collection.requests.length === 0) return;

    if (collection.timer) {
      clearTimeout(collection.timer);
      collection.timer = null;
    }

    const requests = collection.requests.splice(0);
    this.collecting.delete(provider);

    const adapter = this.providers.get(provider);
    if (!adapter) {
      for (const req of requests) req.reject(new Error(`No batch adapter for ${provider}`));
      return;
    }

    const batchRequests: BatchRequest[] = requests.map((r) => ({
      customId: r.customId,
      body: r.body,
    }));

    try {
      const batchId = await adapter.submit(batchRequests, this.fetch);

      const job: PendingBatchJob = {
        batchId,
        provider,
        createdAt: Date.now(),
        requests: requests.map((r) => ({
          customId: r.customId,
          conversationId: r.conversationId,
          clientId: r.clientId,
        })),
      };
      await this.persistence.set(`batch:${batchId}`, job);
      this.pendingResolvers.set(batchId, requests);

      const firstPoll = this.strategy.estimateFirstPoll(requests.length);
      await this.scheduler.after(firstPoll, 'batchPoll', { batchId });

      this.hooks.emitSync('onWarning', {
        source: 'plugin',
        code: 'batch_created',
        message: `Batch ${batchId} created: ${requests.length} requests on ${provider}`,
        details: { batchId, provider, count: requests.length },
      });
    } catch (e) {
      for (const req of requests) req.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async handleBatchComplete(
    job: PendingBatchJob,
    adapter: BatchProviderAdapter,
  ): Promise<void> {
    const results = await adapter.getResults(job.batchId, this.fetch);
    const resolvers = this.pendingResolvers.get(job.batchId);

    for (const result of results) {
      if (resolvers) {
        const resolver = resolvers.find((r) => r.customId === result.customId);
        if (resolver) {
          if (result.success && result.response) {
            resolver.resolve(result.response);
          } else {
            resolver.reject(new Error(result.error ?? 'Batch request failed'));
          }
        }
      }

      this.hooks.emitSync('onWarning', {
        source: 'plugin',
        code: 'batch_result_ready',
        message: `Batch ${job.batchId} result for ${result.customId}: ${result.success ? 'OK' : 'FAIL'}`,
        details: {
          batchId: job.batchId,
          customId: result.customId,
          conversationId: job.requests.find((r) => r.customId === result.customId)?.conversationId,
          success: result.success,
        },
      });
    }

    this.pendingResolvers.delete(job.batchId);
    await this.persistence.delete(`batch:${job.batchId}`);
  }

  private countBatchableRequestors(provider: string): number {
    let count = 0;
    for (const [, info] of this.requestors) {
      if (info.provider === provider && info.batchable) count++;
    }
    return count;
  }

  private getPendingCount(provider: string): number {
    return this.collecting.get(provider)?.requests.length ?? 0;
  }
}
