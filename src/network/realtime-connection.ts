/** RealtimeConnectionImpl — wraps a raw RealtimeSocket into the engine-owned
 *  RealtimeConnection: normalizes inbound frames (string → text, binary → bytes),
 *  fans out to adapter listeners, and emits observability hooks. This is the
 *  realtime sibling of QueueState's HTTP handling — except there is no queue: a
 *  live socket has no per-call retry / rate-limit / idempotency.
 *
 *  Knows nothing about provider protocols. A RealtimeProviderAdapter sits on top
 *  and maps normalized frames ↔ provider event JSON. */

import type { HookBus } from '../bus/hook-bus';
import type { RealtimeConnection, RealtimeFrame, RealtimeSocket, WsRequest } from './types';

type FrameCb = (f: RealtimeFrame) => void;
type VoidCb = () => void;
type ErrCb = (e: Error) => void;

export interface RealtimeConnectionDeps {
  socket: RealtimeSocket;
  req: WsRequest;
  hooks: HookBus;
}

export class RealtimeConnectionImpl implements RealtimeConnection {
  private readonly socket: RealtimeSocket;
  private readonly req: WsRequest;
  private readonly hooks: HookBus;

  private readonly messageCbs = new Set<FrameCb>();
  private readonly openCbs = new Set<VoidCb>();
  private readonly closeCbs = new Set<VoidCb>();
  private readonly errorCbs = new Set<ErrCb>();

  constructor(deps: RealtimeConnectionDeps) {
    this.socket = deps.socket;
    this.req = deps.req;
    this.hooks = deps.hooks;

    this.socket.addEventListener('open', () => this.handleOpen());
    this.socket.addEventListener('message', (ev) => this.handleMessage(ev));
    this.socket.addEventListener('close', (ev) => this.handleClose(ev));
    this.socket.addEventListener('error', (ev) => this.handleError(ev));
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.socket.send(data);
    const kind = typeof data === 'string' ? 'text' : 'binary';
    const bytes = typeof data === 'string' ? byteLengthOf(data) : binaryByteLength(data);
    this.emitFrameHook('out', kind, bytes);
  }

  on(type: 'message', cb: FrameCb): () => void;
  on(type: 'open' | 'close', cb: VoidCb): () => void;
  on(type: 'error', cb: ErrCb): () => void;
  on(type: 'message' | 'open' | 'close' | 'error', cb: FrameCb | VoidCb | ErrCb): () => void {
    const set =
      type === 'message'
        ? this.messageCbs
        : type === 'open'
          ? this.openCbs
          : type === 'close'
            ? this.closeCbs
            : this.errorCbs;
    set.add(cb as never);
    return () => set.delete(cb as never);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private handleOpen(): void {
    void this.hooks
      .emit('onRealtimeOpen', {
        provider: this.req.provider,
        model: this.req.model,
        url: this.req.url,
      })
      .catch(() => {});
    for (const cb of this.openCbs) cb();
  }

  private handleMessage(ev: unknown): void {
    const frame = normalizeFrame((ev as { data?: unknown })?.data);
    if (!frame) return;
    const kind = 'text' in frame ? 'text' : 'binary';
    const bytes = 'text' in frame ? byteLengthOf(frame.text) : frame.binary.byteLength;
    this.emitFrameHook('in', kind, bytes);
    for (const cb of this.messageCbs) cb(frame);
  }

  private handleClose(ev: unknown): void {
    const e = ev as { code?: number; reason?: string } | undefined;
    void this.hooks
      .emit('onRealtimeClose', {
        provider: this.req.provider,
        model: this.req.model,
        code: e?.code ?? null,
        reason: e?.reason ?? null,
      })
      .catch(() => {});
    for (const cb of this.closeCbs) cb();
  }

  private handleError(ev: unknown): void {
    const error = toError(ev);
    void this.hooks
      .emit('onRealtimeError', {
        provider: this.req.provider,
        model: this.req.model,
        error,
      })
      .catch(() => {});
    for (const cb of this.errorCbs) cb(error);
  }

  private emitFrameHook(direction: 'in' | 'out', kind: 'text' | 'binary', bytes: number): void {
    void this.hooks
      .emit('onRealtimeFrame', {
        provider: this.req.provider,
        model: this.req.model,
        direction,
        kind,
        bytes,
      })
      .catch(() => {});
  }
}

/** string → {text}; ArrayBuffer / typed-array / Node Buffer → {binary}.
 *  Returns null for an unrecognized payload (e.g. a Blob we can't read sync). */
function normalizeFrame(data: unknown): RealtimeFrame | null {
  if (data == null) return null;
  if (typeof data === 'string') return { text: data };
  if (data instanceof ArrayBuffer) return { binary: new Uint8Array(data) };
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return { binary: new Uint8Array(view.buffer, view.byteOffset, view.byteLength) };
  }
  return null;
}

function binaryByteLength(data: ArrayBufferLike | ArrayBufferView): number {
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return (data as ArrayBuffer).byteLength;
}

function byteLengthOf(s: string): number {
  return new TextEncoder().encode(s).length;
}

function toError(ev: unknown): Error {
  if (ev instanceof Error) return ev;
  const message =
    (ev as { message?: string })?.message ??
    (typeof ev === 'string' ? ev : 'realtime socket error');
  return new Error(message);
}
