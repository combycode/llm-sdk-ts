/** OpenAI moderations adapter -- POST /v1/moderations.
 *  Supports text and image+text content-part input as described in
 *  https://platform.openai.com/docs/api-reference/moderations/create
 *  All HTTP flows through the injected EngineFetch. */

import type { EngineFetch } from '../../../network/types';
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

  async moderate(
    input: string | string[] | ModerationContentPart | ModerationContentPart[],
    model: string,
    fetch: EngineFetch,
  ): Promise<ModerationResult[]> {
    const res = await fetch({
      url: `${this.baseURL}${OPENAI_MODERATION_PATH}`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: { model, input },
      provider: 'openai',
      model,
      responseType: 'json',
    });

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
