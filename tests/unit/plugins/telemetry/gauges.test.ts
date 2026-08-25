/** The gauges come back down.
 *
 *  A counter that only rises is still readable — you look at the rate. A GAUGE
 *  that only rises is a lie: it reports the current state, and the number people
 *  check to decide whether the system is saturated drifts upward forever.
 *
 *  Both gauges have now been wrong this way. `queueDepth` only climbed until
 *  `onDequeue` was made to mirror the post-dequeue length. `inFlight` only
 *  climbed because it was decremented on `onRequestComplete` alone, and a failed
 *  attempt emits `onModelError` INSTEAD — the two are the success and catch
 *  branches of one try. Three failed model-list calls in the sandbox left it
 *  reading IN-FLIGHT 3 with every queue idle.
 *
 *  So this covers every gauge on the metrics object, and the failure shapes that
 *  end an attempt without completing it.
 */
import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { TelemetryAdapter } from '../../../../src/plugins/telemetry/telemetry';

const hooks = () => new HookBus();

const start = (bus: HookBus, attempt = 0) =>
  bus.emitSync('onRequestStart', {
    provider: 'openai',
    model: 'm',
    queueName: 'openai/m',
    url: 'https://api.openai.com/v1/responses',
    method: 'POST',
    bodySize: 1,
    attempt,
    idempotencyKey: `k${attempt}`,
    streaming: false,
  });

const complete = (bus: HookBus, attempt = 0) =>
  bus.emitSync('onRequestComplete', {
    provider: 'openai',
    model: 'm',
    queueName: 'openai/m',
    status: 200,
    headers: {},
    latencyMs: 5,
    attempt,
    bodySize: 1,
    streaming: false,
  });

const fail = (bus: HookBus, attempt = 0) =>
  bus.emitSync('onModelError', {
    provider: 'openai',
    model: 'm',
    queueName: 'openai/m',
    error: new Error('boom') as never,
    headers: {},
    attempt,
  } as never);

describe('inFlight', () => {
  it('returns to zero when every attempt succeeds', () => {
    const bus = hooks();
    const t = new TelemetryAdapter(bus);
    start(bus);
    start(bus, 1);
    expect(t.metrics.inFlight).toBe(2);
    complete(bus);
    complete(bus, 1);
    expect(t.metrics.inFlight).toBe(0);
    t.destroy();
  });

  it('returns to zero when attempts FAIL — the case that was leaking', () => {
    const bus = hooks();
    const t = new TelemetryAdapter(bus);
    for (let i = 0; i < 3; i++) start(bus, i);
    expect(t.metrics.inFlight).toBe(3);
    for (let i = 0; i < 3; i++) fail(bus, i);
    expect(t.metrics.inFlight).toBe(0);
    expect(t.metrics.errors).toBe(3);
    t.destroy();
  });

  it('balances a retry: start, fail, start again, succeed', () => {
    // `onRequestStart` fires per ATTEMPT, so a retry increments a second time and
    // its own outcome has to bring it back.
    const bus = hooks();
    const t = new TelemetryAdapter(bus);
    start(bus, 0);
    fail(bus, 0);
    start(bus, 1);
    complete(bus, 1);
    expect(t.metrics.inFlight).toBe(0);
    t.destroy();
  });

  it('never goes negative when a subscriber joins mid-flight', () => {
    // Attaching after a request began means seeing an outcome whose start was
    // never observed.
    const bus = hooks();
    const t = new TelemetryAdapter(bus);
    complete(bus);
    fail(bus);
    expect(t.metrics.inFlight).toBe(0);
    t.destroy();
  });
});

describe('queueDepth', () => {
  it('mirrors the queue rather than only climbing', () => {
    const bus = hooks();
    const t = new TelemetryAdapter(bus);
    bus.emitSync('onEnqueue', { provider: 'openai', model: 'm', queueName: 'q', queueLength: 3 } as never);
    expect(t.metrics.queueDepth).toBe(3);
    bus.emitSync('onDequeue', { provider: 'openai', model: 'm', queueName: 'q', queueLength: 0 } as never);
    expect(t.metrics.queueDepth).toBe(0);
    t.destroy();
  });
});
