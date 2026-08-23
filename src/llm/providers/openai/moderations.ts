/** OpenAI moderations adapter -- POST /v1/moderations.
 *  Supports text and image+text content-part input as described in
 *  https://platform.openai.com/docs/api-reference/moderations/create
 *  All HTTP flows through the injected EngineFetch. */

import { buildFromSpec } from '../../../wire/interpreter';
import type { Registry } from '../../../wire/interpreter';
import { serviceSpec } from '../../../wire/service-specs';
import { makeRegistry } from '../../wire-transforms';
import type { EngineFetch, HttpRequest } from '../../../network/types';
import type {
  ModerationCategories,
  ModerationContentPart,
  ModerationRawResult,
  ModerationRawResponse,
  ModerationResult,
  ModerationScores,
} from '../../../helpers/moderate-types';

export interface OpenAIModerationAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export const OPENAI_MODERATION_BASE_URL = 'https://api.openai.com';
export const OPENAI_MODERATION_PATH = '/v1/moderations';
export const OPENAI_MODERATION_DEFAULT_MODEL = 'omni-moderation-latest';

export class OpenAIModerationAdapter {
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenAIModerationAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? OPENAI_MODERATION_BASE_URL;
  }

  /** Named code these specs need. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one request from its spec, then add the engine metadata.
   *
   *  `bodyKind: none` arrives as `noBody` and `raw` as `rawBody`; the engine wants
   *  the body field absent in the first case and the caller's bytes in the second. */
  private fromSpec(
    specId: string,
    input: object,
    model: string,
    responseType: 'json' | 'text' | 'arraybuffer' = 'json',
    rawBytes?: unknown,
  ): HttpRequest {
    const built = buildFromSpec(serviceSpec(specId), input as never, this.wireRegistry, 'openai', undefined, { baseURL: this.baseURL, apiKey: this.apiKey }) as unknown as Record<string, unknown>;
    const { noBody, rawBody, body, ...rest } = built;
    return {
      ...rest,
      ...(rawBody ? { body: rawBytes, rawBody: true } : noBody ? {} : { body }),
      provider: 'openai',
      model,
      responseType,
    } as HttpRequest;
  }

  /** Report-only classification. `input` reaches the wire untouched: string,
   *  array of strings, or content parts are all accepted. */
  buildModerateRequest(
    input: string | string[] | ModerationContentPart | ModerationContentPart[],
    model: string,
  ): HttpRequest {
    return this.fromSpec('openai/moderations', { model, input }, model);
  }

  async moderate(
    input: string | string[] | ModerationContentPart | ModerationContentPart[],
    model: string,
    fetch: EngineFetch,
  ): Promise<ModerationResult[]> {
    const res = await fetch(this.buildModerateRequest(input, model));

    if (res.status >= 400) {
      throw new Error(`OpenAI moderations failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const data = res.body as ModerationRawResponse;
    return (data.results ?? []).map(parseRawResult);
  }
}

function parseRawResult(r: ModerationRawResult): ModerationResult {
  return {
    flagged: r.flagged,
    categories: r.categories as unknown as ModerationCategories,
    categoryScores: r.category_scores as unknown as ModerationScores,
    categoryAppliedInputTypes: r.category_applied_input_types,
  };
}
