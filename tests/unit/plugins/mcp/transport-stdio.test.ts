/** Stdio MCP transport, driven by a fake child process.
 *
 *  NOTHING here spawns a real process. `node:child_process` is reached through the runtime's lazy
 *  loader, so the loader is replaced for the duration of this file and `spawn` returns an
 *  in-memory child whose streams the test drives. The pinned behaviours are the ones only the
 *  transport can get wrong: the env handed to the child, newline framing on stdout, and what
 *  `close()` does to a server that will not exit.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test';
import * as runtimeModule from '../../../../src/runtime/runtime';
import { McpError, McpErrorCode } from '../../../../src/plugins/mcp/jsonrpc';

const RUNTIME_PATH = '../../../../src/runtime/runtime';
const realNodeChildProcess = runtimeModule.nodeChildProcess;

type SpawnCall = { file: string; args: string[]; opts: Record<string, unknown> };

/** stdout / stderr side of the fake child. */
class FakeReadable {
  encoding: string | null = null;
  private readonly handlers = new Map<string, Array<(arg: unknown) => void>>();
  setEncoding(enc: string): void {
    this.encoding = enc;
  }
  on(ev: string, cb: (arg: unknown) => void): this {
    const arr = this.handlers.get(ev) ?? [];
    arr.push(cb);
    this.handlers.set(ev, arr);
    return this;
  }
  /** Push a stdout chunk exactly as Node would. */
  push(chunk: string): void {
    for (const cb of [...(this.handlers.get('data') ?? [])]) cb(chunk);
  }
}

class FakeWritable {
  readonly writes: string[] = [];
  ended = 0;
  /** Set to make the next write report a failure through its callback. */
  writeError: Error | null = null;
  /** Set to make `end()` throw, as a broken pipe does. */
  endThrows = false;
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    if (this.writeError) {
      cb?.(this.writeError);
      return false;
    }
    this.writes.push(chunk);
    cb?.(null);
    return true;
  }
  end(): void {
    this.ended++;
    if (this.endThrows) throw new Error('EPIPE');
  }
  lines(): Array<Record<string, unknown>> {
    return this.writes.map((w) => JSON.parse(w.trimEnd()) as Record<string, unknown>);
  }
}

class FakeChild {
  stdout: FakeReadable | null = new FakeReadable();
  stdin: FakeWritable | null = new FakeWritable();
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly signals: string[] = [];
  /** Set to make `kill()` throw, as it does when the process is already gone. */
  killThrows = false;
  private readonly handlers = new Map<string, Array<(arg: unknown) => void>>();

  on(ev: string, cb: (arg: unknown) => void): this {
    const arr = this.handlers.get(ev) ?? [];
    arr.push(cb);
    this.handlers.set(ev, arr);
    return this;
  }
  once(ev: string, cb: (arg: unknown) => void): this {
    return this.on(ev, cb);
  }
  kill(signal: string): boolean {
    this.signals.push(signal);
    if (this.killThrows) throw new Error('ESRCH');
    return true;
  }
  emit(ev: string, arg?: unknown): void {
    for (const cb of [...(this.handlers.get(ev) ?? [])]) cb(arg);
  }
}

/** The child the next `spawn` will return, and the calls it recorded. */
let nextChild: FakeChild = new FakeChild();
const spawnCalls: SpawnCall[] = [];

mock.module(RUNTIME_PATH, () => ({
  ...runtimeModule,
  nodeChildProcess: async () => ({
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ file, args, opts });
      return nextChild;
    },
  }),
}));

afterAll(() => {
  // Hand the real loader back so no later test file inherits the fake.
  mock.module(RUNTIME_PATH, () => ({ ...runtimeModule, nodeChildProcess: realNodeChildProcess }));
});

const { StdioTransport } = await import('../../../../src/plugins/mcp/transport-stdio');
type Stdio = InstanceType<typeof StdioTransport>;

/** A started transport wired to a fresh fake child. */
async function started(config: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  nextChild = new FakeChild();
  spawnCalls.length = 0;
  const child = nextChild;
  const t = new StdioTransport({ command: 'my-mcp-server', ...config } as never, opts as never);
  await t.start();
  return { t, child, spawn: spawnCalls[0] };
}

const stdinOf = (child: FakeChild) => child.stdin as FakeWritable;
const stdoutOf = (child: FakeChild) => child.stdout as FakeReadable;

