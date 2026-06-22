/** ModelRouter — resolves model names to registered ServerEntry targets. */

import type { AgentTool } from '../agent/types';
import type { LLMClient } from '../llm/client';

export interface ServerEntry {
  /** Model id as it appears in OAI requests. */
  model: string;
  /** Pre-configured LLMClient for this model. */
  client: LLMClient;
  /** Internal tools (executable on the server) that this entry exposes. */
  internalTools?: AgentTool[];
  /** When false, client-supplied tools in the OAI request are dropped. Default true. */
  allowExternalTools?: boolean;
  /** Optional capability metadata exposed in /v1/models. */
  capabilities?: {
    supportsPreviousResponseId?: boolean;
    stateRetentionDays?: number | null;
    tools?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    maxContext?: number;
  };
}

export interface ResolvedTarget {
  entry: ServerEntry;
  client: LLMClient;
  model: string;
  internalTools: AgentTool[];
  allowExternalTools: boolean;
  supportsPreviousResponseId: boolean;
  stateRetentionDays: number | null;
}

export interface ModelListing {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  orxa?: {
    routing: 'direct';
    apis: Array<'responses' | 'chat.completions'>;
    supports_previous_response_id?: boolean;
    state_retention_days?: number | null;
    capabilities?: {
      tools?: boolean;
      vision?: boolean;
      reasoning?: boolean;
      max_context?: number;
    };
  };
}

export class ModelRouter {
  private readonly byModel = new Map<string, ServerEntry>();

  constructor(config: { entries: ServerEntry[] }) {
    for (const e of config.entries) this.register(e);
  }

  register(e: ServerEntry): void {
    if (this.byModel.has(e.model)) {
      throw new Error(`ModelRouter: duplicate model id "${e.model}"`);
    }
    this.byModel.set(e.model, e);
  }

  unregister(model: string): boolean {
    return this.byModel.delete(model);
  }

  list(): ModelListing[] {
    const now = Math.floor(Date.now() / 1000);
    return Array.from(this.byModel.values()).map((e) => ({
      id: e.model,
      object: 'model' as const,
      created: now,
      owned_by: 'user',
      orxa: {
        routing: 'direct' as const,
        apis: ['chat.completions'] as Array<'responses' | 'chat.completions'>,
        supports_previous_response_id: e.capabilities?.supportsPreviousResponseId,
        state_retention_days: e.capabilities?.stateRetentionDays,
        capabilities: {
          tools: e.capabilities?.tools,
          vision: e.capabilities?.vision,
          reasoning: e.capabilities?.reasoning,
          max_context: e.capabilities?.maxContext,
        },
      },
    }));
  }

  resolve(modelName: string): ResolvedTarget {
    const entry = this.byModel.get(modelName);
    if (!entry) {
      throw new Error(
        `model "${modelName}" not registered. Known: [${[...this.byModel.keys()].join(', ')}]`,
      );
    }
    return {
      entry,
      client: entry.client,
      model: entry.model,
      internalTools: entry.internalTools ?? [],
      allowExternalTools: entry.allowExternalTools ?? true,
      supportsPreviousResponseId: entry.capabilities?.supportsPreviousResponseId ?? false,
      stateRetentionDays: entry.capabilities?.stateRetentionDays ?? null,
    };
  }
}
