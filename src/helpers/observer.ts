/** createObserver — agent-scoped reactive subscription.
 *
 *      createObserver(agent, 'onRunComplete', reactor);
 *
 *  The reactor is either a plain async function `(ctx) => void` or an
 *  AgentOptions object describing an observer agent. When it's an agent
 *  config, the helper internally builds an AgentLoop with the supplied
 *  tools; on every fired event it converts the ctx to a prompt and runs
 *  `observer.complete(prompt)` — the observer's tools execute the side
 *  effects, the reply text is discarded.
 *
 *  Hooks are pulled from `coreRegistry.get().hooks`. Events fire fire-
 *  and-forget; an in-flight reaction never blocks the next event. */

import type { AgentLoop } from '../agent/loop';
import type {
  RunCompleteContext,
  RunErrorContext,
  RunStartContext,
  StepCompleteContext,
  StepStartContext,
  ToolCallCompleteContext,
  ToolCallErrorContext,
  ToolCallStartContext,
} from '../bus/hook-map';
import { createAgent, type CreateAgentOptions } from './agent';
import { coreRegistry } from './engine';

/** Agent-scoped event names — hook-map entries that carry `agentId`. */
export type AgentEventName =
  | 'onRunStart'
  | 'onRunComplete'
  | 'onRunError'
  | 'onStepStart'
  | 'onStepComplete'
  | 'onToolCallStart'
  | 'onToolCallComplete'
  | 'onToolCallError';

interface AgentEventCtxMap {
  onRunStart: RunStartContext;
  onRunComplete: RunCompleteContext;
  onRunError: RunErrorContext;
  onStepStart: StepStartContext;
  onStepComplete: StepCompleteContext;
  onToolCallStart: ToolCallStartContext;
  onToolCallComplete: ToolCallCompleteContext;
  onToolCallError: ToolCallErrorContext;
}

export type ObserverReactor<E extends AgentEventName> =
  | ((ctx: AgentEventCtxMap[E]) => void | Promise<void>)
  | ObserverAgentReactor<E>;

export interface ObserverAgentReactor<E extends AgentEventName> extends CreateAgentOptions {
  /** Convert the event ctx into the prompt text fed to the observer agent.
   *  Defaults to a JSON dump of ctx. */
  prompt?: (ctx: AgentEventCtxMap[E]) => string | Promise<string>;
}

export function createObserver<E extends AgentEventName>(
  agent: AgentLoop,
  event: E,
  reactor: ObserverReactor<E>,
): () => void {
  const hooks = coreRegistry.get().hooks;

  if (typeof reactor === 'function') {
    return hooks.on(event, (ctx) => {
      if ((ctx as { agentId?: string }).agentId !== agent.id) return;
      // Fire-and-forget: never block the hook bus on a slow reactor.
      void Promise.resolve(reactor(ctx as AgentEventCtxMap[E])).catch((err) => {
        hooks.emitSync('onWarning', {
          source: 'agent',
          code: 'observer_failed',
          message: `observer reactor threw: ${(err as Error).message}`,
          details: { event, agentId: agent.id },
        });
      });
    });
  }

  const { prompt: buildPrompt, ...agentOpts } = reactor;
  const observer = createAgent(agentOpts);
  const renderPrompt =
    buildPrompt ?? ((ctx: AgentEventCtxMap[E]) => JSON.stringify(ctx, replacer, 2));

  return hooks.on(event, (ctx) => {
    if ((ctx as { agentId?: string }).agentId !== agent.id) return;
    void Promise.resolve(renderPrompt(ctx as AgentEventCtxMap[E]))
      .then((text) => observer.complete(text))
      .catch((err) => {
        hooks.emitSync('onWarning', {
          source: 'agent',
          code: 'observer_agent_failed',
          message: `observer agent threw: ${(err as Error).message}`,
          details: { event, agentId: agent.id, observerId: observer.id },
        });
      });
  });
}

// Drop fields that don't serialise cleanly (Maps, Errors, AbortControllers)
// so the default ctx-as-prompt shape is human-readable.
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}
