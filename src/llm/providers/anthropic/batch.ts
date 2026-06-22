/** Anthropic batch adapter — POST /v1/messages/batches with inline requests.
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import { isBrowser } from '../../../runtime/runtime';
import type { EngineFetch } from '../../../network/types';
import type {
  BatchProviderAdapter,
  BatchRequest,
  BatchResult,
  BatchStatus,
} from '../../../plugins/batch/types';
import { ANTHROPIC_API_VERSION } from './constants';

export interface AnthropicBatchAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicBatchAdapter implements BatchProviderAdapter {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: AnthropicBatchAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.anthropic.com';
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
    };
    if (isBrowser()) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return headers;
  }

  async submit(requests: BatchRequest[], fetch: EngineFetch): Promise<string> {
    const body = {
      requests: requests.map((r) => ({
        custom_id: r.customId,
        params: r.body,
      })),
    };

    const res = await fetch({
      url: `${this.baseURL}/v1/messages/batches`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'anthropic',
      model: 'batch',
      responseType: 'json',
    });

    if (res.status >= 400)
      throw new Error(`Anthropic batch submit failed (${res.status}): ${JSON.stringify(res.body)}`);
    const data = (res.body as Record<string, unknown>) ?? {};
    return data.id as string;
  }

  async getStatus(batchId: string, fetch: EngineFetch): Promise<BatchStatus> {
    const res = await fetch({
      url: `${this.baseURL}/v1/messages/batches/${batchId}`,
      method: 'GET',
      headers: this.authHeaders(),
      body: undefined,
      provider: 'anthropic',
      model: 'batch',
      responseType: 'json',
    });
    const data = (res.body as Record<string, unknown>) ?? {};
    const counts = (data.request_counts as Record<string, number>) ?? {};

    const statusMap: Record<string, BatchStatus['status']> = {
      in_progress: 'processing',
      ended: 'completed',
      canceling: 'processing',
      expired: 'expired',
    };

    return {
      id: batchId,
      status: statusMap[data.processing_status as string] ?? 'pending',
      total:
        (counts.processing ?? 0) +
        (counts.succeeded ?? 0) +
        (counts.errored ?? 0) +
        (counts.canceled ?? 0) +
        (counts.expired ?? 0),
      completed: counts.succeeded ?? 0,
      failed: (counts.errored ?? 0) + (counts.expired ?? 0),
      pending: counts.processing ?? 0,
    };
  }

  async getResults(batchId: string, fetch: EngineFetch): Promise<BatchResult[]> {
    const res = await fetch({
      url: `${this.baseURL}/v1/messages/batches/${batchId}/results`,
      method: 'GET',
      headers: this.authHeaders(),
      body: undefined,
      provider: 'anthropic',
      model: 'batch',
      responseType: 'text',
    });
    const text = (res.body as string) ?? '';
    const lines = text
      .trim()
      .split('\n')
      .filter((l) => l.trim());

    return lines.map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const result = entry.result as Record<string, unknown>;
      return {
        customId: entry.custom_id as string,
        success: result?.type === 'succeeded',
        response: result?.type === 'succeeded' ? (result.message ?? null) : null,
        error: result?.type !== 'succeeded' ? JSON.stringify(result) : null,
      };
    });
  }

  async cancel(batchId: string, fetch: EngineFetch): Promise<void> {
    await fetch({
      url: `${this.baseURL}/v1/messages/batches/${batchId}/cancel`,
      method: 'POST',
      headers: this.authHeaders(),
      body: {},
      provider: 'anthropic',
      model: 'batch',
      responseType: 'json',
    });
  }
}
