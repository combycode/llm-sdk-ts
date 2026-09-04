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

export interface XAIBatchAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** One xAI result row, unwrapped.
 *
 *  The answer is nested and TAGGED, exactly as the request is: the row carries
 *  `batch_result.response.<variant>`, where the variant names the API that ran
 *  it (`chat_get_completion`, `responses`, `image_generation`, …). Reading
 *  `r.response` — which is what a flat shape suggests, and what this adapter
 *  did — finds nothing, so every answer came back as a failure with no error to
 *  explain it. Measured live 2026-09-04.
 *
 *  The variant is taken WHATEVER it is called rather than matched against a
 *  list: xAI has already added variants, and an unknown one is still an answer. */
function unwrapResult(row: Record<string, unknown>): {
  response: unknown;
  error: string | null;
} {
  const outer = (row.batch_result as Record<string, unknown>) ?? row;
  const rawError = row.error_message ?? row.error ?? outer.error ?? null;
  let response = outer.response as unknown;
  if (response && typeof response === 'object') {
    const values = Object.values(response as Record<string, unknown>);
    if (values.length === 1 && values[0] && typeof values[0] === 'object') response = values[0];
  }
  const error =
    rawError == null ? null : typeof rawError === 'string' ? rawError : JSON.stringify(rawError);
  return { response: response ?? null, error };
}

export class XAIBatchAdapter implements BatchProviderAdapter {
  readonly name = 'xai';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: XAIBatchAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.x.ai';
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
  buildCancelRequest(batchId: string): HttpRequest {
    return this.fromSpec('xai/batch.cancel', { batchId });
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
    // The counts live under `state`, NOT at the top level. Measured live
    // 2026-09-04: read from the top they are all zero, so `total` is 0, the
    // batch never looks finished, and a polling caller waits forever on a job
    // that completed in under a minute.
    const counts = (data.state as Record<string, number>) ?? {};
    const numPending = counts.num_pending ?? 0;
    const numSuccess = counts.num_success ?? 0;
    const numError = counts.num_error ?? 0;
    const numCancelled = counts.num_cancelled ?? 0;
    const total = counts.num_requests ?? numPending + numSuccess + numError + numCancelled;

    const settled: BatchStatus['status'] =
      numError === total ? 'failed' : numCancelled === total ? 'cancelled' : 'completed';
    const status: BatchStatus['status'] =
      numPending === 0 && total > 0 ? settled : 'processing';

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

    return results.map((r) => {
      const { response, error } = unwrapResult(r);
      return {
        customId: (r.batch_request_id as string) ?? (r.custom_id as string) ?? '',
        success: !!response && !error,
        response: response ?? null,
        error,
      };
    });
  }

  async cancel(batchId: string, fetch: EngineFetch): Promise<void> {
    await fetch(this.buildCancelRequest(batchId));
  }
}
