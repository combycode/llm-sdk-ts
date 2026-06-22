import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { ConsoleSink } from '../../../../src/plugins/logger/console-sink';
import { Logger } from '../../../../src/plugins/logger/logger';
import type { LogEvent, LogSink } from '../../../../src/plugins/logger/types';

class CollectorSink implements LogSink {
  events: LogEvent[] = [];
  log(event: LogEvent): void {
    this.events.push(event);
  }
}

class StringWriter {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

describe('Logger — direct log()', () => {
  it('dispatches to a single sink', () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    logger.log({
      timestamp: 100,
      level: 'info',
      source: 'test',
      kind: 'demo',
      message: 'hello',
    });
    expect(sink.events.length).toBe(1);
    expect(sink.events[0].message).toBe('hello');
  });

  it('fans out to multiple sinks', () => {
    const a = new CollectorSink();
    const b = new CollectorSink();
    const logger = new Logger({ sinks: [a, b], minLevel: 'trace' });
    logger.log({ timestamp: 1, level: 'info', source: 's', kind: 'k' });
    expect(a.events.length).toBe(1);
    expect(b.events.length).toBe(1);
  });

  it('drops events below minLevel', () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink], minLevel: 'warn' });
    logger.log({ timestamp: 1, level: 'info', source: 's', kind: 'k' });
    logger.log({ timestamp: 2, level: 'warn', source: 's', kind: 'k' });
    logger.log({ timestamp: 3, level: 'error', source: 's', kind: 'k' });
    expect(sink.events.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('default minLevel is info', () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink] });
    logger.log({ timestamp: 1, level: 'debug', source: 's', kind: 'k' });
    logger.log({ timestamp: 2, level: 'info', source: 's', kind: 'k' });
    expect(sink.events.map((e) => e.level)).toEqual(['info']);
  });

  it('throws when constructed with no sinks', () => {
    expect(() => new Logger({ sinks: [] })).toThrow();
  });

  it('continues when one sink throws synchronously', () => {
    const bad: LogSink = {
      log() {
        throw new Error('bad');
      },
    };
    const good = new CollectorSink();
    const logger = new Logger({ sinks: [bad, good], minLevel: 'trace' });
    logger.log({ timestamp: 1, level: 'info', source: 's', kind: 'k' });
    expect(good.events.length).toBe(1);
  });

  it('continues when a sink returns a rejected promise', async () => {
    const bad: LogSink = {
      log: async () => {
        throw new Error('bad');
      },
    };
    const good = new CollectorSink();
    const logger = new Logger({ sinks: [bad, good], minLevel: 'trace' });
    logger.log({ timestamp: 1, level: 'info', source: 's', kind: 'k' });
    // Allow microtask to settle.
    await Promise.resolve();
    expect(good.events.length).toBe(1);
  });
});

describe('Logger — attach to HookBus', () => {
  it('subscribes to onWarning', async () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    const hooks = new HookBus();
    logger.attach(hooks);

    await hooks.emit('onWarning', { source: 'agent', code: 'C1', message: 'something' });

    expect(sink.events.length).toBe(1);
    expect(sink.events[0].level).toBe('warn');
    expect(sink.events[0].source).toBe('agent');
    expect(sink.events[0].message).toBe('something');
    expect(sink.events[0].data).toEqual({ code: 'C1' });
  });

  it('logs completion (info, with usage + correlation ctx)', async () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    const hooks = new HookBus();
    logger.attach(hooks);

    await hooks.emit('onCompletion', {
      provider: 'openai',
      model: 'gpt-x',
      response: { usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'stop', latencyMs: 12 },
      ctx: { sessionId: 's', requestId: 'r' },
    } as never);

    const e = sink.events.find((x) => x.kind === 'completion');
    expect(e?.level).toBe('info');
    expect(e?.message).toContain('10->5');
    expect(e?.ctx).toEqual({ sessionId: 's', requestId: 'r' });
  });

  it('logs model errors / retries / rate-limits at the right levels', async () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    const hooks = new HookBus();
    logger.attach(hooks);

    const trace = { sessionId: 's', requestId: 'r' };
    await hooks.emit('onModelError', {
      provider: 'p', model: 'm', queueName: 'q', error: { message: 'boom', kind: 'server_error' },
      headers: {}, attempt: 0, willRetry: true, trace,
    } as never);
    hooks.emitSync('onRetry', {
      provider: 'p', model: 'm', queueName: 'q', attempt: 1, backoffMs: 200, reason: 'server_error', idempotencyKey: 'k', trace,
    } as never);

    const me = sink.events.find((x) => x.kind === 'model_error');
    const rt = sink.events.find((x) => x.kind === 'retry');
    expect(me?.level).toBe('warn'); // willRetry → warn, not error
    expect(me?.ctx).toEqual(trace);
    expect(rt?.message).toContain('retry #1');
  });

  it('detach() unsubscribes from hooks', async () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    const hooks = new HookBus();
    logger.attach(hooks);
    logger.detach();

    await hooks.emit('onWarning', { source: 'agent', code: 'C1', message: 'something' });
    expect(sink.events.length).toBe(0);
    expect(hooks.handlerCount).toBe(0);
  });

  it('attach is chainable', () => {
    const logger = new Logger({ sinks: [new CollectorSink()], minLevel: 'trace' });
    const hooks = new HookBus();
    expect(logger.attach(hooks)).toBe(logger);
  });
});

