/** The DEFAULT WebSocket factory (no `connect` injected).
 *
 *  Every other realtime test injects a fake socket, so the factory the library
 *  actually ships with — the one that decides between the 2-arg WHATWG form and
 *  Bun's `{ protocols, headers }` form — is the one piece never exercised. Get
 *  that wrong and auth silently disappears from the handshake.
 *
 *  No socket is opened: `WebSocket` is swapped for a recording constructor. */

import { afterEach, describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { NetworkEngine } from '../../../src/network/engine';
import type { WsRequest } from '../../../src/network/types';

const g = globalThis as unknown as { WebSocket?: unknown };
const realWS = g.WebSocket;
afterEach(() => {
  if (realWS === undefined) delete g.WebSocket;
  else g.WebSocket = realWS;
});

const calls: Array<{ url: string; second: unknown }> = [];

/** Stands in for the global WebSocket: records its arguments, opens nothing. */
class RecordingWS {
  readyState = 0;
  constructor(url: string, second?: unknown) {
    calls.push({ url, second });
  }
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

const REQ: WsRequest = {
  url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
  protocols: ['realtime', 'openai-insecure-api-key.sk-x'],
  provider: 'openai',
  model: 'gpt-realtime',
};

describe('defaultConnectFn', () => {
  it('with no headers: passes protocols POSITIONALLY (the WHATWG 2-arg form)', () => {
    calls.length = 0;
    g.WebSocket = RecordingWS;
    const engine = new NetworkEngine({ hooks: new HookBus() });
    engine.connect(REQ);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(REQ.url);
    // Positional protocols — NOT an options object, which browsers reject.
    expect(calls[0].second).toEqual(REQ.protocols);
  });

  it('with headers: uses the options-object form so the headers survive', () => {
    calls.length = 0;
    g.WebSocket = RecordingWS;
    const engine = new NetworkEngine({ hooks: new HookBus() });
    engine.connect({ ...REQ, headers: { authorization: 'Bearer sk-x' } });
    expect(calls[0].second).toEqual({
      protocols: REQ.protocols,
      headers: { authorization: 'Bearer sk-x' },
    });
  });

  it('undefined protocols stay undefined rather than becoming an empty list', () => {
    calls.length = 0;
    g.WebSocket = RecordingWS;
    const engine = new NetworkEngine({ hooks: new HookBus() });
    engine.connect({ url: 'wss://x/y', provider: 'p', model: 'm' });
    expect(calls[0].second).toBeUndefined();
  });

  it('no global WebSocket: throws a message that names the way out', () => {
    delete g.WebSocket;
    const engine = new NetworkEngine({ hooks: new HookBus() });
    expect(() => engine.connect(REQ)).toThrow(
      /no global WebSocket available.*Pass a `connect` factory to createEngine/,
    );
  });

  it('an injected connect factory takes precedence over the global', () => {
    calls.length = 0;
    g.WebSocket = RecordingWS;
    let injected = 0;
    const engine = new NetworkEngine({
      hooks: new HookBus(),
      connect: () => {
        injected++;
        return { readyState: 1, addEventListener() {}, send() {}, close() {} } as never;
      },
    });
    engine.connect(REQ);
    expect(injected).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
