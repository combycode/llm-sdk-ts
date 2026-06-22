/** Agent-layer shared types — TokenCounter contract used by ContextRegistry,
 *  ConversationHistory, and the ContextMeasurer plugin.
 *  Also defines AgentTool (executable tool) and run-report types. */

import type { ContentPart, Message } from '../llm/types/messages';
import type { Tool } from '../llm/types/tools';
import type { Usage } from '../llm/types/response';
import type { HistorySnapshot } from './history-types';
import type { PendingToolCall } from './approval-types';
import type { TraceContext } from '../network/types';

export type ContentClass = 'prose' | 'code' | 'mixed' | 'structured';

export interface TokenCountContext {
  provider?: string;
  model?: string;
  contentClass?: ContentClass;
  accuracy?: 'fast' | 'exact';
}

export interface TokenCounter {
  /** Fast estimate — synchronous, no I/O. Used on every request. */
  estimate(text: string, ctx?: TokenCountContext): number;

  /** Estimate for a whole message, including multi-part content. */
  estimateMessage(msg: Message, ctx?: TokenCountContext): number;

  /** Accurate count — may perform I/O (lazy tokenizer load, API call). */
  measure(text: string, ctx?: TokenCountContext): Promise<number>;

  /** Accurate count for a whole message. */
  measureMessage(msg: Message, ctx?: TokenCountContext): Promise<number>;

  /** Feed actual usage for calibration refinement. */
  learn(input: LearnInput): void;
}

export interface LearnInput {
  provider: string;
  model: string;
  bytesSent: number;
  actualTokens: number;
  contentClass?: ContentClass;
  timestamp?: number;
}

// ─── Agent tools (executable wrapper around a Tool schema) ───────────────

export interface AgentTool {
  /** Tool schema sent to the LLM. */
  definition: Tool;
  /** Execute the tool. Return string or structured content. */
  execute: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<string | ContentPart[]>;
}

export interface ToolExecutionContext {
  step: number;
  callId: string;
  signal: AbortSignal;
  metrics: Map<string, { value: number | string | boolean; type: string }>;
  /** Run trace identity: sessionId = agentId (ConversationHistory id),
   *  requestId = runId for this .complete()/.stream() invocation,
   *  callId = this tool call's id (same as ctx.callId). */
  trace?: TraceContext;
}

// ─── Reports (kept as `lastReport` on AgentLoop) ─────────────────────────

export interface ToolCallReport {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  resultSizeBytes: number;
  latencyMs: number;
  skipped: boolean;
  error: string | null;
  metrics: Record<string, { value: number | string | boolean; type: string }>;
}

export interface StepReport {
  index: number;
  type: 'initial' | 'tool_followup';
  llmLatencyMs: number;
  usage: Usage;
  finishReason: string;
  toolCalls: ToolCallReport[];
  toolTotalMs: number;
}

export interface AgentRunReport {
  id: string;
  model: string;
  startedAt: number;
  completedAt: number;
  totalMs: number;
  reason: 'done' | 'stopped' | 'error' | 'guardrail' | 'max_steps';
  userMessage: string | ContentPart[] | Message[];
  finalText: string;
  error?: string;
  steps: StepReport[];
  stepCount: number;
  toolCallCount: number;
  totalUsage: Usage;
  totalLlmTimeMs: number;
  totalToolTimeMs: number;
}

// ─── Stream events ───────────────────────────────────────────────────────

export type AgentStreamEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_call_start';
      step: number;
      callId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | { type: 'tool_call_end'; step: number; callId: string; latencyMs: number }
  | { type: 'step_end'; step: number; usage: Usage; latencyMs: number }
  | { type: 'done'; response: import('../llm/types/response').CompletionResponse };

// ─── Snapshot (serializable AgentLoop state) ─────────────────────────────

export interface AgentLoopSnapshot {
  version: 1;
  system: string;
  context: string;
  history: HistorySnapshot;
  toolNames: string[];
  reports: AgentRunReport[];
  metadata: Record<string, unknown>;
  createdAt: number;
  savedAt: number;
  /** Tool calls suspended awaiting human approval. Present when the loop was
   *  checkpointed at an approval gate. Empty or absent otherwise. */
  pendingToolCalls?: PendingToolCall[];
}

export type { PendingToolCall };
