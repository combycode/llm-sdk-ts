/** HookMap — typed event catalog for HookBus.
 *
 *  Each subsystem adds its events here as it lands in the SDK. Keep this
 *  file as the single source of truth (no module-level declaration merging)
 *  so the universe of events is greppable in one place.
 *
 *  Each layer (network, llm, agent, server) and plugin (cache, ...) extends
 *  this interface with the events it emits.
 *
 *  Convention:
 *    - Names always start with `on`.
 *    - Context shape carries the `RequestContext` accumulating IDs when
 *      the event happens during a request lifecycle (vs. lifecycle-only
 *      events like onClientCreate).
 */

import type { ConversationHistory } from '../agent/history';
import type { GuardrailTriggeredContext } from '../agent/guardrail-types';
import type { ApprovalRequest, ApprovalDecision } from '../agent/approval-types';
import type { ContentPart, Message, ToolCallPart } from '../llm/types/messages';
import type { CompletionResponse } from '../llm/types/response';
import type { ErrorKind, LLMError } from '../network/errors';
import type { TraceContext } from '../network/types';
import type { RequestContext } from '../types/request-context';

export type { GuardrailTriggeredContext };

/** Sources known to emit warnings. */
export type WarningSource =
  | 'agent'
  | 'llm'
  | 'network'
  | 'engine'
  | 'queue'
  | 'cache'
  | 'cost'
  | 'context'
  | 'media'
  | 'files'
  | 'persistence'
  | 'server'
  | 'plugin';

