import { describe, expect, it } from 'bun:test';
import { RequestQueue } from '../../../src/network/request-queue';

const fakeRequest = (model = 'test') => ({
  url: 'http://test',
  headers: {},
  body: {},
  provider: 'test',
  model,
});

describe('RequestQueue', () => {
  it('enqueue and dequeue in FIFO order', () => {
    const q = new RequestQueue();
    q.enqueue(fakeRequest('a'), 1, 0);
    q.enqueue(fakeRequest('b'), 1, 0);
    q.enqueue(fakeRequest('c'), 1, 0);

    const e1 = q.dequeue();
    const e2 = q.dequeue();
    const e3 = q.dequeue();

    expect(e1?.request.model).toBe('a');
    expect(e2?.request.model).toBe('b');
    expect(e3?.request.model).toBe('c');
  });

  it('higher priority (lower number) dequeues first', () => {
    const q = new RequestQueue();
    q.enqueue(fakeRequest('low'), 3, 0);
    q.enqueue(fakeRequest('high'), 0, 0);
    q.enqueue(fakeRequest('mid'), 1, 0);

    expect(q.dequeue()?.request.model).toBe('high');
    expect(q.dequeue()?.request.model).toBe('mid');
    expect(q.dequeue()?.request.model).toBe('low');
  });

  it('rejects when queue full', async () => {
    const q = new RequestQueue({ maxSize: 2, timeoutMs: 30_000 });
    q.enqueue(fakeRequest(), 1, 0);
    q.enqueue(fakeRequest(), 1, 0);

    await expect(q.enqueue(fakeRequest(), 1, 0)).rejects.toThrow('Queue full');
  });

  it('dequeue returns null when empty', () => {
    const q = new RequestQueue();
    expect(q.dequeue()).toBeNull();
  });

  it('peek returns top without removing', () => {
    const q = new RequestQueue();
    q.enqueue(fakeRequest('a'), 1, 0);
    expect(q.peek()?.request.model).toBe('a');
    expect(q.length).toBe(1);
  });

  it('expired entries are purged on dequeue', async () => {
    const q = new RequestQueue({ maxSize: 10, timeoutMs: 20 });
    const promise = q.enqueue(fakeRequest('expired'), 1, 0);
    await new Promise((r) => setTimeout(r, 30));

    expect(q.dequeue()).toBeNull();
    expect(q.length).toBe(0);

    await expect(promise).rejects.toThrow('timed out in queue');
  });

  it('length tracks queue size', () => {
    const q = new RequestQueue();
    expect(q.length).toBe(0);
    q.enqueue(fakeRequest(), 1, 0);
    q.enqueue(fakeRequest(), 1, 0);
    expect(q.length).toBe(2);
    q.dequeue();
    expect(q.length).toBe(1);
  });

  it('waitForItem resolves when item added', async () => {
    const q = new RequestQueue();
    let waited = false;
    const promise = q.waitForItem().then(() => {
      waited = true;
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(waited).toBe(false);

    q.enqueue(fakeRequest(), 1, 0);
    await promise;
    expect(waited).toBe(true);
  });
});
