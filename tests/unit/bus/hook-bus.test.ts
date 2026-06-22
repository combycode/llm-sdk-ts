import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';

describe('HookBus', () => {
  it('emits to registered handler', async () => {
    const bus = new HookBus();
    let received: any = null;
    bus.on('onWarning', (ctx) => {
      received = ctx;
    });

    await bus.emit('onWarning', { source: 'agent', code: 'test', message: 'hello' });
    expect(received).not.toBeNull();
    expect(received.code).toBe('test');
    expect(received.message).toBe('hello');
  });

  it('supports multiple handlers on same hook', async () => {
    const bus = new HookBus();
    const calls: number[] = [];
    bus.on('onWarning', () => {
      calls.push(1);
    });
    bus.on('onWarning', () => {
      calls.push(2);
    });
    bus.on('onWarning', () => {
      calls.push(3);
    });

    await bus.emit('onWarning', { source: 'agent', code: 'x', message: 'x' });
    expect(calls).toEqual([1, 2, 3]);
  });

  it('handlers run in registration order', async () => {
    const bus = new HookBus();
    const order: string[] = [];
    bus.on('onWarning', () => {
      order.push('first');
    });
    bus.on('onWarning', () => {
      order.push('second');
    });

    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    expect(order).toEqual(['first', 'second']);
  });

  it('unsubscribe removes handler', async () => {
    const bus = new HookBus();
    let count = 0;
    const unsub = bus.on('onWarning', () => {
      count++;
    });

    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    expect(count).toBe(1);

    unsub();
    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    expect(count).toBe(1);
  });

  it('once fires only once', async () => {
    const bus = new HookBus();
    let count = 0;
    bus.once('onWarning', () => {
      count++;
    });

    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    expect(count).toBe(1);
  });

  it('off removes all handlers for a hook', async () => {
    const bus = new HookBus();
    let count = 0;
    bus.on('onWarning', () => {
      count++;
    });
    bus.on('onWarning', () => {
      count++;
    });

    bus.off('onWarning');
    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    expect(count).toBe(0);
  });

  it('off() with no args clears all hooks', async () => {
    const bus = new HookBus();
    let count = 0;
    bus.on('onWarning', () => {
      count++;
    });

    bus.off();
    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    expect(count).toBe(0);
  });

  it('has() checks for registered handlers', () => {
    const bus = new HookBus();
    expect(bus.has('onWarning')).toBe(false);
    const unsub = bus.on('onWarning', () => {});
    expect(bus.has('onWarning')).toBe(true);
    unsub();
    expect(bus.has('onWarning')).toBe(false);
  });

  it('emitSync fires synchronously', () => {
    const bus = new HookBus();
    let fired = false;
    bus.on('onWarning', () => {
      fired = true;
    });

    bus.emitSync('onWarning', { source: 'agent', code: '', message: '' });
    expect(fired).toBe(true);
  });

  it('emit with no handlers does not throw', async () => {
    const bus = new HookBus();
    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    // no error
  });

  it('async handlers are awaited in order', async () => {
    const bus = new HookBus();
    const order: number[] = [];

    bus.on('onWarning', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    bus.on('onWarning', async () => {
      order.push(2);
    });

    await bus.emit('onWarning', { source: 'agent', code: '', message: '' });
    expect(order).toEqual([1, 2]);
  });

  it('handler errors propagate from emit()', async () => {
    const bus = new HookBus();
    bus.on('onWarning', () => {
      throw new Error('boom');
    });

    await expect(bus.emit('onWarning', { source: 'agent', code: '', message: '' })).rejects.toThrow(
      'boom',
    );
  });

  it('handlerCount tracks live subscriptions', () => {
    const bus = new HookBus();
    expect(bus.handlerCount).toBe(0);

    const u1 = bus.on('onWarning', () => {});
    const u2 = bus.on('onWarning', () => {});
    expect(bus.handlerCount).toBe(2);

    u1();
    expect(bus.handlerCount).toBe(1);

    u2();
    expect(bus.handlerCount).toBe(0);
  });

  it('unsubscribing the last handler removes the hook entry', () => {
    const bus = new HookBus();
    const unsub = bus.on('onWarning', () => {});
    expect(bus.has('onWarning')).toBe(true);
    unsub();
    expect(bus.has('onWarning')).toBe(false);
  });

  describe('onAny', () => {
    it('fires for every event with (name, ctx), even with no named handler', async () => {
      const bus = new HookBus();
      const seen: Array<[string, unknown]> = [];
      bus.onAny((name, ctx) => {
        seen.push([name, ctx]);
      });

      await bus.emit('onWarning', { source: 'agent', code: 'a', message: 'm' });
      bus.emitSync('onCostEntry', { entry: { id: '1' } as never, runningTotal: 1 });

      expect(seen.map(([n]) => n)).toEqual(['onWarning', 'onCostEntry']);
      expect((seen[0][1] as { code: string }).code).toBe('a');
    });

    it('runs alongside named handlers and unsubscribes', async () => {
      const bus = new HookBus();
      let named = 0;
      let any = 0;
      bus.on('onWarning', () => {
        named++;
      });
      const unsub = bus.onAny(() => {
        any++;
      });
      await bus.emit('onWarning', { source: 'agent', code: 'a', message: 'm' });
      expect([named, any]).toEqual([1, 1]);

      unsub();
      await bus.emit('onWarning', { source: 'agent', code: 'a', message: 'm' });
      expect([named, any]).toEqual([2, 1]);
    });

    it('counts toward handlerCount and is cleared by off()', () => {
      const bus = new HookBus();
      bus.onAny(() => {});
      expect(bus.handlerCount).toBe(1);
      bus.off();
      expect(bus.handlerCount).toBe(0);
    });
  });
});
