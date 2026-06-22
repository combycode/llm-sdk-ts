/** batch() / submitBatch() / batchJob() — explicit batch processing.
 *
 *  A batch request is a deferred complete(): you describe each item the same way
 *  (prompt/system/maxTokens/…), the helper builds the per-provider body via that
 *  provider's adapter, submits one batch, and gives back a BatchJob handle.
 *
 *  Two modes off the SAME handle:
 *    - AUTO   : `await batch({...})` or `await job.wait()` — polls until done.
 *    - MANUAL : keep `job.id`, persist it, later `batchJob({id, provider})` →
 *               `job.status()` / `job.results()` (results() throws until complete).
 *
 *  Reuses the existing per-provider BatchProviderAdapters; all HTTP flows through
 *  engine.fetch (queue/retry/hooks). */

import { AnthropicAdapter } from '../llm/providers/anthropic/messages';
import { AnthropicBatchAdapter } from '../llm/providers/anthropic/batch';
import { GoogleAdapter } from '../llm/providers/google/generate';
import { GoogleBatchAdapter } from '../llm/providers/google/batch';
import { OpenAIBatchAdapter } from '../llm/providers/openai/batch';
import { OpenAIResponsesAdapter } from '../llm/providers/openai/responses';
import type { ContentPart, Message } from '../llm/types/messages';
import type { ProviderAdapter } from '../llm/types/provider';
import type { ProviderName } from '../llm/types/provider';
import type { NormalizedRequest } from '../llm/types/request';
import type { CompletionResponse } from '../llm/types/response';
import type { BatchProviderAdapter, BatchRequest, BatchStatus } from '../plugins/batch/types';
import type { HookBus } from '../bus/hook-bus';
import type { ModelCatalog } from '../plugins/model-catalog/catalog';
import { calculateCost, extractProviderCost } from '../plugins/cost-collector/cost-collector-internal';
import type { EngineFetch } from '../network/types';
import { resolveModel } from './client-resolver';
import { sleep } from '../util/async';
import type { EngineHandle } from './engine';
import { coreRegistry } from './engine';

/** Default poll cadence + ceiling (the provider batch window is ~24h). */
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const TERMINAL: ReadonlySet<BatchStatus['status']> = new Set([
  'completed',
  'failed',
  'expired',
  'cancelled',
]);

// ─── Public types ─────────────────────────────────────────────────────────

export interface BatchRequestInput {
  /** Correlation id. Defaults to `req-<index>` when omitted. */
  customId?: string;
  prompt: string | ContentPart[] | Message[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  structured?: { schema: Record<string, unknown>; name?: string };
}

export interface BatchItemResult {
  customId: string;
  success: boolean;
  /** Parsed reply text ('' when failed or empty). */
  text: string;
  /** Full normalized response (usage, finishReason, raw), or null on failure. */
  response: CompletionResponse | null;
  error: string | null;
}

export interface WaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onProgress?: (status: BatchStatus) => void;
}

export interface BatchJob {
  readonly id: string;
  readonly provider: ProviderName;
  /** Current provider-side status (manual progress check). */
  status(): Promise<BatchStatus>;
  /** Fetch results. Throws if the batch is not yet in a terminal state. */
  results(): Promise<BatchItemResult[]>;
  /** Poll until terminal, then return results (auto mode). */
  wait(opts?: WaitOptions): Promise<BatchItemResult[]>;
  cancel(): Promise<void>;
}

export interface SubmitBatchOptions {
  model: string;
  provider?: ProviderName;
  apiKey?: string;
  requests: BatchRequestInput[];
  engine?: EngineHandle;
}

export interface BatchJobRef {
  id: string;
  provider: ProviderName;
  apiKey?: string;
  engine?: EngineHandle;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Submit a batch; returns a handle immediately (no blocking). */
export async function submitBatch(opts: SubmitBatchOptions): Promise<BatchJob> {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider, model } = resolveModel(opts.model, opts.provider, 'batch');
  const apiKey = opts.apiKey ?? engine.apiKeys[provider];
  if (!apiKey) throw noKey('submitBatch', provider);

  const { batchAdapter, completion } = resolveWiring(provider, model, apiKey);

  const inputCustomIds: string[] = [];
  const requests: BatchRequest[] = opts.requests.map((req, i) => {
    const customId = req.customId ?? `req-${i}`;
    inputCustomIds.push(customId);
    const normalized: NormalizedRequest = {
      model,
      messages: toMessages(req.prompt),
      system: req.system,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      structured: req.structured,
    };
    return { customId, body: completion.buildRequest(normalized).body as Record<string, unknown> };
  });

  const id = await batchAdapter.submit(requests, engine.fetch);
  return new BatchJobImpl(
    id,
    provider,
    model,
    batchAdapter,
    completion,
    engine.fetch,
    engine.hooks,
    engine.catalog,
    inputCustomIds,
  );
}

/** Reconstruct a handle from a persisted id (resume — manual mode only). */
export function batchJob(ref: BatchJobRef): BatchJob {
  const engine = ref.engine ?? coreRegistry.get();
  const apiKey = ref.apiKey ?? engine.apiKeys[ref.provider];
  if (!apiKey) throw noKey('batchJob', ref.provider);
  const { batchAdapter, completion } = resolveWiring(ref.provider, '', apiKey);
  return new BatchJobImpl(
    ref.id,
    ref.provider,
    '',
    batchAdapter,
    completion,
    engine.fetch,
    engine.hooks,
    engine.catalog,
  );
}

