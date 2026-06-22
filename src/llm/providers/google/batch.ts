/** Google batch adapter — inline batchGenerateContent.
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import type { EngineFetch } from '../../../network/types';
import type {
  BatchProviderAdapter,
  BatchRequest,
  BatchResult,
  BatchStatus,
} from '../../../plugins/batch/types';

export interface GoogleBatchAdapterConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

interface InlinedItem {
  response?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

/** Dig the inlined per-request responses out of a completed batch resource:
 *  metadata.output.inlinedResponses.inlinedResponses[]. */
function extractInlined(data: Record<string, unknown>): InlinedItem[] {
  const metadata = (data.metadata as Record<string, unknown>) ?? {};
  const output = (metadata.output as Record<string, unknown>) ?? {};
  const wrapper = (output.inlinedResponses as Record<string, unknown>) ?? {};
  return (wrapper.inlinedResponses as InlinedItem[]) ?? [];
}

export class GoogleBatchAdapter implements BatchProviderAdapter {
  readonly name = 'google';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;

  constructor(config: GoogleBatchAdapterConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-3.1-flash-lite-preview';
    this.baseURL = config.baseURL ?? 'https://generativelanguage.googleapis.com';
  }

  async submit(requests: BatchRequest[], fetch: EngineFetch): Promise<string> {
    // Gemini inline batch wire shape (from @google/genai): each request is
    // { request: <generateContent body>, metadata: { key } }, nested under
    // batch.inputConfig.requests.requests. (The old `{ requests: [...] }` was
    // rejected with "Unknown name 'requests'".)
    const inlinedRequests = requests.map((r) => ({
      request: r.body,
      metadata: { key: r.customId },
    }));

    const res = await fetch({
      url: `${this.baseURL}/v1beta/models/${this.model}:batchGenerateContent?key=${this.apiKey}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        batch: {
          displayName: `orxa-batch-${requests.length}`,
          inputConfig: { requests: { requests: inlinedRequests } },
        },
      },
      provider: 'google',
      model: this.model,
      responseType: 'json',
    });

    if (res.status >= 400)
      throw new Error(`Google batch submit failed (${res.status}): ${JSON.stringify(res.body)}`);
    const data = (res.body as Record<string, unknown>) ?? {};
    return (data.name as string) ?? (data.id as string) ?? crypto.randomUUID();
  }

  async getStatus(batchId: string, fetch: EngineFetch): Promise<BatchStatus> {
    const res = await fetch({
      url: `${this.baseURL}/v1beta/${batchId}?key=${this.apiKey}`,
      method: 'GET',
      headers: {},
      body: undefined,
      provider: 'google',
      model: this.model,
      responseType: 'json',
    });
    if (res.status >= 400)
      return { id: batchId, status: 'failed', total: 0, completed: 0, failed: 0, pending: 0 };

    const data = (res.body as Record<string, unknown>) ?? {};
    // The live batch resource keeps state under metadata.state (BATCH_STATE_*),
    // with `done:true` on completion. (Old code read top-level JOB_STATE_*.)
    const metadata = (data.metadata as Record<string, unknown>) ?? {};
    const state = (metadata.state as string) ?? '';

    const statusMap: Record<string, BatchStatus['status']> = {
      BATCH_STATE_PENDING: 'pending',
      BATCH_STATE_RUNNING: 'processing',
      BATCH_STATE_SUCCEEDED: 'completed',
      BATCH_STATE_FAILED: 'failed',
      BATCH_STATE_CANCELLED: 'cancelled',
      BATCH_STATE_EXPIRED: 'expired',
    };
    const status = data.done ? 'completed' : (statusMap[state] ?? 'pending');

    const inlined = extractInlined(data);
    const total = inlined.length;
    const failed = inlined.filter((r) => r.error || !r.response).length;
    const done = status === 'completed';
    return {
      id: batchId,
      status,
      total,
      completed: done ? total - failed : 0,
      failed: done ? failed : 0,
      pending: done ? 0 : total,
    };
  }

  async getResults(batchId: string, fetch: EngineFetch): Promise<BatchResult[]> {
    const res = await fetch({
      url: `${this.baseURL}/v1beta/${batchId}?key=${this.apiKey}`,
      method: 'GET',
      headers: {},
      body: undefined,
      provider: 'google',
      model: this.model,
      responseType: 'json',
    });
    if (res.status >= 400) return [];

    const data = (res.body as Record<string, unknown>) ?? {};
    // Results live at metadata.output.inlinedResponses.inlinedResponses[], each
    // { response: <generateContentResponse>, metadata: { key } } — the key is the
    // customId we set at submit, so correlation survives.
    return extractInlined(data).map((r, i) => ({
      customId: (r.metadata?.key as string | undefined) ?? `req_${i}`,
      success: !!r.response && !r.error,
      response: r.response ?? null,
      error: r.error ? JSON.stringify(r.error) : null,
    }));
  }

  async cancel(batchId: string, fetch: EngineFetch): Promise<void> {
    await fetch({
      url: `${this.baseURL}/v1beta/${batchId}:cancel?key=${this.apiKey}`,
      method: 'POST',
      headers: {},
      body: {},
      provider: 'google',
      model: this.model,
      responseType: 'json',
    });
  }
}
