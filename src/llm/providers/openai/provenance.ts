/** OpenAI content-provenance adapter — POST /v1/content_provenance_checks (openai-ts 7.x).
 *
 *  Answers "does this file carry provider provenance signals?" — a C2PA manifest and/or a SynthID
 *  watermark. It is the only "was this AI-generated" primitive any tracked SDK ships.
 *
 *  Note what it does NOT do: a `not_detected` result is not proof a human made the file. Provenance
 *  signals are strippable (a re-encode or a screenshot usually loses them), so absence is absence of
 *  evidence. Only `detected` with a `trusted` validation state is a positive statement.
 *
 *  All HTTP flows through the injected EngineFetch. */

import type { EngineFetch } from '../../../network/types';
import type { ProvenanceCheckResult, ProvenanceRawResponse } from '../../../helpers/provenance-types';

export interface OpenAIProvenanceAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export const OPENAI_PROVENANCE_BASE_URL = 'https://api.openai.com';
export const OPENAI_PROVENANCE_PATH = '/v1/content_provenance_checks';

export class OpenAIProvenanceAdapter {
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenAIProvenanceAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? OPENAI_PROVENANCE_BASE_URL;
  }

  async check(
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
    fetch: EngineFetch,
  ): Promise<ProvenanceCheckResult> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: mimeType }), filename);

    const res = await fetch(
      {
        url: `${this.baseURL}${OPENAI_PROVENANCE_PATH}`,
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        rawBody: true,
        provider: 'openai',
        model: 'content_provenance_check',
        responseType: 'json',
      },
      { queueName: 'openai/provenance' },
    );

    return parseProvenanceResponse(res.body as ProvenanceRawResponse);
  }
}

/** Normalise the wire response into the unified verdict. */
export function parseProvenanceResponse(raw: ProvenanceRawResponse | undefined): ProvenanceCheckResult {
  const results = Array.isArray(raw?.results) ? raw.results : [];
  const signals = results.map((r) => ({
    kind: r.type === 'synthid' ? ('synthid' as const) : ('c2pa' as const),
    detected: r.outcome === 'detected',
    ...(r.validation_state !== undefined ? { validationState: r.validation_state } : {}),
    ...(r.issuer !== undefined ? { issuer: r.issuer } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.generated_at !== undefined ? { generatedAt: r.generated_at } : {}),
  }));

  return {
    // "Any signal detected" — a file may legitimately carry one and not the other (audio gets
    // SynthID only), so requiring both would report every audio file as clean.
    detected: signals.some((s) => s.detected),
    /** Only a detected C2PA manifest that actually validated is a trustworthy claim. */
    trusted: signals.some((s) => s.detected && s.validationState === 'trusted'),
    signals,
    ...(raw?.created_at !== undefined ? { createdAt: raw.created_at } : {}),
  };
}
