/** ConsoleSink — writes LogEvents to stdout/stderr with simple formatting.
 *
 *  - error/warn → stderr
 *  - info/debug/trace → stdout
 *
 *  Format (default): `[ISO_TIMESTAMP] [LEVEL] [source] kind: message  {data}`
 *  Caller may pass a custom `format` callback for full control. */

import type { LogEvent, LogLevel, LogSink } from './types';

export interface ConsoleSinkConfig {
  /** Custom formatter overrides the default `[ts] [level] [source] kind: message`. */
  format?: (event: LogEvent) => string;
  /** Writers (test override). Defaults to process.stderr / process.stdout. */
  stderr?: { write: (s: string) => unknown };
  stdout?: { write: (s: string) => unknown };
}

const STDERR_LEVELS: ReadonlySet<LogLevel> = new Set(['error', 'warn']);

/** A writer over process streams when available (Node/Bun), else console.
 *  Keeps ConsoleSink usable in the browser without a custom writer. */
type Writer = { write: (s: string) => unknown };
const hasProcess = typeof process !== 'undefined' && !!(process as { stderr?: unknown }).stderr;
const defaultStderr: Writer = hasProcess
  ? process.stderr
  : { write: (s: string) => console.error(s.replace(/\n$/, '')) };
const defaultStdout: Writer = hasProcess
  ? process.stdout
  : { write: (s: string) => console.log(s.replace(/\n$/, '')) };

export class ConsoleSink implements LogSink {
  private readonly format: (event: LogEvent) => string;
  private readonly stderr: { write: (s: string) => unknown };
  private readonly stdout: { write: (s: string) => unknown };

  constructor(config?: ConsoleSinkConfig) {
    this.format = config?.format ?? defaultFormat;
    this.stderr = config?.stderr ?? defaultStderr;
    this.stdout = config?.stdout ?? defaultStdout;
  }

  log(event: LogEvent): void {
    const line = `${this.format(event)}\n`;
    if (STDERR_LEVELS.has(event.level)) {
      this.stderr.write(line);
    } else {
      this.stdout.write(line);
    }
  }
}

function defaultFormat(event: LogEvent): string {
  const ts = new Date(event.timestamp).toISOString();
  const head = `[${ts}] [${event.level.toUpperCase()}] [${event.source}] ${event.kind}`;
  const tail: string[] = [];
  if (event.message) tail.push(event.message);
  if (event.ctx && Object.keys(event.ctx).length > 0) {
    tail.push(JSON.stringify({ ctx: event.ctx }));
  }
  if (event.data && Object.keys(event.data).length > 0) {
    tail.push(JSON.stringify(event.data));
  }
  return tail.length > 0 ? `${head}: ${tail.join(' ')}` : head;
}
