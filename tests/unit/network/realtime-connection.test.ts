/** Tests for engine.connect (realtime WebSocket transport): frame normalization,
 *  lifecycle event fan-out, and observability hooks — all via an injected fake
 *  socket, no real network. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { NetworkEngine } from '../../../src/network/engine';
import type {
  ConnectFn,
  RealtimeFrame,
  RealtimeSocket,
  WsRequest,
} from '../../../src/network/types';

/** A controllable fake WebSocket. Tests drive it via emit(). */
class FakeSocket implements RealtimeSocket {
  readyState = 0;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  lastOpts: { protocols?: string | string[]; headers?: Record<string, string> } | undefined;

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.emit('close', { code, reason });
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  emit(type: string, ev?: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

function makeEngine(): { engine: NetworkEngine; hooks: HookBus; sockets: FakeSocket[] } {
  const hooks = new HookBus();
  const sockets: FakeSocket[] = [];
  const connect: ConnectFn = (_url, opts) => {
    const s = new FakeSocket();
    s.lastOpts = opts;
    sockets.push(s);
    return s;
  };
  return { engine: new NetworkEngine({ hooks, connect }), hooks, sockets };
}

const REQ: WsRequest = {
  url: 'wss://example.com/v1/realtime?model=m',
  protocols: ['realtime', 'openai-insecure-api-key.sk-x'],
  provider: 'openai',
  model: 'gpt-realtime',
};

describe('engine.connect — transport + normalization', () => {
  it('passes url + protocols to the socket factory', () => {
    const { engine, sockets } = makeEngine();
    engine.connect(REQ);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].lastOpts?.protocols).toEqual(REQ.protocols);
  });

  it('normalizes a string frame to {text}', () => {
    const { engine, sockets } = makeEngine();
    const conn = engine.connect(REQ);
    const frames: RealtimeFrame[] = [];
    conn.on('message', (f) => frames.push(f));
    sockets[0].emit('message', { data: 'hello' });
    expect(frames).toEqual([{ text: 'hello' }]);
  });

  it('normalizes an ArrayBuffer/typed-array frame to {binary}', () => {
    const { engine, sockets } = makeEngine();
    const conn = engine.connect(REQ);
    const frames: RealtimeFrame[] = [];
    conn.on('message', (f) => frames.push(f));
    sockets[0].emit('message', { data: new Uint8Array([1, 2, 3]).buffer });
    expect(frames).toHaveLength(1);
    const f = frames[0];
    expect('binary' in f && Array.from(f.binary)).toEqual([1, 2, 3]);
  });

  it('fans out open / close lifecycle to listeners', () => {
    const { engine, sockets } = makeEngine();
    const conn = engine.connect(REQ);
    const seen: string[] = [];
    conn.on('open', () => seen.push('open'));
    conn.on('close', () => seen.push('close'));
    sockets[0].emit('open');
    conn.close();
    expect(seen).toEqual(['open', 'close']);
  });

  it('unsubscribe stops further callbacks', () => {
    const { engine, sockets } = makeEngine();
    const conn = engine.connect(REQ);
    let n = 0;
    const off = conn.on('message', () => n++);
    sockets[0].emit('message', { data: 'a' });
    off();
    sockets[0].emit('message', { data: 'b' });
    expect(n).toBe(1);
  });

  it('send() forwards raw data to the socket', () => {
    const { engine, sockets } = makeEngine();
    const conn = engine.connect(REQ);
    conn.send('{"type":"response.create"}');
    expect(sockets[0].sent).toEqual(['{"type":"response.create"}']);
  });
});

describe('engine.connect — observability hooks', () => {
  it('emits onRealtimeOpen on open with url/provider/model', () => {
    const { engine, hooks, sockets } = makeEngine();
    let ctx: { provider?: string; model?: string; url?: string } = {};
    hooks.on('onRealtimeOpen', (c) => {
      ctx = c;
    });
    engine.connect(REQ);
    sockets[0].emit('open');
    expect(ctx).toEqual({ provider: 'openai', model: 'gpt-realtime', url: REQ.url });
  });

  it('emits onRealtimeFrame (in/out) with metadata only', () => {
    const { engine, hooks, sockets } = makeEngine();
    const frames: Array<{ direction: string; kind: string; bytes: number }> = [];
    hooks.on('onRealtimeFrame', (c) => {
      frames.push({ direction: c.direction, kind: c.kind, bytes: c.bytes });
    });
    const conn = engine.connect(REQ);
    conn.send('PING'); // out, text, 4 bytes
    sockets[0].emit('message', { data: new Uint8Array([0, 1, 2, 3, 4]).buffer }); // in, binary, 5
    expect(frames).toEqual([
      { direction: 'out', kind: 'text', bytes: 4 },
      { direction: 'in', kind: 'binary', bytes: 5 },
    ]);
  });

  it('emits onRealtimeClose with code/reason', () => {
    const { engine, hooks, sockets } = makeEngine();
    let ctx: { code?: number | null; reason?: string | null } = {};
    hooks.on('onRealtimeClose', (c) => {
      ctx = { code: c.code, reason: c.reason };
    });
    engine.connect(REQ);
    sockets[0].emit('close', { code: 1000, reason: 'done' });
    expect(ctx).toEqual({ code: 1000, reason: 'done' });
  });

  it('emits onRealtimeError and fans out to error listeners', () => {
    const { engine, hooks, sockets } = makeEngine();
    let hookErr: Error | null = null;
    hooks.on('onRealtimeError', (c) => {
      hookErr = c.error;
    });
    const conn = engine.connect(REQ);
    let cbErr: Error | null = null;
    conn.on('error', (e) => {
      cbErr = e;
    });
    sockets[0].emit('error', { message: 'socket boom' });
    expect(hookErr).toBeInstanceOf(Error);
    expect(cbErr).toBeInstanceOf(Error);
    expect((cbErr as unknown as Error).message).toBe('socket boom');
  });
});
