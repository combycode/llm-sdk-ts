/** InternalToolRunner — executes InternalTools with client pooling, fallback, hooks.
 *
 *  Contract:
 *  1. run(toolId, input) resolves tool → validates input → resolves models → executes.
 *  2. Key availability is checked IMMEDIATELY after tool lookup, before execution:
 *     if no configured API key matches any of tool's required providers → throws.
 *  3. Per attempt, skip models whose providers lack keys.
 *  4. Emits onInternalToolCallStart/Complete/Error hooks.
 *  5. Cost of underlying LLM calls is tracked via existing onCompletion (CostCollector).
 *
 *  v2 adaptation: clients are built via the engine handle's adapter resolver
 *  (auto-discovers default adapter). The engine wires every LLMClient through
 *  the network queue; every tool's underlying HTTP therefore inherits queue
 *  rate-limit / retry / hook behavior automatically.
 */

import type { InternalTool, InternalToolContext } from '../types';
import type { InternalToolRunnerConfig } from './types';
import type { ProviderName } from '../../../llm/types/provider';
import type { TokenCounter } from '../../../agent/types';
import type { Usage } from '../../../llm/types/response';
import type { LLMClient } from '../../../llm/client';
import { HybridTokenCounter } from '../../context-measurer/counter/hybrid';
import { createLLM } from '../../../helpers/llm';

export class InternalToolRunner {
  private clients = new Map<string, LLMClient>();
  private counter: TokenCounter;

  constructor(private readonly config: InternalToolRunnerConfig) {
    this.counter = config.counter ?? new HybridTokenCounter({ catalog: config.catalog });
  }

  /** Execute a tool by ID. */
  async run<T = unknown>(toolId: string, input: unknown): Promise<T> {
    const tool = await this.config.registry.get(toolId);
    if (!tool) throw new Error(`Tool not found in registry: ${toolId}`);
    return this.runDirect<T>(tool, input);
  }

  /** Execute a tool instance directly (bypasses registry). */
  async runDirect<T = unknown>(tool: InternalTool, input: unknown): Promise<T> {
    this.validateInput(tool, input);

    const models = this.resolveModels(tool);

    if (models.length === 0) {
      return this.executeNonLLM<T>(tool, input);
    }

    this.assertKeyAvailability(tool, models);

    return this.executeLLM<T>(tool, input, models);
  }

  /** Close all pooled clients. */
  async destroy(): Promise<void> {
    for (const [, client] of this.clients) {
      client.destroy();
    }
    this.clients.clear();
  }

  get poolSize(): number {
    return this.clients.size;
  }

  /** Expose the registry so adjacent tooling can resolve tools. */
  get registry() {
    return this.config.registry;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private validateInput(tool: InternalTool, input: unknown): void {
    const schema = tool.inputSchema as Record<string, unknown> | undefined;
    if (schema?.type !== 'object') return;

    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error(
        `Tool ${tool.id} expects object input, got ${Array.isArray(input) ? 'array' : typeof input}`,
      );
    }

    const required = (schema.required as string[] | undefined) ?? [];
    const missing = required.filter((k) => !(k in (input as Record<string, unknown>)));
    if (missing.length > 0) {
      throw new Error(`Tool ${tool.id} missing required input fields: ${missing.join(', ')}`);
    }
  }

  private validateOutput(tool: InternalTool, output: unknown): void {
    const schema = tool.outputSchema as Record<string, unknown> | undefined;
    if (!schema) return;

    const expected = schema.type as string | undefined;
    if (!expected) return;

    let mismatch = false;
    if (
      expected === 'object' &&
      (typeof output !== 'object' || output === null || Array.isArray(output))
    )
      mismatch = true;
    else if (expected === 'array' && !Array.isArray(output)) mismatch = true;
    else if (expected === 'string' && typeof output !== 'string') mismatch = true;
    else if (expected === 'number' && typeof output !== 'number') mismatch = true;
    else if (expected === 'boolean' && typeof output !== 'boolean') mismatch = true;

    if (mismatch) {
      this.config.hooks.emitSync('onWarning', {
        source: 'agent',
        code: 'output_schema_mismatch',
        message: `Tool ${tool.id} output does not match schema: expected ${expected}, got ${Array.isArray(output) ? 'array' : typeof output}`,
        details: { toolId: tool.id },
      });
    }
  }

  /** Build ordered model list. Precedence:
   *  1. compat.recommended for this tool (benchmark-derived, cost-ranked).
   *  2. tool.modelPreference.preferredModel.
   *  3. tool.modelPreference.fallbackModels.
   *  4. runner.defaultModel.
   */
  private resolveModels(tool: InternalTool): string[] {
    const pref = tool.modelPreference;
    const out: string[] = [];

    const recommended = this.config.compat?.[tool.id]?.recommended ?? [];
    out.push(...recommended);
    if (pref?.preferredModel) out.push(pref.preferredModel);
    if (pref?.fallbackModels) out.push(...pref.fallbackModels);
    if (out.length === 0 && this.config.defaultModel) out.push(this.config.defaultModel);

    return [...new Set(out)];
  }