describe('StdioTransport: spawning', () => {
  it('passes the configured command, args and cwd to the child', async () => {
    const { spawn } = await started({ command: 'my-mcp-server', args: ['--stdio'], cwd: '/work' });
    // On Windows a bare command is routed through cmd.exe, so only the tail is stable — what
    // matters is that our args and cwd reach the spawn.
    expect(JSON.stringify(spawn.args)).toContain('--stdio');
    expect(spawn.opts.cwd).toBe('/work');
  });

  it('pipes stdin/stdout, inherits stderr, and hides the console window', async () => {
    // stderr is INHERITED on purpose: server logs belong on our stderr, and piping them without
    // draining would eventually block the child.
    const { spawn } = await started();
    expect(spawn.opts.stdio).toEqual(['pipe', 'pipe', 'inherit']);
    expect(spawn.opts.windowsHide).toBe(true);
  });

  it('hands the child a minimal env, not the whole host environment', async () => {
    // The host env of a developer machine is full of unrelated credentials. An MCP server gets the
    // few variables it needs to find its own runtime and nothing else.
    process.env.ORXA_MCP_SECRET_PROBE = 'must-not-leak';
    try {
      const { spawn } = await started();
      const env = spawn.opts.env as Record<string, string>;
      expect(env.ORXA_MCP_SECRET_PROBE).toBeUndefined();
      // …but the runtime-locating variables ARE present, or the server cannot start at all.
      const passthrough = process.platform === 'win32' ? ['PATH', 'Path'] : ['PATH'];
      expect(passthrough.some((k) => typeof env[k] === 'string')).toBe(true);
    } finally {
      delete process.env.ORXA_MCP_SECRET_PROBE;
    }
  });

  it('lets the caller add and override env entries', async () => {
    const { spawn } = await started({ env: { API_TOKEN: 'from-config', PATH: 'overridden' } });
    const env = spawn.opts.env as Record<string, string>;
    expect(env.API_TOKEN).toBe('from-config');
    expect(env.PATH).toBe('overridden');
  });

  it('sets utf8 on stdout so chunks arrive as strings, not Buffers', async () => {
    const { child } = await started();
    expect(stdoutOf(child).encoding).toBe('utf8');
  });

  it('fails loudly when the child has no stdout to read', async () => {
    nextChild = new FakeChild();
    nextChild.stdout = null;
    const t = new StdioTransport({ command: 'my-mcp-server' });
    const err = (await t.start().catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(McpErrorCode.ConnectionClosed);
    expect(err.message).toMatch(/no stdout/);
  });

  it('setProtocolVersion is a no-op — stdio carries no headers', async () => {
    const { t, child } = await started();
    t.setProtocolVersion();
    expect(stdinOf(child).writes).toEqual([]);
  });
});

describe('StdioTransport: framing', () => {
  it('writes one newline-terminated JSON-RPC line per request', async () => {
    const { t, child } = await started();
    const pending = t.request('tools/list', { cursor: 'p2' });

    expect(stdinOf(child).writes).toEqual([
      `${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: { cursor: 'p2' } })}\n`,
    ]);

    stdoutOf(child).push(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { tools: [] } })}\n`);
    expect(await pending).toEqual({ tools: [] });
  });

  it('omits `params` when the caller passed none', async () => {
    const { t, child } = await started();
    const pending = t.request('ping');
    expect(Object.keys(stdinOf(child).lines()[0])).toEqual(['jsonrpc', 'id', 'method']);
    stdoutOf(child).push(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} })}\n`);
    await pending;
  });

  it('reassembles a response split across chunks', async () => {
    // stdout arrives in arbitrary chunks; a parser that assumes one message per chunk drops
    // everything from a server that writes in pieces.
    const { t, child } = await started();
    const pending = t.request('tools/list');
    const line = JSON.stringify({ jsonrpc: '2.0', id: 0, result: { tools: ['a'] } });
    stdoutOf(child).push(line.slice(0, 10));
    stdoutOf(child).push(`${line.slice(10)}\n`);
    expect(await pending).toEqual({ tools: ['a'] });
  });

  it('routes several messages arriving in one chunk', async () => {
    const { t, child } = await started();
    const seen: string[] = [];
    t.setHandlers({ onNotification: (m) => seen.push(m) });
    const pending = t.request('tools/list');
    stdoutOf(child).push(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/a' })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 0, result: 1 })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/b' })}\n`,
    );
    expect(await pending).toBe(1);
    expect(seen).toEqual(['notifications/a', 'notifications/b']);
  });

  it('tolerates CRLF line endings', async () => {
    const { t, child } = await started();
    const pending = t.request('tools/list');
    stdoutOf(child).push(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: 'crlf' })}\r\n`);
    expect(await pending).toBe('crlf');
  });

  it('ignores blank lines and unparseable lines instead of dying on server chatter', async () => {
    // Servers do write stray text to stdout. Dropping the line keeps the session alive.
    const { t, child } = await started();
    const pending = t.request('tools/list');
    expect(() => stdoutOf(child).push('\n   \nSome log line, not JSON\n')).not.toThrow();
    stdoutOf(child).push(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: 'survived' })}\n`);
    expect(await pending).toBe('survived');
  });

  it('notify() writes a line with no id', async () => {
    const { t, child } = await started();
    await t.notify('notifications/initialized');
    await t.notify('notifications/progress', { progress: 1 });
    expect(stdinOf(child).lines()).toEqual([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
    ]);
  });

  it('answers a server->client request on the same pipe', async () => {
    const { t, child } = await started();
    t.setHandlers({ onRequest: async (method) => ({ answered: method }) });
    stdoutOf(child).push(`${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' })}\n`);
    await new Promise((r) => setTimeout(r, 5));
    expect(stdinOf(child).lines()).toEqual([{ jsonrpc: '2.0', id: 'srv-1', result: { answered: 'roots/list' } }]);
    // The trailing newline is the frame delimiter: without it the server's parser waits forever
    // for the end of a message we consider sent.
    expect(stdinOf(child).writes[0].endsWith('\n')).toBe(true);
  });
});

