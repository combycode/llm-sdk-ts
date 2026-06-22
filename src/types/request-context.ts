/** RequestContext — propagates accumulating IDs and routing keys across the
 *  4 layers (network → llm → agent → server) and through plugin handlers.
 *
 *  Mint-if-absent rule: each layer fills in what's missing.
 *    - server mints requestId        (or agent mints if no server)
 *    - agent mints callId            (or LLM mints if no agent)
 *    - LLM mints clientId            (per construction, persistent)
 *    - LLM computes queueName/cacheKey/configName (formula defaults)
 *
 *  Override semantics:
 *    - agent MAY override cacheKey, configName (semantic)
 *    - agent MUST NOT override queueName (infrastructure)
 *
 *  See reports/016 §RequestContext for full lifetime table. */
export interface RequestContext {
  // ─── Trace correlation ───────────────────────────────────────────────
  /** Minted by the HOLDER (engine/server/orchestrator) once, lives for its
   *  lifetime (a CLI process / browser page). Shared by every request under it.
   *  A bare standalone client mints its own. `sessionId:requestId` forms the
   *  OTel trace id. */
  sessionId?: string;

  // ─── Layer 4 — Server ────────────────────────────────────────────────
  /** Set by AuthPlugin on authenticated request. Identifies the user across
   *  requests. Used to scope ResponseStore + ConversationLoader. */
  userId?: string;
  /** Per-request id — minted at each request starting point (mint-if-absent:
   *  server/agent set it, else the LLM client mints in buildContext). Follows
   *  the whole chain; the request half of the trace id. */
  requestId?: string;

  // ─── Layer 3 — Agent ─────────────────────────────────────────────────
  /** = `history.id`. Stable for the lifetime of the conversation. */
  conversationId?: string;
  /** Unique per `.complete()` / `.stream()` call. */
  callId?: string;

  // ─── Layer 2 — LLM client ────────────────────────────────────────────
  /** UUID per LLMClient instance. Set in client ctor. */
  clientId?: string;
  /** Routing key for the network engine's queues. Default formula:
   *  `"$provider/$model"`. NOT overridable from agent (infrastructure). */
  queueName?: string;
  /** Cache key. Computed as content hash by default. Agent MAY override. */
  cacheKey?: string;
  /** Cache namespace. Default: `"default"`. */
  cacheName?: string;
  /** Settings registry key for ConfigurationPlugin. Default formula:
   *  `"$provider/$model"`. Agent MAY override. */
  configName?: string;

  // ─── Provider state (LLM-populated) ──────────────────────────────────
  providerResponseId?: string;
  previousResponseId?: string;
}
