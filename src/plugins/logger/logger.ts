/** Logger — fan-out from HookBus events into one or more LogSinks.
 *
 *  Two ways to feed the Logger:
 *    1. `attach(hooks)` — subscribes to known SDK hook events (onWarning today;
 *       more added as later phases land). Converts each to a LogEvent.
 *    2. `log(event)` — direct entry for plugins that want to log without
 *       going through HookBus.
 *
 *  Level filtering: events below `minLevel` are dropped before reaching sinks.
 *
 *  Multiple sinks are dispatched in parallel; sink errors are caught and
 *  re-emitted as `system.logger-sink-error` to stderr (so a bad sink can't
 *  silently kill log delivery). */

import type { HookBus } from '../../bus/hook-bus';
import type { HookHandler, HookName } from '../../bus/hook-map';
import { type LogEvent, type LogLevel, type LogSink, LOG_LEVEL_RANK } from './types';

export interface LoggerConfig {
  sinks: LogSink[];
  /** Drop events with rank below this level. Default: 'info'. */
  minLevel?: LogLevel;
}

export class Logger {
  private readonly sinks: LogSink[];
  private readonly minRank: number;
  private detachers: Array<() => void> = [];

  constructor(config: LoggerConfig) {
    if (config.sinks.length === 0) {
      throw new Error('Logger requires at least one sink');
    }
    this.sinks = [...config.sinks];
    this.minRank = LOG_LEVEL_RANK[config.minLevel ?? 'info'];
  }

  /** Manually log an event. Bypasses HookBus. */
  log(event: LogEvent): void {
    if (LOG_LEVEL_RANK[event.level] < this.minRank) return;
    for (const sink of this.sinks) {
      try {
        const result = sink.log(event);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err) => this.handleSinkError(sink, err, event));
        }
      } catch (err) {
        this.handleSinkError(sink, err as Error, event);
      }
    }
  }

  /** Subscribe to known hook events on a HookBus, converting each to a leveled
   *  LogEvent (carrying the request's correlation ids). Returns this. */
  attach(hooks: HookBus): this {
    const sub = <K extends HookName>(name: K, handler: HookHandler<K>): void => {
      this.detachers.push(hooks.on(name, handler));
    };

    sub('onWarning', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'warn',
        source: ctx.source,
        kind: 'warning',
        message: ctx.message,
        data: { code: ctx.code, ...(ctx.details ?? {}) },
      });
    });

    sub('onCompletion', (ctx) => {
      const u = ctx.response.usage;
      this.log({
        timestamp: Date.now(),
        level: 'info',
        source: ctx.provider,
        kind: 'completion',
        message: `${ctx.provider}/${ctx.model} ${u.inputTokens}->${u.outputTokens} tok`,
        ctx: ctx.ctx,
        data: { finishReason: ctx.response.finishReason, latencyMs: ctx.response.latencyMs },
      });
    });

    sub('onModelError', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: ctx.willRetry ? 'warn' : 'error',
        source: ctx.provider,
        kind: 'model_error',
        message: `${ctx.error.message} (${ctx.queueName})`,
        ctx: ctx.trace,
        data: { attempt: ctx.attempt, willRetry: ctx.willRetry, errorKind: ctx.error.kind },
      });
    });

    sub('onRetry', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'warn',
        source: ctx.provider,
        kind: 'retry',
        message: `retry #${ctx.attempt} (${ctx.reason}) after ${ctx.backoffMs}ms`,
        ctx: ctx.trace,
        data: { attempt: ctx.attempt, reason: ctx.reason, backoffMs: ctx.backoffMs },
      });
    });

    sub('onRateLimitHit', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'warn',
        source: ctx.provider,
        kind: 'rate_limit',
        message: `rate limited (HTTP ${ctx.status})`,
        ctx: ctx.trace,
        data: { retryAfterMs: ctx.retryAfterMs },
      });
    });

    sub('onMediaGenerated', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'info',
        source: ctx.provider,
        kind: 'media',
        message: `${ctx.mediaType ?? 'media'} x${ctx.count ?? 1}`,
        ctx: ctx.trace,
      });
    });

    sub('onMediaError', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'error',
        source: ctx.provider,
        kind: 'media_error',
        message: String(ctx.error),
      });
    });

    sub('onInternalError', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'error',
        source: ctx.source ?? 'internal',
        kind: 'internal_error',
        message: ctx.error.message,
        data: { queueName: ctx.queueName, provider: ctx.provider },
      });
    });

    sub('onBudgetWarning', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'warn',
        source: 'cost',
        kind: 'budget_warning',
        message: `budget ${ctx.budgetId} at ${ctx.percentage.toFixed(0)}%`,
        data: { current: ctx.current, limit: ctx.limit },
      });
    });

    sub('onBudgetExceeded', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'error',
        source: 'cost',
        kind: 'budget_exceeded',
        message: `budget ${ctx.budgetId} exceeded ($${ctx.current.toFixed(4)} / $${ctx.limit})`,
      });
    });

    sub('onCostEntry', (ctx) => {
      this.log({
        timestamp: Date.now(),
        level: 'debug',
        source: ctx.entry.provider,
        kind: 'cost',
        message: `$${ctx.entry.cost.total.toFixed(6)} (${ctx.entry.cost.source})`,
        data: { runningTotal: ctx.runningTotal },
      });
    });

    return this;
  }

  /** Unsubscribe from any HookBus(es) attached to. */
  detach(): void {
    for (const d of this.detachers) d();
    this.detachers = [];
  }

  /** Flush any buffering sinks (best-effort; errors swallowed per-sink). */
  async flush(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        if (!sink.flush) return;
        try {
          await sink.flush();
        } catch {
          /* swallow */
        }
      }),
    );
  }

  /** Detach + flush. */
  async destroy(): Promise<void> {
    this.detach();
    await this.flush();
  }

  private handleSinkError(sink: LogSink, err: unknown, originalEvent: LogEvent): void {
    // Avoid recursing through this very Logger; write directly to stderr.
    const msg =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown sink error';
    const line = `[${new Date().toISOString()}] [ERROR] [logger] sink-error: ${msg} (originalKind=${originalEvent.kind})`;
    if (typeof process !== 'undefined' && process.stderr) process.stderr.write(`${line}\n`);
    else console.error(line);
  }
}
