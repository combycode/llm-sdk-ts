/** dispatch — execute a chat-completion request against a ResolvedTarget.
 *
 *  Takes the user message + ConversationHistory (already containing prior
 *  turns), wraps the target's LLMClient in a transient AgentLoop that
 *  reuses the history, runs it, and returns the assistant text plus token
 *  counts. The history is mutated in place: [user, assistant, ...]. */

import { AgentLoop } from '../agent/loop';
import { toolKey } from '../agent/tool-key';
import type { ConversationHistory } from '../agent/history';
import type { AgentTool } from '../agent/types';
import type { HookBus } from '../bus/hook-bus';
import type { OaiToolDefinition } from './oai-types';
import type { ResolvedTarget } from './router';

export interface DispatchInput {
  target: ResolvedTarget;
  history: ConversationHistory;
  userText: string;
  systemPrompt?: string;
  /** External tools requested by the OAI client. Filtered out when the entry
   *  has `allowExternalTools: false`. Wrapped as throw-on-execute AgentTools
   *  (server-side execution of caller-defined tools is not yet supported). */
  externalTools?: OaiToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  hooks: HookBus;
  /** When provided, dispatch reuses this AgentLoop instead of building a fresh
   *  one. Resolved by an AgentLoaderPlugin so server callers can persist agent
   *  state across requests (system prompt, tools, attached history). */
  agentLoop?: AgentLoop;
}

export interface DispatchResult {
  text: string;
  providerResponseId: string | null;
  inputTokens: number;
  outputTokens: number;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  // Capture provider response id from onCompletion (when supported by target).
  let capturedProviderId: string | null = null;
  let unsub: (() => void) | null = null;
  if (input.target.supportsPreviousResponseId) {
    unsub = input.hooks.on('onCompletion', (ctx) => {
      if (ctx.model !== input.target.model) return;
      if (typeof ctx.response.id === 'string' && ctx.response.id.length > 0) {
        capturedProviderId = ctx.response.id;
      }
    });
  }

  try {
    let loop: AgentLoop;
    if (input.agentLoop) {
      // Caller-provided (typically from AgentLoaderPlugin). The loader owns
      // system prompt + tools + history; we don't override.
      loop = input.agentLoop;
    } else {
      const tools = mergeTools(
        input.target.internalTools,
        input.target.allowExternalTools ? toAgentTools(input.externalTools) : [],
      );
      loop = new AgentLoop({
        client: input.target.client,
        system: input.systemPrompt ?? '',
        hooks: input.hooks,
        history: input.history,
        maxTokens: input.maxOutputTokens,
        temperature: input.temperature,
        tools,
      });
    }

    const result = await loop.complete(input.userText);
    return {
      text: result.text,
      providerResponseId: capturedProviderId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  } finally {
    unsub?.();
  }
}

/** Merge internal (server-defined) and external (client-defined) tools.
 *  External tools that collide with internal names are dropped — internal wins. */
function mergeTools(internal: AgentTool[], external: AgentTool[]): AgentTool[] {
  const seen = new Set(internal.map(toolKey));
  const merged: AgentTool[] = [...internal];
  for (const t of external) {
    const k = toolKey(t);
    if (!seen.has(k)) {
      merged.push(t);
      seen.add(k);
    }
  }
  return merged;
}

/** Wrap OAI tool definitions as throw-on-execute AgentTools so the model
 *  receives the schema but executing one tells the model to produce text. */
function toAgentTools(tools?: OaiToolDefinition[]): AgentTool[] {
  if (!tools || tools.length === 0) return [];
  const out: AgentTool[] = [];
  for (const t of tools) {
    if (t.type !== 'function') continue;
    out.push({
      definition: {
        type: 'function' as const,
        name: t.function.name,
        description: t.function.description ?? '',
        parameters: t.function.parameters ?? {},
      },
      execute: async () => {
        throw new Error(
          `tool "${t.function.name}": client-defined tools aren't executed by the OAI server. ` +
            'The model should produce a final text answer.',
        );
      },
    });
  }
  return out;
}
