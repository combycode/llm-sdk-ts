/** Types for InternalToolRunner — config, LLM tool definition. */

import type { HookBus } from '../../../bus/hook-bus';
import type { LLMClientConfig } from '../../../llm/client-config';
import type { ProviderName } from '../../../llm/types/provider';
import type { JsonSchema } from '../../../llm/types/tools';
import type { ModelCatalog } from '../../model-catalog/catalog';
import type { ToolRegistry } from '../registry';
import type { CompatFile, ModelPreference } from '../types';
import type { TokenCounter } from '../../../agent/types';
import type { EngineHandle } from '../../../helpers/engine';

export interface InternalToolRunnerConfig {
  hooks: HookBus;
  registry: ToolRegistry;
  catalog?: ModelCatalog;
  /** Engine handle — supplies fetch/hooks/adapter wiring for pooled clients.
   *  When omitted, the runner can still execute non-LLM tools but every
   *  LLM-backed tool will throw on first call. */
  engine?: EngineHandle;
  /** Map of provider → API key. A tool's model requires the matching key. */
  apiKeys: Partial<Record<ProviderName, string>>;
  /** Fallback model when a tool has no modelPreference and needs LLM. */
  defaultModel?: string;
  /** Benchmark-derived recommendations, keyed by tool ID. Optional. */
  compat?: CompatFile;
  /** Shared client options applied to every pooled LLMClient. */
  clientOptions?: Partial<
    Omit<
      LLMClientConfig,
      'provider' | 'apiKey' | 'model' | 'hooks' | 'fetch' | 'fetchStream' | 'adapter'
    >
  >;
  /** Token counter used by tools to convert char-length to max-tokens.
   *  Auto-created from catalog (HybridTokenCounter) when not provided. */
  counter?: TokenCounter;
}

/** Context passed to a tool's resolveMaxTokens() function. */
export interface ResolveMaxTokensContext {
  provider: string;
  model: string;
  counter: TokenCounter;
}

/** Declarative LLM tool — prompt template + schema. Convert via defineLLMTool(). */
export interface LLMToolDefinition {
  id: string;
  namespace: string;
  name: string;
  version: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;

  systemPrompt?: string;
  userTemplate?: string;
  outputFormat?: 'text' | 'json';

  prepareInput?: (input: Record<string, unknown>) => Record<string, unknown>;

  resolveMaxTokens?: (input: Record<string, unknown>, ctx: ResolveMaxTokensContext) => number;

  outputExample?: unknown;

  variants?: import('./variants').PromptVariant[];

  modelPreference: ModelPreference;
  recommendedThreshold?: number;
  tags?: string[];
  signature?: string;
}