describe('Logger — flush + destroy', () => {
  it('flush() awaits sink.flush()', async () => {
    let flushed = false;
    const sink: LogSink = {
      log() {},
      async flush() {
        await new Promise((r) => setTimeout(r, 5));
        flushed = true;
      },
    };
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    await logger.flush();
    expect(flushed).toBe(true);
  });

  it('flush() ignores sinks without flush method', async () => {
    const logger = new Logger({ sinks: [new CollectorSink()] });
    await logger.flush();
  });

  it('destroy() detaches and flushes', async () => {
    const sink = new CollectorSink();
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    const hooks = new HookBus();
    logger.attach(hooks);
    expect(hooks.handlerCount).toBeGreaterThan(0);

    await logger.destroy();
    expect(hooks.handlerCount).toBe(0);
  });
});

describe('ConsoleSink', () => {
  it('writes warn/error to stderr, others to stdout', () => {
    const stderr = new StringWriter();
    const stdout = new StringWriter();
    const sink = new ConsoleSink({ stderr, stdout });

    sink.log({ timestamp: 1, level: 'info', source: 'x', kind: 'k', message: 'hi' });
    sink.log({ timestamp: 2, level: 'warn', source: 'x', kind: 'k', message: 'oops' });
    sink.log({ timestamp: 3, level: 'error', source: 'x', kind: 'k', message: 'boom' });

    expect(stdout.buf).toContain('hi');
    expect(stdout.buf).not.toContain('oops');
    expect(stderr.buf).toContain('oops');
    expect(stderr.buf).toContain('boom');
  });

  it('default format includes timestamp, level, source, kind', () => {
    const stdout = new StringWriter();
    const sink = new ConsoleSink({ stdout, stderr: new StringWriter() });
    sink.log({ timestamp: 1700000000000, level: 'info', source: 'src', kind: 'kind' });
    expect(stdout.buf).toContain('[INFO]');
    expect(stdout.buf).toContain('[src]');
    expect(stdout.buf).toContain('kind');
    expect(stdout.buf).toContain('2023');
  });

  it('appends data and ctx as JSON when present', () => {
    const stdout = new StringWriter();
    const sink = new ConsoleSink({ stdout, stderr: new StringWriter() });
    sink.log({
      timestamp: 1,
      level: 'info',
      source: 's',
      kind: 'k',
      message: 'hi',
      ctx: { requestId: 'req_1', userId: 'u1' },
      data: { foo: 42 },
    });
    expect(stdout.buf).toContain('hi');
    expect(stdout.buf).toContain('"requestId":"req_1"');
    expect(stdout.buf).toContain('"foo":42');
  });

  it('custom format() overrides default', () => {
    const stdout = new StringWriter();
    const sink = new ConsoleSink({
      stdout,
      stderr: new StringWriter(),
      format: (e) => `<<${e.level}|${e.kind}>>`,
    });
    sink.log({ timestamp: 1, level: 'info', source: 's', kind: 'demo' });
    expect(stdout.buf).toContain('<<info|demo>>');
  });
});

describe('Logger + ConsoleSink — end-to-end through hook bus', () => {
  it('warning event renders to stderr', async () => {
    const stderr = new StringWriter();
    const stdout = new StringWriter();
    const sink = new ConsoleSink({ stderr, stdout });
    const logger = new Logger({ sinks: [sink], minLevel: 'trace' });
    const hooks = new HookBus();
    logger.attach(hooks);

    await hooks.emit('onWarning', {
      source: 'cache',
      code: 'CACHE_MISS',
      message: 'cold start',
    });

    expect(stderr.buf).toContain('CACHE_MISS');
    expect(stderr.buf).toContain('cold start');
    expect(stdout.buf).toBe('');
  });
});
