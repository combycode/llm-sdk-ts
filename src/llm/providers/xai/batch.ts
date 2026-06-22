/** xAI batch adapter — create batch, add requests, poll, get results.
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import type { EngineFetch } from '../../../network/types';
import type {
  BatchProviderAdapter,
  BatchRequest,
  BatchResult,
  BatchStatus,
} from '../../../plugins/batch/types';

export interface XAIBatchAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class XAIBatchAdapter implements BatchProviderAdapter {
  readonly name = 'xai';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: XAIBatchAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.x.ai';
  }

  private bearer(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async submit(requests: BatchRequest[], fetch: EngineFetch): Promise<string> {
    const createRes = await fetch({
      url: `${this.baseURL}/v1/batches`,
      method: 'POST',
      headers: { ...this.bearer(), 'content-type': 'application/json' },
      body: { name: `batch_${Date.now()}` },
      provider: 'xai',
      model: 'batch',
      responseType: 'json',
    });
    if (createRes.status >= 400)
      throw new Error(`xAI batch create failed: ${JSON.stringify(createRes.body)}`);
    const batch = (createRes.body as Record<string, unknown>) ?? {};
    const batchId = (batch.batch_id as string) ?? (batch.id as string);

    const batchRequests = requests.map((r) => ({
      batch_request_id: r.customId,
      batch_request: { endpoint: 'responses', body: r.body },
    }));

    const addRes = await fetch({
      url: `${this.baseURL}/v1/batches/${batchId}/requests`,
      method: 'POST',
      headers: { ...this.bearer(), 'content-type': 'application/json' },
      body: { batch_requests: batchRequests },
      provider: 'xai',
      model: 'batch',
      responseType: 'json',
    });
    if (addRes.status >= 400)
      throw new Error(`xAI batch add requests failed: ${JSON.stringify(addRes.body)}`);

    return batchId;
  }

  async getStatus(batchId: string, fetch: EngineFetch): Promise<BatchStatus> {
    const res = await fetch({
      url: `${this.baseURL}/v1/batches/${batchId}`,
      method: 'GET',
      headers: this.bearer(),
      body: undefined,
      provider: 'xai',
      model: 'batch',
      responseType: 'json',
    });
    if (res.status >= 400)
      return { id: batchId, status: 'failed', total: 0, completed: 0, failed: 0, pending: 0 };

    const data = (res.body as Record<string, unknown>) ?? {};
    const numPending = (data.num_pending as number) ?? 0;
    const numSuccess = (data.num_success as number) ?? 0;
    const numError = (data.num_error as number) ?? 0;
    const total = (data.num_requests as number) ?? numPending + numSuccess + numError;

    const status: BatchStatus['status'] =
      numPending === 0 && total > 0 ? (numError === total ? 'failed' : 'completed') : 'processing';

    return {
      id: batchId,
      status,
      total,
      completed: numSuccess,
      failed: numError,
      pending: numPending,
    };
  }

  async getResults(batchId: string, fetch: EngineFetch): Promise<BatchResult[]> {
    const res = await fetch({
      url: `${this.baseURL}/v1/batches/${batchId}/results`,
      method: 'GET',
      headers: this.bearer(),
      body: undefined,
      provider: 'xai',
      model: 'batch',
      responseType: 'json',
    });
    if (res.status >= 400) return [];

    const data = (res.body as Record<string, unknown>) ?? {};
    const results =
      (data.results as Array<Record<string, unknown>>) ??
      (data.data as Array<Record<string, unknown>>) ??
      [];

    return results.map((r) => ({
      customId: (r.batch_request_id as string) ?? (r.custom_id as string) ?? '',
      success: r.status === 'succeeded' || !!r.response,
      response: r.response ?? null,
      error: (r.error_message as string) ?? (r.error ? JSON.stringify(r.error) : null),
    }));
  }

  async cancel(batchId: string, fetch: EngineFetch): Promise<void> {
    await fetch({
      url: `${this.baseURL}/v1/batches/${batchId}/cancel`,
      method: 'POST',
      headers: this.bearer(),
      body: {},
      provider: 'xai',
      model: 'batch',
      responseType: 'json',
    });
  }
}
