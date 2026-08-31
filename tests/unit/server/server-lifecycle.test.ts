/**
 * `start()` / `stop()` — the only part of OaiServer that binds a socket.
 *
 * Every other server test goes through `handle(request)` on purpose, which is
 * why these seventeen lines were the last uncovered block in the library. They
 * are covered here with an EPHEMERAL port: `port: 0` lets the OS pick a free
 * one, so two runs on the same machine cannot collide, and each test closes its
 * own listener in a `finally` so a failed assertion cannot leave one bound.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { OaiServer } from '../../../src/server/server';

/** Every server started by a test, so nothing outlives its assertion. */
const started: OaiServer[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.stop()));
});

function ephemeral(): OaiServer {
  const server = new OaiServer({ port: 0 });
  started.push(server);
  return server;
}

describe('OaiServer HTTP lifecycle', () => {
  it('start binds a real port and reports where it landed', () => {
    const where = ephemeral().start();
    // Port 0 is the REQUEST; what comes back must be the port actually bound,
    // or a caller has no way to reach the server it just started.
    expect(where.port).toBeGreaterThan(0);
    expect(typeof where.hostname).toBe('string');
  });

  it('answers a real request over that socket', async () => {
    const { port } = ephemeral().start();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    // Proves the bound listener is wired to `handle`, not merely listening.
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('starting twice is refused rather than leaking the first listener', () => {
    const server = ephemeral();
    server.start();
    expect(() => server.start()).toThrow('OaiServer already started');
  });

  it('stop closes the socket, and the port stops answering', async () => {
    const server = ephemeral();
    const { port } = server.start();
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);

    await server.stop();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('stop on a server that never started is a no-op', async () => {
    // Not an error: a caller tearing down in a `finally` should not have to
    // remember whether start() got that far.
    await expect(new OaiServer({ port: 0 }).stop()).resolves.toBeUndefined();
  });

  it('start again after stop, on a fresh port', async () => {
    const server = ephemeral();
    const first = server.start();
    await server.stop();
    const second = server.start();
    expect(second.port).toBeGreaterThan(0);
    // The guard is cleared by stop(), or a restart would throw "already started".
    expect(typeof first.port).toBe('number');
  });
});
