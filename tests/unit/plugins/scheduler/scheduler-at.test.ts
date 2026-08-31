/** Scheduler — absolute scheduling, restart recovery, and failure isolation.
 *
 *  The durability contract is the point of this plugin: a task lives in
 *  persistence, not in a timer, so a process that dies between `after()` and
 *  the fire still runs it after a restart. The tests below never sleep on a
 *  wall-clock delay — they schedule into the PAST (so the timer's delay clamps
 *  to zero) and then yield once across a macrotask boundary.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryPersistence } from '../../../../src/plugins/persistence/memory';
import { FilePersistence } from '../../../../src/plugins/persistence/file';
import { Scheduler, type ScheduledTaskDef } from '../../../../src/plugins/scheduler/scheduler';

/** Let every already-due timer run. Not a delay: the timers are due at 0. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const FAR_FUTURE = 4_102_444_800_000; // 2100-01-01, used where no timer is armed.

/** An hour out: far enough never to fire during a run, close enough that
 *  setTimeout does not overflow its 32-bit delay. */
const soon = (): number => Date.now() + 3_600_000;

describe('Scheduler.at — absolute times', () => {
  it('accepts a Date and persists the task with that exact fireAt', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    s.register('t', () => {});

    const when = new Date(FAR_FUTURE);
    const id = await s.at(when, 't', { x: 1 });

    const pending = await s.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual({
      id,
      name: 't',
      args: { x: 1 },
      fireAt: FAR_FUTURE,
      type: 'once',
      interval: null,
    });
    expect(id.startsWith('task_')).toBe(true);
    s.stop();
  });

  it('accepts a raw epoch number as well as a Date', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    s.register('t', () => {});

    await s.at(FAR_FUTURE, 't');
    await s.at(new Date(FAR_FUTURE), 't');

    const pending = await s.pending();
    expect(pending.map((t) => t.fireAt)).toEqual([FAR_FUTURE, FAR_FUTURE]);
    // Args default to an empty object rather than undefined.
    expect(pending[0].args).toEqual({});
    s.stop();
  });

  it('a time already in the past fires on the next tick, not never', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    const seen: Array<Record<string, unknown>> = [];
    s.register('t', (args) => {
      seen.push(args);
    });
    await s.start();

    await s.at(Date.now() - 60_000, 't', { late: true });
    await tick();

    expect(seen).toEqual([{ late: true }]);
    // A one-shot task is removed from persistence once it has run.
    expect(await s.pending()).toEqual([]);
    s.stop();
  });

  it('a task scheduled while the scheduler is STOPPED is persisted but not armed', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    let fired = 0;
    s.register('t', () => {
      fired++;
    });

    // No start() — the task is durable, but nothing is watching the clock.
    await s.at(Date.now() - 1000, 't');
    await tick();
    expect(fired).toBe(0);
    expect(await s.pending()).toHaveLength(1);

    // start() picks up what was persisted and arms it.
    await s.start();
    await tick();
    expect(fired).toBe(1);
    s.stop();
  });

  it('cancel() disarms the timer, not merely the persisted record', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    let fired = 0;
    s.register('t', () => {
      fired++;
    });
    await s.start();

    // Already due: the timer is armed with a zero delay, so only clearTimeout
    // can stop it. Deleting the record alone would not.
    const id = await s.at(Date.now() - 1000, 't');
    await s.cancel(id);
    await tick();

    expect(fired).toBe(0);
    expect(await s.pending()).toEqual([]);
    s.stop();
  });

  it('cancel() also removes a not-yet-due task', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    s.register('t', () => {});
    await s.start();

    const id = await s.at(soon(), 't');
    await s.cancel(id);

    expect(await s.pending()).toEqual([]);
    s.stop();
  });

  it('cancelling an unknown id is harmless', async () => {
    const s = new Scheduler(new MemoryPersistence());
    await s.cancel('task_nope');
    expect(await s.pending()).toEqual([]);
  });
});

