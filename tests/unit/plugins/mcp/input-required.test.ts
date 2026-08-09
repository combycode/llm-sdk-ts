/** Multi-round-trip requests (MRTR / SEP-2322) — the 2026-07-28 replacement for the back-channel.
 *
 *  Two things are being protected here:
 *   1. **R2** — `McpCallResult` did NOT become a union. Code reading `.content` still compiles and
 *      still works, and a caller who never meets a modern server never sees the new fields.
 *   2. **One handler, both wires** — the same `onServerRequest` callback that answers a pushed
 *      `sampling/createMessage` on the handshake wire answers an embedded one on the modern wire. */

import { describe, expect, it } from 'bun:test';
import { McpClient } from '../../../../src/plugins/mcp/client';
import { McpError, McpErrorCode } from '../../../../src/plugins/mcp/jsonrpc';
import type { IncomingMcpHandlers, McpTransport } from '../../../../src/plugins/mcp/transport';
import {
  isInputRequired,
  runInputRequiredDriver,
} from '../../../../src/plugins/mcp/input-required';

class ScriptedTransport implements McpTransport {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private step = 0;

  constructor(private readonly script: Array<(params: unknown) => unknown>) {}

  async start(): Promise<void> {}
  setHandlers(_h: IncomingMcpHandlers): void {}
  setProtocolVersion(): void {}
  setEra(): void {}
  async notify(): Promise<void> {}
  async close(): Promise<void> {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'server/discover') {
      return {
        capabilities: {},
        supportedVersions: ['2026-07-28'],
        resultType: 'complete',
        _meta: {},
      };
    }
    const fn = this.script[this.step++];
    if (!fn) throw new Error(`unscripted call #${this.step}: ${method}`);
    const out = fn(params);
    if (out instanceof Error) throw out;
    return out;
  }

  toolCalls(): unknown[] {
    return this.calls.filter((c) => c.method === 'tools/call').map((c) => c.params);
  }
}

const askForSampling = (state: string) => () => ({
  resultType: 'input_required',
  requestState: state,
  inputRequests: {
    q1: { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: 'hi' }] } },
  },
});

const done = (text: string) => () => ({
  resultType: 'complete',
  content: [{ type: 'text', text }],
});

// ─── the driver in isolation ──────────────────────────────────────────────────

describe('isInputRequired', () => {
  it("treats an ABSENT resultType as 'complete' (every pre-2026 result)", () => {
    expect(isInputRequired({ content: [] })).toBe(false);
    expect(isInputRequired({ resultType: 'complete', content: [] })).toBe(false);
    expect(isInputRequired({ resultType: 'input_required' })).toBe(true);
    expect(isInputRequired(null)).toBe(false);
  });
});

describe('runInputRequiredDriver', () => {
  it('gives up after maxRounds with an actionable message', async () => {
    const never = { resultType: 'input_required', inputRequests: { a: { method: 'roots/list' } } };
    await expect(
      runInputRequiredDriver(never, {
        dispatch: async () => ({ roots: [] }),
        retry: async () => never,
        maxRounds: 3,
      }),
    ).rejects.toThrow(/more than 3 rounds/);
  });

  it('backs off on a state-only leg instead of spinning', async () => {
    let legs = 0;
    const started = performance.now();
    await runInputRequiredDriver(
      { resultType: 'input_required', requestState: 's0' },
      {
        dispatch: async () => ({}),
        retry: async () => {
          legs++;
          return legs < 3
            ? { resultType: 'input_required', requestState: `s${legs}` }
            : { resultType: 'complete', content: [] };
        },
      },
    );
    // 50ms + 100ms of backoff before the third leg; without it this would be a spin loop.
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(legs).toBe(3);
  });
});

// ─── through the client ───────────────────────────────────────────────────────

describe('callTool drives input_required to a terminal result', () => {
  it('answers the embedded request and retries with responses + requestState', async () => {
    const t = new ScriptedTransport([askForSampling('opaque-token'), done('final answer')]);
    const seen: string[] = [];

    const client = new McpClient(t, {
      onServerRequest: async (method) => {
        seen.push(method);
        return { role: 'assistant', content: { type: 'text', text: 'sampled' } };
      },
    });
    await client.connect();

    const res = await client.callTool('do_thing', { a: 1 });

    // The caller sees a finished call — never the intermediate question.
    expect(res.content).toEqual([{ type: 'text', text: 'final answer' }]);
    // The SAME callback that serves a pushed sampling request on the handshake wire served this.
    expect(seen).toEqual(['sampling/createMessage']);

    const [first, second] = t.toolCalls() as Array<Record<string, unknown>>;
    // This is a MODERN session, so every request also carries the `_meta` identity
    // envelope; assert the call-specific fields and check the envelope separately rather
    // than pinning the whole object.
    const { _meta: firstMeta, ...firstRest } = first;
    expect(firstRest).toEqual({ name: 'do_thing', arguments: { a: 1 } });
    expect((firstMeta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']).toBe(
      '2026-07-28',
    );

    const { _meta: secondMeta, ...secondRest } = second;
    expect(secondRest).toEqual({
      name: 'do_thing',
      arguments: { a: 1 },
      inputResponses: { q1: { role: 'assistant', content: { type: 'text', text: 'sampled' } } },
      requestState: 'opaque-token', // echoed byte-exact, never inspected
    });
    expect((secondMeta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']).toBe(
      '2026-07-28',
    );
  });

  it('leaves a plain (legacy) result completely untouched', async () => {
    const legacy = new ScriptedTransport([
      () => ({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } }),
      () => ({ content: [{ type: 'text', text: 'plain' }] }), // no resultType, as pre-2026 servers send
    ]);
    const client = new McpClient(legacy, { protocolMode: 'legacy' });
    await client.connect();

    const res = await client.callTool('x');

    expect(res.content).toEqual([{ type: 'text', text: 'plain' }]);
    // Exactly one tools/call: a result without `resultType` costs no extra round-trip and the
    // driver never runs. R3 — the field is optional and its absence is the old behaviour.
    expect(legacy.toolCalls()).toHaveLength(1);
  });

  it('propagates a handler failure instead of retrying forever', async () => {
    const t = new ScriptedTransport([askForSampling('s'), done('unreachable')]);
    const client = new McpClient(t, {
      onServerRequest: async () => {
        throw new McpError({ code: McpErrorCode.InvalidRequest, message: 'user declined' });
      },
    });
    await client.connect();
    await expect(client.callTool('do_thing')).rejects.toThrow('user declined');
  });
});

describe('getPrompt drives it too', () => {
  it('resolves through the same driver', async () => {
    const t = new ScriptedTransport([
      () => ({
        resultType: 'input_required',
        requestState: 'p1',
        inputRequests: { r: { method: 'roots/list' } },
      }),
      () => ({ resultType: 'complete', messages: [{ role: 'user', content: { type: 'text', text: 'ok' } }] }),
    ]);
    const client = new McpClient(t, { onServerRequest: async () => ({ roots: [] }) });
    await client.connect();

    const res = await client.getPrompt('p', { k: 'v' });
    expect(res.messages).toHaveLength(1);
    const second = t.calls.filter((c) => c.method === 'prompts/get')[1]?.params as Record<string, unknown>;
    expect(second.requestState).toBe('p1');
    expect(second.inputResponses).toEqual({ r: { roots: [] } });
  });
});