/** One-shot auto mode: submit + wait + results. */
export async function batch(opts: SubmitBatchOptions & WaitOptions): Promise<BatchItemResult[]> {
  const job = await submitBatch(opts);
  return job.wait(opts);
}

// ─── Implementation ───────────────────────────────────────────────────────

class BatchJobImpl implements BatchJob {
  constructor(
    readonly id: string,
    readonly provider: ProviderName,
    private readonly model: string,
    private readonly batchAdapter: BatchProviderAdapter,
    private readonly completion: ProviderAdapter,
    private readonly fetch: EngineFetch,
    private readonly hooks: HookBus,
    private readonly catalog: ModelCatalog,
    /** Present only when submitted via submitBatch — lets us remap provider ids
     *  (notably Google, which keys results by index, not the supplied id). */
    private readonly inputCustomIds?: string[],
  ) {}

  status(): Promise<BatchStatus> {
    return this.batchAdapter.getStatus(this.id, this.fetch);
  }

  async results(): Promise<BatchItemResult[]> {
    const status = await this.status();
    if (!TERMINAL.has(status.status)) {
      throw new Error(`batch ${this.id} not complete (status: ${status.status})`);
    }
    return this.collect();
  }

  async wait(opts: WaitOptions = {}): Promise<BatchItemResult[]> {
    const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    for (;;) {
      const status = await this.status();
      opts.onProgress?.(status);
      if (TERMINAL.has(status.status)) break;
      if (Date.now() - start > timeout) {
        throw new Error(`batch ${this.id} timed out after ${timeout}ms (status: ${status.status})`);
      }
      await sleep(interval);
    }
    return this.collect();
  }

  cancel(): Promise<void> {
    return this.batchAdapter.cancel(this.id, this.fetch);
  }

  /** Fetch raw results, remap ids, parse each response into text + normalized form.
   *  Emits onCostEntry for each successfully-parsed result so the cost-collector
   *  accounts for batch completions (batch submissions are not individually billed
   *  at submit time; cost accrues when results are downloaded). */
  private async collect(): Promise<BatchItemResult[]> {
    const raw = await this.batchAdapter.getResults(this.id, this.fetch);
    return raw.map((r, i) => {
      // openai/anthropic preserve custom_id; google returns index ids — fall back
      // to the i-th submitted id (results come back in submission order).
      const customId = this.inputCustomIds
        ? this.inputCustomIds.includes(r.customId)
          ? r.customId
          : (this.inputCustomIds[i] ?? r.customId)
        : r.customId;

      let text = '';
      let response: CompletionResponse | null = null;
      if (r.success && r.response != null) {
        try {
          response = this.completion.parseResponse(r.response, 0);
          text = response.text;
        } catch {
          /* leave text empty — surfaced via success/response */
        }
        // Emit cost outside the parse try/catch so parse errors don't swallow
        // the hook; but only when parse succeeded (response is set).
        if (response != null) {
          this.emitBatchItemCost(response, customId);
        }
      }
      return { customId, success: r.success, text, response, error: r.error };
    });
  }

  /** Emit one onCostEntry for a successfully-parsed batch item. */
  private emitBatchItemCost(response: CompletionResponse, customId: string): void {
    const provider = this.provider;
    const model = response.model || this.model;
    const tokens = {
      input: response.usage.inputTokens,
      output: response.usage.outputTokens,
      cached: response.usage.cachedTokens,
      cacheWrite: response.usage.cacheWriteTokens,
      reasoning: response.usage.reasoningTokens,
      audioInput: response.usage.audioInputTokens ?? 0,
      audioOutput: response.usage.audioOutputTokens ?? 0,
    };
    const providerEvidence = extractProviderCost(provider, response.raw);
    const cost = calculateCost(
      this.catalog,
      provider,
      model,
      tokens,
      providerEvidence,
      response.usage.pricingTier,
    );
    const entry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      provider,
      model,
      tokens,
      cost,
      providerEvidence,
      tags: {
        provider,
        model,
        type: 'batch',
        batchId: this.id,
        customId,
      } as Record<string, string | undefined>,
    };
    this.hooks.emitSync('onCostEntry', { entry, runningTotal: 0 });
  }
}

interface Wiring {
  batchAdapter: BatchProviderAdapter;
  completion: ProviderAdapter;
}

function resolveWiring(provider: ProviderName, model: string, apiKey: string): Wiring {
  switch (provider) {
    case 'openai':
      // OpenAI batch runs against /v1/responses → build/parse with the Responses adapter.
      return {
        batchAdapter: new OpenAIBatchAdapter({ apiKey }),
        completion: new OpenAIResponsesAdapter({ apiKey }),
      };
    case 'anthropic':
      return {
        batchAdapter: new AnthropicBatchAdapter({ apiKey }),
        completion: new AnthropicAdapter({ apiKey }),
      };
    case 'google':
      return {
        batchAdapter: new GoogleBatchAdapter({ apiKey, model }),
        completion: new GoogleAdapter({ apiKey }),
      };
    default:
      throw new Error(
        `batch: no batch support for provider "${provider}" (supported: openai, anthropic, google).`,
      );
  }
}

function toMessages(prompt: string | ContentPart[] | Message[]): Message[] {
  if (typeof prompt === 'string') return [{ role: 'user', content: prompt }];
  if (prompt.length > 0 && 'role' in (prompt[0] as object)) return prompt as Message[];
  return [{ role: 'user', content: prompt as ContentPart[] }];
}

function noKey(fn: string, provider: string): Error {
  return new Error(
    `${fn}: no API key for provider "${provider}". Pass apiKey or set engine.apiKeys["${provider}"].`,
  );
}
