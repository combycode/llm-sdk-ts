import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { CompletionContext, ContextMeasureContext } from '../../../../src/bus/hook-map';
import { ConversationHistory } from '../../../../src/agent/history';
import { ModelCatalog } from '../../../../src/plugins/model-catalog/catalog';
import { MemoryPersistence } from '../../../../src/plugins/persistence/memory';
import { ContextMeasurer } from '../../../../src/plugins/context-measurer/measurer';
import { HeuristicCounter } from '../../../../src/plugins/context-measurer/counter/heuristic';
import { PersistenceCalibrationStore } from '../../../../src/plugins/context-measurer/calibration/store';

function buildCatalog(): ModelCatalog {
  const c = new ModelCatalog();
  c.set('test', 'tiny', {
    pricing: { inputPerMTok: 1, outputPerMTok: 1 },
    contextWindow: 1000,
    tokenizer: { strategy: 'heuristic', charsPerTokenDefault: 4, countApiAvailable: false },
  });
  return c;
}

describe('ContextMeasurer', () => {
  it('emits onContextMeasure with current/window/percentage on resolve', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog();
    const measurer = new ContextMeasurer({ hooks, catalog });

    const events: ContextMeasureContext[] = [];
    hooks.on('onContextMeasure', (ctx) => {
      events.push(ctx);
    });

    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages: [{ role: 'user', content: 'hello world' }],
    });

    expect(events.length).toBe(1);
    expect(events[0].provider).toBe('test');
    expect(events[0].window).toBe(1000);
    expect(events[0].current).toBeGreaterThan(0);
    expect(events[0].percentage).not.toBeNull();
    measurer.destroy();
  });

  it('returns abort=true when listener sets ctx.abort', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog();
    new ContextMeasurer({ hooks, catalog });

    hooks.on('onContextMeasure', (ctx) => {
      ctx.abort = true;
      ctx.abortReason = 'too big';
    });

    const resolveCtx = {
      provider: 'test',
      model: 'tiny',
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    await hooks.emit('onMessageResolve', resolveCtx);

    expect(resolveCtx).toMatchObject({ abort: true, abortReason: 'too big' });
  });

  it('learns from completion, updating calibration store via EMA', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog();
    const persistence = new MemoryPersistence();
    new ContextMeasurer({ hooks, catalog, persistence });

    const completion: CompletionContext = {
      provider: 'test',
      model: 'tiny',
      response: {
        id: 'r',
        model: 'tiny',
        content: [],
        finishReason: 'stop',
        usage: {
          inputTokens: 100,
          outputTokens: 0,
          totalTokens: 100,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        text: '',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      },
      request: {
        estimatedInputTokens: 100,
        inputChars: 500, // 5 chars/token actual
        messageCount: 1,
        hasTools: false,
      },
      ctx: {},
    };
    await hooks.emit('onCompletion', completion);

    // Calibration is fire-and-forget — give it a tick.
    await new Promise((r) => setTimeout(r, 10));

    const store = new PersistenceCalibrationStore(persistence);
    const entry = await store.get('test', 'tiny');
    expect(entry).not.toBeNull();
    // First sample uses raw ratio (no EMA blend yet) — so ratio ≈ 5.
    expect(entry!.charsPerToken).toBeCloseTo(5, 1);
    expect(entry!.samples).toBe(1);
  });

  it('exact-mode upgrades when threshold crossed', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog();
    let measureCalls = 0;
    const counter = new HeuristicCounter(catalog);
    const realMeasureMessage = counter.measureMessage.bind(counter);
    counter.measureMessage = (msg, ctx) => {
      measureCalls++;
      return realMeasureMessage(msg, ctx);
    };
    new ContextMeasurer({
      hooks,
      catalog,
      counter,
      thresholds: { warn: 0.5, exact: 0.5 },
    });

    const events: ContextMeasureContext[] = [];
    hooks.on('onContextMeasure', (ctx) => {
      events.push(ctx);
    });

    // 800 chars → 200 estimated tokens at rate 4 → ≥ 0.5 of 1000 window.
    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages: [{ role: 'user', content: 'x'.repeat(2400) }],
    });

    expect(events.length).toBe(1);
    expect(events[0].accuracy).toBe('exact');
    expect(measureCalls).toBeGreaterThan(0);
  });

  it('forwards history reference to onContextMeasure when provided', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog();
    new ContextMeasurer({ hooks, catalog });

    const history = new ConversationHistory();
    const events: ContextMeasureContext[] = [];
    hooks.on('onContextMeasure', (ctx) => {
      events.push(ctx);
    });

    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages: [{ role: 'user', content: 'hi' }],
      history,
    });

    expect(events[0].history).toBe(history);
  });
});

describe('PersistenceCalibrationStore', () => {
  it('blends new samples via EMA with existing', async () => {
    const persistence = new MemoryPersistence();
    const store = new PersistenceCalibrationStore(persistence, {
      emaAlpha: 0.5,
      minSamplesForConfidence: 4,
    });

    await store.update({ provider: 'p', model: 'm', charsPerToken: 4, samples: 1 });
    const second = await store.update({
      provider: 'p',
      model: 'm',
      charsPerToken: 6,
      samples: 1,
    });

    // 0.5 * 6 + 0.5 * 4 = 5
    expect(second.charsPerToken).toBeCloseTo(5, 5);
    expect(second.samples).toBe(2);
    expect(second.confidence).toBeCloseTo(0.5, 5);
  });

  it('lists and resets entries', async () => {
    const persistence = new MemoryPersistence();
    const store = new PersistenceCalibrationStore(persistence);
    await store.update({ provider: 'a', model: '1', charsPerToken: 4, samples: 1 });
    await store.update({ provider: 'a', model: '2', charsPerToken: 4, samples: 1 });
    await store.update({ provider: 'b', model: '1', charsPerToken: 4, samples: 1 });

    const all = await store.list();
    expect(all.length).toBe(3);

    const onlyA = await store.list({ provider: 'a' });
    expect(onlyA.length).toBe(2);

    await store.reset({ provider: 'a' });
    const after = await store.list();
    expect(after.length).toBe(1);
    expect(after[0].provider).toBe('b');
  });
});
