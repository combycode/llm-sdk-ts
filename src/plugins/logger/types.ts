/** Logger types — sinks, levels, events. */

import type { RequestContext } from '../../types/request-context';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Numeric ranking — higher is more severe. Used to compare against minLevel. */
export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEvent {
  timestamp: number;
  level: LogLevel;
  /** Logical source: 'network', 'llm', 'agent', 'server', or a plugin name. */
  source: string;
  /** Hook name or short identifier of the kind of event. */
  kind: string;
  /** Optional human-readable message. */
  message?: string;
  /** Accumulating IDs (userId, requestId, conversationId, callId, ...). */
  ctx?: RequestContext;
  /** Arbitrary structured data — sinks decide how to render. */
  data?: Record<string, unknown>;
}

/** A LogSink consumes LogEvents. Built-in: ConsoleSink. Future: OTel, Sentry, File. */
export interface LogSink {
  log(event: LogEvent): void | Promise<void>;
  /** Optional flush hook — called by Logger.flush() / destroy(). */
  flush?(): void | Promise<void>;
}
