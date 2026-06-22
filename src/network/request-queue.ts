/** Priority request queue (min-heap). Lower priority = higher urgency.
 *  Same priority = FIFO. */

import type { HttpRequest, HttpResponse } from './types';

export interface QueueEntry {
  id: string;
  request: HttpRequest;
  priority: number;
  enqueuedAt: number;
  deadline: number;
  estimatedTokens: number;
  attempt: number;
  resolve: (res: HttpResponse) => void;
  reject: (err: Error) => void;
}

export interface QueueConfig {
  /** Max pending requests. Reject new ones if exceeded. */
  maxSize: number;
  /** Max time (ms) a request can wait in queue. */
  timeoutMs: number;
}

const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  maxSize: 200,
  timeoutMs: 30_000,
};

export class RequestQueue {
  private heap: QueueEntry[] = [];
  private readonly config: QueueConfig;
  private drainWaiters: (() => void)[] = [];

  constructor(config?: Partial<QueueConfig>) {
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...config };
  }

  enqueue(
    request: HttpRequest,
    priority: number,
    estimatedTokens: number,
    attempt = 0,
  ): Promise<HttpResponse> {
    if (this.heap.length >= this.config.maxSize) {
      return Promise.reject(new Error(`Queue full (${this.config.maxSize} pending)`));
    }
    const now = performance.now();
    return new Promise<HttpResponse>((resolve, reject) => {
      const entry: QueueEntry = {
        id: crypto.randomUUID(),
        request,
        priority,
        enqueuedAt: now,
        deadline: now + this.config.timeoutMs,
        estimatedTokens,
        attempt,
        resolve,
        reject,
      };
      this.push(entry);
      this.notifyDrain();
    });
  }

  dequeue(): QueueEntry | null {
    this.purgeExpired();
    if (this.heap.length === 0) return null;
    return this.pop();
  }

  peek(): QueueEntry | null {
    this.purgeExpired();
    return this.heap.length > 0 ? this.heap[0] : null;
  }

  waitForItem(): Promise<void> {
    if (this.heap.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  get length(): number {
    return this.heap.length;
  }

  private purgeExpired(): void {
    const now = performance.now();
    const expired: QueueEntry[] = [];
    this.heap = this.heap.filter((entry) => {
      if (now > entry.deadline) {
        expired.push(entry);
        return false;
      }
      return true;
    });
    if (expired.length > 0) {
      this.rebuildHeap();
      for (const entry of expired) {
        entry.reject(
          new Error(`Request timed out in queue after ${Math.round(now - entry.enqueuedAt)}ms`),
        );
      }
    }
  }

  private notifyDrain(): void {
    const waiter = this.drainWaiters.shift();
    if (waiter) waiter();
  }

  // ─── Min-heap ops ────────────────────────────────────────────────────

  private push(entry: QueueEntry): void {
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
  }

  private pop(): QueueEntry {
    const top = this.heap[0];
    const last = this.heap.pop() as QueueEntry;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) < 0) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.compare(this.heap[left], this.heap[smallest]) < 0) smallest = left;
      if (right < n && this.compare(this.heap[right], this.heap[smallest]) < 0) smallest = right;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }

  private rebuildHeap(): void {
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.sinkDown(i);
  }

  /** Compare: lower priority first, then earlier enqueue time. */
  private compare(a: QueueEntry, b: QueueEntry): number {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.enqueuedAt - b.enqueuedAt;
  }
}
