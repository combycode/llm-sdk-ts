import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { BeforeSubmitContext } from '../../../../src/bus/hook-map';
import type { EngineFetch, HttpResponse } from '../../../../src/network/types';
import { Batcher } from '../../../../src/plugins/batch/batcher';
import { DefaultBatchStrategy } from '../../../../src/plugins/batch/strategy';
import type {
  BatchProviderAdapter,
  BatchRequest,
  BatchResult,
  BatchStatus,
  BatchStrategy,
  PendingBatchJob,
} from '../../../../src/plugins/batch/types';
import { MemoryPersistence } from '../../../../src/plugins/persistence/memory';
import { Scheduler } from '../../../../src/plugins/scheduler/scheduler';

/** Engine fetch stand-in. The Batcher never calls it itself — it threads it into
 *  every adapter method so batch HTTP inherits NetworkEngine queue semantics. */
const engineFetch: EngineFetch = async (): Promise<HttpResponse> => ({
  status: 200,
  headers: {},
  body: {},
});

/** Let queued microtasks + zero-delay timers drain. `flushCollection` is fired
 *  and not awaited by the synchronous onBeforeSubmit path, so tests must let it
 *  settle before asserting on persistence/scheduler state. */
function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Outcome {
  ok: boolean;
  value?: unknown;
  error?: Error;
}

/** Attach settle handlers immediately. Intercepted promises can settle during a
 *  later `await`, and an unhandled rejection fails the whole test file. */
function outcome(p: Promise<unknown> | undefined): Promise<Outcome> {
  return Promise.resolve(p).then(
    (value) => ({ ok: true, value }),
    (error: Error) => ({ ok: false, error }),
  );
}

interface FakeAdapter extends BatchProviderAdapter {
  /** marker (from request body) -> customId the Batcher minted for it. */
  idsByMarker: Map<string, string>;
  submitted: BatchRequest[];
  fetchesSeen: EngineFetch[];
  results: BatchResult[];
  status: BatchStatus;
  submitError: Error | null;
}

function makeAdapter(name = 'openai'): FakeAdapter {
  const a: FakeAdapter = {
    name,
    idsByMarker: new Map(),
    submitted: [],
    fetchesSeen: [],
    results: [],
    status: { id: 'b1', status: 'completed', total: 0, completed: 0, failed: 0, pending: 0 },
    submitError: null,
    async submit(requests, fetch) {
      a.fetchesSeen.push(fetch);
      if (a.submitError) throw a.submitError;
      a.submitted = requests;
      for (const r of requests) {
        a.idsByMarker.set(String(r.body.marker), r.customId);
      }
      return 'batch_1';
    },
    async getStatus(_batchId, fetch) {
      a.fetchesSeen.push(fetch);
      return a.status;
    },
    async getResults(_batchId, fetch) {
      a.fetchesSeen.push(fetch);
      return a.results;
    },
    async cancel(_batchId, fetch) {
      a.fetchesSeen.push(fetch);
    },
  };
  return a;
}

/** Strategy that records what the Batcher asked it, so requestor accounting is
 *  observable rather than inferred. */
class SpyStrategy implements BatchStrategy {
  collectionWindowMs: number;
  minBatchSize = 1;
  maxBatchSize: number;
  pollIntervalMs = 30_000;
  calls: Array<{ provider: string; markedRequestorsCount: number; pendingCount: number }> = [];
  verdict = true;
  firstPollMs = 1_000;
  estimateArgs: number[] = [];

  constructor(opts: { collectionWindowMs?: number; maxBatchSize?: number } = {}) {
    this.collectionWindowMs = opts.collectionWindowMs ?? 60_000;
    this.maxBatchSize = opts.maxBatchSize ?? 1_000;
  }

  shouldBatch(ctx: { provider: string; markedRequestorsCount: number; pendingCount: number }) {
    this.calls.push({ ...ctx });
    return this.verdict;
  }

  estimateFirstPoll(batchSize: number): number {
    this.estimateArgs.push(batchSize);
    return this.firstPollMs;
  }
}

