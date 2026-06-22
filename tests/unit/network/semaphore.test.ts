import { describe, expect, it } from 'bun:test';
import { Semaphore } from '../../../src/network/semaphore';

describe('Semaphore', () => {
  it('acquire returns immediately when capacity available', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.inFlight).toBe(2);
    expect(sem.available).toBe(0);
  });

  it('blocks when capacity exhausted; release admits waiter', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    let admitted = false;
    const p = sem.acquire().then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(sem.waiting).toBe(1);

    sem.release();
    await p;
    expect(admitted).toBe(true);
  });

  it('available reflects remaining slots', async () => {
    const sem = new Semaphore(3);
    expect(sem.available).toBe(3);
    await sem.acquire();
    expect(sem.available).toBe(2);
    sem.release();
    expect(sem.available).toBe(3);
  });
});
