/** createServer — convenience helper that builds an OaiServer with engine
 *  wiring (shared HookBus + ResponseStore-backed Persistence).
 *
 *  When `agents` is supplied, the helper auto-builds an `agentLoader` that
 *  constructs an AgentLoop per request and a `conversationLoader` backed
 *  by `createCollection<HistorySnapshot>('server-conversations')` so chat
 *  history survives across requests + restarts. The raw `agentLoader` /
 *  `conversationLoader` slots remain available for advanced cases. */

import type { AgentTool } from '../agent/types';
import { ConversationHistory } from '../agent/history';
import type { HistorySnapshot } from '../agent/history-types';
import type { AgentLoop } from '../agent/loop';
import type {
  AgentLoaderContext,
  AgentLoaderPlugin,
  ConversationLoaderContext,
  ConversationLoaderPlugin,
} from '../server/loaders';
import { ResponseStore } from '../server/response-store';
import { OaiServer, type OaiServerConfig } from '../server/server';
import { createAgent, type CreateAgentOptions } from './agent';
import { createCollection } from './collection';
import type { EngineHandle } from './engine';
import { coreRegistry } from './engine';

export interface ServerAgentSpec extends CreateAgentOptions {
  /** Pre-built AgentLoop. When set, the same instance is reused for every
   *  request — best for single-tenant stateful agents. */
  agent?: AgentLoop;
  /** Internal tools (executable on the server, hidden from the client). */
  internalTools?: AgentTool[];
  /** When false, client-supplied tools in the OAI request are dropped. Default true. */
  allowExternalTools?: boolean;
}

export interface CreateServerOptions
  extends Omit<OaiServerConfig, 'hooks' | 'responseStorePersistence'> {
  /** High-level agent registration. Each entry becomes a server model with
   *  a per-request AgentLoop built from the spec, plus per-(userId,
   *  conversationId) history backed by `engine.persistence`. */
  agents?: Record<string, ServerAgentSpec>;
  engine?: EngineHandle;
  hooks?: OaiServerConfig['hooks'];
  responseStorePersistence?: OaiServerConfig['responseStorePersistence'];
}

export function createServer(opts: CreateServerOptions = {}): OaiServer {
  const engine = opts.engine ?? coreRegistry.get();
  const responseStore =
    opts.responseStore ??
    new ResponseStore({
      persistence: opts.responseStorePersistence ?? engine.persistence,
    });

  const built = opts.agents ? buildLoaders(opts.agents) : null;

  const server = new OaiServer({
    ...opts,
    hooks: opts.hooks ?? engine.hooks,
    responseStore,
    agentLoader: built?.agentLoader ?? opts.agentLoader,
    conversationLoader: built?.conversationLoader ?? opts.conversationLoader,
  });

  // Register each high-level agent as a static entry too, so /v1/models and
  // the router can resolve it. The agentLoader takes precedence per-request
  // when present (so the static entry's client is just a fallback).
  if (opts.agents) {
    for (const [model, spec] of Object.entries(opts.agents)) {
      const fallbackClient = spec.agent?.client ?? createAgent(spec).client;
      server.register({
        model,
        client: fallbackClient,
        internalTools: spec.internalTools,
        allowExternalTools: spec.allowExternalTools,
      });
    }
  }

  return server;
}

function buildLoaders(agents: Record<string, ServerAgentSpec>): {
  agentLoader: AgentLoaderPlugin;
  conversationLoader: ConversationLoaderPlugin;
} {
  const conversations = createCollection<HistorySnapshot>('server-conversations');

  const keyFor = (userId: string | null, conversationId: string): string =>
    `${userId ?? 'anon'}:${conversationId}`;

  const conversationLoader: ConversationLoaderPlugin = {
    async load({ userId, conversationId }: ConversationLoaderContext) {
      const snap = await conversations.get(keyFor(userId, conversationId));
      return snap ? ConversationHistory.import(snap) : null;
    },
    async save(
      { userId, conversationId }: ConversationLoaderContext,
      history: ConversationHistory,
    ) {
      await conversations.set(keyFor(userId, conversationId), history.export());
    },
  };

  const agentLoader: AgentLoaderPlugin = {
    async load({ userId, model, conversationId }: AgentLoaderContext) {
      const spec = agents[model];
      if (!spec) return null;
      if (spec.agent) return spec.agent;
      const cid = conversationId ?? 'default';
      const snap = await conversations.get(keyFor(userId, cid));
      const history = snap ? ConversationHistory.import(snap) : new ConversationHistory();
      return createAgent({ ...spec, history });
    },
  };

  return { agentLoader, conversationLoader };
}
