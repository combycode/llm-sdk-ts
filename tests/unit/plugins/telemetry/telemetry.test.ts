/** TelemetryAdapter — turns the event stream into spans, metrics, and logs,
 *  correlated by sessionId:requestId. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { TelemetryAdapter, sanitizeUrl, sanitizeHeaders } from '../../../../src/plugins/telemetry/telemetry';

const trace = { sessionId: 's', requestId: 'r' };

async function feedOneRequest(bus: HookBus) {
  await bus.emit('onBeforeSubmit', { ctx: trace } as never);
  await bus.emit('onRequestStart', {
    provider: 'openai',
    model: 'm',
    queueName: 'openai/m',
    url: 'https://api/x',
    method: 'POST',
    attempt: 0,
    idempotencyKey: 'k',
    streaming: false,
    trace,
  } as never);
  await bus.emit('onRequestComplete', {
    provider: 'openai',
    model: 'm',
    queueName: 'openai/m',
    status: 200,
    headers: {},
    latencyMs: 42,
    attempt: 0,
    bodySize: 0,
    streaming: false,
    trace,
  } as never);
  await bus.emit('onCompletion', {
    provider: 'openai',
    model: 'm',
    response: { usage: { inputTokens: 10, outputTokens: 5 } },
    ctx: trace,
  } as never);
  bus.emitSync('onCostEntry', {
    entry: { cost: { total: 0.001 } },
    runningTotal: 0.001,
  } as never);
}

describe('TelemetryAdapter', () => {
  it('builds llm + http spans correlated by traceId', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedOneRequest(bus);

    const { spans } = tel.snapshot();
    expect(spans).toHaveLength(2);
    const llm = spans.find((s) => s.name === 'llm.request');
    const http = spans.find((s) => s.name === 'http.request');
    expect(llm?.traceId).toBe('s:r');
    expect(http?.traceId).toBe('s:r');
    expect(llm?.status).toBe('ok');
    expect(http?.attributes['http.status_code']).toBe(200);
    expect(llm?.attributes['gen_ai.usage.input_tokens']).toBe(10);
  });

  it('updates event-driven metrics (tokens, cost, latency, requests)', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedOneRequest(bus);

    const { metrics } = tel.snapshot();
    expect(metrics.requests).toBe(1);
    expect(metrics.completions).toBe(1);
    expect(metrics.inputTokens).toBe(10);
    expect(metrics.outputTokens).toBe(5);
    expect(metrics.costUsd).toBeCloseTo(0.001, 6);
    expect(metrics.latency).toMatchObject({ count: 1, avg: 42 });
    expect(metrics.inFlight).toBe(0);
  });

  it('logs every event with category + traceId', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedOneRequest(bus);

    const { events } = tel.snapshot();
    expect(events.map((e) => e.name)).toEqual([
      'onBeforeSubmit',
      'onRequestStart',
      'onRequestComplete',
      'onCompletion',
      'onCostEntry',
    ]);
    expect(events[1].category).toBe('network');
    expect(events[1].traceId).toBe('s:r');
  });

  it('counts retries / rate-limits / errors and media', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onRetry', { provider: 'p', model: 'm', queueName: 'q', attempt: 1, backoffMs: 1, reason: 'rate_limit', idempotencyKey: 'k' } as never);
    bus.emitSync('onModelError', { provider: 'p', model: 'm', queueName: 'q', error: {}, headers: {}, attempt: 0, willRetry: false } as never);
    await bus.emit('onMediaGenerated', { provider: 'p', source: 'media_output', mediaType: 'image', count: 1, parts: [], stored: true, trace } as never);

    const { metrics, spans } = tel.snapshot();
    expect(metrics.retries).toBe(1);
    expect(metrics.errors).toBe(1);
    expect(metrics.mediaGenerated).toBe(1);
    expect(spans.find((s) => s.name === 'media.generate')?.traceId).toBe('s:r');
  });

  it('synthesizes the llm span for the stream path (no onBeforeSubmit)', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    // stream() emits onRequestStart/Complete + onCompletion, but NOT onBeforeSubmit
    await bus.emit('onRequestStart', {
      provider: 'a', model: 'm', queueName: 'q', url: 'u', method: 'POST', attempt: 0,
      idempotencyKey: 'k', streaming: true, trace,
    } as never);
    await bus.emit('onRequestComplete', {
      provider: 'a', model: 'm', queueName: 'q', status: 200, headers: {}, latencyMs: 10,
      attempt: 0, bodySize: 0, streaming: true, trace,
    } as never);
    await bus.emit('onCompletion', {
      provider: 'a', model: 'm', response: { usage: { inputTokens: 1, outputTokens: 2 } }, ctx: trace,
    } as never);

    const llm = tel.snapshot().spans.find((s) => s.name === 'llm.request');
    expect(llm?.traceId).toBe('s:r');
    expect(llm?.durationMs).toBeGreaterThanOrEqual(0); // spans the http span
    expect(llm?.attributes['gen_ai.usage.output_tokens']).toBe(2);
  });

  it('toOtlpTraces shapes spans into resourceSpans', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedOneRequest(bus);
    const otlp = tel.toOtlpTraces() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };
    expect(otlp.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it('stamps the service resource (service.name + attrs) on exports', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus, {
      resource: {
        serviceName: 'billing-api',
        serviceNamespace: 'prod',
        serviceInstanceId: 'sess_1',
        attributes: { 'deployment.environment': 'eu' },
      },
    });
    const otlp = tel.toOtlpTraces() as {
      resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } }>;
    };
    const attrs = otlp.resourceSpans[0].resource.attributes;
    const map = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
    expect(map).toEqual({
      'service.name': 'billing-api',
      'service.namespace': 'prod',
      'service.instance.id': 'sess_1',
      'deployment.environment': 'eu',
    });
  });

  it('defaults service.name to unknown_service', () => {
    const tel = new TelemetryAdapter(new HookBus());
    expect(tel.resource.serviceName).toBe('unknown_service');
  });

  it('serialize() returns a JSON bundle with blobs trimmed', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus, { resource: { serviceName: 'svc' } });
    // an event carrying a huge base64-ish string
    await bus.emit('onMediaGenerated', {
      provider: 'p', source: 'media_output', mediaType: 'image', count: 1, parts: [],
      stored: true, trace, blob: 'x'.repeat(5000),
    } as never);

    const json = JSON.parse(tel.serialize());
    expect(json.resource.serviceName).toBe('svc');
    expect(json.metrics.mediaGenerated).toBe(1);
    expect(Array.isArray(json.events)).toBe(true);
    // the 5000-char blob is trimmed
    expect(tel.serialize()).not.toContain('x'.repeat(600));
    expect(tel.serialize()).toContain('chars trimmed');
  });

  it('serialize() surfaces an Error message (non-enumerable) from event ctx', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const error = Object.assign(new Error('Unable to process input image'), {
      kind: 'invalid_request',
      provider: 'google',
      status: 400,
    });
    await bus.emit('onModelError', {
      provider: 'google', model: 'veo-3.1', queueName: 'google/veo-3.1',
      error, headers: {}, attempt: 0, willRetry: false, trace,
    } as never);

    const json = JSON.parse(tel.serialize());
    const ev = json.events.find((e: { name: string }) => e.name === 'onModelError');
    // SEC-H1: only safe structural fields are exported; arbitrary props are not spread.
    // name/message/code/status are preserved; all other attached props are dropped.
    expect(ev.ctx.error.message).toBe('Unable to process input image');
    expect(ev.ctx.error.name).toBe('Error');
    expect(ev.ctx.error.status).toBe(400); // status is a safe structural LLMError field
    expect(ev.ctx.error.kind).toBeUndefined();     // arbitrary attached prop — not exported
    expect(ev.ctx.error.provider).toBeUndefined(); // arbitrary attached prop — not exported
  });

  it('serialize() includes Error.code in output when present', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    await bus.emit('onModelError', {
      provider: 'p', model: 'm', queueName: 'q',
      error, headers: {}, attempt: 0, willRetry: false, trace,
    } as never);
    const json = JSON.parse(tel.serialize());
    const ev = json.events.find((e: { name: string }) => e.name === 'onModelError');
    expect(ev.ctx.error.code).toBe('ENOSPC');
  });

  it('destroy() detaches the tap', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    tel.destroy();
    await bus.emit('onCompletion', { provider: 'p', model: 'm', response: {}, ctx: trace } as never);
    expect(tel.snapshot().events).toHaveLength(0);
  });
});

// ─── SEC-H2: LLMError.raw capping in telemetry ───────────────────────────────

describe('TelemetryAdapter — LLMError.raw capping', () => {
  it('caps a huge raw string in the stored onModelError event', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const bigRaw = 'x'.repeat(10000);
    const error = Object.assign(new Error('provider error'), { kind: 'server_error', raw: bigRaw });
    await bus.emit('onModelError', {
      provider: 'openai', model: 'gpt-4o', queueName: 'openai/gpt-4o',
      error, headers: {}, attempt: 0, willRetry: false,
    } as never);

    const ev = tel.snapshot().events.find((e) => e.name === 'onModelError');
    const storedError = (ev?.ctx as Record<string, unknown>)?.error as Record<string, unknown>;
    const storedRaw = storedError?.raw as string;
    // raw must be capped well below 10000 chars
    expect(typeof storedRaw).toBe('string');
    expect(storedRaw.length).toBeLessThan(1000);
    expect(storedRaw).toContain('truncated');
  });

  it('does not mutate the original LLMError when capping raw', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const bigRaw = 'y'.repeat(5000);
    const error = Object.assign(new Error('big raw error'), { kind: 'server_error', raw: bigRaw });
    await bus.emit('onModelError', {
      provider: 'anthropic', model: 'claude-3', queueName: 'anthropic/claude-3',
      error, headers: {}, attempt: 0, willRetry: false,
    } as never);

    // The original error object must be untouched
    expect((error as unknown as { raw: string }).raw).toBe(bigRaw);
    expect((error as unknown as { raw: string }).raw.length).toBe(5000);
  });

  it('preserves name, message, status on capped error; drops arbitrary attached props', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const error = Object.assign(new Error('rate limited'), {
      kind: 'rate_limit',
      status: 429,
      retryable: true,
      raw: 'z'.repeat(2000),
    });
    await bus.emit('onModelError', {
      provider: 'openai', model: 'gpt-4', queueName: 'openai/gpt-4',
      error, headers: {}, attempt: 0, willRetry: true,
    } as never);

    const ev = tel.snapshot().events.find((e) => e.name === 'onModelError');
    const storedError = (ev?.ctx as Record<string, unknown>)?.error as Record<string, unknown>;
    expect(storedError?.name).toBe('Error');
    expect(storedError?.message).toBe('rate limited');
    expect(storedError?.status).toBe(429);       // status is a structural LLMError field
    expect(storedError?.kind).toBeUndefined();   // arbitrary attached prop — not exported
    expect(storedError?.retryable).toBeUndefined(); // arbitrary attached prop — not exported
  });

  it('does not cap raw when it is within the limit', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const smallRaw = 'small error body';
    const error = Object.assign(new Error('small error'), { kind: 'invalid_request', raw: smallRaw });
    await bus.emit('onModelError', {
      provider: 'openai', model: 'gpt-4', queueName: 'openai/gpt-4',
      error, headers: {}, attempt: 0, willRetry: false,
    } as never);

    const ev = tel.snapshot().events.find((e) => e.name === 'onModelError');
    const storedError = (ev?.ctx as Record<string, unknown>)?.error as Record<string, unknown>;
    expect(storedError?.raw).toBe(smallRaw);
  });

  it('caps and sanitizes a raw string that contains a sensitive URL query param', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    // A provider might echo the request URL in the raw error body
    const rawWithKey = `https://example.com/api?key=SECRET_KEY_VALUE ${'x'.repeat(600)}`;
    const error = Object.assign(new Error('bad request'), { kind: 'invalid_request', raw: rawWithKey });
    await bus.emit('onModelError', {
      provider: 'google', model: 'gemini', queueName: 'google/gemini',
      error, headers: {}, attempt: 0, willRetry: false,
    } as never);

    const ev = tel.snapshot().events.find((e) => e.name === 'onModelError');
    const storedError = (ev?.ctx as Record<string, unknown>)?.error as Record<string, unknown>;
    const storedRaw = storedError?.raw as string;
    // Raw is capped (the huge body is cut), and the URL part is sanitized
    expect(storedRaw).not.toContain('SECRET_KEY_VALUE');
  });

  it('caps a huge raw object (non-string) serialized from LLMError', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const bigObj = { detail: 'x'.repeat(5000), nested: { more: 'y'.repeat(5000) } };
    const error = Object.assign(new Error('complex error'), { kind: 'server_error', raw: bigObj });
    await bus.emit('onModelError', {
      provider: 'xai', model: 'grok', queueName: 'xai/grok',
      error, headers: {}, attempt: 0, willRetry: false,
    } as never);

    const ev = tel.snapshot().events.find((e) => e.name === 'onModelError');
    const storedError = (ev?.ctx as Record<string, unknown>)?.error as Record<string, unknown>;
    const storedRaw = storedError?.raw as string;
    expect(typeof storedRaw).toBe('string');
    expect(storedRaw.length).toBeLessThan(1000);
    expect(storedRaw).toContain('truncated');
  });
});

// ─── Part 1: CATEGORY coverage ────────────────────────────────────────────────

describe('TelemetryAdapter CATEGORY coverage', () => {
  it('agent hooks route to category "agent" (not "other")', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const runId = 'run-1';
    await bus.emit('onRunStart', {
      runId,
      agentId: 'a1',
      userMessage: 'hi',
      model: 'm',
      toolNames: [],
      historyLength: 0,
    } as never);
    await bus.emit('onStepStart', { runId, agentId: 'a1', step: 0, type: 'initial', messageCount: 1, estimatedInputTokens: 10 } as never);
    await bus.emit('onRunComplete', { runId, agentId: 'a1', userMessage: 'hi', reason: 'done', text: 'ok', response: {} } as never);
    const { events } = tel.snapshot();
    for (const ev of events) {
      expect(ev.category).toBe('agent');
    }
  });

  it('tool hooks route to category "tool" (not "other")', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onToolCallStart', { runId: 'r', agentId: 'a', step: 0, callId: 'c1', toolName: 'myTool', arguments: {} } as never);
    bus.emitSync('onToolCallComplete', { runId: 'r', agentId: 'a', step: 0, callId: 'c1', toolName: 'myTool', arguments: {}, result: 'ok', resultSizeBytes: 2, latencyMs: 5, metrics: new Map() } as never);
    const { events } = tel.snapshot();
    for (const ev of events) {
      expect(ev.category).toBe('tool');
    }
  });

  it('internal-tools hooks route to category "tool" (not "other")', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onInternalToolCallStart', { toolId: 't1', input: {}, chosenModel: 'm', attempt: 0 } as never);
    bus.emitSync('onInternalToolCallComplete', { toolId: 't1', input: {}, output: {}, chosenModel: 'm', latencyMs: 1, attempts: 1 } as never);
    const { events } = tel.snapshot();
    for (const ev of events) {
      expect(ev.category).toBe('tool');
    }
  });

  it('server hooks route to category "server" (not "other")', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onServerRequest', { serverId: 's', requestId: 'req-1', method: 'POST', path: '/v1/chat', userId: null, model: 'gpt-4o' } as never);
    bus.emitSync('onServerResponse', { serverId: 's', requestId: 'req-1', status: 200, latencyMs: 10, userId: null, model: 'gpt-4o' } as never);
    const { events } = tel.snapshot();
    for (const ev of events) {
      expect(ev.category).toBe('server');
    }
  });

  it('realtime hooks route to category "realtime" (not "other")', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onRealtimeOpen', { provider: 'openai', model: 'gpt-4o-realtime', url: 'wss://x' } as never);
    bus.emitSync('onRealtimeClose', { provider: 'openai', model: 'gpt-4o-realtime', code: 1000, reason: 'done' } as never);
    const { events } = tel.snapshot();
    for (const ev of events) {
      expect(ev.category).toBe('realtime');
    }
  });

  it('onMcpError routes to category "mcp" (not "error")', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onMcpError', { server: 'calc', phase: 'connect', error: new Error('fail') } as never);
    const { events } = tel.snapshot();
    expect(events[0].category).toBe('mcp');
  });
});

// ─── Part 2: Spans for agent / tool / mcp ─────────────────────────────────────

describe('TelemetryAdapter agent/tool/mcp spans', () => {
  it('opens agent.run span on onRunStart and closes on onRunComplete', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const runId = 'run-abc';
    await bus.emit('onRunStart', {
      runId,
      agentId: 'ag1',
      userMessage: 'hello',
      model: 'm',
      toolNames: [],
      historyLength: 0,
    } as never);
    await bus.emit('onRunComplete', { runId, agentId: 'ag1', userMessage: 'hello', reason: 'done', text: 'ok', response: {} } as never);
    const { spans } = tel.snapshot();
    const span = spans.find((s) => s.name === 'agent.run');
    expect(span).toBeDefined();
    expect(span?.kind).toBe('agent');
    expect(span?.traceId).toBe(runId);
    expect(span?.status).toBe('ok');
    expect(span?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('marks agent.run span as error on onRunError', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const runId = 'run-err';
    await bus.emit('onRunStart', { runId, agentId: 'ag1', userMessage: 'hi', model: 'm', toolNames: [], historyLength: 0 } as never);
    await bus.emit('onRunError', { runId, agentId: 'ag1', step: 0, error: new Error('boom'), phase: 'llm_call' } as never);
    const span = tel.snapshot().spans.find((s) => s.name === 'agent.run');
    expect(span?.status).toBe('error');
    expect(span?.attributes['agent.phase']).toBe('llm_call');
  });

  it('opens tool.call span on onToolCallStart and closes on onToolCallComplete', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const callId = 'call-xyz';
    bus.emitSync('onToolCallStart', { runId: 'r', agentId: 'a', step: 0, callId, toolName: 'search', arguments: {} } as never);
    await bus.emit('onToolCallComplete', { runId: 'r', agentId: 'a', step: 0, callId, toolName: 'search', arguments: {}, result: 'ok', resultSizeBytes: 2, latencyMs: 12, metrics: new Map() } as never);
    const { spans } = tel.snapshot();
    const span = spans.find((s) => s.name === 'tool.call');
    expect(span).toBeDefined();
    expect(span?.kind).toBe('tool');
    expect(span?.status).toBe('ok');
    expect(span?.attributes['tool.name']).toBe('search');
  });

  it('marks tool.call span as error on onToolCallError', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const callId = 'call-err';
    bus.emitSync('onToolCallStart', { runId: 'r', agentId: 'a', step: 0, callId, toolName: 'search', arguments: {} } as never);
    await bus.emit('onToolCallError', { runId: 'r', agentId: 'a', step: 0, callId, toolName: 'search', arguments: {}, error: new Error('not found'), latencyMs: 3, metrics: new Map() } as never);
    const span = tel.snapshot().spans.find((s) => s.name === 'tool.call');
    expect(span?.status).toBe('error');
    expect(span?.attributes['tool.error']).toBe('not found');
  });

  it('emits mcp.connect point span on onMcpConnect', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onMcpConnect', { server: 'calc', transport: 'stdio', toolCount: 2 } as never);
    const span = tel.snapshot().spans.find((s) => s.name === 'mcp.connect');
    expect(span).toBeDefined();
    expect(span?.kind).toBe('mcp');
    expect(span?.status).toBe('ok');
    expect(span?.attributes['mcp.tool_count']).toBe(2);
  });

  it('emits mcp.tool_call point span on onMcpToolCall with duration', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onMcpToolCall', { server: 'calc', tool: 'add', latencyMs: 25, isError: false } as never);
    const span = tel.snapshot().spans.find((s) => s.name === 'mcp.tool_call');
    expect(span).toBeDefined();
    expect(span?.durationMs).toBe(25);
    expect(span?.status).toBe('ok');
    expect(span?.attributes['mcp.tool']).toBe('add');
  });

  it('marks mcp.tool_call as error when isError=true', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    bus.emitSync('onMcpToolCall', { server: 'calc', tool: 'div', latencyMs: 5, isError: true } as never);
    const span = tel.snapshot().spans.find((s) => s.name === 'mcp.tool_call');
    expect(span?.status).toBe('error');
  });
});

// ─── Part 3: TraceContext threading ───────────────────────────────────────────

describe('TelemetryAdapter trace correlation on agent hooks', () => {
  it('agent hooks carry trace correlation when trace field is set', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const runId = 'run-trace-test';
    const agentId = 'agent-trace-sess';
    const runTrace = { sessionId: agentId, requestId: runId };
    await bus.emit('onRunStart', {
      runId,
      agentId,
      userMessage: 'test',
      model: 'm',
      toolNames: [],
      historyLength: 0,
      trace: runTrace,
    } as never);
    await bus.emit('onRunComplete', {
      runId,
      agentId,
      userMessage: 'test',
      reason: 'done',
      text: 'ok',
      response: {},
      trace: runTrace,
    } as never);
    const { events } = tel.snapshot();
    const startEv = events.find((e) => e.name === 'onRunStart');
    const completeEv = events.find((e) => e.name === 'onRunComplete');
    const expectedTraceId = `${agentId}:${runId}`;
    expect(startEv?.traceId).toBe(expectedTraceId);
    expect(completeEv?.traceId).toBe(expectedTraceId);
  });

  it('tool hooks carry the same trace as the parent run', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const runId = 'run-tool-trace';
    const agentId = 'agent-tool-sess';
    const runTrace = { sessionId: agentId, requestId: runId };
    bus.emitSync('onToolCallStart', {
      runId, agentId, step: 0, callId: 'c1', toolName: 'calc', arguments: {},
      trace: runTrace,
    } as never);
    const { events } = tel.snapshot();
    expect(events[0].traceId).toBe(`${agentId}:${runId}`);
  });
});

// ─── SEC-C1: URL and header sanitization ──────────────────────────────────────

describe('sanitizeUrl', () => {
  it('redacts ?key= query parameter', () => {
    const url = 'https://generativelanguage.googleapis.com/v1beta/files?key=AIzaSy_SECRET';
    const sanitized = sanitizeUrl(url);
    expect(sanitized).not.toContain('AIzaSy_SECRET');
    expect(sanitized).toContain('key=***REDACTED***');
  });

  it('redacts api_key query parameter', () => {
    const url = 'https://example.com/api?api_key=super-secret&other=ok';
    const sanitized = sanitizeUrl(url);
    expect(sanitized).not.toContain('super-secret');
    expect(sanitized).toContain('api_key=***REDACTED***');
    expect(sanitized).toContain('other=ok');
  });

  it('redacts access_token query parameter', () => {
    const url = 'https://example.com/api?access_token=tok-123';
    const sanitized = sanitizeUrl(url);
    expect(sanitized).not.toContain('tok-123');
    expect(sanitized).toContain('access_token=***REDACTED***');
  });

  it('passes through URLs without sensitive params unchanged', () => {
    const url = 'https://api.openai.com/v1/models?limit=10';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('does not throw on invalid URLs, returns input unchanged', () => {
    const bad = 'not-a-url';
    expect(sanitizeUrl(bad)).toBe(bad);
  });
});

describe('sanitizeHeaders', () => {
  it('redacts authorization header', () => {
    const headers = { authorization: 'Bearer sk-secret', 'content-type': 'application/json' };
    const out = sanitizeHeaders(headers);
    expect(out.authorization).toBe('***REDACTED***');
    expect(out['content-type']).toBe('application/json');
  });

  it('redacts x-goog-api-key header (case-insensitive key name)', () => {
    const headers = { 'x-goog-api-key': 'AIzaSy_SECRET' };
    const out = sanitizeHeaders(headers);
    expect(out['x-goog-api-key']).toBe('***REDACTED***');
  });

  it('redacts x-api-key header', () => {
    const headers = { 'x-api-key': 'sk-ant-secret' };
    const out = sanitizeHeaders(headers);
    expect(out['x-api-key']).toBe('***REDACTED***');
  });

  it('passes through non-sensitive headers unchanged', () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    const out = sanitizeHeaders(headers);
    expect(out).toEqual(headers);
  });
});

describe('TelemetryAdapter URL sanitization in events', () => {
  it('redacts ?key= from url stored in onRequestStart event ctx', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await bus.emit('onRequestStart', {
      provider: 'google',
      model: 'imagen',
      queueName: 'google/imagen',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/imagen:predict?key=AIzaSy_SECRET',
      method: 'POST',
      bodySize: 0,
      attempt: 0,
      idempotencyKey: 'k',
      streaming: false,
      trace,
    } as never);

    const { events } = tel.snapshot();
    const ev = events.find((e) => e.name === 'onRequestStart');
    const ctxUrl = (ev?.ctx as Record<string, unknown>)?.url as string;
    expect(ctxUrl).not.toContain('AIzaSy_SECRET');
    expect(ctxUrl).toContain('key=***REDACTED***');
  });

  it('redacts ?key= from http.url span attribute', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const trace2 = { sessionId: 's2', requestId: 'r2' };
    await bus.emit('onRequestStart', {
      provider: 'google',
      model: 'imagen',
      queueName: 'google/imagen',
      url: 'https://generativelanguage.googleapis.com/v1beta/files?key=SECRET123&pageSize=100',
      method: 'GET',
      bodySize: 0,
      attempt: 0,
      idempotencyKey: 'k2',
      streaming: false,
      trace: trace2,
    } as never);
    // Close the span so it moves from open -> spans
    await bus.emit('onRequestComplete', {
      provider: 'google', model: 'imagen', queueName: 'google/imagen',
      status: 200, headers: {}, latencyMs: 10, attempt: 0, bodySize: 0, streaming: false,
      trace: trace2,
    } as never);

    const { spans } = tel.snapshot();
    const span = spans.find((s) => s.kind === 'http');
    const httpUrl = span?.attributes['http.url'] as string | undefined;
    expect(httpUrl).toBeDefined();
    expect(httpUrl).not.toContain('SECRET123');
    expect(httpUrl).toContain('key=***REDACTED***');
  });
});
