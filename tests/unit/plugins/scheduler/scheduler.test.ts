import { describe, expect, it } from 'bun:test';
import { MemoryPersistence } from '../../../../src/plugins/persistence/memory';
import { parseDuration, Scheduler } from '../../../../src/plugins/scheduler/scheduler';

describe('parseDuration', () => {
  it('numbers pass through', () => {
    expect(parseDuration(1234)).toBe(1234);
  });

  it('s/m/h/d suffixes', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('500ms')).toBe(500);
  });

  it('invalid string throws', () => {
    expect(() => parseDuration('xyz')).toThrow(/Invalid duration/);
  });
});

describe('Scheduler', () => {
  it('after() persists and fires once', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    let fired = 0;
    s.register('t', () => {
      fired++;
    });
    await s.start();

    await s.after(10, 't', { x: 1 });
    expect((await s.pending()).length).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(1);
    expect((await s.pending()).length).toBe(0);

    s.stop();
  });

  it('cancel() removes pending task', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    s.register('t', () => {});
    await s.start();

    const id = await s.after(10_000, 't');
    expect((await s.pending()).length).toBe(1);

    await s.cancel(id);
    expect((await s.pending()).length).toBe(0);
    s.stop();
  });

  it('every() reschedules after firing', async () => {
    const p = new MemoryPersistence();
    const s = new Scheduler(p);
    let fired = 0;
    s.register('t', () => {
      fired++;
    });
    await s.start();

    const id = await s.every(15, 't');
    await new Promise((r) => setTimeout(r, 70));
    expect(fired).toBeGreaterThanOrEqual(2);

    await s.cancel(id);
    s.stop();
  });

  it('overdue tasks fire immediately on start()', async () => {
    const p = new MemoryPersistence();
    // Manually plant a task in the past (no scheduler running yet)
    await p.set('task:overdue', {
      id: 'overdue',
      name: 't',
      args: {},
      fireAt: Date.now() - 1000,
      type: 'once',
      interval: null,
    });

    const s = new Scheduler(p);
    let fired = 0;
    s.register('t', () => {
      fired++;
    });
    await s.start();

    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(1);
    s.stop();
  });
});
