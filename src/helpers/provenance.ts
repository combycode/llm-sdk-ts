/** checkProvenance() — does this file carry provider provenance signals?
 *
 *    const v = await checkProvenance({ file: bytes, filename: 'photo.png', mimeType: 'image/png' });
 *    if (v.trusted) { … }   // a manifest that actually validated
 *
 *  Same shape as `moderate()`: bytes in, structured verdict out, HTTP through engine.fetch.
 *
 *  **Read `detected: false` carefully.** Provenance signals are strippable — a re-encode, a crop or
 *  a screenshot usually removes them — so a negative result is absence of evidence, not evidence
 *  that a human made the file. Only `trusted` is a positive statement. */

import type { CostEntry } from '../bus/hook-map';
import { OpenAIProvenanceAdapter } from '../llm/providers/openai/provenance';
import type { CheckProvenanceOptions, ProvenanceCheckResult } from './provenance-types';
import { coreRegistry } from './engine';

const PROVENANCE_COST_NOTE = 'free: content-provenance endpoint not billed';
const PROVENANCE_DEFAULT_PROVIDER = 'openai';
const PROVENANCE_MODEL_LABEL = 'content_provenance_check';

export async function checkProvenance(
  opts: CheckProvenanceOptions,
): Promise<ProvenanceCheckResult> {
  const engine = opts.engine ?? coreRegistry.get();
  const provider = opts.provider ?? PROVENANCE_DEFAULT_PROVIDER;

  if (provider !== 'openai') {
    throw new Error(
      `checkProvenance: provider "${provider}" is not supported. Only "openai" exposes a content-provenance API.`,
    );
  }

  const apiKey = opts.apiKey ?? engine.apiKeys[provider];
  if (!apiKey) {
    throw new Error(
      `checkProvenance: no API key for provider "${provider}". Pass apiKey or set engine.apiKeys["${provider}"].`,
    );
  }

  const adapter = new OpenAIProvenanceAdapter({ apiKey });
  const result = await adapter.check(opts.file, opts.filename, opts.mimeType, engine.fetch);

  emitProvenanceZero(engine, provider);

  return result;
}

/** Honest-zero cost entry: the endpoint is not billed, but the ledger records every call so a
 *  reader can tell "free" from "never happened". Mirrors `moderate()` exactly. */
function emitProvenanceZero(engine: ReturnType<typeof coreRegistry.get>, provider: string): void {
  const cost: CostEntry['cost'] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    source: 'calculated',
  };
  const entry: CostEntry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    provider,
    model: PROVENANCE_MODEL_LABEL,
    tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
    cost,
    providerEvidence: { note: PROVENANCE_COST_NOTE },
    tags: { provider, model: PROVENANCE_MODEL_LABEL, type: 'provenance' } as Record<
      string,
      string | undefined
    >,
  };
  engine.hooks.emitSync('onCostEntry', { entry, runningTotal: 0 });
}
