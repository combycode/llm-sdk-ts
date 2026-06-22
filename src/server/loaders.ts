/** Loader plugin slots for OaiServer.
 *
 *  AgentLoaderPlugin: dynamically resolves an AgentLoop for a given (userId,
 *  model) pair, allowing per-user / per-conversation agent instances rather
 *  than the static ServerEntry registration.
 *
 *  ConversationLoaderPlugin: rehydrates a ConversationHistory by
 *  (userId, conversationId), letting persistence live outside ResponseStore. */

import type { AgentLoop } from '../agent/loop';
import type { ConversationHistory } from '../agent/history';

export interface AgentLoaderContext {
  userId: string | null;
  model: string;
  conversationId?: string;
}

export interface AgentLoaderPlugin {
  load(ctx: AgentLoaderContext): Promise<AgentLoop | null>;
}

export interface ConversationLoaderContext {
  userId: string | null;
  conversationId: string;
}

export interface ConversationLoaderPlugin {
  load(ctx: ConversationLoaderContext): Promise<ConversationHistory | null>;
  save(ctx: ConversationLoaderContext, history: ConversationHistory): Promise<void>;
}