interface Harness {
  hooks: HookBus;
  persistence: MemoryPersistence;
  scheduler: Scheduler;
  strategy: SpyStrategy;
  providers: Map<string, BatchProviderAdapter>;
  adapter: FakeAdapter;
  batcher: Batcher;
  warnings: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
}

function harness(opts: { collectionWindowMs?: number; maxBatchSize?: number } = {}): Harness {
  const hooks = new HookBus();
  const persistence = new MemoryPersistence();
  // Never started: `after()` persists the task but arms no timer, so polls are
  // driven explicitly by the test and asserted via `scheduler.pending()`.
  const scheduler = new Scheduler(persistence);
  const strategy = new SpyStrategy(opts);
  const adapter = makeAdapter();
  const providers = new Map<string, BatchProviderAdapter>([['openai', adapter]]);
  const warnings: Harness['warnings'] = [];
  hooks.on('onWarning', (c) => {
    warnings.push({ code: c.code, message: c.message, details: c.details });
  });
  const batcher = new Batcher({
    hooks,
    persistence,
    scheduler,
    strategy,
    providers,
    fetch: engineFetch,
  });
  return { hooks, persistence, scheduler, strategy, providers, adapter, batcher, warnings };
}

/** Emit onBeforeSubmit and return the context the Batcher may have mutated. */
function submit(
  hooks: HookBus,
  over: Partial<BeforeSubmitContext> & { marker?: string } = {},
): BeforeSubmitContext {
  const { marker, ...rest } = over;
  const ctx: BeforeSubmitContext = {
    provider: 'openai',
    model: 'gpt-4o',
    clientId: 'c1',
    mode: 'background',
    batchable: true,
    request: { marker: marker ?? 'm', model: 'gpt-4o' },
    ctx: {},
    ...rest,
  };
  hooks.emitSync('onBeforeSubmit', ctx);
  return ctx;
}

/** Record which timers get armed and which get cleared. A leaked collection
 *  timer has no other observable effect — it just pins the event loop open for
 *  the whole collection window — so the handles themselves are the assertion. */
