/** xAI batch adapter — create batch, add requests, poll, get results.
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
import { fnv1a32Hex } from '../../../util/hash';

export interface XAIBatchAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** Name the batch from its CONTENTS, never from a clock.
 *
 *  This used to be `batch_${Date.now()}`, which made the request the only one in
 *  the provider surface that was not a pure function of its input: it could not
 *  be asserted in a test or reproduced from a log, and a retried create produced
 *  a second, differently-named batch that nothing could deduplicate.
 *
 *  Deriving it from the custom ids keeps identical submissions identical, so a
 *  retry is idempotent from the caller's point of view, while two different
 *  batches still get different names. */
function _batchName(requests: BatchRequest[]): string {
  const digest = fnv1a32Hex(requests.map((r) => r.customId).join('\u0000'));
  return `batch_${requests.length}_${digest}`;
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

  /** Batch rules need no adapter handles: the request list is mapped by the spec. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one batch request from its spec, then add the engine metadata.
   *
   *  `bodyKind: none` in a spec means no body at all: the interpreter reports that
   *  as `noBody`, and the engine wants the field simply absent. */
  private fromSpec(
    specId: string,
    input: object,
    responseType: 'json' | 'text' = 'json',
  ): HttpRequest {
    const built = buildFromSpec(
      serviceSpec(specId),
      input as never,
      this.wireRegistry,
      'xai',
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    ) as unknown as Record<string, unknown>;
    const { noBody, body, ...rest } = built;
    return {
      ...rest,
      ...(noBody ? {} : { body }),
      provider: 'xai',
      model: 'batch',
      responseType,
    } as HttpRequest;
  }

  buildCreateRequest(requests: BatchRequest[]): HttpRequest {
    return this.fromSpec('xai/batch.create', { requests });
  }
  buildAddRequestsRequest(batchId: string, requests: BatchRequest[]): HttpRequest {
    return this.fromSpec('xai/batch.addRequests', { batchId, requests });
  }
  buildStatusRequest(batchId: string): HttpRequest {
    return this.fromSpec('xai/batch.getStatus', { batchId });
  }
  buildResultsRequest(batchId: string): HttpRequest {
    return this.fromSpec('xai/batch.getResults', { batchId });
  }

  async submit(requests: BatchRequest[], fetch: EngineFetch): Promise<string> {
    const createRes = await fetch(this.buildCreateRequest(requests));
    if (createRes.status >= 400)
      throw new Error(`xAI batch create failed: ${JSON.stringify(createRes.body)}`);
    const batch = (createRes.body as Record<string, unknown>) ?? {};
    const batchId = (batch.batch_id as string) ?? (batch.id as string);

    const _batchRequests = requests.map((r) => ({
      batch_request_id: r.customId,
      batch_request: { endpoint: 'responses', body: r.body },
    }));

    const addRes = await fetch(this.buildAddRequestsRequest(batchId, requests));
    if (addRes.status >= 400)
      throw new Error(`xAI batch add requests failed: ${JSON.stringify(addRes.body)}`);

    return batchId;
  }

  async getStatus(batchId: string, fetch: EngineFetch): Promise<BatchStatus> {
    const res = await fetch(this.buildStatusRequest(batchId));
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
    const res = await fetch(this.buildResultsRequest(batchId));
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
