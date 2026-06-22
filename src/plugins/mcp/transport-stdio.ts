/** Stdio MCP transport — spawns the server as a child process and exchanges
 *  newline-delimited JSON-RPC over stdin/stdout. Node/Bun only (browser callers
 *  get a friendly error via the lazy `node:child_process` loader). */

import { nodeChildProcess, nodeFs } from '../../runtime/runtime';
import { McpError, McpErrorCode } from './jsonrpc';
import type { McpTransport } from './transport';
import type { McpStdioConfig } from './types';
import { BaseJsonRpcTransport } from './base-transport';
import { windowsSpawnPlan } from './win-spawn';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Minimal safe env passed to the child (the server still needs PATH etc. to
 *  resolve its own runtime). User-supplied `env` overrides these. */
function safeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof process === 'undefined') return out;
  const keys =
    process.platform === 'win32'
      ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES']
      : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'TMPDIR'];
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export class StdioTransport extends BaseJsonRpcTransport implements McpTransport {
  private proc: import('node:child_process').ChildProcess | null = null;
  private buffer = '';
  private readonly timeoutMs: number;

  constructor(
    private readonly config: McpStdioConfig,
    opts: { timeoutMs?: number } = {},
  ) {
    super();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    const cp = await nodeChildProcess();
    const isWin = typeof process !== 'undefined' && process.platform === 'win32';

    let file = this.config.command;
    let args = this.config.args ?? [];
    let verbatim = false;
    if (isWin) {
      // Resolve real path + route .cmd/.bat through cmd.exe (no cross-spawn dep).
      const fs = await nodeFs();
      const plan = windowsSpawnPlan(file, args, process.env, (p) => fs.existsSync(p));
      file = plan.file;
      args = plan.args;
      verbatim = plan.verbatim;
    }

    const proc = cp.spawn(file, args, {
      env: { ...safeEnv(), ...this.config.env },
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    this.proc = proc;

    const stdout = proc.stdout;
    if (!stdout) throw new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP stdio: child has no stdout' });
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.on('exit', () =>
      this.failAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP stdio server exited' })),
    );
    proc.on('error', (e: Error) =>
      this.failAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: e.message })),
    );
  }

  setProtocolVersion(): void {
    // stdio has no per-message headers — nothing to record.
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const proc = this.proc;
    const stdin = proc?.stdin;
    if (!proc || !stdin) {
      throw new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP stdio transport not started' });
    }
    const id = this.allocateId();
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      this.registerPending(id, resolve, reject, this.timeoutMs, method);
      stdin.write(line, (err) => {
        if (err) {
          clearTimeout(this.pending.get(id)?.timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const stdin = this.proc?.stdin;
    if (!stdin) return;
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })}\n`);
  }

  async close(): Promise<void> {
    this.failAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP transport closed' }));
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const term = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }, 500);
      const kill = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 2500);
      proc.once('exit', () => {
        clearTimeout(term);
        clearTimeout(kill);
        resolve();
      });
    });
  }

  // ─── internal ───────────────────────────────────────────────────────────

  protected sendMessage(obj: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify(obj)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) this.parseAndRoute(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private parseAndRoute(line: string): void {
    let msg: import('./base-transport').InboundMessage;
    try {
      msg = JSON.parse(line) as import('./base-transport').InboundMessage;
    } catch {
      return; // not a complete/valid JSON line — drop (server logs go to stderr)
    }
    this.routeIncoming(msg);
  }
}
