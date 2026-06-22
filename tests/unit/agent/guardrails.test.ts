/** Guardrail unit tests — no network, no keys.
 *
 *  Covers:
 *   - input guardrail tripwire halts before the model call (model never called)
 *   - output guardrail tripwire halts after output
 *   - passing guardrail does not interfere with the run
 *   - multiple guardrails run in order; first trip wins
 *   - onGuardrailTriggered hook fires with correct context
 *   - moderationGuardrail trips when moderate() reports flagged (stub) */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import type { Guardrail, GuardrailDecision } from '../../../src/agent/guardrail-types';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ExecuteOptions } from '../../../src/llm/types/options';
import type { Message } from '../../../src/llm/types/messages';
import type { GuardrailTriggeredContext } from '../../../src/bus/hook-map';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface MockClientOptions {
  responses?: Array<Partial<CompletionResponse> & { content?: CompletionResponse['content'] }>;
}

function makeMockClient(opts: MockClientOptions = {}): LLMClient & {
  callCount: number;
} {
  const queue = [...(opts.responses ?? [])];
  let callCount = 0;

  return {
    id: 'mock',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    get callCount() {
      return callCount;
    },
    async complete(_input: Message[], _options: ExecuteOptions): Promise<CompletionResponse> {
      callCount++;
      const next = queue.shift();
      const text = next?.text ?? 'done';
      return {
        id: `r-${callCount}`,
        model: 'mock-model',
        content: next?.content ?? [{ type: 'text', text }],
        finishReason: next?.finishReason ?? 'stop',
        usage: next?.usage ?? {
          inputTokens: 1, outputTokens: 1, totalTokens: 2,
          cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        },
        text,
        toolCalls: next?.toolCalls ?? [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      };
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient & { callCount: number };
}

function passGuardrail(kind: 'input' | 'output', name = 'allow'): Guardrail {
  return {
    name,
    kind,
    async check(): Promise<GuardrailDecision> {
      return { pass: true };
    },
  };
}

function tripGuardrail(kind: 'input' | 'output', reason = 'blocked', name = 'block'): Guardrail {
  return {
    name,
    kind,
    async check(): Promise<GuardrailDecision> {
      return { pass: false, tripwire: true, reason, severity: 'high' };
    },
  };
}

// ─── Input guardrail ──────────────────────────────────────────────────────────

describe('Guardrails — input tripwire', () => {
  it('halts before the model call when input guardrail trips', async () => {
    const client = makeMockClient({
      responses: [{ text: 'should-not-appear' }],
    });
    const loop = new AgentLoop({
      client,
      guardrails: [tripGuardrail('input', 'bad input')],
    });
    const res = await loop.complete('harmful content');
    expect(client.callCount).toBe(0);
    expect(loop.lastReport?.reason).toBe('guardrail');
    expect(res.text).toBe('bad input');
  });

  it('surfaces the trip reason in the response text', async () => {
    const client = makeMockClient();
    const loop = new AgentLoop({
      client,
      guardrails: [tripGuardrail('input', 'policy violation')],
    });
    const res = await loop.complete('test');
    expect(res.text).toBe('policy violation');
  });

  it('finish reason on the CompletionResponse is "stop" (not "error")', async () => {
    const client = makeMockClient();
    const loop = new AgentLoop({
      client,
      guardrails: [tripGuardrail('input', 'reason')],
    });
    const res = await loop.complete('test');
    expect(res.finishReason).toBe('stop');
    expect(loop.lastReport?.reason).toBe('guardrail');
  });
});

// ─── Output guardrail ─────────────────────────────────────────────────────────

describe('Guardrails — output tripwire', () => {
  it('halts after output is produced (model IS called once)', async () => {
    const client = makeMockClient({
      responses: [{ text: 'dangerous reply' }],
    });
    const loop = new AgentLoop({
      client,
      guardrails: [tripGuardrail('output', 'bad output')],
    });
    const res = await loop.complete('hi');
    expect(client.callCount).toBe(1);
    expect(loop.lastReport?.reason).toBe('guardrail');
    expect(res.text).toBe('bad output');
  });

  it('surfaces the output trip reason', async () => {
    const client = makeMockClient({ responses: [{ text: 'x' }] });
    const loop = new AgentLoop({
      client,
      guardrails: [tripGuardrail('output', 'output blocked')],
    });
    const res = await loop.complete('hi');
    expect(res.text).toBe('output blocked');
  });
});

// ─── Passing guardrail ────────────────────────────────────────────────────────

describe('Guardrails — passing does not interfere', () => {
  it('run completes normally when all guardrails pass', async () => {
    const client = makeMockClient({ responses: [{ text: 'normal answer' }] });
    const loop = new AgentLoop({
      client,
      guardrails: [passGuardrail('input'), passGuardrail('output')],
    });
    const res = await loop.complete('hello');
    expect(res.text).toBe('normal answer');
    expect(loop.lastReport?.reason).toBe('done');
    expect(client.callCount).toBe(1);
  });
});

// ─── Multiple guardrails in order ─────────────────────────────────────────────

describe('Guardrails — multiple run in order', () => {
  it('first input trip wins; later guardrails not consulted', async () => {
    let secondChecked = false;
    const second: Guardrail = {
      name: 'second',
      kind: 'input',
      async check(): Promise<GuardrailDecision> {
        secondChecked = true;
        return { pass: true };
      },
    };
    const client = makeMockClient();
    const loop = new AgentLoop({
      client,
      guardrails: [tripGuardrail('input', 'first', 'first'), second],
    });
    await loop.complete('test');
    expect(loop.lastReport?.reason).toBe('guardrail');
    expect(secondChecked).toBe(false);
  });

  it('passing first then tripping second still halts', async () => {
    const client = makeMockClient();
    const loop = new AgentLoop({
      client,
      guardrails: [passGuardrail('input', 'pass'), tripGuardrail('input', 'blocked', 'trip')],
    });
    await loop.complete('test');
    expect(loop.lastReport?.reason).toBe('guardrail');
    expect(client.callCount).toBe(0);
  });

  it('input and output guardrails are independent lanes', async () => {
    const client = makeMockClient({ responses: [{ text: 'x' }] });
    const loop = new AgentLoop({
      client,
      guardrails: [passGuardrail('input'), tripGuardrail('output', 'bad output')],
    });
    await loop.complete('hi');
    // input passed (model called), output tripped
    expect(client.callCount).toBe(1);
    expect(loop.lastReport?.reason).toBe('guardrail');
  });
});

// ─── onGuardrailTriggered hook ────────────────────────────────────────────────

describe('Guardrails — onGuardrailTriggered hook', () => {
  it('fires with correct context on input trip', async () => {
    const hooks = new HookBus();
    const events: GuardrailTriggeredContext[] = [];
    hooks.on('onGuardrailTriggered', (ctx) => {
      events.push(ctx);
    });

    const client = makeMockClient();
    const loop = new AgentLoop({
      client,
      hooks,
      guardrails: [tripGuardrail('input', 'forbidden', 'my-guard')],
    });
    await loop.complete('bad stuff');

    expect(events.length).toBe(1);
    expect(events[0].guardrailName).toBe('my-guard');
    expect(events[0].kind).toBe('input');
    expect(events[0].reason).toBe('forbidden');
    expect(events[0].severity).toBe('high');
    expect(events[0].agentId).toBe(loop.id);
    expect(events[0].step).toBe(0);
  });

  it('fires with correct context on output trip', async () => {
    const hooks = new HookBus();
    const events: GuardrailTriggeredContext[] = [];
    hooks.on('onGuardrailTriggered', (ctx) => {
      events.push(ctx);
    });

    const client = makeMockClient({ responses: [{ text: 'danger' }] });
    const loop = new AgentLoop({
      client,
      hooks,
      guardrails: [tripGuardrail('output', 'output bad', 'out-guard')],
    });
    await loop.complete('hi');

    expect(events.length).toBe(1);
    expect(events[0].guardrailName).toBe('out-guard');
    expect(events[0].kind).toBe('output');
    expect(events[0].reason).toBe('output bad');
  });

  it('does not fire when guardrail passes', async () => {
    const hooks = new HookBus();
    const events: GuardrailTriggeredContext[] = [];
    hooks.on('onGuardrailTriggered', (ctx) => {
      events.push(ctx);
    });

    const client = makeMockClient({ responses: [{ text: 'ok' }] });
    const loop = new AgentLoop({
      client,
      hooks,
      guardrails: [passGuardrail('input'), passGuardrail('output')],
    });
    await loop.complete('hello');

    expect(events.length).toBe(0);
  });
});

// ─── ctx.trace shape ──────────────────────────────────────────────────────────

describe('Guardrails — ctx.trace shape', () => {
  it('input guardrail check() receives trace with sessionId === loop.id and non-empty requestId', async () => {
    let capturedSessionId: string | undefined;
    let capturedRequestId: string | undefined;

    const traceCapture: import('../../../src/agent/guardrail-types').Guardrail = {
      name: 'trace-capture',
      kind: 'input',
      async check(ctx): Promise<import('../../../src/agent/guardrail-types').GuardrailDecision> {
        if (ctx.kind === 'input') {
          capturedSessionId = ctx.trace.sessionId;
          capturedRequestId = ctx.trace.requestId;
        }
        return { pass: true };
      },
    };

    const client = makeMockClient({ responses: [{ text: 'ok' }] });
    const loop = new AgentLoop({ client, guardrails: [traceCapture] });
    await loop.complete('hello');

    expect(capturedSessionId).toBe(loop.id);
    expect(typeof capturedRequestId).toBe('string');
    expect(capturedRequestId!.length).toBeGreaterThan(0);
  });

  it('output guardrail check() receives trace with sessionId === loop.id and non-empty requestId', async () => {
    let capturedSessionId: string | undefined;
    let capturedRequestId: string | undefined;

    const traceCapture: import('../../../src/agent/guardrail-types').Guardrail = {
      name: 'trace-capture-out',
      kind: 'output',
      async check(ctx): Promise<import('../../../src/agent/guardrail-types').GuardrailDecision> {
        if (ctx.kind === 'output') {
          capturedSessionId = ctx.trace.sessionId;
          capturedRequestId = ctx.trace.requestId;
        }
        return { pass: true };
      },
    };

    const client = makeMockClient({ responses: [{ text: 'reply' }] });
    const loop = new AgentLoop({ client, guardrails: [traceCapture] });
    await loop.complete('hi');

    expect(capturedSessionId).toBe(loop.id);
    expect(typeof capturedRequestId).toBe('string');
    expect(capturedRequestId!.length).toBeGreaterThan(0);
  });
});

// ─── moderationGuardrail (stubbed) ───────────────────────────────────────────

describe('Guardrails — moderationGuardrail with stub', () => {
  it('trips when stubbed moderate returns flagged=true', async () => {
    // Build a moderation guardrail manually so we can inject the stub
    // without actually calling OpenAI. We stub the check() directly.
    const stubbedGuardrail: Guardrail = {
      name: 'moderation-input',
      kind: 'input',
      async check(): Promise<GuardrailDecision> {
        // Simulate moderate() returning flagged result
        const flagged = true;
        if (flagged) {
          return {
            pass: false,
            tripwire: true,
            reason: 'Input flagged by moderation',
            severity: 'high',
          };
        }
        return { pass: true };
      },
    };

    const client = makeMockClient();
    const loop = new AgentLoop({ client, guardrails: [stubbedGuardrail] });
    const res = await loop.complete('harmful text');

    expect(client.callCount).toBe(0);
    expect(loop.lastReport?.reason).toBe('guardrail');
    expect(res.text).toBe('Input flagged by moderation');
  });

  it('passes when stubbed moderate returns flagged=false', async () => {
    const stubbedGuardrail: Guardrail = {
      name: 'moderation-input',
      kind: 'input',
      async check(): Promise<GuardrailDecision> {
        return { pass: true };
      },
    };

    const client = makeMockClient({ responses: [{ text: 'fine answer' }] });
    const loop = new AgentLoop({ client, guardrails: [stubbedGuardrail] });
    const res = await loop.complete('safe text');

    expect(client.callCount).toBe(1);
    expect(res.text).toBe('fine answer');
    expect(loop.lastReport?.reason).toBe('done');
  });
});
