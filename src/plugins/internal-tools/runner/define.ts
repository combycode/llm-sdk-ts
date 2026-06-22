/** defineLLMTool — convert a declarative LLMToolDefinition into an InternalTool
 *  with execute() that renders templates, calls LLM, parses output. */

import type { InternalTool, InternalToolContext } from '../types';
import type { LLMToolDefinition } from './types';
import type { LLMClient } from '../../../llm/client';
import type { JsonSchema } from '../../../llm/types/tools';
import { renderTemplate, parseJsonWithFences } from './template';
import { composeJsonSystemPrompt } from './json-enforcement';
import { selectVariant, type PromptVariant } from './variants';

/** Append output-structure guidance to system prompt. */
function attachStructureGuidance(
  baseSystem: string,
  outputFormat: 'text' | 'json' | undefined,
  outputSchema: JsonSchema | undefined,
  outputExample: unknown,
): string {
  if (outputFormat !== 'json') return baseSystem;

  const parts: string[] = [baseSystem];

  if (outputSchema) {
    parts.push('\n## Output schema (your JSON must match)');
    parts.push('```json');
    parts.push(JSON.stringify(outputSchema, null, 2));
    parts.push('```');
  }

  if (outputExample !== undefined) {
    parts.push('\n## Output example (copy this shape exactly)');
    parts.push('```json');
    parts.push(JSON.stringify(outputExample, null, 2));
    parts.push('```');
  }

  return parts.join('\n');
}

function singlePromptVariant(def: LLMToolDefinition): PromptVariant {
  return {
    id: 'default',
    systemPrompt: def.systemPrompt ?? '',
    userTemplate: def.userTemplate ?? '',
    outputExample: def.outputExample,
    outputSchema: def.outputSchema,
    resolveMaxTokens: def.resolveMaxTokens,
    isDefault: true,
  };
}

function applySchemaDefaults(
  input: unknown,
  schema: JsonSchema | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : {};

  if (!schema || (schema as Record<string, unknown>).type !== 'object') return base;
  const props = (schema as Record<string, unknown>).properties as
    | Record<string, { default?: unknown }>
    | undefined;
  if (!props) return base;

  for (const [key, prop] of Object.entries(props)) {
    if (!(key in base) && prop.default !== undefined) {
      base[key] = prop.default;
    }
  }
  return base;
}

export const LLM_DEF_KEY = Symbol.for('orxa:llm_tool_def');

export function getLLMToolDefinition(tool: InternalTool): LLMToolDefinition | null {
  return (tool as unknown as Record<symbol, LLMToolDefinition | undefined>)[LLM_DEF_KEY] ?? null;
}

export function defineLLMTool(def: LLMToolDefinition): InternalTool {
  const tool: InternalTool = {
    id: def.id,
    namespace: def.namespace,
    name: def.name,
    version: def.version,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    modelPreference: def.modelPreference,
    recommendedThreshold: def.recommendedThreshold,
    tags: def.tags,
    signature: def.signature,
    execute: async (input: unknown, ctx: InternalToolContext) => {
      const client = ctx.client as LLMClient | undefined;
      const modelId = ctx.modelId as string | undefined;
      if (!client || !modelId) {
        throw new Error(
          `Tool ${def.id} requires an LLM client + model in context (runner must provide these)`,
        );
      }

      const slash = modelId.indexOf('/');
      const provider = slash > 0 ? modelId.slice(0, slash) : modelId;
      const modelName = slash > 0 ? modelId.slice(slash + 1) : modelId;

      let vars = applySchemaDefaults(input, def.inputSchema);
      if (def.prepareInput) vars = def.prepareInput(vars);

      const variantsToUse = def.variants ?? [singlePromptVariant(def)];
      const activeVariant = selectVariant(variantsToUse, {
        provider,
        model: modelName,
        mode: (vars.mode as string | undefined) ?? (input as { mode?: string })?.mode,
      });

      const activeSchema = activeVariant.outputSchema ?? def.outputSchema;
      const activeExample = activeVariant.outputExample ?? def.outputExample;
      const activeResolveMaxTokens = activeVariant.resolveMaxTokens ?? def.resolveMaxTokens;

      const baseSystem = renderTemplate(activeVariant.systemPrompt, vars);
      const withStructure = attachStructureGuidance(
        baseSystem,
        def.outputFormat,
        activeSchema,
        activeExample,
      );
      const system =
        def.outputFormat === 'json' ? composeJsonSystemPrompt(withStructure) : withStructure;
      const user = renderTemplate(activeVariant.userTemplate, vars);

      let maxTokens = def.modelPreference.maxTokens;
      if (activeResolveMaxTokens) {
        const counter = ctx.counter;
        if (!counter)
          throw new Error(`Tool ${def.id}: resolveMaxTokens requires a TokenCounter in context`);
        maxTokens = activeResolveMaxTokens(vars, {
          provider,
          model: modelName,
          counter,
        });
      }

      // v2 LLMClient.complete: input → messages, options bag for the rest.
      // Model is fixed at client construction (the runner pools by model).
      const response = await client.complete([{ role: 'user', content: user }], {
        system,
        maxTokens,
        temperature: def.modelPreference.temperature,
      });

      ctx.recordLLMResponse?.(response);

      if (def.outputFormat === 'json') {
        try {
          return parseJsonWithFences(response.text);
        } catch (err) {
          throw new Error(
            `Tool ${def.id} produced non-JSON output. Parser error: ${(err as Error).message}. Raw (first 500 chars): ${response.text.slice(0, 500)}`,
          );
        }
      }
      return response.text;
    },
  };

  (tool as unknown as Record<symbol, LLMToolDefinition>)[LLM_DEF_KEY] = def;
  return tool;
}
