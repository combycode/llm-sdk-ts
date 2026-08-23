/** Anthropic batch adapter — POST /v1/messages/batches with inline requests.
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import { buildFromSpec } from '../../../wire/interpreter';
import type { Registry } from '../../../wire/interpreter';
import { serviceSpec } from '../../../wire/service-specs';
import { makeRegistry } from '../../wire-transforms';
import type { EngineFetch, HttpRequest } from '../../../network/types';
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

  /** Batch rules need no adapter handles: the requests are mapped by the spec. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one batch request from its spec, then add the engine metadata.
   *  Every batch call is routed under the `batch` model name for queueing. */
  private fromSpec(
    specId: string,
    input: object,
    responseType: 'json' | 'text' = 'json',
  ): HttpRequest {
    const built = buildFromSpec(serviceSpec(specId), input as never, this.wireRegistry, 'anthropic', undefined, {
      baseURL: this.baseURL,
      apiKey: this.apiKey,
      apiVersion: ANTHROPIC_API_VERSION,
    }) as unknown as Record<string, unknown>;
    // `bodyKind: none` in a spec means the request carries no body at all. The
    // interpreter says so with `noBody`; the engine wants the field simply absent.
    const { noBody, body, ...rest } = built;
    return {
      ...rest,
      ...(noBody ? {} : { body }),
      provider: 'anthropic',
      model: 'batch',
      responseType,
    } as HttpRequest;
  }

  buildSubmitRequest(requests: BatchRequest[]): HttpRequest {
    return this.fromSpec('anthropic/batch.submit', { requests });
  }
  buildStatusRequest(batchId: string): HttpRequest {
    return this.fromSpec('anthropic/batch.getStatus', { batchId });
  }
  /** Results stream back as JSONL, so this one decodes as TEXT. Forcing `json`
   *  here would have broken every batch read — caught by the frozen corpus, not
   *  by any type. */
  buildResultsRequest(batchId: string): HttpRequest {
    return this.fromSpec('anthropic/batch.getResults', { batchId }, 'text');
  }
  buildCancelRequest(batchId: string): HttpRequest {
    return this.fromSpec('anthropic/batch.cancel', { batchId });
  }

  async submit(requests: BatchRequest[], fetch: EngineFetch): Promise<string> {
    const res = await fetch(this.buildSubmitRequest(requests));

    if (res.status >= 400)
      throw new Error(`Anthropic batch submit failed (${res.status}): ${JSON.stringify(res.body)}`);
    const data = (res.body as Record<string, unknown>) ?? {};
    return data.id as string;
  }

  async getStatus(batchId: string, fetch: EngineFetch): Promise<BatchStatus> {
    const res = await fetch(this.buildStatusRequest(batchId));
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
    const res = await fetch(this.buildResultsRequest(batchId));
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
    await fetch(this.buildCancelRequest(batchId));
  }
}
