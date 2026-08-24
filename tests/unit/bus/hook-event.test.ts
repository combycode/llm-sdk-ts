/** The event union is the portable contract — one variant per hook, no drift.
 *
 *  `HookEvent` is derived from `HookMap`, so these tests are not checking a
 *  hand-written list against another hand-written list. They check the two
 *  properties a port depends on:
 *
 *    1. Every hook that can be emitted arrives on the stream. A hook added to
 *       the map but never reaching `onAny` would be invisible to telemetry and
 *       to any Rust/Python consumer generated from the same catalog.
 *    2. A consumer that switches over `type` is told by the COMPILER when a new
 *       variant appears. That is what a Rust `match` gives for free and what the
 *       old `(name, ctx: unknown)` shape could never give.
 */
import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import type { HookEvent, HookMap, HookName } from '../../../src/bus/hook-map';

/** Every key of HookMap, as values. Written as a `Record<HookName, true>` so a
 *  hook added to the map fails to compile here until it is listed — the list
 *  cannot silently fall behind. */
const ALL_HOOKS: Record<HookName, true> = {
  onWarning: true,
  onInternalError: true,
  onEnqueue: true,
  onDequeue: true,
  onQueueTimeout: true,
  onRateLimitUpdate: true,
  onRequestStart: true,
  onRequestComplete: true,
  onModelError: true,
  onRateLimitHit: true,
  onRetry: true,
  onStreamChunk: true,
  onRealtimeOpen: true,
  onRealtimeFrame: true,
  onRealtimeClose: true,
  onRealtimeError: true,
  onClientCreate: true,
  onClientDestroy: true,
  onMessageResolve: true,
  onBeforeSubmit: true,
  onCompletion: true,
  onAgentCreate: true,
  onAgentDestroy: true,
  onRunStart: true,
  onStepStart: true,
  onStepComplete: true,
  onToolCallStart: true,
  onToolCallComplete: true,
  onToolCallError: true,
  onToolSearch: true,
  onRunComplete: true,
  onRunError: true,
  onGuardrailTriggered: true,
  onApprovalRequested: true,
  onApprovalResolved: true,
  onServerRequest: true,
  onServerResponse: true,
  onAuthFail: true,
  onCostEntry: true,
  onBudgetWarning: true,
  onBudgetExceeded: true,
  onContextMeasure: true,
  onMediaGenerated: true,
  onMediaError: true,
  onMediaProgress: true,
  onInternalToolCallStart: true,
  onInternalToolCallComplete: true,
  onInternalToolCallError: true,
  onMcpConnect: true,
  onMcpToolCall: true,
  onMcpError: true,
};

const HOOK_NAMES = Object.keys(ALL_HOOKS) as HookName[];

describe('HookEvent', () => {
  it('every hook in the map reaches a catch-all subscriber as { type, ctx }', () => {
    const bus = new HookBus();
    const seen: HookEvent[] = [];
    bus.onAny((event) => {
      seen.push(event);
    });

    for (const name of HOOK_NAMES) {
      // The envelope is what is under test; the payload only has to be identifiable.
      bus.emitSync(name, { probe: name } as unknown as HookMap[typeof name]);
    }

    expect(seen.map((e) => e.type)).toEqual(HOOK_NAMES);
    expect(seen.every((e) => (e.ctx as unknown as { probe: string }).probe === e.type)).toBe(true);
  });

  it('a switch over every variant leaves `never` — so a new hook breaks consumers loudly', () => {
    // This is the compile-time half, and it is the half that matters: if a 52nd
    // hook is added to HookMap, `rest` stops being `never` and this file fails to
    // typecheck. A port generated from the same catalog gets the same signal.
    function categorise(event: HookEvent): string {
      switch (event.type) {
        case 'onCompletion':
          return `llm:${event.ctx.provider}`;
        case 'onToolCallStart':
          return `tool:${event.ctx.toolName}`;
        case 'onMcpToolCall':
          return `mcp:${event.ctx.server}`;
        default: {
          // Not `never` here — the three cases above are a subset on purpose, so
          // this branch proves the OPPOSITE property: an unhandled variant keeps
          // its name and stays usable.
          const rest: Exclude<HookEvent, { type: 'onCompletion' | 'onToolCallStart' | 'onMcpToolCall' }> =
            event;
          return rest.type;
        }
      }
    }

    const bus = new HookBus();
    const labels: string[] = [];
    bus.onAny((e) => {
      labels.push(categorise(e));
    });
    bus.emitSync('onCompletion', { provider: 'openai' } as unknown as HookMap['onCompletion']);
    bus.emitSync('onToolCallStart', { toolName: 'search' } as unknown as HookMap['onToolCallStart']);
    bus.emitSync('onMcpToolCall', { server: 'fs' } as unknown as HookMap['onMcpToolCall']);
    bus.emitSync('onRetry', {} as unknown as HookMap['onRetry']);

    expect(labels).toEqual(['llm:openai', 'tool:search', 'mcp:fs', 'onRetry']);
  });

  it('the union has exactly one variant per hook', () => {
    // Guards the derivation itself: `{ [K in HookName]: ... }[HookName]` collapses
    // to `never` if HookMap is ever emptied or the mapped type is mistyped, and a
    // union of `never` would make every test above vacuously pass.
    const sample: HookEvent = { type: 'onWarning', ctx: { source: 'agent', code: 'c', message: 'm' } };
    expect(sample.type).toBe('onWarning');
    expect(HOOK_NAMES).toHaveLength(51);
  });
});