  private assertKeyAvailability(tool: InternalTool, models: string[]): void {
    const required = new Set<string>();
    for (const modelId of models) {
      const [provider] = this.parseModelId(modelId);
      required.add(provider);
    }

    const available = Object.keys(this.config.apiKeys ?? {}).filter(
      (p) => !!this.config.apiKeys?.[p as ProviderName],
    );

    const usable = [...required].filter((p) => available.includes(p));
    if (usable.length === 0) {
      throw new Error(
        `Tool ${tool.id} requires API key for one of [${[...required].join(', ')}]; ` +
          `runner has keys for [${available.join(', ')}]`,
      );
    }
  }

  private parseModelId(modelId: string): [string, string] {
    const slash = modelId.indexOf('/');
    if (slash <= 0) throw new Error(`Invalid model ID "${modelId}" (expected "provider/model")`);
    return [modelId.slice(0, slash), modelId.slice(slash + 1)];
  }

  /** Build (or fetch from pool) a client pinned to (provider, model). */
  private getClient(modelId: string): LLMClient {
    const [provider, model] = this.parseModelId(modelId);
    const apiKey = this.config.apiKeys?.[provider as ProviderName];
    if (!apiKey) throw new Error(`No API key for provider: ${provider}`);

    const engine = this.config.engine;
    if (!engine) {
      throw new Error(
        `InternalToolRunner: engine is required to execute LLM-backed tools (tool model "${modelId}")`,
      );
    }

    // Pool by provider, or by (provider, model) when catalog flags
    // requiresDedicatedClient. Built via createLLM so the default adapter is
    // auto-resolved and the engine's fetch + hooks thread into the client.
    const requiresDedicated = !!this.config.catalog?.get(provider, model)?.requiresDedicatedClient;
    const key = requiresDedicated ? `${provider}/${model}` : provider;
    let client = this.clients.get(key);
    if (!client) {
      client = createLLM({
        engine,
        provider: provider as ProviderName,
        model,
        apiKey,
        hooks: this.config.hooks,
        ...this.config.clientOptions,
      });
      this.clients.set(key, client);
    }
    return client;
  }

  private async executeNonLLM<T>(tool: InternalTool, input: unknown): Promise<T> {
    const start = performance.now();
    this.config.hooks.emitSync('onInternalToolCallStart', {
      toolId: tool.id,
      input,
      chosenModel: '',
      attempt: 1,
    });

    try {
      const output = await tool.execute(input, { hooks: this.config.hooks, counter: this.counter });
      this.validateOutput(tool, output);
      await this.config.hooks.emit('onInternalToolCallComplete', {
        toolId: tool.id,
        input,
        output,
        chosenModel: '',
        latencyMs: performance.now() - start,
        attempts: 1,
      });
      return output as T;
    } catch (err) {
      await this.config.hooks.emit('onInternalToolCallError', {
        toolId: tool.id,
        input,
        chosenModel: '',
        error: err as Error,
        attempt: 1,
        willRetry: false,
      });
      throw err;
    }
  }

  private async executeLLM<T>(tool: InternalTool, input: unknown, models: string[]): Promise<T> {
    const startTotal = performance.now();
    const errors: Array<{ model: string; error: Error }> = [];

    for (let i = 0; i < models.length; i++) {
      const modelId = models[i];
      const attempt = i + 1;

      const [provider] = this.parseModelId(modelId);
      if (!this.config.apiKeys?.[provider as ProviderName]) {
        errors.push({ model: modelId, error: new Error(`No API key for ${provider}`) });
        continue;
      }

      let client: LLMClient;
      try {
        client = this.getClient(modelId);
      } catch (err) {
        errors.push({ model: modelId, error: err as Error });
        continue;
      }

      this.config.hooks.emitSync('onInternalToolCallStart', {
        toolId: tool.id,
        input,
        chosenModel: modelId,
        attempt,
      });

      try {
        let capturedUsage: Usage | undefined;
        const ctx: InternalToolContext = {
          hooks: this.config.hooks,
          client,
          modelId,
          toolId: tool.id,
          counter: this.counter,
          recordLLMResponse: (response) => {
            capturedUsage = response.usage;
          },
        };

        const output = await tool.execute(input, ctx);
        this.validateOutput(tool, output);

        await this.config.hooks.emit('onInternalToolCallComplete', {
          toolId: tool.id,
          input,
          output,
          chosenModel: modelId,
          latencyMs: performance.now() - startTotal,
          attempts: attempt,
          usage: capturedUsage,
        });
        return output as T;
      } catch (err) {
        errors.push({ model: modelId, error: err as Error });
        const willRetry = i < models.length - 1;

        await this.config.hooks.emit('onInternalToolCallError', {
          toolId: tool.id,
          input,
          chosenModel: modelId,
          error: err as Error,
          attempt,
          willRetry,
        });

        if (willRetry) {
          this.config.hooks.emitSync('onWarning', {
            source: 'agent',
            code: 'internal_tool_fallback',
            message: `Tool ${tool.id} failed on ${modelId}, trying next model`,
            details: {
              toolId: tool.id,
              failedModel: modelId,
              errorMessage: (err as Error).message,
            },
          });
        }
      }
    }

    const summary = errors.map((e) => `${e.model}: ${e.error.message}`).join('; ');
    throw new Error(`Tool ${tool.id} failed on all ${errors.length} model(s): ${summary}`);
  }
}