describe('StdioTransport: failures', () => {
  it('refuses to send before start() rather than dropping the call', async () => {
    const t = new StdioTransport({ command: 'my-mcp-server' });
    const err = (await t.request('tools/list').catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(McpErrorCode.ConnectionClosed);
    expect(err.message).toMatch(/not started/);
  });

  it('notify() before start is a silent no-op', async () => {
    const t = new StdioTransport({ command: 'my-mcp-server' });
    await expect(t.notify('notifications/initialized')).resolves.toBeUndefined();
  });

  it('a failed stdin write rejects that request and forgets it', async () => {
    // Without the cleanup the pending entry keeps a live timer and rejects a second time later.
    const { t, child } = await started();
    stdinOf(child).writeError = new Error('EPIPE');
    await expect(t.request('tools/list')).rejects.toThrow('EPIPE');
    expect((t as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
  });

  it('the child exiting fails every in-flight request', async () => {
    const { t, child } = await started();
    const pending = t.request('tools/list');
    child.emit('exit', 1);
    const err = (await pending.catch((e) => e)) as McpError;
    expect(err.code).toBe(McpErrorCode.ConnectionClosed);
    expect(err.message).toBe('MCP stdio server exited');
  });

  it('a spawn error surfaces the OS message, not a generic one', async () => {
    // "ENOENT: my-mcp-server" is the whole diagnosis; replacing it with a house message would
    // throw away the only useful information.
    const { t, child } = await started();
    const pending = t.request('tools/list');
    child.emit('error', new Error('spawn my-mcp-server ENOENT'));
    await expect(pending).rejects.toThrow('spawn my-mcp-server ENOENT');
  });

  it('a request the server never answers times out', async () => {
    const { t } = await started({}, { timeoutMs: 20 });
    await expect(t.request('tools/list')).rejects.toThrow(/'tools\/list' timed out/);
  });
});

describe('StdioTransport: close', () => {
  it('is a no-op when the transport was never started', async () => {
    const t = new StdioTransport({ command: 'my-mcp-server' });
    await expect(t.close()).resolves.toBeUndefined();
  });

  it('fails in-flight work, closes stdin, and returns as soon as the child exits', async () => {
    const { t, child } = await started();
    const pending = t.request('tools/list');
    const closing = t.close();

    await expect(pending).rejects.toThrow('MCP transport closed');
    expect(stdinOf(child).ended).toBe(1);

    child.emit('exit', 0);
    await closing;
    expect(child.signals).toEqual([]); // a cooperative child is never signalled
  });

  it('returns immediately when the child has already exited', async () => {
    const { t, child } = await started();
    child.exitCode = 0;
    const t0 = Date.now();
    await t.close();
    expect(Date.now() - t0).toBeLessThan(400); // no 500ms SIGTERM wait
    expect(child.signals).toEqual([]);
  });

  it('treats a signalled child as already gone', async () => {
    const { t, child } = await started();
    child.signalCode = 'SIGKILL';
    await t.close();
    expect(child.signals).toEqual([]);
  });

  it('survives a stdin that throws on end()', async () => {
    const { t, child } = await started();
    stdinOf(child).endThrows = true;
    child.exitCode = 0;
    await expect(t.close()).resolves.toBeUndefined();
  });

  it('escalates SIGTERM then SIGKILL against a child that refuses to exit', async () => {
    // A wedged server must not keep the process alive forever, and SIGKILL must resolve close()
    // even though the child never reports an exit.
    const { t, child } = await started();
    const t0 = Date.now();
    await t.close();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
  }, 10_000);

  it('still resolves when the signals themselves throw', async () => {
    const { t, child } = await started();
    child.killThrows = true;
    await expect(t.close()).resolves.toBeUndefined();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  }, 10_000);

  it('refuses later requests once closed', async () => {
    const { t, child } = await started();
    child.exitCode = 0;
    await t.close();
    await expect(t.request('tools/list')).rejects.toThrow(/not started/);
  });
});

describe('StdioTransport: stdin missing', () => {
  it('rejects a request when the child has no stdin', async () => {
    nextChild = new FakeChild();
    const child = nextChild;
    const t: Stdio = new StdioTransport({ command: 'my-mcp-server' });
    await t.start();
    child.stdin = null;
    await expect(t.request('tools/list')).rejects.toThrow(/not started/);
    await expect(t.notify('notifications/x')).resolves.toBeUndefined();
  });
});
