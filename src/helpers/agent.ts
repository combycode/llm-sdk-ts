/** createAgent — convenience helper that builds an AgentLoop. Accepts either
 *  a pre-built `client` or a model string (`'provider/model'`) plus optional
 *  apiKey override; the helper builds the client via createLLM with the
 *  engine's fetch + hooks + adapter wiring, pulling apiKey from
 *  `engine.apiKeys` when not passed. */

import { AgentLoop } from '../agent/loop';
import type { AgentLoopConfig } from '../agent/loop-config';
import type { LLMClient } from '../llm/client';
import type { LLMClientConfig } from '../llm/client-config';
import type { ProviderName } from '../llm/types/provider';
import { createLLM } from './llm';
import type { EngineHandle } from './engine';
import { coreRegistry } from './engine';

export interface CreateAgentOptions extends Omit<AgentLoopConfig, 'client' | 'hooks' | 'system'> {
  /** Persona / role text. May be a function for live-reload prompts —
   *  re-evaluated at the start of every `complete()` / `stream()` call. */
  system?: AgentLoopConfig['system'];
  /** Pre-built client. When omitted, pass a `model` (and optionally `apiKey`)
   *  and the helper will build one via createLLM. */
  client?: LLMClient;

  /** Model string. Bare (e.g. `claude-haiku-4-5` — pair with `provider`) or
   *  namespaced (e.g. `anthropic/claude-haiku-4-5`). */
  model?: string;
  /** Required when `model` is bare. */
  provider?: ProviderName;
  /** Optional — falls back to `engine.apiKeys[provider]`. */
  apiKey?: string;
  baseURL?: string;
  /** Extra LLMClient options applied to the lazily-built client. */
  clientOptions?: Partial<
    Omit<LLMClientConfig, 'provider' | 'model' | 'apiKey' | 'baseURL' | 'hooks' | 'fetch'>
  >;

  engine?: EngineHandle;
  hooks?: AgentLoopConfig['hooks'];
}

export function createAgent(opts: CreateAgentOptions): AgentLoop {
  const engine = opts.engine ?? coreRegistry.get();
  let client = opts.client;
  if (!client) {
    if (!opts.model) {
      throw new Error('createAgent: provide either `client` or `model`');
    }
    client = createLLM({
      engine,
      provider: opts.provider,
      model: opts.model,
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      ...(opts.clientOptions ?? {}),
    });
  }
  return new AgentLoop({
    ...opts,
    client,
    hooks: opts.hooks ?? engine.hooks,
  });
}
