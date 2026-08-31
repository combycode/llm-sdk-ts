/** xAI Responses API adapter.
 *  Mirrors OpenAI Responses API at api.x.ai/v1/responses.
 *  Differences:
 *  - System prompt via role:system in input (not instructions)
 *  - Reasoning automatic for reasoning models (no effort param needed)
 *  - Encrypted reasoning via include: ["reasoning.encrypted_content"]
 */

import type { ProviderAdapter } from '../../types/provider';
import type { FileOutput } from '../../types/response';
import { bytesToBase64 } from '../../../util/base64';
import { OpenAIResponsesAdapter } from '../openai/responses';
import type { Registry } from '../../../wire/interpreter';
import { XAI_RESPONSES_REGISTRY } from './responses-registry';

export interface XAIResponsesAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** xAI returns code-execution output files INLINE inside the `code_interpreter_call`
 *  `logs` payload (a JSON string: `{stdout, output_files:[{file_name, mime_type, data:[…bytes]}]}`),
 *  not as OpenAI-style `container_file_citation` annotations. Requires the request to
 *  ask for them via `include: ['code_interpreter_call.outputs']`. */
export function xaiCodeExecFiles(item: Record<string, unknown>): FileOutput[] {
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
  /** Identical to OpenAI's by inheritance, but addressed by its own id so the
   *  target has a spec of its own rather than a special case in the lookup. */
  protected override responseSpecId(): string {
    return 'xai/responses.response';
  }

  protected override responseRegistry(): Registry {
    return XAI_RESPONSES_REGISTRY;
  }

  override readonly name: ProviderAdapter['name'] = 'xai';

  constructor(config: XAIResponsesAdapterConfig) {
    super({ apiKey: config.apiKey, baseURL: config.baseURL ?? 'https://api.x.ai' });
  }

  override baseURL(): string {
    return this._baseURL ?? 'https://api.x.ai';
  }

  /** Everything this class used to do to `super.buildRequest()` — the max_tokens
   *  rename, the reasoning strip, the tier remap, the routing passthrough — is the
   *  `xai` overlay in the shared spec. Naming the flavor IS the override now. */
  protected override readonly wireFlavor: string = 'xai';

  /** xAI embeds code-execution files inline in the `logs` payload — extend the base
   *  extraction (which handles OpenAI-style annotations / image URLs) with the xAI shape. */
  protected override filesFromOutputItem(item: Record<string, unknown>): FileOutput[] {
    return [...super.filesFromOutputItem(item), ...xaiCodeExecFiles(item)];
  }
}
