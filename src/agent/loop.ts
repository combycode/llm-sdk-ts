/** AgentLoop — Layer 3 multi-step orchestration.
 *
 *  Drives a conversation through `client.complete` / `client.stream` until
 *  the model returns a response without tool calls (or `stop()` is called).
 *  Owns: history, executable tools, agent-level hooks, run reports.
 *
 *  Reshape vs old llm-sdk loop:
 *    - `model` removed from config — read from `client.model`.
 *    - `system` lives in history.registry as `agentloop.system` layer.
 *    - `complete(input, options?)` returns CompletionResponse (not AgentRunResult).
 *    - `lastReport` getter exposes run-level details (step/tool reports).
 *    - Input shapes (`string | ContentPart[] | Message[]`) APPEND to history. */

import { HookBus } from '../bus/hook-bus';
import {
  contentText,
  type ContentPart,
  type Message,
  type ToolCallPart,
} from '../llm/types/messages';
import type { ExecuteOptions } from '../llm/types/options';
import type { CacheConfig, ThinkingConfig } from '../llm/types/request';
import { emptyUsage, type CompletionResponse, type Usage } from '../llm/types/response';
import type { LLMClient } from '../llm/client';
import { parseStructured as parseStructuredText } from '../llm/client-internal';
import { writeAgentLoopContext, writeAgentLoopSystem } from './context-registry/layers';
import { ConversationHistory } from './history';
import type {
  AgentLoopSnapshot,
  AgentRunReport,
  AgentStreamEvent,
  AgentTool,
  StepReport,
  ToolCallReport,
} from './types';
import type { Guardrail, GuardrailDecision } from './guardrail-types';
import { toolKey } from './tool-key';
import type { AgentLoopConfig } from './loop-config';
import type { PermissionPolicy } from '../plugins/permissions/policy';
import type { ApprovalRequest, ApprovalDecision, PendingToolCall } from './approval-types';
import {
  makeStepState,
  accumulateStreamEvent,
  finalizeUnendedToolCalls,
  buildStepResponse,
  lookupToolOrError,
  executeWithTimeout,
  handleToolError,
} from './loop-internals';

// ─── AgentLoop ──────────────────────────────────────────────────────────

export class AgentLoop {
  readonly id: string;
  readonly client: LLMClient;
  readonly hooks: HookBus;

  private _system: string;
  private _systemThunk: (() => string | Promise<string>) | null = null;
  private _context: string;
  private _tools: Map<string, AgentTool>;
  private _history: ConversationHistory;
  private _reports: AgentRunReport[] = [];
  private _metadata: Record<string, unknown> = {};

  private _maxTokens?: number;
  private _temperature?: number;
  private _thinking?: ThinkingConfig;
  private _cache?: CacheConfig;

  private _parallelToolCalls: boolean;
  private _toolTimeout: number;
  private _maxSteps: number;
  private _guardrails: Guardrail[];
  private _policy: PermissionPolicy | null;
  private _approve: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | null;
  private _checkpoint: import('../plugins/persistence/types').Persistence | null;

  /** Tool calls suspended awaiting human approval (populated during a durable pause). */
  private _pendingToolCalls: PendingToolCall[] = [];

  private _running = false;
  private _stopRequested = false;
  private _abortController: AbortController | null = null;

  constructor(config: AgentLoopConfig) {
    if (!config.client) throw new Error('AgentLoop: client is required');

    this.client = config.client;
    this.hooks = config.hooks ?? new HookBus();
    if (typeof config.system === 'function') {
      this._systemThunk = config.system;
      this._system = '';
    } else {
      this._system = config.system ?? '';
    }
    this._context = config.context ?? '';
    this._maxTokens = config.maxTokens;
    this._temperature = config.temperature;
    this._thinking = config.thinking;
    this._cache = config.cache;
    this._parallelToolCalls = config.parallelToolCalls ?? true;
    this._toolTimeout = config.toolTimeout ?? DEFAULT_TOOL_TIMEOUT_MS;
    this._maxSteps =
      config.maxSteps !== undefined && config.maxSteps > 0
        ? config.maxSteps
        : DEFAULT_MAX_STEPS;
    this._guardrails = config.guardrails ?? [];
    this._policy = config.policy ?? null;
    this._approve = config.approve ?? null;
    this._checkpoint = config.checkpoint ?? null;

    this._tools = new Map();
    for (const t of config.tools ?? []) {
      this._tools.set(toolKey(t), t);
    }

    if (config.history instanceof ConversationHistory) {
      this._history = config.history;
    } else if (config.history) {
      this._history = ConversationHistory.import(config.history);
    } else {
      this._history = new ConversationHistory();
    }

    this.id = this._history.id;

    // Publish loop-level system/context into the history's ContextRegistry so
    // they flow through the same composition pipeline as ContextGuard facts,
    // memory layers, etc. See `context-registry/layers.ts` for priorities.
    writeAgentLoopSystem(this._history.registry, this._system, 'agent-loop');
    writeAgentLoopContext(this._history.registry, this._context, 'agent-loop');

    this.hooks.emitSync('onAgentCreate', {
      agentId: this.id,
      clientId: this.client.id,
      provider: this.client.provider,
      model: this.client.model,
      mode: this.client.mode,
      batchable: this.client.batchable,
    });
  }

