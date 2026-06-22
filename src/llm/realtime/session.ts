/** BaseRealtimeSession — wires an engine RealtimeConnection to the normalized
 *  RealtimeSession event model. Providers subclass it and implement just the
 *  protocol mapping (onOpen handshake, frame → event, input → wire frames). */

import type { RealtimeConnection, RealtimeFrame } from '../../network/types';
import type { RealtimeEvent, RealtimeEventType, RealtimeInput, RealtimeSession } from './types';

type AnyCb = (e: RealtimeEvent) => void;

export abstract class BaseRealtimeSession implements RealtimeSession {
  protected readonly conn: RealtimeConnection;
  private readonly listeners = new Map<RealtimeEventType, Set<AnyCb>>();
  private ready = false;
  private readonly outbox: Array<() => void> = [];

  constructor(conn: RealtimeConnection) {
    this.conn = conn;
    // Socket-open is NOT the same as "ready to send": OpenAI can accept content
    // immediately, but Google must first receive `setupComplete`. So the base
    // does NOT auto-emit `open` here — the subclass calls markReady() at the
    // right moment, and the normalized `open` event means "ready to send".
    conn.on('open', () => this.onOpen());
    conn.on('message', (f) => this.onFrame(f));
    conn.on('error', (error) => this.emit({ type: 'error', error }));
    conn.on('close', () => this.emit({ type: 'close' }));
  }

  on<E extends RealtimeEventType>(
    type: E,
    cb: (e: Extract<RealtimeEvent, { type: E }>) => void,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb as AnyCb);
    return () => set?.delete(cb as AnyCb);
  }

  close(): void {
    this.conn.close();
  }

  abstract send(input: RealtimeInput, opts?: { turnComplete?: boolean }): void;

  /** Fan an event out to subscribers. */
  protected emit(event: RealtimeEvent): void {
    for (const cb of this.listeners.get(event.type) ?? []) cb(event);
  }

  /** Mark the session ready: flush any buffered sends and emit `open`. Idempotent.
   *  Called by the subclass once its handshake is complete (OpenAI: on socket
   *  open; Google: on `setupComplete`). */
  protected markReady(): void {
    if (this.ready) return;
    this.ready = true;
    for (const fn of this.outbox.splice(0)) fn();
    this.emit({ type: 'open' });
  }

  /** Run a wire-send now if ready, else buffer it until markReady(). Lets callers
   *  `createRealtime(...).send(...)` without first awaiting an `open` event. */
  protected whenReady(fn: () => void): void {
    if (this.ready) fn();
    else this.outbox.push(fn);
  }

  /** Send a JSON object as a text frame (the common wire form for both providers). */
  protected sendJSON(obj: unknown): void {
    this.conn.send(JSON.stringify(obj));
  }

  /** Provider handshake on socket open (e.g. session.update / setup). */
  protected abstract onOpen(): void;

  /** Map one inbound provider frame onto zero or more normalized events. */
  protected abstract onFrame(frame: RealtimeFrame): void;
}