export interface WarningContext {
  source: WarningSource;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** An internal SDK invariant was violated — a "should never happen" event, e.g.
 *  a queue worker threw from its pre-`try` setup (which would otherwise hang the
 *  caller forever). Deliberately DISTINCT from `onModelError`: that signals a
 *  provider/model request failure (the provider's fault, expected to recur under
 *  load); this signals a bug in the SDK itself. Keeping them separate stops
 *  engine bugs from polluting per-provider error metrics and makes any occurrence
 *  here independently alert-worthy. */
export interface InternalErrorContext {
  /** Subsystem that raised it. */
  source: WarningSource;
  /** The error the affected caller will be rejected with. */
  error: LLMError;
  /** Queue name when raised inside a queued request, else null. */
  queueName: string | null;
  /** Provider when known, else null. */
  provider: string | null;
}

// ─── Network layer (10 hooks) ────────────────────────────────────────────

/** Queue layer */
export interface EnqueueContext {
  provider: string;
  model: string;
  queueName: string;
  priority: number;
  queueLength: number;
  estimatedTokens: number;
  trace?: TraceContext;
}

export interface DequeueContext {
  provider: string;
  model: string;
  queueName: string;
  waitedMs: number;
  queueLength: number;
  trace?: TraceContext;
}

export interface QueueTimeoutContext {
  provider: string;
  model: string;
  queueName: string;
  waitedMs: number;
  deadline: number;
  trace?: TraceContext;
}

export interface RateLimitUpdateContext {
  provider: string;
  queueName: string;
  source: 'response_headers' | 'rate_limit_error';
  rpmRemaining: number | null;
  tpmRemaining: number | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  resetAt: number | null;
  trace?: TraceContext;
}

/** HTTP layer */
export interface RequestStartContext {
  provider: string;
  model: string;
  queueName: string;
  url: string;
  method: string;
  bodySize: number;
  attempt: number;
  idempotencyKey: string;
  streaming: boolean;
  /** Set true to abort the request. */
  abort?: boolean;
  trace?: TraceContext;
}

export interface RequestCompleteContext {
  provider: string;
  model: string;
  queueName: string;
  status: number;
  headers: Record<string, string>;
  latencyMs: number;
  attempt: number;
  bodySize: number;
  streaming: boolean;
  trace?: TraceContext;
}

export interface ModelErrorContext {
  provider: string;
  model: string;
  queueName: string;
  error: LLMError;
  headers: Record<string, string>;
  attempt: number;
  willRetry: boolean;
  trace?: TraceContext;
}

export interface RateLimitHitContext {
  provider: string;
  model: string;
  queueName: string;
  status: number;
  retryAfterMs: number | null;
  headers: Record<string, string>;
  remainingRequests: number | null;
  remainingTokens: number | null;
  limitRequests: number | null;
  limitTokens: number | null;
  trace?: TraceContext;
}

export interface RetryContext {
  provider: string;
  model: string;
  queueName: string;
  attempt: number;
  backoffMs: number;
  reason: ErrorKind;
  idempotencyKey: string;
  trace?: TraceContext;
}

export interface StreamChunkContext {
  provider: string;
  model: string;
  queueName: string;
  chunkIndex: number;
  raw: unknown;
  trace?: TraceContext;
}

// ─── LLM layer (5 hooks) ────────────────────────────────────────────────

export interface ClientCreateContext {
  clientId: string;
  provider: string;
  model: string;
  mode: 'foreground' | 'background';
  batchable: boolean;
}

export interface ClientDestroyContext {
  clientId: string;
  provider: string;
  model: string;
}

export interface MessageResolveContext {
  provider: string;
  model: string;
  /** Messages being sent. Handlers MAY mutate this array in place
   *  (FilesRegistry resolves file refs; ContextGuard compacts). */
  messages: Message[];
  /** Full system-prompt string. */
  system?: string;
  /** Conversation reference, when caller (AgentLoop) provides it. Enables
   *  ContextGuard to read strategy from history.metadata and mutate history. */
  history?: ConversationHistory;
  /** Set true to abort the request pre-send. */
  abort?: boolean;
  abortReason?: string;
}

export interface BeforeSubmitContext {
  provider: string;
  model: string;
  clientId: string;
  agentId?: string;
  mode: 'foreground' | 'background';
  batchable: boolean;
  /** Provider-formatted request body. */
  request: Record<string, unknown>;
  /** RequestContext IDs accumulated so far. */
  ctx: RequestContext;
  // Control fields — set by Cache plugin to short-circuit:
  intercepted?: boolean;
  resultPromise?: Promise<unknown>;
}

export interface CompletionContext {
  provider: string;
  model: string;
  response: CompletionResponse;
  request: {
    estimatedInputTokens: number;
    inputChars: number;
    messageCount: number;
    hasTools: boolean;
  };
  /** Provider-formatted request body — same object passed to onBeforeSubmit. */
  requestBody?: Record<string, unknown>;
  /** Raw HTTP response body (pre-parsing). Cache stores this so a hit can
   *  replay exact bytes through parseResponse. */
  responseBody?: unknown;
  /** RequestContext IDs accumulated through the call. */
  ctx: RequestContext;
}

// ─── Agent layer (10 hooks) ─────────────────────────────────────────────

export interface AgentCreateContext {
  agentId: string;
  clientId: string;
  provider: string;
  model: string;
  mode: 'foreground' | 'background';
  batchable: boolean;
}

export interface AgentDestroyContext {
  agentId: string;
  clientId: string;
}

export interface RunStartContext {
  runId: string;
  agentId: string;
  userMessage: string | ContentPart[] | Message[];
  model: string;
  system?: string;
  toolNames: string[];
  historyLength: number;
  trace?: TraceContext;
}

export interface StepStartContext {
  runId: string;
  agentId: string;
  step: number;
  type: 'initial' | 'tool_followup';
  messageCount: number;
  estimatedInputTokens: number;
  trace?: TraceContext;
}

export interface StepCompleteContext {
  runId: string;
  agentId: string;
  step: number;
  response: CompletionResponse;
  hasToolCalls: boolean;
  toolCalls: ToolCallPart[];
  willContinue: boolean;
  trace?: TraceContext;
}

export interface ToolCallStartContext {
  runId: string;
  agentId: string;
  step: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Set true to skip execution. */
  skip?: boolean;
  /** Set to use this string as the result without executing. */
  overrideResult?: string;
  trace?: TraceContext;
}

export interface ToolCallCompleteContext {
  runId: string;
  agentId: string;
  step: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string | ContentPart[];
  resultSizeBytes: number;
  latencyMs: number;
  metrics: Map<string, { value: number | string | boolean; type: string }>;
  trace?: TraceContext;
}

export interface ToolCallErrorContext {
  runId: string;
  agentId: string;
  step: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  error: Error;
  latencyMs: number;
  metrics: Map<string, { value: number | string | boolean; type: string }>;
  /** Default true — set false to abort the run. */
  continueOnError?: boolean;
  /** Use this instead of the error message. */
  fallbackResult?: string;
  trace?: TraceContext;
}

export interface RunCompleteContext {
  runId: string;
  agentId: string;
  /** Original input passed to `agent.complete(...)` for this run. */
  userMessage: string | ContentPart[] | Message[];
  reason: 'done' | 'stopped' | 'error' | 'guardrail' | 'max_steps';
  text: string;
  response: CompletionResponse;
  trace?: TraceContext;
}

export interface RunErrorContext {
  runId: string;
  agentId: string;
  step: number;
  error: Error;
  phase: 'build_request' | 'llm_call' | 'tool_execution' | 'parse_response';
  trace?: TraceContext;
}

// ─── Agent — approval (2 hooks) ─────────────────────────────────────────

/** Emitted when the loop suspends at an approval gate waiting for a human decision.
 *  Extends ApprovalRequest (which carries trace) and adds flat runId/agentId so
 *  hook consumers have direct access to those ids without unpacking trace. */
export interface ApprovalRequestedContext extends ApprovalRequest {
  /** The agent-loop run ID this call belongs to (same as trace.requestId). */
  runId: string;
  /** The agent ID / conversation ID (same as trace.sessionId). */
  agentId: string;
}

/** Emitted when the approver returns a decision and the loop resumes. */
export interface ApprovalResolvedContext {
  callId: string;
  toolName: string;
  runId: string;
  agentId: string;
  step: number;
  decision: ApprovalDecision['decision'];
  note?: string;
  trace?: TraceContext;
}

// ─── Cost / Budget (3 hooks) ────────────────────────────────────────────

export interface CostEntry {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  tokens: {
    input: number;
    output: number;
    cached: number;
    cacheWrite: number;
    reasoning: number;
    /** Audio input/output tokens (realtime / audio models), priced separately. */
    audioInput?: number;
    audioOutput?: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
    source: 'provider' | 'calculated' | 'unknown';
  };
  /** Service tier billed (provider's raw name, e.g. 'batch' | 'priority'), when
   *  the provider reported one. The tier whose rates were used for `cost`. */
  serviceTier?: string;
  providerEvidence: Record<string, unknown>;
  tags: Record<string, string | undefined>;
}

export interface CostEntryContext {
  entry: CostEntry;
  runningTotal: number;
  trace?: TraceContext;
}

export interface BudgetWarningContext {
  budgetId: string;
  scope: Record<string, string | undefined>;
  limit: number;
  current: number;
  threshold: number;
  percentage: number;
}

export interface BudgetExceededContext {
  budgetId: string;
  scope: Record<string, string | undefined>;
  limit: number;
  current: number;
  overage: number;
}

// ─── Context (1 hook) ───────────────────────────────────────────────────

export interface ContextMeasureContext {
  provider: string;
  model: string;
  /** Estimated current input tokens. */
  current: number;
  /** Model context window (null if unknown). */
  window: number | null;
  /** current / window, 0-1 (null when window unknown). */
  percentage: number | null;
  accuracy: 'fast' | 'exact';
  messages: Message[];
  system?: string;
  history?: ConversationHistory;
  abort?: boolean;
  abortReason?: string;
  trace?: TraceContext;
}

// ─── Internal tools (3 hooks) ──────────────────────────────────────────

export interface InternalToolCallStartContext {
  toolId: string;
  input: unknown;
  /** Empty string for non-LLM tools. */
  chosenModel: string;
  attempt: number;
}

export interface InternalToolCallCompleteContext {
  toolId: string;
  input: unknown;
  output: unknown;
  /** Empty string for non-LLM tools. */
  chosenModel: string;
  latencyMs: number;
  attempts: number;
  /** Usage from the underlying LLM call, when applicable. */
  usage?: import('../llm/types/response').Usage;
}

export interface InternalToolCallErrorContext {
  toolId: string;
  input: unknown;
  /** Empty string for non-LLM tools. */
  chosenModel: string;
  error: Error;
  attempt: number;
  willRetry: boolean;
}

// ─── Media (2 hooks) ────────────────────────────────────────────────────

export interface MediaGeneratedContext {
  /** MediaOutputPart entries — one per saved media item. */
  parts: Array<import('../llm/types/messages').MediaOutputPart>;
  /** True when MediaStore retained the bytes. */
  stored: boolean;
  provider: string;
  /** `inline` = from inside an LLM response; `media_output` = MediaOutput. */
  source: 'inline' | 'media_output';
  /** Cost-bearing metadata. CostCollector subscribes to this event and
   *  computes via catalog.pricing (perImage, perMChars, perSecond). */
  model?: string;
  mediaType?: 'image' | 'audio' | 'video';
  count?: number;
  /** For audio TTS — chars-billed input. */
  textInput?: string;
  /** For video — generated duration seconds. */
  durationSeconds?: number;
  /** Token usage the provider reported (token-priced media). Lets the cost
   *  engine price gpt-image / gemini-tts by their per-token rates. */
  usage?: import('../llm/types/response').Usage;
  /** The resolution requested — selects a `perUnit[resolution]` rate. */
  resolution?: string;
  /** Provider-reported cost evidence (extracted), when the response carries it. */
  providerEvidence?: Record<string, unknown>;
  /** Trace correlation for this media op (sessionId + minted requestId). */
  trace?: TraceContext;
}

export interface MediaErrorContext {
  id: string;
  type: 'image' | 'audio' | 'video';
  provider: string;
  error: string;
  /** For async ops (video). */
  operationId?: string;
}

// ─── Server layer (3 hooks) ─────────────────────────────────────────────

export interface ServerRequestContext {
  serverId: string;
  requestId: string;
  method: string;
  path: string;
  userId: string | null;
  model: string | null;
}

export interface ServerResponseContext {
  serverId: string;
  requestId: string;
  status: number;
  latencyMs: number;
  userId: string | null;
  model: string | null;
}

export interface AuthFailContext {
  serverId: string;
  requestId: string;
  reason: string;
}

// ─── Network — realtime (WebSocket transport) ────────────────────────────

export interface RealtimeOpenContext {
  provider: string;
  model: string;
  url: string;
}

/** One frame crossed the socket. Carries METADATA only (never the payload) —
 *  size + direction + kind, enough for cost/observability without leaking
 *  conversation content through the hook bus. */
export interface RealtimeFrameContext {
  provider: string;
  model: string;
  direction: 'in' | 'out';
  kind: 'text' | 'binary';
  bytes: number;
}

export interface RealtimeCloseContext {
  provider: string;
  model: string;
  code: number | null;
  reason: string | null;
}

export interface RealtimeErrorContext {
  provider: string;
  model: string;
  error: Error;
}

/** The catalog. Extend per-phase. */
// ─── MCP (plugin) ─────────────────────────────────────────────────────────

export interface McpConnectContext {
  /** The connection's namespace/label. */
  server: string;
  transport: 'stdio' | 'http' | 'ws';
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  trace?: TraceContext;
}

export interface McpToolCallContext {
  server: string;
  tool: string;
  latencyMs: number;
  isError: boolean;
  trace?: TraceContext;
}

export interface McpErrorContext {
  server: string;
  phase: 'connect' | 'request';
  error: Error;
  trace?: TraceContext;
}

export interface HookMap {
  // Cross-cutting
  onWarning: WarningContext;
  onInternalError: InternalErrorContext;
  // Network — queue layer
  onEnqueue: EnqueueContext;
  onDequeue: DequeueContext;
  onQueueTimeout: QueueTimeoutContext;
  onRateLimitUpdate: RateLimitUpdateContext;
  // Network — HTTP layer
  onRequestStart: RequestStartContext;
  onRequestComplete: RequestCompleteContext;
  onModelError: ModelErrorContext;
  onRateLimitHit: RateLimitHitContext;
  onRetry: RetryContext;
  onStreamChunk: StreamChunkContext;
  // Network — realtime (WebSocket)
  onRealtimeOpen: RealtimeOpenContext;
  onRealtimeFrame: RealtimeFrameContext;
  onRealtimeClose: RealtimeCloseContext;
  onRealtimeError: RealtimeErrorContext;
  // LLM layer
  onClientCreate: ClientCreateContext;
  onClientDestroy: ClientDestroyContext;
  onMessageResolve: MessageResolveContext;
  onBeforeSubmit: BeforeSubmitContext;
  onCompletion: CompletionContext;
  // Agent layer
  onAgentCreate: AgentCreateContext;
  onAgentDestroy: AgentDestroyContext;
  onRunStart: RunStartContext;
  onStepStart: StepStartContext;
  onStepComplete: StepCompleteContext;
  onToolCallStart: ToolCallStartContext;
  onToolCallComplete: ToolCallCompleteContext;
  onToolCallError: ToolCallErrorContext;
  onRunComplete: RunCompleteContext;
  onRunError: RunErrorContext;
  onGuardrailTriggered: GuardrailTriggeredContext;
  onApprovalRequested: ApprovalRequestedContext;
  onApprovalResolved: ApprovalResolvedContext;
  // Server layer
  onServerRequest: ServerRequestContext;
  onServerResponse: ServerResponseContext;
  onAuthFail: AuthFailContext;
  // Cost layer (plugin)
  onCostEntry: CostEntryContext;
  onBudgetWarning: BudgetWarningContext;
  onBudgetExceeded: BudgetExceededContext;
  // Context layer (plugin)
  onContextMeasure: ContextMeasureContext;
  // Media layer (plugin)
  onMediaGenerated: MediaGeneratedContext;
  onMediaError: MediaErrorContext;
  // Internal tools (plugin)
  onInternalToolCallStart: InternalToolCallStartContext;
  onInternalToolCallComplete: InternalToolCallCompleteContext;
  onInternalToolCallError: InternalToolCallErrorContext;
  // MCP (plugin)
  onMcpConnect: McpConnectContext;
  onMcpToolCall: McpToolCallContext;
  onMcpError: McpErrorContext;
}

export type HookName = keyof HookMap;
export type HookHandler<K extends HookName> = (ctx: HookMap[K]) => void | Promise<void>;