  destroy(): void {
    this.hooks.emitSync('onAgentDestroy', {
      agentId: this.id,
      clientId: this.client.id,
    });
  }

  // ─── State accessors ────────────────────────────────────────────────────

  /** Model is owned by client. */
  get model(): string {
    return this.client.model;
  }

  get system(): string {
    return this._system;
  }
  set system(v: string) {
    this._system = v;
    writeAgentLoopSystem(this._history.registry, v, 'agent-loop');
  }

  get context(): string {
    return this._context;
  }
  set context(v: string) {
    this._context = v;
    writeAgentLoopContext(this._history.registry, v, 'agent-loop');
  }

  get history(): ConversationHistory {
    return this._history;
  }

  get running(): boolean {
    return this._running;
  }

  get reports(): readonly AgentRunReport[] {
    return this._reports;
  }

  get lastReport(): AgentRunReport | null {
    return this._reports.at(-1) ?? null;
  }

  get metadata(): Record<string, unknown> {
    return this._metadata;
  }

  addTool(tool: AgentTool): void {
    this._tools.set(toolKey(tool), tool);
  }

  removeTool(name: string): void {
    this._tools.delete(name);
  }

  toolNames(): string[] {
    return [...this._tools.keys()];
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  stop(): void {
    this._stopRequested = true;
    this._abortController?.abort();
  }

  // ─── complete (non-streaming) ───────────────────────────────────────────

  async complete(
    input: string | ContentPart[] | Message[],
    options: ExecuteOptions = {},
  ): Promise<CompletionResponse> {
    const { runId, startedAt, startPerf, userMessageText, runTrace } = await this.beginRun(input);

    const steps: StepReport[] = [];
    const totalUsage = emptyUsage();
    let totalLlmTimeMs = 0;
    let totalToolTimeMs = 0;
    let stepCount = 0;
    let toolCallCount = 0;
    let lastResponse: CompletionResponse | null = null;
    let reason: 'done' | 'stopped' | 'error' | 'guardrail' | 'max_steps' = 'done';
    let errorMsg: string | undefined;
    let guardrailTripReason: string | undefined;

    try {
      while (true) {
        if (this._stopRequested) {
          reason = 'stopped';
          break;
        }

        const stepType: 'initial' | 'tool_followup' = stepCount === 0 ? 'initial' : 'tool_followup';

        await this.hooks.emit('onStepStart', {
          runId,
          agentId: this.id,
          step: stepCount,
          type: stepType,
          messageCount: this._history.length,
          estimatedInputTokens: this._history.estimatedTokens(),
          trace: runTrace,
        });

        const stepStart = performance.now();

        // Send full history as Message[] (input → REPLACE on LLMClient).
        // Compose system from registry layers (LAYER_AGENTLOOP_SYSTEM + any
        // 'system'-tagged contributors like context-guard.summary, facts).
        const composedSystem = this._history.registry.flat({ tag: 'system' });
        const composedSystemStr =
          options.system ?? (composedSystem.length > 0 ? composedSystem : undefined);

        // Run input guardrails before the LLM call.
        const inputTrip = await this.runInputGuardrails(
          runId, stepCount, this._history.messages(),
          Array.isArray(composedSystemStr)
            ? composedSystemStr.join('\n')
            : (composedSystemStr as string | undefined),
          runTrace,
        );
        if (inputTrip) {
          reason = 'guardrail';
          guardrailTripReason = inputTrip;
          break;
        }

        lastResponse = await this.client.complete(this._history.messages(), {
          ...options,
          system: composedSystemStr,
          history: options.history ?? this._history,
          maxTokens: options.maxTokens ?? this._maxTokens,
          temperature: options.temperature ?? this._temperature,
          thinking: options.thinking ?? this._thinking,
          cache: options.cache ?? this._cache,
          tools: this.toolDefinitions(options),
          ctx: { ...options.ctx, conversationId: this._history.id },
          signal: options.signal ?? this._abortController?.signal,
        });

        const stepLatency = performance.now() - stepStart;
        totalLlmTimeMs += stepLatency;
        addUsage(totalUsage, lastResponse.usage);

        this._history.append(
          { role: 'assistant', content: lastResponse.content },
          { model: this.client.model, usage: lastResponse.usage, latencyMs: stepLatency },
        );

        const hasToolCalls =
          lastResponse.finishReason === 'tool_use' && lastResponse.toolCalls.length > 0;

        await this.hooks.emit('onStepComplete', {
          runId,
          agentId: this.id,
          step: stepCount,
          response: lastResponse,
          hasToolCalls,
          toolCalls: lastResponse.toolCalls,
          willContinue: hasToolCalls && !this._stopRequested,
          trace: runTrace,
        });

        // Run output guardrails after the step response is produced.
        const outputTrip = await this.runOutputGuardrails(runId, stepCount, lastResponse, runTrace);
        if (outputTrip) {
          reason = 'guardrail';
          guardrailTripReason = outputTrip;
          break;
        }

        const stepToolReports: ToolCallReport[] = [];
        let stepToolTimeMs = 0;

        if (hasToolCalls) {
          const toolResults = await this.executeToolCalls(
            runId,
            stepCount,
            lastResponse.toolCalls,
            stepToolReports,
            runTrace,
          );
          stepToolTimeMs = stepToolReports.reduce((sum, r) => sum + r.latencyMs, 0);
          totalToolTimeMs += stepToolTimeMs;
          toolCallCount += lastResponse.toolCalls.length;

          this._history.append({ role: 'tool', content: toolResults });
        }

        steps.push({
          index: stepCount,
          type: stepType,
          llmLatencyMs: stepLatency,
          usage: lastResponse.usage,
          finishReason: lastResponse.finishReason,
          toolCalls: stepToolReports,
          toolTotalMs: stepToolTimeMs,
        });

        stepCount++;

        if (!hasToolCalls) break;

        if (stepCount >= this._maxSteps) {
          reason = 'max_steps';
          break;
        }
      }
    } catch (e) {
      reason = 'error';
      errorMsg = e instanceof Error ? e.message : String(e);

      await this.hooks.emit('onRunError', {
        runId,
        agentId: this.id,
        step: stepCount,
        error: e instanceof Error ? e : new Error(String(e)),
        phase: 'llm_call',
        trace: runTrace,
      });
    } finally {
      this._running = false;
      this._abortController = null;
    }

    // Compose final CompletionResponse — total usage, last step's content/text.
    const finalText =
      reason === 'guardrail'
        ? (guardrailTripReason ?? '')
        : reason === 'max_steps'
          ? `stopped: reached maxSteps (${this._maxSteps})`
          : (lastResponse?.text ?? '');
    const finalContent = lastResponse?.content ?? [];
    const finalResponse: CompletionResponse = {
      id: lastResponse?.id ?? `agent-${runId}`,
      model: this.client.model,
      content: finalContent,
      finishReason:
        reason === 'done'
          ? 'stop'
          : reason === 'stopped'
            ? 'stop'
            : reason === 'guardrail'
              ? 'stop'
              : reason === 'max_steps'
                ? 'length'
                : 'error',
      usage: totalUsage,
      text: finalText,
      toolCalls: lastResponse?.toolCalls ?? [],
      thinking: lastResponse?.thinking ?? null,
      media: lastResponse?.media ?? [],
      latencyMs: performance.now() - startPerf,
      raw: lastResponse?.raw ?? null,
    };

    await this.finalizeRun({
      runId,
      startedAt,
      startPerf,
      userMessage: input,
      userMessageText,
      finalText,
      reason,
      error: errorMsg,
      response: finalResponse,
      steps,
      stepCount,
      toolCallCount,
      totalUsage,
      totalLlmTimeMs,
      totalToolTimeMs,
      runTrace,
    });

    return finalResponse;
  }

  /** Run `complete` with a JSON Schema enforced via `structured`, then
   *  JSON.parse the response text. Tool calls are still allowed within the
   *  loop; only the FINAL turn is constrained. */
  async structuredComplete<T = unknown>(
    input: string | ContentPart[] | Message[],
    schema: Record<string, unknown>,
    options: ExecuteOptions = {},
  ): Promise<T> {
    const res = await this.complete(input, {
      ...options,
      structured: { ...(options.structured ?? {}), schema },
    });
    return parseStructuredText<T>(res.text);
  }

  // ─── stream ─────────────────────────────────────────────────────────────

  async *stream(
    input: string | ContentPart[] | Message[],
    options: ExecuteOptions = {},
  ): AsyncIterable<AgentStreamEvent> {
    const { runId, startedAt, startPerf, userMessageText, runTrace } = await this.beginRun(input);

    const steps: StepReport[] = [];
    const totalUsage = emptyUsage();
    let totalLlmTimeMs = 0;
    let totalToolTimeMs = 0;
    let stepCount = 0;
    let toolCallCount = 0;
    let finalText = '';
    let finalContent: ContentPart[] = [];
    let lastResponse: CompletionResponse | null = null;
    let reason: 'done' | 'stopped' | 'error' | 'guardrail' | 'max_steps' = 'done';
    let errorMsg: string | undefined;
    let guardrailTripReason: string | undefined;

    try {
      while (true) {
        if (this._stopRequested) {
          reason = 'stopped';
          break;
        }

        const stepType: 'initial' | 'tool_followup' = stepCount === 0 ? 'initial' : 'tool_followup';
        yield { type: 'step_start', step: stepCount };

        await this.hooks.emit('onStepStart', {
          runId,
          agentId: this.id,
          step: stepCount,
          type: stepType,
          messageCount: this._history.length,
          estimatedInputTokens: this._history.estimatedTokens(),
          trace: runTrace,
        });

        const stepStart = performance.now();
        const state = makeStepState();

        const composedSystemStream = this._history.registry.flat({ tag: 'system' });
        const composedSystemForStream =
          options.system ?? (composedSystemStream.length > 0 ? composedSystemStream : undefined);

        // Run input guardrails before the streaming LLM call.
        const streamInputTrip = await this.runInputGuardrails(
          runId, stepCount, this._history.messages(),
          Array.isArray(composedSystemForStream)
            ? composedSystemForStream.join('\n')
            : (composedSystemForStream as string | undefined),
          runTrace,
        );
        if (streamInputTrip) {
          reason = 'guardrail';
          guardrailTripReason = streamInputTrip;
          break;
        }

        for await (const event of this.client.stream(this._history.messages(), {
          ...options,
          system: composedSystemForStream,
          history: options.history ?? this._history,
          maxTokens: options.maxTokens ?? this._maxTokens,
          temperature: options.temperature ?? this._temperature,
          thinking: options.thinking ?? this._thinking,
          cache: options.cache ?? this._cache,
          tools: this.toolDefinitions(options),
          ctx: { ...options.ctx, conversationId: this._history.id },
          signal: options.signal ?? this._abortController?.signal,
        })) {
          const toYield = accumulateStreamEvent(event, state);
          if (toYield) yield toYield;
        }

        finalizeUnendedToolCalls(state);

        const { response: stepResponse, content, stepLatency } = buildStepResponse(
          state,
          this.client.model,
          stepStart,
        );

        totalLlmTimeMs += stepLatency;
        addUsage(totalUsage, state.stepUsage);
        finalContent = content;
        finalText = state.stepText;
        lastResponse = stepResponse;

        this._history.append(
          { role: 'assistant', content },
          { model: this.client.model, usage: state.stepUsage, latencyMs: stepLatency },
        );

        const hasToolCalls = state.stepToolCalls.length > 0;

        await this.hooks.emit('onStepComplete', {
          runId,
          agentId: this.id,
          step: stepCount,
          response: stepResponse,
          hasToolCalls,
          toolCalls: state.stepToolCalls,
          willContinue: hasToolCalls && !this._stopRequested,
          trace: runTrace,
        });

        // Run output guardrails after the step response.
        const streamOutputTrip = await this.runOutputGuardrails(
          runId, stepCount, stepResponse, runTrace,
        );
        if (streamOutputTrip) {
          reason = 'guardrail';
          guardrailTripReason = streamOutputTrip;
          break;
        }

        yield { type: 'step_end', step: stepCount, usage: state.stepUsage, latencyMs: stepLatency };

        const stepToolReports: ToolCallReport[] = [];
        let stepToolTimeMs = 0;

        if (hasToolCalls) {
          yield* this.emitToolCallStarts(stepCount, state.stepToolCalls);

          const toolResults = await this.executeToolCalls(
            runId,
            stepCount,
            state.stepToolCalls,
            stepToolReports,
            runTrace,
          );
          stepToolTimeMs = stepToolReports.reduce((sum, r) => sum + r.latencyMs, 0);
          totalToolTimeMs += stepToolTimeMs;
          toolCallCount += state.stepToolCalls.length;

          yield* this.emitToolCallEnds(stepCount, stepToolReports);

          this._history.append({ role: 'tool', content: toolResults });
        }

        steps.push({
          index: stepCount,
          type: stepType,
          llmLatencyMs: stepLatency,
          usage: state.stepUsage,
          finishReason: state.stepFinishReason,
          toolCalls: stepToolReports,
          toolTotalMs: stepToolTimeMs,
        });

        stepCount++;

        if (!hasToolCalls) break;

        if (stepCount >= this._maxSteps) {
          reason = 'max_steps';
          break;
        }
      }
    } catch (e) {
      reason = 'error';
      errorMsg = e instanceof Error ? e.message : String(e);
      await this.hooks.emit('onRunError', {
        runId,
        agentId: this.id,
        step: stepCount,
        error: e instanceof Error ? e : new Error(String(e)),
        phase: 'llm_call',
        trace: runTrace,
      });
    } finally {
      this._running = false;
      this._abortController = null;
    }

    if (reason === 'guardrail') finalText = guardrailTripReason ?? '';
    if (reason === 'max_steps') finalText = `stopped: reached maxSteps (${this._maxSteps})`;

    const finalResponse: CompletionResponse = {
      id: lastResponse?.id ?? `agent-${runId}`,
      model: this.client.model,
      content: finalContent,
      finishReason:
        reason === 'done'
          ? 'stop'
          : reason === 'stopped'
            ? 'stop'
            : reason === 'guardrail'
              ? 'stop'
              : reason === 'max_steps'
                ? 'length'
                : 'error',
      usage: totalUsage,
      text: finalText,
      toolCalls: lastResponse?.toolCalls ?? [],
      thinking: lastResponse?.thinking ?? null,
      media: [],
      latencyMs: performance.now() - startPerf,
      raw: null,
    };

    await this.finalizeRun({
      runId,
      startedAt,
      startPerf,
      userMessage: input,
      userMessageText,
      finalText,
      reason,
      error: errorMsg,
      response: finalResponse,
      steps,
      stepCount,
      toolCallCount,
      totalUsage,
      totalLlmTimeMs,
      totalToolTimeMs,
      runTrace,
    });

    yield { type: 'done', response: finalResponse };
  }

  /** Yield tool_call_start events for all tool calls in this step. */
  private *emitToolCallStarts(
    step: number,
    toolCalls: ToolCallPart[],
  ): IterableIterator<AgentStreamEvent> {
    for (const tc of toolCalls) {
      yield {
        type: 'tool_call_start',
        step,
        callId: tc.id,
        toolName: tc.name,
        arguments: tc.arguments,
      };
    }
  }

  /** Yield tool_call_end events for all completed tool reports. */
  private *emitToolCallEnds(
    step: number,
    reports: ToolCallReport[],
  ): IterableIterator<AgentStreamEvent> {
    for (const r of reports) {
      yield { type: 'tool_call_end', step, callId: r.callId, latencyMs: r.latencyMs };
    }
  }

  // ─── Tool execution ─────────────────────────────────────────────────────

  private async executeToolCalls(
    runId: string,
    step: number,
    toolCalls: ToolCallPart[],
    reports: ToolCallReport[],
    runTrace: { sessionId: string; requestId: string },
  ): Promise<ContentPart[]> {
    if (this._parallelToolCalls && toolCalls.length > 1) {
      return Promise.all(toolCalls.map((tc) => this.executeSingleTool(tc, runId, step, reports, runTrace)));
    }
    const results: ContentPart[] = [];
    for (const tc of toolCalls) {
      results.push(await this.executeSingleTool(tc, runId, step, reports, runTrace));
    }
    return results;
  }

  private async executeSingleTool(
    tc: ToolCallPart,
    runId: string,
    step: number,
    reports: ToolCallReport[],
    runTrace: { sessionId: string; requestId: string },
  ): Promise<ContentPart> {
    const metrics = new Map<string, { value: number | string | boolean; type: string }>();

    const beforeCtx = {
      runId,
      agentId: this.id,
      step,
      callId: tc.id,
      toolName: tc.name,
      arguments: tc.arguments,
      skip: undefined as boolean | undefined,
      overrideResult: undefined as string | undefined,
      trace: runTrace,
    };
    await this.hooks.emit('onToolCallStart', beforeCtx);

    if (beforeCtx.skip) {
      return this.buildSkippedResult(tc, beforeCtx.overrideResult, reports);
    }

    if (beforeCtx.overrideResult !== undefined) {
      return this.buildOverriddenResult(tc, beforeCtx.overrideResult, reports);
    }

    const toolStart = performance.now();
    const lookup = await lookupToolOrError(
      tc,
      this._tools,
      this.hooks,
      runId,
      this.id,
      step,
      metrics,
      reports,
      toolStart,
      runTrace,
    );
    if (!lookup.found) return lookup.errorResult;

    // ─── Permission check ────────────────────────────────────────────────
    if (this._policy !== null) {
      const target: import('../plugins/permissions/types').PermissionTarget = {
        kind: 'tool',
        toolName: tc.name,
      };
      const decision = this._policy.check('agent', target, 'execute');

      if (decision.ask) {
        return this.runApprovalGate(tc, runId, step, decision.reason, metrics, reports, toolStart, runTrace, lookup.tool);
      }

      if (!decision.allow) {
        return this.buildDeniedResult(tc, decision.reason ?? DENIAL_DEFAULT_REASON, reports);
      }
    }

    // ─── Execute ─────────────────────────────────────────────────────────
    try {
      const baseCtx = { step, callId: tc.id, metrics, trace: { sessionId: runTrace.sessionId, requestId: runTrace.requestId, callId: tc.id } };
      const result = await executeWithTimeout(lookup.tool, tc, baseCtx, this._toolTimeout);
      return await this.buildSuccessResult(tc, result, runId, step, metrics, reports, toolStart, runTrace);
    } catch (e) {
      return handleToolError(e, tc, this.hooks, runId, this.id, step, metrics, reports, toolStart, runTrace);
    }
  }

  /** Build a skipped-tool result content part and push the report. */
  private buildSkippedResult(
    tc: ToolCallPart,
    overrideResult: string | undefined,
    reports: ToolCallReport[],
  ): ContentPart {
    const result = overrideResult ?? 'Tool call skipped by hook';
    reports.push({
      callId: tc.id,
      toolName: tc.name,
      arguments: tc.arguments,
      resultSizeBytes: result.length,
      latencyMs: 0,
      skipped: true,
      error: null,
      metrics: {},
    });
    return { type: 'tool_result', id: tc.id, content: result };
  }

  /** Build an overridden-tool result content part and push the report. */
  private buildOverriddenResult(
    tc: ToolCallPart,
    result: string,
    reports: ToolCallReport[],
  ): ContentPart {
    reports.push({
      callId: tc.id,
      toolName: tc.name,
      arguments: tc.arguments,
      resultSizeBytes: result.length,
      latencyMs: 0,
      skipped: false,
      error: null,
      metrics: {},
    });
    return { type: 'tool_result', id: tc.id, content: result };
  }

  /** Build a denied-tool result (policy deny) and push the report. */
  private buildDeniedResult(
    tc: ToolCallPart,
    reason: string,
    reports: ToolCallReport[],
  ): ContentPart {
    reports.push({
      callId: tc.id,
      toolName: tc.name,
      arguments: tc.arguments,
      resultSizeBytes: reason.length,
      latencyMs: 0,
      skipped: false,
      error: reason,
      metrics: {},
    });
    return { type: 'tool_result', id: tc.id, content: reason, isError: true };
  }

  /** Suspend at the approval gate: emit hooks, optionally persist, await decision. */
  private async runApprovalGate(
    tc: ToolCallPart,
    runId: string,
    step: number,
    reason: string | undefined,
    metrics: Map<string, { value: number | string | boolean; type: string }>,
    reports: ToolCallReport[],
    toolStart: number,
    runTrace: { sessionId: string; requestId: string },
    tool: AgentTool,
  ): Promise<ContentPart> {
    const req: ApprovalRequest = {
      callId: tc.id,
      toolName: tc.name,
      arguments: tc.arguments,
      reason,
      step,
      trace: { sessionId: runTrace.sessionId, requestId: runTrace.requestId, callId: tc.id },
    };

    const pending: PendingToolCall = {
      callId: tc.id,
      toolName: tc.name,
      arguments: tc.arguments,
      step,
      requestedAt: Date.now(),
      runId,
    };
    this._pendingToolCalls.push(pending);

    await this.hooks.emit('onApprovalRequested', { ...req, runId, agentId: this.id });

    if (this._checkpoint !== null) {
      const snap = this.dump();
      await this._checkpoint.set(CHECKPOINT_KEY_PREFIX + this.id, snap);
    }

    const decision = await this.resolveApproval(req);

    this._pendingToolCalls = this._pendingToolCalls.filter((p) => p.callId !== tc.id);

    await this.hooks.emit('onApprovalResolved', {
      callId: tc.id,
      toolName: tc.name,
      runId,
      agentId: this.id,
      step,
      decision: decision.decision,
      note: decision.note,
      trace: runTrace,
    });

    if (decision.decision === 'approve') {
      if (decision.overrideResult !== undefined) {
        return this.buildOverriddenResult(tc, decision.overrideResult, reports);
      }
      try {
        const baseCtx = { step, callId: tc.id, metrics, trace: { sessionId: runTrace.sessionId, requestId: runTrace.requestId, callId: tc.id } };
        const result = await executeWithTimeout(tool, tc, baseCtx, this._toolTimeout);
        return await this.buildSuccessResult(tc, result, runId, step, metrics, reports, toolStart, runTrace);
      } catch (e) {
        return handleToolError(e, tc, this.hooks, runId, this.id, step, metrics, reports, toolStart, runTrace);
      }
    }

    if (decision.decision === 'skip') {
      return this.buildSkippedResult(tc, decision.overrideResult, reports);
    }

    const denyMsg = decision.note ?? DENIAL_DEFAULT_REASON;
    return this.buildDeniedResult(tc, denyMsg, reports);
  }

  /** Emit onToolCallComplete, push report, and return success content part. */
  private async buildSuccessResult(
    tc: ToolCallPart,
    result: string | ContentPart[],
    runId: string,
    step: number,
    metrics: Map<string, { value: number | string | boolean; type: string }>,
    reports: ToolCallReport[],
    toolStart: number,
    runTrace: { sessionId: string; requestId: string },
  ): Promise<ContentPart> {
    const latencyMs = performance.now() - toolStart;
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    await this.hooks.emit('onToolCallComplete', {
      runId,
      agentId: this.id,
      step,
      callId: tc.id,
      toolName: tc.name,
      arguments: tc.arguments,
      result,
      resultSizeBytes: resultStr.length,
      latencyMs,
      metrics,
      trace: runTrace,
    });

    reports.push({
      callId: tc.id,
      toolName: tc.name,
      arguments: tc.arguments,
      resultSizeBytes: resultStr.length,
      latencyMs,
      skipped: false,
      error: null,
      metrics: Object.fromEntries(metrics),
    });
    return { type: 'tool_result', id: tc.id, content: resultStr };
  }

  /** Merge agent's tool definitions with caller-provided tools (caller wins on conflict). */
  private toolDefinitions(
    options: ExecuteOptions,
  ): import('../llm/types/tools').Tool[] | undefined {
    const own = [...this._tools.values()].map((t) => t.definition);
    if (options.tools) return [...own, ...options.tools];
    return own.length > 0 ? own : undefined;
  }

  // ─── Run helpers ────────────────────────────────────────────────────────

  private async beginRun(input: string | ContentPart[] | Message[]): Promise<{
    runId: string;
    startedAt: number;
    startPerf: number;
    userMessageText: string;
    runTrace: { sessionId: string; requestId: string };
  }> {
    if (this._running) throw new Error('AgentLoop is already running');
    this._running = true;
    this._stopRequested = false;
    this._abortController = new AbortController();

    // Re-evaluate the system thunk so live-reload prompts (config files,
    // collection-backed prompts) pick up changes between runs.
    if (this._systemThunk) {
      const next = await this._systemThunk();
      if (next !== this._system) {
        this._system = next;
        writeAgentLoopSystem(this._history.registry, next, 'agent-loop');
      }
    }

    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    const startPerf = performance.now();

    const userMessageText =
      typeof input === 'string'
        ? input
        : Array.isArray(input) && input.length > 0 && 'role' in input[0]
          ? contentText((input[input.length - 1] as Message).content)
          : contentText(input as ContentPart[]);

    const runTrace = { sessionId: this.id, requestId: runId };
    await this.hooks.emit('onRunStart', {
      runId,
      agentId: this.id,
      userMessage: input,
      model: this.client.model,
      system: this._history.system,
      toolNames: [...this._tools.keys()],
      historyLength: this._history.length,
      trace: runTrace,
    });

    // Append (NOT replace). For Message[], append each; for string/ContentPart[], wrap as user.
    if (typeof input === 'string') {
      this._history.append({ role: 'user', content: input });
    } else if (Array.isArray(input) && input.length > 0 && 'role' in input[0]) {
      for (const m of input as Message[]) this._history.append(m);
    } else {
      this._history.append({ role: 'user', content: input as ContentPart[] });
    }

    return { runId, startedAt, startPerf, userMessageText, runTrace };
  }

  private async finalizeRun(args: {
    runId: string;
    startedAt: number;
    startPerf: number;
    userMessage: string | ContentPart[] | Message[];
    userMessageText: string;
    finalText: string;
    reason: 'done' | 'stopped' | 'error' | 'guardrail' | 'max_steps';
    error?: string;
    response: CompletionResponse;
    steps: StepReport[];
    stepCount: number;
    toolCallCount: number;
    totalUsage: Usage;
    totalLlmTimeMs: number;
    totalToolTimeMs: number;
    runTrace: { sessionId: string; requestId: string };
  }): Promise<AgentRunReport> {
    const report: AgentRunReport = {
      id: args.runId,
      model: this.client.model,
      startedAt: args.startedAt,
      completedAt: Date.now(),
      totalMs: performance.now() - args.startPerf,
      reason: args.reason,
      userMessage: args.userMessage,
      finalText: args.finalText,
      error: args.error,
      steps: args.steps,
      stepCount: args.stepCount,
      toolCallCount: args.toolCallCount,
      totalUsage: args.totalUsage,
      totalLlmTimeMs: args.totalLlmTimeMs,
      totalToolTimeMs: args.totalToolTimeMs,
    };
    this._reports.push(report);
    await this.hooks.emit('onRunComplete', {
      runId: args.runId,
      agentId: this.id,
      userMessage: args.userMessage,
      reason: args.reason,
      text: args.finalText,
      response: args.response,
      trace: args.runTrace,
    });
    return report;
  }

  // ─── Guardrail runners ──────────────────────────────────────────────────

  /** Run all input-kind guardrails in order. Returns the trip reason on the first
   *  tripwire, or null when all pass. Emits onGuardrailTriggered on trip. */
  private async runInputGuardrails(
    runId: string,
    step: number,
    messages: import('../llm/types/messages').Message[],
    system: string | undefined,
    runTrace: { sessionId: string; requestId: string },
  ): Promise<string | null> {
    for (const g of this._guardrails) {
      if (g.kind !== 'input') continue;
      const decision: GuardrailDecision = await g.check({
        kind: 'input',
        trace: { sessionId: runTrace.sessionId, requestId: runTrace.requestId },
        step,
        messages,
        system,
      });
      if (!decision.pass && decision.tripwire) {
        await this.hooks.emit('onGuardrailTriggered', {
          runId,
          agentId: this.id,
          step,
          guardrailName: g.name,
          kind: 'input',
          reason: decision.reason,
          severity: decision.severity,
          trace: runTrace,
        });
        return decision.reason;
      }
    }
    return null;
  }

  /** Run all output-kind guardrails in order. Returns the trip reason on the first
   *  tripwire, or null when all pass. Emits onGuardrailTriggered on trip. */
  private async runOutputGuardrails(
    runId: string,
    step: number,
    response: CompletionResponse,
    runTrace: { sessionId: string; requestId: string },
  ): Promise<string | null> {
    for (const g of this._guardrails) {
      if (g.kind !== 'output') continue;
      const decision: GuardrailDecision = await g.check({
        kind: 'output',
        trace: { sessionId: runTrace.sessionId, requestId: runTrace.requestId },
        step,
        response,
      });
      if (!decision.pass && decision.tripwire) {
        await this.hooks.emit('onGuardrailTriggered', {
          runId,
          agentId: this.id,
          step,
          guardrailName: g.name,
          kind: 'output',
          reason: decision.reason,
          severity: decision.severity,
          trace: runTrace,
        });
        return decision.reason;
      }
    }
    return null;
  }

  // ─── Dump / Restore ─────────────────────────────────────────────────────

  dump(): AgentLoopSnapshot {
    const snap: AgentLoopSnapshot = {
      version: 1,
      system: this._system,
      context: this._context,
      history: this._history.export(),
      toolNames: [...this._tools.keys()],
      reports: [...this._reports],
      metadata: { ...this._metadata },
      createdAt: this._history.export().createdAt,
      savedAt: Date.now(),
    };
    if (this._pendingToolCalls.length > 0) {
      snap.pendingToolCalls = [...this._pendingToolCalls];
    }
    return snap;
  }

  static restore(
    snapshot: AgentLoopSnapshot,
    config: {
      client: LLMClient;
      hooks?: HookBus;
      tools: AgentTool[];
      policy?: PermissionPolicy;
      approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
      checkpoint?: import('../plugins/persistence/types').Persistence;
    },
  ): AgentLoop {
    const agent = new AgentLoop({
      client: config.client,
      hooks: config.hooks,
      system: snapshot.system,
      context: snapshot.context,
      tools: config.tools,
      history: snapshot.history,
      policy: config.policy,
      approve: config.approve,
      checkpoint: config.checkpoint,
    });

    agent._reports = snapshot.reports ?? [];
    agent._metadata = snapshot.metadata ?? {};
    agent._pendingToolCalls = snapshot.pendingToolCalls ? [...snapshot.pendingToolCalls] : [];

    const snapshotNames = new Set(snapshot.toolNames);
    const currentNames = new Set(config.tools.map(toolKey));

    for (const name of snapshotNames) {
      if (!currentNames.has(name)) {
        agent.hooks.emitSync('onWarning', {
          source: 'agent',
          code: 'tool_removed',
          message: `Tool "${name}" was used in saved conversation but is not provided now`,
          details: { toolName: name },
        });
      }
    }
    for (const name of currentNames) {
      if (!snapshotNames.has(name)) {
        agent.hooks.emitSync('onWarning', {
          source: 'agent',
          code: 'tool_added',
          message: `Tool "${name}" is new (not in saved conversation)`,
          details: { toolName: name },
        });
      }
    }

    return agent;
  }

  /** Return the list of tool calls currently suspended awaiting approval. */
  get pendingApprovals(): readonly PendingToolCall[] {
    return this._pendingToolCalls;
  }

  /** Feed an approval decision for a pending tool call identified by callId.
   *
   *  This is the resume entry point after a process restart:
   *   1. Restore the loop from a snapshot (AgentLoop.restore).
   *   2. Call resumeWithApproval(callId, decision) to remove the pending record.
   *   3. Re-run the agent — the approver will be invoked again with the SAME
   *      callId; provide a pass-through approver that returns the pre-fed decision.
   *
   *  Rationale: the tool call itself is not stored in pending state (only its
   *  metadata), because the actual execution requires re-running the LLM step.
   *  The canonical resume model is: restore -> re-complete with an approver that
   *  returns the already-obtained decision for the known callId. This keeps the
   *  loop stateless w.r.t. execution and the approval decision authoritative. */
  resumeWithApproval(callId: string, decision: ApprovalDecision): void {
    const idx = this._pendingToolCalls.findIndex((p) => p.callId === callId);
    if (idx === -1) {
      this.hooks.emitSync('onWarning', {
        source: 'agent',
        code: 'approval_callid_not_found',
        message: `resumeWithApproval: callId "${callId}" not found in pending approvals`,
        details: { callId, pendingCount: this._pendingToolCalls.length },
      });
      return;
    }
    this._pendingToolCalls.splice(idx, 1);
    // Store the pre-fed decision so the next run can retrieve it.
    this._prefedApprovals.set(callId, decision);
  }

  /** Pre-fed decisions supplied via resumeWithApproval — consumed on the next run. */
  private _prefedApprovals = new Map<string, ApprovalDecision>();

  /** Return a prefed decision (consumed once) or fall back to the real approver. */
  private async resolveApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    const prefed = this._prefedApprovals.get(req.callId);
    if (prefed !== undefined) {
      this._prefedApprovals.delete(req.callId);
      return prefed;
    }
    if (this._approve !== null) {
      return this._approve(req);
    }
    return { decision: APPROVAL_DEFAULT_WHEN_NO_APPROVER };
  }
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Default maximum number of tool-followup steps per agent run.
 *  Callers that need more steps should set `maxSteps` in AgentLoopConfig. */
export const DEFAULT_MAX_STEPS = 16;

/** Default tool execution timeout in milliseconds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Prefix used when persisting snapshots to the checkpoint store. */
const CHECKPOINT_KEY_PREFIX = 'agent-loop:';

/** Message returned to the model when a tool call is blocked by policy. */
const DENIAL_DEFAULT_REASON = 'Tool call denied by permission policy';

/** Default decision used when policy says "ask" but no approver is configured. */
const APPROVAL_DEFAULT_WHEN_NO_APPROVER: ApprovalDecision['decision'] = 'deny';

// ─── Helpers ────────────────────────────────────────────────────────────

function addUsage(target: Usage, source: Usage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.cachedTokens += source.cachedTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.reasoningTokens += source.reasoningTokens;
}
