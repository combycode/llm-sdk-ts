/** xAI Responses API adapter.
 *  Mirrors OpenAI Responses API at api.x.ai/v1/responses.
 *  Differences:
 *  - System prompt via role:system in input (not instructions)
 *  - Reasoning automatic for reasoning models (no effort param needed)
 *  - Encrypted reasoning via include: ["reasoning.encrypted_content"]
 */

import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import type { FileOutput } from '../../types/response';
import { isFunctionTool } from '../../types/tools';
import { bytesToBase64 } from '../../../util/base64';
import { OpenAIResponsesAdapter } from '../openai/responses';
import { xaiRequestTier } from './tiers';

export interface XAIResponsesAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** xAI returns code-execution output files INLINE inside the `code_interpreter_call`
 *  `logs` payload (a JSON string: `{stdout, output_files:[{file_name, mime_type, data:[…bytes]}]}`),
 *  not as OpenAI-style `container_file_citation` annotations. Requires the request to
 *  ask for them via `include: ['code_interpreter_call.outputs']`. */
function xaiCodeExecFiles(item: Record<string, unknown>): FileOutput[] {
  if (item.type !== 'code_interpreter_call') return [];
  const files: FileOutput[] = [];
  for (const out of (item.outputs as Array<Record<string, unknown>>) ?? []) {
    if (out.type !== 'logs' || typeof out.logs !== 'string') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(out.logs) as Record<string, unknown>;
    } catch {
      continue; // plain-text logs (not the xAI JSON envelope)
    }
    for (const f of (parsed.output_files as Array<Record<string, unknown>>) ?? []) {
      if (!Array.isArray(f.data)) continue;
      files.push({
        data: bytesToBase64(Uint8Array.from(f.data as number[])),
        ...(typeof f.file_name === 'string' ? { name: f.file_name } : {}),
        ...(typeof f.mime_type === 'string' ? { mimeType: f.mime_type } : {}),
        source: 'code_execution',
      });
    }
  }
  return files;
}

export class XAIResponsesAdapter extends OpenAIResponsesAdapter {
  override readonly name: ProviderAdapter['name'] = 'xai';

  constructor(config: XAIResponsesAdapterConfig) {
    super({ apiKey: config.apiKey, baseURL: config.baseURL ?? 'https://api.x.ai' });
  }

  override baseURL(): string {
    return this._baseURL ?? 'https://api.x.ai';
  }

  override buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const result = super.buildRequest(req);
    const body = result.body as Record<string, unknown>;

    // xAI: system prompt goes in input as role:system, not as instructions
    if (req.system && body.instructions) {
      const input = body.input as unknown[];
      input.unshift({ role: 'system', content: req.system });
      delete body.instructions;
    }

    // xAI reasoning models reason automatically — remove reasoning param
    // Only grok-4.20-multi-agent uses reasoning.effort (for agent count)
    if (!req.model.includes('multi-agent')) {
      delete body.reasoning;
    }

    // Service tier: the inherited OpenAI map can emit auto/flex/scale, which xAI
    // rejects (its enum is DEFAULT|PRIORITY only). Remap from the unified tier.
    const xaiTier = xaiRequestTier(req.serviceTier);
    if (xaiTier) body.service_tier = xaiTier;
    else delete body.service_tier;

    // Code-execution output files are returned only when explicitly requested via
    // `include`. xAI accepts the OpenAI-style token here (its own `code_execution_*`
    // strings 400). Without it, `code_interpreter_call` yields empty logs and no file.
    const usesCodeInterpreter = req.tools?.some(
      (t) => !isFunctionTool(t) && t.type === 'code_interpreter',
    );
    if (usesCodeInterpreter) {
      const include = new Set([...((body.include as string[]) ?? []), 'code_interpreter_call.outputs']);
      body.include = [...include];
    }

    return result;
  }

  /** xAI embeds code-execution files inline in the `logs` payload — extend the base
   *  extraction (which handles OpenAI-style annotations / image URLs) with the xAI shape. */
  protected override filesFromOutputItem(item: Record<string, unknown>): FileOutput[] {
    return [...super.filesFromOutputItem(item), ...xaiCodeExecFiles(item)];
  }
}
