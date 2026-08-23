/** OpenAI batch adapter — upload JSONL file, create batch, poll, download results.
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

export interface OpenAIBatchAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class OpenAIBatchAdapter implements BatchProviderAdapter {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenAIBatchAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.openai.com';
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
      'openai',
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    ) as unknown as Record<string, unknown>;
    const { noBody, body, ...rest } = built;
    return {
      ...rest,
      ...(noBody ? {} : { body }),
      provider: 'openai',
      model: 'batch',
      responseType,
    } as HttpRequest;
  }

  buildStatusRequest(batchId: string): HttpRequest {
    return this.fromSpec('openai/batch.getStatus', { batchId });
  }
  buildCancelRequest(batchId: string): HttpRequest {
    return this.fromSpec('openai/batch.cancel', { batchId });
  }
  /** The SECOND call of the results flow: the output file is JSONL, so it decodes
   *  as text. The first call is buildStatusRequest, which yields the file id. */
  buildResultsFileRequest(fileId: string): HttpRequest {
    return this.fromSpec('openai/batch.getResults', { fileId }, 'text');
  }

  async submit(requests: BatchRequest[], fetch: EngineFetch): Promise<string> {
    const jsonl = requests
      .map((r) =>
        JSON.stringify({
          custom_id: r.customId,
          method: 'POST',
          url: '/v1/responses',
          body: r.body,
        }),
      )
      .join('\n');

    const form = new FormData();
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch_input.jsonl');
    form.append('purpose', 'batch');

    const uploadRes = await fetch({
      url: `${this.baseURL}/v1/files`,
      method: 'POST',
      headers: this.bearer(),
      body: form,
      rawBody: true,
      provider: 'openai',
      model: 'batch',
      responseType: 'json',
    });
    if (uploadRes.status >= 400)
      throw new Error(`OpenAI file upload failed: ${JSON.stringify(uploadRes.body)}`);
    const file = (uploadRes.body as Record<string, unknown>) ?? {};

    const batchRes = await fetch({
      url: `${this.baseURL}/v1/batches`,
      method: 'POST',
      headers: { ...this.bearer(), 'content-type': 'application/json' },
      body: {
        input_file_id: file.id,
        endpoint: '/v1/responses',
        completion_window: '24h',
      },
      provider: 'openai',
      model: 'batch',
      responseType: 'json',
    });
    if (batchRes.status >= 400)
      throw new Error(`OpenAI batch create failed: ${JSON.stringify(batchRes.body)}`);
    const batch = (batchRes.body as Record<string, unknown>) ?? {};
    return batch.id as string;
  }

  async getStatus(batchId: string, fetch: EngineFetch): Promise<BatchStatus> {
    const res = await fetch(this.buildStatusRequest(batchId));
    const data = (res.body as Record<string, unknown>) ?? {};
    const counts = (data.request_counts as Record<string, number>) ?? {};

    const statusMap: Record<string, BatchStatus['status']> = {
      validating: 'pending',
      in_progress: 'processing',
      finalizing: 'processing',
      completed: 'completed',
      failed: 'failed',
      expired: 'expired',
      cancelling: 'processing',
      cancelled: 'cancelled',
    };

    return {
      id: batchId,
      status: statusMap[data.status as string] ?? 'pending',
      total: counts.total ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      pending: (counts.total ?? 0) - (counts.completed ?? 0) - (counts.failed ?? 0),
    };
  }

  async getResults(batchId: string, fetch: EngineFetch): Promise<BatchResult[]> {
    const batchRes = await fetch(this.buildStatusRequest(batchId));
    const batch = (batchRes.body as Record<string, unknown>) ?? {};
    const outputFileId = batch.output_file_id as string;
    if (!outputFileId) return [];

    const fileRes = await fetch(this.buildResultsFileRequest(outputFileId));
    const text = (fileRes.body as string) ?? '';
    const lines = text
      .trim()
      .split('\n')
      .filter((l) => l.trim());

    return lines.map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const response = entry.response as Record<string, unknown> | null;
      return {
        customId: entry.custom_id as string,
        success: response?.status_code === 200,
        response: response?.body ?? null,
        error: entry.error ? JSON.stringify(entry.error) : null,
      };
    });
  }

  async cancel(batchId: string, fetch: EngineFetch): Promise<void> {
    await fetch(this.buildCancelRequest(batchId));
  }
}
