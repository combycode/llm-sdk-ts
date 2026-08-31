/** Logger — the full HookBus fan-out.
 *
 *  Each subscription is a contract about severity and shape: an operator's
 *  alerting rules key off `level` and `kind`, and a support trace is only
 *  followable if the request's correlation ids ride along. A hook that logs at
 *  the wrong level is worse than one that does not log at all — it either pages
 *  someone for a retry that succeeded, or buries a budget breach in debug.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { Logger } from '../../../../src/plugins/logger/logger';
import type { LogEvent, LogSink } from '../../../../src/plugins/logger/types';

class CollectorSink implements LogSink {
  events: LogEvent[] = [];
  log(event: LogEvent): void {
    this.events.push(event);
  }
}

function attached(): { sink: CollectorSink; hooks: HookBus; logger: Logger } {
  const sink = new CollectorSink();
  const hooks = new HookBus();
  const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
  logger.attach(hooks);
  return { sink, hooks, logger };
}

const trace = { sessionId: 's1', requestId: 'r1' };

function only(sink: CollectorSink, kind: string): LogEvent {
  const found = sink.events.filter((e) => e.kind === kind);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('Logger — network events', () => {
  it('a rate limit is a warning naming the HTTP status, with the retry hint in data', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onRateLimitHit', {
      provider: 'openai',
      model: 'gpt-x',
      queueName: 'q',
      status: 429,
      retryAfterMs: 2500,
      headers: {},
      remainingRequests: 0,
      remainingTokens: 0,
      limitRequests: 100,
      limitTokens: 1000,
      trace,
    });

    const e = only(sink, 'rate_limit');
    expect(e.level).toBe('warn');
    expect(e.source).toBe('openai');
    expect(e.message).toBe('rate limited (HTTP 429)');
    expect(e.data).toEqual({ retryAfterMs: 2500 });
    expect(e.ctx).toEqual(trace);
  });

  it('a model error that will NOT be retried is an error, not a warning', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onModelError', {
      provider: 'anthropic',
      model: 'claude-x',
      queueName: 'main',
      error: { message: 'bad request', kind: 'invalid_request' },
      headers: {},
      attempt: 2,
      willRetry: false,
      trace,
    } as never);

    const e = only(sink, 'model_error');
    expect(e.level).toBe('error');
    expect(e.message).toBe('bad request (main)');
    expect(e.data).toEqual({ attempt: 2, willRetry: false, errorKind: 'invalid_request' });
  });
});

describe('Logger — media events', () => {
  it('generated media is info, naming the type and the count', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onMediaGenerated', {
      parts: [],
      stored: true,
      provider: 'google',
      source: 'inline',
      mediaType: 'image',
      count: 3,
      trace,
    } as never);

    const e = only(sink, 'media');
    expect(e.level).toBe('info');
    expect(e.source).toBe('google');
    expect(e.message).toBe('image x3');
    expect(e.ctx).toEqual(trace);
  });

  it('media with no type or count still logs, using neutral defaults', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onMediaGenerated', {
      parts: [],
      stored: false,
      provider: 'openai',
      source: 'media_output',
    } as never);

    expect(only(sink, 'media').message).toBe('media x1');
  });

  it('a media failure is an error carrying the failure text', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onMediaError', {
      id: 'm1',
      type: 'video',
      provider: 'google',
      error: 'render timed out',
    });

    const e = only(sink, 'media_error');
    expect(e.level).toBe('error');
    expect(e.message).toBe('render timed out');
  });
});

describe('Logger — internal errors', () => {
  it('is an error attributed to the raising subsystem', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onInternalError', {
      source: 'cache',
      error: { message: 'store unavailable' },
      queueName: 'main',
      provider: 'openai',
    } as never);

    const e = only(sink, 'internal_error');
    expect(e.level).toBe('error');
    expect(e.source).toBe('cache');
    expect(e.message).toBe('store unavailable');
    expect(e.data).toEqual({ queueName: 'main', provider: 'openai' });
  });

  it('falls back to the "internal" source when the raiser did not name itself', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onInternalError', {
      source: undefined,
      error: { message: 'boom' },
      queueName: null,
      provider: null,
    } as never);

    expect(only(sink, 'internal_error').source).toBe('internal');
  });
});

describe('Logger — cost events', () => {
  it('a budget warning is a warn with the percentage rounded to a whole number', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onBudgetWarning', {
      budgetId: 'daily',
      scope: {},
      limit: 10,
      current: 8.4,
      threshold: 0.8,
      percentage: 84.37,
    });

    const e = only(sink, 'budget_warning');
    expect(e.level).toBe('warn');
    expect(e.source).toBe('cost');
    expect(e.message).toBe('budget daily at 84%');
    expect(e.data).toEqual({ current: 8.4, limit: 10 });
  });

  it('a budget breach is an error showing spend against the limit', async () => {
    const { sink, hooks } = attached();

    await hooks.emit('onBudgetExceeded', {
      budgetId: 'daily',
      scope: {},
      limit: 10,
      current: 10.123456789,
      overage: 0.123456789,
    });

    const e = only(sink, 'budget_exceeded');
    expect(e.level).toBe('error');
    expect(e.source).toBe('cost');
    // Four decimals: enough to see cents, not so many it reads as noise.
    expect(e.message).toBe('budget daily exceeded ($10.1235 / $10)');
  });

  it('a per-call cost entry is DEBUG — routine, and far too frequent to be info', async () => {
    const { sink, hooks } = attached();

    hooks.emitSync('onCostEntry', {
      entry: {
        id: 'e1',
        timestamp: 0,
        provider: 'openai',
        model: 'gpt-x',
        tokens: { input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 },
        cost: {
          input: 0.001,
          output: 0.0005,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          total: 0.0015,
          source: 'calculated',
        },
        providerEvidence: {},
        tags: {},
      },
      runningTotal: 1.25,
    } as never);

    const e = only(sink, 'cost');
    expect(e.level).toBe('debug');
    expect(e.source).toBe('openai');
    // Six decimals: a single cheap call is well under a hundredth of a cent.
    expect(e.message).toBe('$0.001500 (calculated)');
    expect(e.data).toEqual({ runningTotal: 1.25 });
  });

  it('the default minLevel of info drops cost entries, so a run is not drowned in them', async () => {
    const sink = new CollectorSink();
    const hooks = new HookBus();
    new Logger({ sinks: [sink] }).attach(hooks);

    hooks.emitSync('onCostEntry', {
      entry: {
        id: 'e1',
        timestamp: 0,
        provider: 'openai',
        model: 'gpt-x',
        tokens: { input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 },
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          total: 0,
          source: 'calculated',
        },
        providerEvidence: {},
        tags: {},
      },
      runningTotal: 0,
    } as never);
    await hooks.emit('onBudgetWarning', {
      budgetId: 'b',
      scope: {},
      limit: 1,
      current: 1,
      threshold: 1,
      percentage: 100,
    });

    expect(sink.events.map((e) => e.kind)).toEqual(['budget_warning']);
  });
});

describe('Logger — attach lifecycle', () => {
  it('one attach subscribes to every hook it knows, and detach removes all of them', async () => {
    const { sink, hooks, logger } = attached();
    const subscribed = hooks.handlerCount;
    expect(subscribed).toBe(11);

    logger.detach();
    expect(hooks.handlerCount).toBe(0);

    await hooks.emit('onMediaError', { id: 'm', type: 'image', provider: 'p', error: 'x' });
    expect(sink.events).toHaveLength(0);
  });

  it('detach twice is harmless', () => {
    const { hooks, logger } = attached();
    logger.detach();
    logger.detach();
    expect(hooks.handlerCount).toBe(0);
  });

  it('a logger can be re-attached after a detach, and detaches cleanly again', async () => {
    const { sink, hooks, logger } = attached();
    logger.detach();
    logger.attach(hooks);
    expect(hooks.handlerCount).toBe(11);

    await hooks.emit('onMediaError', { id: 'm', type: 'image', provider: 'p', error: 'again' });
    expect(sink.events.map((e) => e.message)).toEqual(['again']);

    logger.detach();
    expect(hooks.handlerCount).toBe(0);
  });

  it('attaching to two buses fans in from both', async () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    const a = new HookBus();
    const b = new HookBus();
    logger.attach(a).attach(b);

    await a.emit('onMediaError', { id: '1', type: 'image', provider: 'p', error: 'from-a' });
    await b.emit('onMediaError', { id: '2', type: 'image', provider: 'p', error: 'from-b' });

    expect(sink.events.map((e) => e.message)).toEqual(['from-a', 'from-b']);

    logger.detach();
    expect(a.handlerCount).toBe(0);
    expect(b.handlerCount).toBe(0);
  });
});

describe('Logger — a broken sink cannot take the process down', () => {
  it('reports the sink failure on stderr and keeps the other sinks fed', () => {
    const original = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      written.push(s);
      return true;
    };
    try {
      const good = new CollectorSink();
      const bad: LogSink = {
        log() {
          throw new Error('disk full');
        },
      };
      const logger = new Logger({ sinks: [bad, good], minLevel: 'trace' });
      logger.log({ timestamp: 1, level: 'info', source: 's', kind: 'demo', message: 'hi' });

      expect(good.events).toHaveLength(1);
      expect(written.join('')).toContain('sink-error: disk full');
      expect(written.join('')).toContain('originalKind=demo');
      expect(written.join('')).toContain('[ERROR] [logger]');
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
  });

  it('a non-Error thrown value still names itself on stderr', () => {
    const original = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      written.push(s);
      return true;
    };
    try {
      const stringThrower: LogSink = {
        log() {
          throw 'just a string';
        },
      };
      const objectThrower: LogSink = {
        log() {
          throw { code: 7 };
        },
      };
      const logger = new Logger({ sinks: [stringThrower, objectThrower], minLevel: 'trace' });
      logger.log({ timestamp: 1, level: 'info', source: 's', kind: 'demo' });

      expect(written.join('')).toContain('sink-error: just a string');
      expect(written.join('')).toContain('sink-error: unknown sink error');
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
  });

  it('an async sink rejection is reported without unhandled-rejection noise', async () => {
    const original = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      written.push(s);
      return true;
    };
    try {
      const bad: LogSink = { log: async () => Promise.reject(new Error('network down')) };
      const logger = new Logger({ sinks: [bad], minLevel: 'trace' });
      logger.log({ timestamp: 1, level: 'info', source: 's', kind: 'demo' });
      // A macrotask boundary: every pending microtask (the .catch) has run by then.
      await new Promise((r) => setTimeout(r, 0));
      expect(written.join('')).toContain('sink-error: network down');
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
  });

  it('flush() swallows a sink that fails to flush and still flushes the others', async () => {
    let secondFlushed = false;
    const bad: LogSink = { log() {}, flush: async () => Promise.reject(new Error('nope')) };
    const good: LogSink = {
      log() {},
      async flush() {
        secondFlushed = true;
      },
    };
    const logger = new Logger({ sinks: [bad, good], minLevel: 'trace' });

    await logger.flush();

    expect(secondFlushed).toBe(true);
  });
});