function withTimerSpy<T>(fn: (t: { armed: unknown[]; cleared: unknown[] }) => T): T {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const armed: unknown[] = [];
  const cleared: unknown[] = [];
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const handle = realSet(handler, ms);
    armed.push(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(handle);
    return realClear(handle);
  }) as typeof clearTimeout;
  try {
    return fn({ armed, cleared });
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

function markBatchableClient(hooks: HookBus, clientId: string, provider = 'openai'): void {
  hooks.emitSync('onClientCreate', {
    clientId,
    provider,
    model: 'gpt-4o',
    mode: 'background',
    batchable: true,
  });
}

describe('Batcher', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  afterEach(() => {
    h.batcher.destroy();
  });

  // ─── Interception gate ────────────────────────────────────────────────

  describe('onBeforeSubmit interception', () => {
    it('intercepts a batchable background request and hands back a pending promise', () => {
      markBatchableClient(h.hooks, 'c1');
      const ctx = submit(h.hooks);
      expect(ctx.intercepted).toBe(true);
      expect(ctx.resultPromise).toBeInstanceOf(Promise);
    });

    it('leaves a non-batchable request alone', () => {
      markBatchableClient(h.hooks, 'c1');
      const ctx = submit(h.hooks, { batchable: false });
      expect(ctx.intercepted).toBeUndefined();
      expect(ctx.resultPromise).toBeUndefined();
    });

    it('leaves a foreground request alone — batching is a background-only trade', () => {
      markBatchableClient(h.hooks, 'c1');
      const ctx = submit(h.hooks, { mode: 'foreground' });
      expect(ctx.intercepted).toBeUndefined();
    });

    it('leaves a request alone when the provider has no batch adapter', () => {
      markBatchableClient(h.hooks, 'c1', 'anthropic');
      const ctx = submit(h.hooks, { provider: 'anthropic' });
      expect(ctx.intercepted).toBeUndefined();
      // Never even consulted the strategy — the adapter check comes first.
      expect(h.strategy.calls.length).toBe(0);
    });

    it('leaves a request alone when the strategy declines', () => {
      markBatchableClient(h.hooks, 'c1');
      h.strategy.verdict = false;
      const ctx = submit(h.hooks);
      expect(h.strategy.calls.length).toBe(1);
      expect(ctx.intercepted).toBeUndefined();
      expect(ctx.resultPromise).toBeUndefined();
    });

    it('stops intercepting after destroy()', () => {
      markBatchableClient(h.hooks, 'c1');
      h.batcher.destroy();
      const ctx = submit(h.hooks);
      expect(ctx.intercepted).toBeUndefined();
    });
  });

  // ─── Requestor accounting ─────────────────────────────────────────────

  describe('requestor accounting drives shouldBatch', () => {
    it('counts only batchable requestors on the matching provider', () => {
      markBatchableClient(h.hooks, 'c1');
      markBatchableClient(h.hooks, 'c2');
      markBatchableClient(h.hooks, 'other', 'anthropic');
      h.hooks.emitSync('onClientCreate', {
        clientId: 'c3',
        provider: 'openai',
        model: 'gpt-4o',
        mode: 'background',
        batchable: false,
      });

      submit(h.hooks);
      expect(h.strategy.calls[0].markedRequestorsCount).toBe(2);
      expect(h.strategy.calls[0].provider).toBe('openai');
    });

    it('onClientDestroy removes the client from the count', () => {
      markBatchableClient(h.hooks, 'c1');
      markBatchableClient(h.hooks, 'c2');
      h.hooks.emitSync('onClientDestroy', { clientId: 'c1', provider: 'openai', model: 'gpt-4o' });
      submit(h.hooks);
      expect(h.strategy.calls[0].markedRequestorsCount).toBe(1);
    });

    it('an agent supersedes its own client — the pair counts once, not twice', () => {
      markBatchableClient(h.hooks, 'c1');
      h.hooks.emitSync('onAgentCreate', {
        agentId: 'a1',
        clientId: 'c1',
        provider: 'openai',
        model: 'gpt-4o',
        mode: 'background',
        batchable: true,
      });
      submit(h.hooks);
      expect(h.strategy.calls[0].markedRequestorsCount).toBe(1);

      // And destroying the agent drops the count to zero — the superseded
      // client entry is gone, not merely shadowed.
      h.hooks.emitSync('onAgentDestroy', { agentId: 'a1', clientId: 'c1' });
      submit(h.hooks, { marker: 'm2' });
      expect(h.strategy.calls[1].markedRequestorsCount).toBe(0);
    });

    it('a non-batchable agent neither registers itself nor evicts its client', () => {
      markBatchableClient(h.hooks, 'c1');
      h.hooks.emitSync('onAgentCreate', {
        agentId: 'a1',
        clientId: 'c1',
        provider: 'openai',
        model: 'gpt-4o',
        mode: 'foreground',
        batchable: false,
      });
      submit(h.hooks);
      expect(h.strategy.calls[0].markedRequestorsCount).toBe(1);

      // Tearing that agent down must not take the client's count with it —
      // proof the client entry, not an agent entry, is what is being counted.
      h.hooks.emitSync('onAgentDestroy', { agentId: 'a1', clientId: 'c1' });
      submit(h.hooks, { marker: 'm2' });
      expect(h.strategy.calls[1].markedRequestorsCount).toBe(1);
    });

    it('reports how many requests are already buffered for the provider', () => {
      h = harness({ maxBatchSize: 99 });
      markBatchableClient(h.hooks, 'c1');
      submit(h.hooks, { marker: 'a' });
      submit(h.hooks, { marker: 'b' });
      submit(h.hooks, { marker: 'c' });
      expect(h.strategy.calls.map((c) => c.pendingCount)).toEqual([0, 1, 2]);
    });
  });

  // ─── Collection + submission ──────────────────────────────────────────

  describe('collection and submission', () => {
    it('flushes as soon as the buffer reaches maxBatchSize', async () => {
      h = harness({ maxBatchSize: 2 });
      markBatchableClient(h.hooks, 'c1');
      submit(h.hooks, { marker: 'a' });
      await tick();
      expect(h.adapter.submitted.length).toBe(0);

      submit(h.hooks, { marker: 'b' });
      await tick();
      expect(h.adapter.submitted.length).toBe(2);
      expect(h.adapter.submitted.map((r) => r.body.marker)).toEqual(['a', 'b']);
    });

    it('flushes on the collection window when the buffer never fills', async () => {
      h = harness({ collectionWindowMs: 0, maxBatchSize: 99 });
      markBatchableClient(h.hooks, 'c1');
      submit(h.hooks, { marker: 'a' });
      expect(h.adapter.submitted.length).toBe(0);
      await tick(5);
      expect(h.adapter.submitted.map((r) => r.body.marker)).toEqual(['a']);
    });

    it('mints a distinct customId per request and forwards the untouched body', async () => {
      h = harness({ maxBatchSize: 2 });
      markBatchableClient(h.hooks, 'c1');
      const bodyA = { marker: 'a', model: 'gpt-4o' };
      submit(h.hooks, { request: bodyA });
      submit(h.hooks, { marker: 'b' });
      await tick();

      const ids = h.adapter.submitted.map((r) => r.customId);
      expect(ids[0]).toMatch(/^req_/);
      expect(new Set(ids).size).toBe(2);
      expect(h.adapter.submitted[0].body).toBe(bodyA);
    });

    it('threads the injected engine fetch into every adapter call', async () => {
      h = harness({ maxBatchSize: 1 });
      markBatchableClient(h.hooks, 'c1');
      submit(h.hooks, { marker: 'a' });
      await tick();
      h.adapter.status = {
        id: 'b',
        status: 'completed',
        total: 1,
        completed: 1,
        failed: 0,
        pending: 0,
      };
      await h.batcher.poll('batch_1');
      expect(h.adapter.fetchesSeen.length).toBe(3); // submit, getStatus, getResults
      for (const f of h.adapter.fetchesSeen) expect(f).toBe(engineFetch);
    });

    it('persists the pending job with per-request routing info', async () => {
      h = harness({ maxBatchSize: 2 });
      markBatchableClient(h.hooks, 'c1');
      submit(h.hooks, { marker: 'a', clientId: 'cA', ctx: { conversationId: 'conv-A' } });
      submit(h.hooks, { marker: 'b', clientId: 'cB' });
      await tick();

      const job = await h.persistence.get<PendingBatchJob>('batch:batch_1');
      expect(job?.batchId).toBe('batch_1');
      expect(job?.provider).toBe('openai');
      expect(typeof job?.createdAt).toBe('number');
      expect(job?.requests.length).toBe(2);
      expect(job?.requests[0].clientId).toBe('cA');
      expect(job?.requests[0].conversationId).toBe('conv-A');
      // Missing conversationId is normalised to '' rather than left undefined.
      expect(job?.requests[1].clientId).toBe('cB');
      expect(job?.requests[1].conversationId).toBe('');
      expect(job?.requests[0].customId).toBe(h.adapter.submitted[0].customId);
    });

    it('schedules the first poll using the strategy estimate for the batch size', async () => {
      h = harness({ maxBatchSize: 2 });
      h.strategy.firstPollMs = 1234;
      markBatchableClient(h.hooks, 'c1');
      submit(h.hooks, { marker: 'a' });
      submit(h.hooks, { marker: 'b' });
      await tick();

      expect(h.strategy.estimateArgs).toEqual([2]);
      const pending = await h.scheduler.pending();
      const poll = pending.find((t) => t.name === 'batchPoll');
      expect(poll?.args.batchId).toBe('batch_1');
      expect(poll?.fireAt).toBeGreaterThan(Date.now() + 1000);
      expect(poll?.fireAt).toBeLessThanOrEqual(Date.now() + 1234);
    });

    it('announces the created batch on onWarning', async () => {
      h = harness({ maxBatchSize: 2 });
      markBatchableClient(h.hooks, 'c1');
      submit(h.hooks, { marker: 'a' });
      submit(h.hooks, { marker: 'b' });
      await tick();

      const created = h.warnings.find((w) => w.code === 'batch_created');
      expect(created?.message).toContain('batch_1');
      expect(created?.details).toMatchObject({
        batchId: 'batch_1',
        provider: 'openai',
        count: 2,
      });
    });

    it('rejects every caller when submit fails, with the adapter error', async () => {
      h = harness({ maxBatchSize: 2 });
      h.adapter.submitError = new Error('provider 429');
      markBatchableClient(h.hooks, 'c1');
      const a = outcome(submit(h.hooks, { marker: 'a' }).resultPromise);
      const b = outcome(submit(h.hooks, { marker: 'b' }).resultPromise);
      expect((await a).error?.message).toBe('provider 429');
      expect((await b).error?.message).toBe('provider 429');
      expect(await h.persistence.list('batch:')).toEqual([]);
    });

    it('wraps a non-Error submit throw so callers always get an Error', async () => {
      h = harness({ maxBatchSize: 1 });
      h.adapter.submit = async () => {
        throw 'string blow-up';
      };
      markBatchableClient(h.hooks, 'c1');
      const a = outcome(submit(h.hooks, { marker: 'a' }).resultPromise);
      const settled = await a;
      expect(settled.error).toBeInstanceOf(Error);
      expect(settled.error?.message).toBe('string blow-up');
    });

    it('rejects callers when the provider adapter vanished before the flush', async () => {
      h = harness({ collectionWindowMs: 0, maxBatchSize: 99 });
      markBatchableClient(h.hooks, 'c1');
      const a = outcome(submit(h.hooks, { marker: 'a' }).resultPromise);
      h.providers.delete('openai');
      expect((await a).error?.message).toBe('No batch adapter for openai');
    });

    it('destroy() releases the armed collection timer instead of leaking it', () => {
      // A 60s window: leaving this timer armed would hold the event loop open
      // long after the Batcher is gone.
      h = harness({ collectionWindowMs: 60_000, maxBatchSize: 99 });
      withTimerSpy(({ armed, cleared }) => {
        markBatchableClient(h.hooks, 'c1');
        submit(h.hooks, { marker: 'a' });
        expect(armed.length).toBe(1);
        expect(cleared.length).toBe(0);
        h.batcher.destroy();
        expect(cleared).toEqual(armed);
      });
    });

    it('a maxBatchSize flush releases the collection window timer it pre-empted', async () => {
      h = harness({ collectionWindowMs: 60_000, maxBatchSize: 2 });
      const spy = withTimerSpy(({ armed, cleared }) => {
        markBatchableClient(h.hooks, 'c1');
        submit(h.hooks, { marker: 'a' });
        expect(armed.length).toBe(1);
        submit(h.hooks, { marker: 'b' });
        return { armed: [...armed], cleared: [...cleared] };
      });
      expect(spy.cleared).toEqual(spy.armed);
      await tick();
      expect(h.adapter.submitted.length).toBe(2);
    });

    it('destroy() clears an armed collection timer so it cannot flush later', async () => {
      h = harness({ collectionWindowMs: 0, maxBatchSize: 99 });
      markBatchableClient(h.hooks, 'c1');
      submit(h.hooks, { marker: 'a' });
      h.batcher.destroy();
      await tick(5);
      expect(h.adapter.submitted.length).toBe(0);
    });
  });

  // ─── Polling ──────────────────────────────────────────────────────────

  describe('poll', () => {
    async function submitOne(marker = 'a'): Promise<BeforeSubmitContext> {
      markBatchableClient(h.hooks, 'c1');
      const ctx = submit(h.hooks, { marker });
      await tick();
      return ctx;
    }

    beforeEach(() => {
      h = harness({ maxBatchSize: 1 });
    });

    it('is a no-op for an unknown batch id', async () => {
      await h.batcher.poll('nope');
      expect(h.warnings.length).toBe(0);
    });

    it('is a no-op when the job names a provider with no adapter', async () => {
      await h.persistence.set<PendingBatchJob>('batch:orphan', {
        batchId: 'orphan',
        provider: 'gone',
        createdAt: 1,
        requests: [],
      });
      await h.batcher.poll('orphan');
      expect(h.warnings.length).toBe(0);
      // The job is left in place — a later adapter registration can pick it up.
      expect(await h.persistence.has('batch:orphan')).toBe(true);
    });

    it('reports progress and reschedules itself while the batch is still running', async () => {
      await submitOne();
      h.adapter.status = {
        id: 'batch_1',
        status: 'processing',
        total: 4,
        completed: 1,
        failed: 0,
        pending: 3,
      };
      h.strategy.pollIntervalMs = 4321;
      const before = await h.scheduler.pending();
      await h.batcher.poll('batch_1');

      const poll = h.warnings.find((w) => w.code === 'batch_poll');
      expect(poll?.message).toBe('Batch batch_1: processing (1/4)');
      expect(poll?.details).toMatchObject({ batchId: 'batch_1', status: 'processing', total: 4 });

      const after = await h.scheduler.pending();
      expect(after.length).toBe(before.length + 1);
      const next = after.filter((t) => !before.some((b) => b.id === t.id))[0];
      expect(next.name).toBe('batchPoll');
      expect(next.fireAt).toBeGreaterThan(Date.now() + 4000);
      // Still open: results were not fetched and the job stays persisted.
      expect(await h.persistence.has('batch:batch_1')).toBe(true);
    });

    it.each([
      'completed',
      'failed',
      'expired',
    ] as const)('settles the batch on terminal status %s', async (status) => {
      h = harness({ maxBatchSize: 1 });
      const out = outcome((await submitOne()).resultPromise);
      const customId = h.adapter.submitted[0].customId;
      h.adapter.status = { id: 'batch_1', status, total: 1, completed: 1, failed: 0, pending: 0 };
      h.adapter.results = [{ customId, success: true, response: { ok: status }, error: null }];

      await h.batcher.poll('batch_1');
      expect(await out).toEqual({ ok: true, value: { ok: status } });
      expect(await h.persistence.has('batch:batch_1')).toBe(false);
    });

    it('does not settle the batch on a non-terminal status', async () => {
      await submitOne();
      h.adapter.status = {
        id: 'batch_1',
        status: 'pending',
        total: 1,
        completed: 0,
        failed: 0,
        pending: 1,
      };
      await h.batcher.poll('batch_1');
      expect(h.adapter.results.length).toBe(0);
      expect(h.warnings.some((w) => w.code === 'batch_result_ready')).toBe(false);
      expect(await h.persistence.has('batch:batch_1')).toBe(true);
    });
  });

  // ─── Result routing — the correctness core ────────────────────────────

  describe('result routing', () => {
    /** Collect N intercepted requests into one batch, keyed by a marker in the
     *  body so the test can map marker -> minted customId. */
    async function collect(markers: string[]): Promise<Array<Promise<Outcome>>> {
      h = harness({ maxBatchSize: markers.length });
      markBatchableClient(h.hooks, 'c1');
      const outs = markers.map((m, i) =>
        outcome(
          submit(h.hooks, { marker: m, clientId: `c${i}`, ctx: { conversationId: `conv-${m}` } })
            .resultPromise,
        ),
      );
      await tick();
      expect(h.adapter.submitted.length).toBe(markers.length);
      return outs;
    }

    it('pairs each result with its own caller by customId, not by position', async () => {
      const [a, b, c] = await collect(['a', 'b', 'c']);
      // The provider returns results in a DIFFERENT order from submission —
      // real batch APIs make no ordering promise. Correlating by array index
      // here would hand caller "a" the answer meant for caller "c".
      h.adapter.results = [
        {
          customId: h.adapter.idsByMarker.get('c')!,
          success: true,
          response: 'for-c',
          error: null,
        },
        {
          customId: h.adapter.idsByMarker.get('a')!,
          success: true,
          response: 'for-a',
          error: null,
        },
        {
          customId: h.adapter.idsByMarker.get('b')!,
          success: true,
          response: 'for-b',
          error: null,
        },
      ];
      h.adapter.status = {
        id: 'batch_1',
        status: 'completed',
        total: 3,
        completed: 3,
        failed: 0,
        pending: 0,
      };

      await h.batcher.poll('batch_1');
      expect(await a).toEqual({ ok: true, value: 'for-a' });
      expect(await b).toEqual({ ok: true, value: 'for-b' });
      expect(await c).toEqual({ ok: true, value: 'for-c' });
    });

    it('routes a per-request failure to that caller alone', async () => {
      const [a, b] = await collect(['a', 'b']);
      h.adapter.results = [
        {
          customId: h.adapter.idsByMarker.get('b')!,
          success: false,
          response: null,
          error: 'content_filter',
        },
        {
          customId: h.adapter.idsByMarker.get('a')!,
          success: true,
          response: 'for-a',
          error: null,
        },
      ];
      h.adapter.status = {
        id: 'batch_1',
        status: 'completed',
        total: 2,
        completed: 1,
        failed: 1,
        pending: 0,
      };

      await h.batcher.poll('batch_1');
      expect(await a).toEqual({ ok: true, value: 'for-a' });
      expect((await b).ok).toBe(false);
      expect((await b).error?.message).toBe('content_filter');
    });

    it('rejects with a default message when a failed result carries no error text', async () => {
      const [a] = await collect(['a']);
      h.adapter.results = [
        { customId: h.adapter.idsByMarker.get('a')!, success: false, response: null, error: null },
      ];
      h.adapter.status = {
        id: 'batch_1',
        status: 'completed',
        total: 1,
        completed: 0,
        failed: 1,
        pending: 0,
      };
      await h.batcher.poll('batch_1');
      expect((await a).error?.message).toBe('Batch request failed');
    });

    it('treats success with a null response as a failure rather than resolving null', async () => {
      const [a] = await collect(['a']);
      h.adapter.results = [
        { customId: h.adapter.idsByMarker.get('a')!, success: true, response: null, error: null },
      ];
      h.adapter.status = {
        id: 'batch_1',
        status: 'completed',
        total: 1,
        completed: 1,
        failed: 0,
        pending: 0,
      };
      await h.batcher.poll('batch_1');
      expect((await a).error?.message).toBe('Batch request failed');
    });

    it('emits batch_result_ready carrying the conversation the result belongs to', async () => {
      const [a, b] = await collect(['a', 'b']);
      h.adapter.results = [
        {
          customId: h.adapter.idsByMarker.get('b')!,
          success: true,
          response: 'for-b',
          error: null,
        },
        {
          customId: h.adapter.idsByMarker.get('a')!,
          success: false,
          response: null,
          error: 'boom',
        },
      ];
      h.adapter.status = {
        id: 'batch_1',
        status: 'completed',
        total: 2,
        completed: 1,
        failed: 1,
        pending: 0,
      };
      await h.batcher.poll('batch_1');

      const ready = h.warnings.filter((w) => w.code === 'batch_result_ready');
      expect(ready.length).toBe(2);
      expect(ready[0].details).toMatchObject({
        batchId: 'batch_1',
        customId: h.adapter.idsByMarker.get('b'),
        conversationId: 'conv-b',
        success: true,
      });
      expect(ready[0].message).toContain('OK');
      expect(ready[1].details).toMatchObject({
        customId: h.adapter.idsByMarker.get('a'),
        conversationId: 'conv-a',
        success: false,
      });
      expect(ready[1].message).toContain('FAIL');
      expect((await a).error?.message).toBe('boom');
      expect((await b).value).toBe('for-b');
    });

    it('drops a result whose customId matches no caller instead of mis-delivering it', async () => {
      const [a] = await collect(['a']);
      h.adapter.results = [
        { customId: 'req_not_ours', success: true, response: 'stranger', error: null },
        {
          customId: h.adapter.idsByMarker.get('a')!,
          success: true,
          response: 'for-a',
          error: null,
        },
      ];
      h.adapter.status = {
        id: 'batch_1',
        status: 'completed',
        total: 2,
        completed: 2,
        failed: 0,
        pending: 0,
      };
      await h.batcher.poll('batch_1');
      expect(await a).toEqual({ ok: true, value: 'for-a' });
      // Still announced, so a restored/routed consumer can see it.
      expect(h.warnings.filter((w) => w.code === 'batch_result_ready').length).toBe(2);
    });

    it('still announces results when no in-process resolvers exist (restored run)', async () => {
      // A job planted directly in persistence has no live Promise to settle —
      // the hook is the only delivery channel after a restart.
      await h.persistence.set<PendingBatchJob>('batch:batch_1', {
        batchId: 'batch_1',
        provider: 'openai',
        createdAt: 1,
        requests: [{ customId: 'req_x', conversationId: 'conv-x', clientId: 'c9' }],
      });
      h.adapter.status = {
        id: 'batch_1',
        status: 'completed',
        total: 1,
        completed: 1,
        failed: 0,
        pending: 0,
      };
      h.adapter.results = [{ customId: 'req_x', success: true, response: 'v', error: null }];

      await h.batcher.poll('batch_1');
      const ready = h.warnings.filter((w) => w.code === 'batch_result_ready');
      expect(ready.length).toBe(1);
      expect(ready[0].details?.conversationId).toBe('conv-x');
      expect(await h.persistence.has('batch:batch_1')).toBe(false);
    });
  });

  // ─── Restore ──────────────────────────────────────────────────────────

  describe('restore', () => {
    it('re-arms a poll for every persisted batch and leaves unrelated keys alone', async () => {
      await h.persistence.set<PendingBatchJob>('batch:b1', {
        batchId: 'b1',
        provider: 'openai',
        createdAt: 1,
        requests: [],
      });
      await h.persistence.set<PendingBatchJob>('batch:b2', {
        batchId: 'b2',
        provider: 'openai',
        createdAt: 1,
        requests: [],
      });
      await h.persistence.set('other:x', { keep: true });

      await h.batcher.restore();
      const polls = (await h.scheduler.pending()).filter((t) => t.name === 'batchPoll');
      expect(polls.map((t) => t.args.batchId).sort()).toEqual(['b1', 'b2']);
      for (const t of polls) {
        expect(t.fireAt).toBeGreaterThan(Date.now() + 4000);
        expect(t.fireAt).toBeLessThanOrEqual(Date.now() + 5000);
      }
    });

    it('skips a batch key whose value is missing', async () => {
      await h.persistence.set<PendingBatchJob | null>('batch:ghost', null);
      await h.batcher.restore();
      expect((await h.scheduler.pending()).filter((t) => t.name === 'batchPoll').length).toBe(0);
    });

    it('restores nothing when persistence holds no batches', async () => {
      await h.batcher.restore();
      expect(await h.scheduler.pending()).toEqual([]);
    });
  });

  // ─── Wiring ───────────────────────────────────────────────────────────

  describe('scheduler wiring', () => {
    it('registers the batchPoll task so a fired timer polls that batch', async () => {
      const persistence = new MemoryPersistence();
      const scheduler = new Scheduler(persistence);
      const adapter = makeAdapter();
      const b = new Batcher({
        hooks: new HookBus(),
        persistence,
        scheduler,
        strategy: new DefaultBatchStrategy(),
        providers: new Map([['openai', adapter]]),
        fetch: engineFetch,
      });
      await persistence.set<PendingBatchJob>('batch:live', {
        batchId: 'live',
        provider: 'openai',
        createdAt: 1,
        requests: [{ customId: 'req_1', conversationId: '', clientId: 'c1' }],
      });
      adapter.status = {
        id: 'live',
        status: 'completed',
        total: 1,
        completed: 1,
        failed: 0,
        pending: 0,
      };
      adapter.results = [{ customId: 'req_1', success: true, response: 'v', error: null }];

      await scheduler.start();
      await scheduler.after(0, 'batchPoll', { batchId: 'live' });
      await tick(20);
      scheduler.stop();
      b.destroy();

      expect(adapter.fetchesSeen.length).toBe(2); // getStatus + getResults
      expect(await persistence.has('batch:live')).toBe(false);
    });

    it('destroy() is idempotent', () => {
      h.batcher.destroy();
      expect(() => h.batcher.destroy()).not.toThrow();
    });
  });
});