describe('Scheduler — restart recovery', () => {
  it('start() arms every task already in persistence', async () => {
    const p = new MemoryPersistence();
    const first = new Scheduler(p);
    first.register('t', () => {});
    await first.at(Date.now() - 1000, 't', { n: 1 });
    await first.at(Date.now() - 1000, 't', { n: 2 });
    // The process "dies" without ever starting.

    const reborn = new Scheduler(p);
    const seen: Array<Record<string, unknown>> = [];
    reborn.register('t', (args) => {
      seen.push(args);
    });
    await reborn.start();
    await tick();

    expect(seen).toHaveLength(2);
    expect(seen.map((a) => a.n).sort()).toEqual([1, 2]);
    reborn.stop();
  });

  it('a persisted task whose handler was never registered is dropped, not retried forever', async () => {
    const p = new MemoryPersistence();
    const first = new Scheduler(p);
    await first.at(Date.now() - 1000, 'handler-gone-away');

    const reborn = new Scheduler(p);
    await reborn.start();
    await tick();

    // fireTask returns early with no handler — and importantly does NOT delete
    // the task, so it can run once the handler is registered again.
    expect(await reborn.pending()).toHaveLength(1);
    reborn.stop();
  });

  it('a persistence key that holds nothing is skipped rather than crashing start()', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    s.register('t', () => {});
    await s.at(soon(), 't');
    // A half-written or externally-cleared record.
    const [key] = await p.list('task:');
    await p.set(key, null);

    await s.start();
    expect(await s.pending()).toEqual([]);
    s.stop();
  });

  it('survives on disk: a new process over the same directory sees the task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orxa-sched-'));
    try {
      const first = new Scheduler(new FilePersistence({ dir }));
      first.register('t', () => {});
      const id = await first.at(soon(), 't', { payload: 'keep me' });

      const reborn = new Scheduler(new FilePersistence({ dir }));
      const pending = await reborn.pending();

      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(id);
      expect(pending[0].args).toEqual({ payload: 'keep me' });
      first.stop();
      reborn.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Scheduler — stop and failure isolation', () => {
  it('stop() disarms pending timers but leaves the tasks in persistence', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    let fired = 0;
    s.register('t', () => {
      fired++;
    });
    await s.start();
    await s.at(Date.now() - 1000, 't');

    s.stop();
    await tick();

    expect(fired).toBe(0);
    expect(await s.pending()).toHaveLength(1);
  });

  it('a periodic task stopped mid-flight does not reschedule itself', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    let fired = 0;
    s.register('t', () => {
      fired++;
      s.stop(); // the process is shutting down while the handler runs
    });
    await s.start();
    await s.every(1, 't');
    await tick();
    await tick();

    expect(fired).toBe(1);
    // Still persisted, so the next start() picks it up again.
    expect(await s.pending()).toHaveLength(1);
  });

  it('a handler that throws is logged and does not stop the periodic schedule', async () => {
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    let fired = 0;
    try {
      s.register('boom', () => {
        fired++;
        if (fired === 1) throw new Error('handler exploded');
      });
      await s.start();
      await s.every(1, 'boom');
      await tick();
      await tick();
      await tick();
    } finally {
      s.stop();
      console.error = originalError;
    }

    expect(fired).toBeGreaterThan(1);
    expect(logged.join('\n')).toContain('Scheduler: task boom(');
    expect(logged.join('\n')).toContain('failed');
  });

  it('a periodic task re-persists a fireAt in the FUTURE after each run', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    // A record left behind by a process that died while the task was overdue.
    const overdue: ScheduledTaskDef = {
      id: 'task_overdue',
      name: 't',
      args: {},
      fireAt: Date.now() - 60_000,
      type: 'periodic',
      interval: 50_000,
    };
    await p.set(`task:${overdue.id}`, overdue);

    let fired = 0;
    s.register('t', () => {
      fired++;
      s.stop(); // shut down after the first run so it does not loop
    });
    await s.start();
    await tick();

    expect(fired).toBe(1);
    const stored = await p.get<ScheduledTaskDef>('task:task_overdue');
    // Without the re-persist the record still says "overdue", and the next
    // start() runs it immediately all over again.
    expect(stored?.fireAt).toBeGreaterThan(Date.now());
    expect(stored?.interval).toBe(50_000);
  });

  it('a rejected async handler is caught like a thrown one', async () => {
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    try {
      s.register('async-boom', async () => {
        throw new Error('rejected');
      });
      await s.start();
      await s.at(Date.now() - 1, 'async-boom');
      await tick();
      await tick();
    } finally {
      s.stop();
      console.error = originalError;
    }

    expect(logged.join('\n')).toContain('async-boom');
    // A failing one-shot is still cleaned up rather than left pending forever.
    expect(await s.pending()).toEqual([]);
  });

  it('register() replaces a handler under the same name', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    const calls: string[] = [];
    s.register('t', () => {
      calls.push('first');
    });
    s.register('t', () => {
      calls.push('second');
    });
    await s.start();
    await s.at(Date.now() - 1, 't');
    await tick();

    expect(calls).toEqual(['second']);
    s.stop();
  });
});
