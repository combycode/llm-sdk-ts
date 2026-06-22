import { describe, expect, it } from 'bun:test';
import { AgentBus } from '../../../src/bus/agent-bus';
import type { AgentEvent } from '../../../src/bus/agent-bus';

describe('AgentBus — exact match', () => {
  it('calls handler on matching kind', async () => {
    const bus = new AgentBus();
    const seen: AgentEvent[] = [];
    bus.on('ask.permission', (e) => {
      seen.push(e);
    });

    await bus.emit({ source: 'm', kind: 'ask.permission', payload: { what: 'x' } });
    expect(seen.length).toBe(1);
    expect(seen[0].kind).toBe('ask.permission');
    expect(seen[0].timestamp).toBeGreaterThan(0);
  });

  it('does not call handler on different kind', async () => {
    const bus = new AgentBus();
    const seen: AgentEvent[] = [];
    bus.on('ask.permission', (e) => {
      seen.push(e);
    });

    await bus.emit({ source: 'm', kind: 'ask.choice', payload: {} });
    expect(seen.length).toBe(0);
  });

  it('multiple handlers for same kind all fire', async () => {
    const bus = new AgentBus();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    bus.on('log', (e) => {
      a.push(e);
    });
    bus.on('log', (e) => {
      b.push(e);
    });

    await bus.emit({ source: 'm', kind: 'log', payload: 'hi' });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  it('unsubscribe removes the handler', async () => {
    const bus = new AgentBus();
    const seen: AgentEvent[] = [];
    const unsub = bus.on('log', (e) => {
      seen.push(e);
    });

    await bus.emit({ source: 'm', kind: 'log', payload: 1 });
    unsub();
    await bus.emit({ source: 'm', kind: 'log', payload: 2 });

    expect(seen.length).toBe(1);
    expect(seen[0].payload).toBe(1);
  });
});

describe('AgentBus — prefix match', () => {
  it('foo.* matches foo.bar', async () => {
    const bus = new AgentBus();
    const seen: string[] = [];
    bus.on('ask.*', (e) => {
      seen.push(e.kind);
    });

    await bus.emit({ source: 'm', kind: 'ask.permission', payload: {} });
    await bus.emit({ source: 'm', kind: 'ask.choice', payload: {} });
    await bus.emit({ source: 'm', kind: 'ask.text', payload: {} });

    expect(seen).toEqual(['ask.permission', 'ask.choice', 'ask.text']);
  });

  it('foo.* also matches nested foo.bar.baz', async () => {
    const bus = new AgentBus();
    const seen: string[] = [];
    bus.on('log.*', (e) => {
      seen.push(e.kind);
    });

    await bus.emit({ source: 'm', kind: 'log.progress', payload: {} });
    await bus.emit({ source: 'm', kind: 'log.progress.update', payload: {} });
    expect(seen).toEqual(['log.progress', 'log.progress.update']);
  });

  it('foo.* does NOT match sibling foo', async () => {
    const bus = new AgentBus();
    const seen: string[] = [];
    bus.on('ask.*', (e) => {
      seen.push(e.kind);
    });

    await bus.emit({ source: 'm', kind: 'ask', payload: {} });
    expect(seen.length).toBe(0);
  });

  it('foo.* does NOT match unrelated prefix', async () => {
    const bus = new AgentBus();
    const seen: string[] = [];
    bus.on('ask.*', (e) => {
      seen.push(e.kind);
    });

    await bus.emit({ source: 'm', kind: 'asking', payload: {} });
    await bus.emit({ source: 'm', kind: 'log', payload: {} });
    expect(seen.length).toBe(0);
  });
});

describe('AgentBus — wildcard', () => {
  it('* catches all events', async () => {
    const bus = new AgentBus();
    const seen: string[] = [];
    bus.on('*', (e) => {
      seen.push(e.kind);
    });

    await bus.emit({ source: 'm', kind: 'a', payload: {} });
    await bus.emit({ source: 'm', kind: 'b.c', payload: {} });
    await bus.emit({ source: 'm', kind: 'foo.bar.baz', payload: {} });

    expect(seen).toEqual(['a', 'b.c', 'foo.bar.baz']);
  });
});

describe('AgentBus — correlation IDs', () => {
  it('onReply fires only for matching correlationId', async () => {
    const bus = new AgentBus();
    const seen: AgentEvent[] = [];
    bus.onReply('q1', (e) => {
      seen.push(e);
    });

    await bus.emit({ source: 'm', kind: 'ask.reply', payload: 'a', correlationId: 'q1' });
    await bus.emit({ source: 'm', kind: 'ask.reply', payload: 'b', correlationId: 'q2' });
    await bus.emit({ source: 'm', kind: 'ask.reply', payload: 'c' });

    expect(seen.length).toBe(1);
    expect(seen[0].payload).toBe('a');
  });

  it('reply() convenience sets correlationId automatically', async () => {
    const bus = new AgentBus();
    let received: AgentEvent | null = null;
    bus.onReply('q1', (e) => {
      received = e;
    });

    await bus.reply('q1', { source: 'user', kind: 'ask.answer', payload: { granted: true } });

    expect(received).not.toBeNull();
    const r = received as AgentEvent | null;
    expect(r?.correlationId).toBe('q1');
    expect(r?.payload).toEqual({ granted: true });
  });

  it('correlation and pattern handlers both fire for a correlated event', async () => {
    const bus = new AgentBus();
    const byPattern: string[] = [];
    const byCorr: string[] = [];
    bus.on('ask.*', (e) => {
      byPattern.push(e.payload as string);
    });
    bus.onReply('q1', (e) => {
      byCorr.push(e.payload as string);
    });

    await bus.emit({ source: 'm', kind: 'ask.reply', payload: 'hi', correlationId: 'q1' });

    expect(byPattern).toEqual(['hi']);
    expect(byCorr).toEqual(['hi']);
  });

  it('onReply unsubscribe works', async () => {
    const bus = new AgentBus();
    const seen: AgentEvent[] = [];
    const unsub = bus.onReply('q1', (e) => {
      seen.push(e);
    });

    await bus.reply('q1', { source: 'x', kind: 'answer', payload: 1 });
    unsub();
    await bus.reply('q1', { source: 'x', kind: 'answer', payload: 2 });

    expect(seen.length).toBe(1);
  });
});

describe('AgentBus — handler isolation', () => {
  it('one handler throwing does not break others', async () => {
    const bus = new AgentBus();
    const seen: string[] = [];
    bus.on('x', () => {
      throw new Error('boom');
    });
    bus.on('x', (e) => {
      seen.push(e.kind);
    });

    await bus.emit({ source: 'm', kind: 'x', payload: {} });
    expect(seen).toEqual(['x']);
  });

  it('thrown error is re-emitted as system.handler-error for observers', async () => {
    const bus = new AgentBus();
    const errors: AgentEvent[] = [];
    bus.on('system.*', (e) => {
      errors.push(e);
    });
    bus.on('x', () => {
      throw new Error('boom-x');
    });

    await bus.emit({ source: 'm', kind: 'x', payload: {} });
    expect(errors.length).toBe(1);
    expect(errors[0].kind).toBe('system.handler-error');
    expect((errors[0].payload as any).originalKind).toBe('x');
    expect((errors[0].payload as any).error).toBe('boom-x');
  });

  it('handler error in system.handler-error itself does not cascade', async () => {
    const bus = new AgentBus();
    bus.on('system.handler-error', () => {
      throw new Error('meta-boom');
    });
    bus.on('x', () => {
      throw new Error('boom');
    });

    // Should complete without throwing.
    await bus.emit({ source: 'm', kind: 'x', payload: {} });
  });
});

describe('AgentBus — bookkeeping', () => {
  it('handlerCount reflects subscriptions', () => {
    const bus = new AgentBus();
    expect(bus.handlerCount).toBe(0);

    const u1 = bus.on('x', () => {});
    const u2 = bus.on('y.*', () => {});
    const u3 = bus.on('*', () => {});
    const u4 = bus.onReply('corr', () => {});
    expect(bus.handlerCount).toBe(4);

    u1();
    u2();
    expect(bus.handlerCount).toBe(2);

    u3();
    u4();
    expect(bus.handlerCount).toBe(0);
  });

  it('clear() removes all handlers', async () => {
    const bus = new AgentBus();
    bus.on('x', () => {});
    bus.on('y.*', () => {});
    bus.on('*', () => {});
    bus.onReply('c', () => {});

    expect(bus.handlerCount).toBe(4);
    bus.clear();
    expect(bus.handlerCount).toBe(0);
  });
});

describe('AgentBus — ordering', () => {
  it('handlers fire in registration order for the same pattern', async () => {
    const bus = new AgentBus();
    const order: number[] = [];
    bus.on('x', () => {
      order.push(1);
    });
    bus.on('x', () => {
      order.push(2);
    });
    bus.on('x', () => {
      order.push(3);
    });

    await bus.emit({ source: 'm', kind: 'x', payload: {} });
    expect(order).toEqual([1, 2, 3]);
  });

  it('wildcard handlers fire before pattern handlers before exact', async () => {
    const bus = new AgentBus();
    const order: string[] = [];
    bus.on('ask.permission', () => {
      order.push('exact');
    });
    bus.on('ask.*', () => {
      order.push('prefix');
    });
    bus.on('*', () => {
      order.push('wildcard');
    });

    await bus.emit({ source: 'm', kind: 'ask.permission', payload: {} });
    expect(order).toEqual(['wildcard', 'prefix', 'exact']);
  });
});

describe('AgentBus — async handlers', () => {
  it('awaits async handlers sequentially', async () => {
    const bus = new AgentBus();
    const order: string[] = [];
    bus.on('x', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('slow');
    });
    bus.on('x', () => {
      order.push('fast');
    });

    await bus.emit({ source: 'm', kind: 'x', payload: {} });
    expect(order).toEqual(['slow', 'fast']);
  });

  it('emit resolves only after all handlers complete', async () => {
    const bus = new AgentBus();
    let done = false;
    bus.on('x', async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    const p = bus.emit({ source: 'm', kind: 'x', payload: {} });
    expect(done).toBe(false);
    await p;
    expect(done).toBe(true);
  });
});

describe('AgentBus — event id', () => {
  it('emit assigns a unique id when not supplied', async () => {
    const bus = new AgentBus();
    const seen: AgentEvent[] = [];
    bus.on('x', (e) => {
      seen.push(e);
    });
    await bus.emit({ source: 'm', kind: 'x', payload: 1 });
    await bus.emit({ source: 'm', kind: 'x', payload: 2 });
    expect(seen[0].id).toMatch(/^evt_[0-9a-f]+$/);
    expect(seen[1].id).toMatch(/^evt_[0-9a-f]+$/);
    expect(seen[0].id).not.toBe(seen[1].id);
  });

  it('emit preserves a caller-supplied id', async () => {
    const bus = new AgentBus();
    const seen: AgentEvent[] = [];
    bus.on('x', (e) => {
      seen.push(e);
    });
    await bus.emit({ id: 'evt_custom', source: 'm', kind: 'x', payload: {} });
    expect(seen[0].id).toBe('evt_custom');
  });

  it('handler-error system event references the original event via causedBy', async () => {
    const bus = new AgentBus();
    let original: AgentEvent | null = null;
    bus.on('x', (e) => {
      original = e;
      throw new Error('boom');
    });
    const errors: AgentEvent[] = [];
    bus.on('system.handler-error', (e) => {
      errors.push(e);
    });
    await bus.emit({ source: 'm', kind: 'x', payload: {} });
    expect(errors.length).toBe(1);
    const orig = original as AgentEvent | null;
    expect(errors[0].causedBy).toBe(orig?.id);
  });
});

describe('AgentBus — subscription names', () => {
  it('accepts an optional name on on() and onReply() without altering delivery', async () => {
    const bus = new AgentBus();
    const seen: AgentEvent[] = [];
    bus.on(
      'x',
      (e) => {
        seen.push(e);
      },
      { name: 'logger' },
    );
    bus.onReply(
      'q1',
      (e) => {
        seen.push(e);
      },
      { name: 'reply-watcher' },
    );

    await bus.emit({ source: 'm', kind: 'x', payload: 1 });
    await bus.emit({ source: 'm', kind: 'y', correlationId: 'q1', payload: 2 });
    expect(seen.length).toBe(2);
  });

  it('unsubscribe still works when a name is set', async () => {
    const bus = new AgentBus();
    let n = 0;
    const off = bus.on(
      'x',
      () => {
        n++;
      },
      { name: 'counter' },
    );
    await bus.emit({ source: 'm', kind: 'x', payload: {} });
    off();
    await bus.emit({ source: 'm', kind: 'x', payload: {} });
    expect(n).toBe(1);
    expect(bus.handlerCount).toBe(0);
  });
});

describe('AgentBus — FIFO ordering across concurrent emits', () => {
  it('two parallel emit() calls process in submission order', async () => {
    const bus = new AgentBus();
    const order: number[] = [];
    bus.on('x', async (e) => {
      await Promise.resolve();
      order.push(e.payload as number);
    });

    const p1 = bus.emit({ source: 'm', kind: 'x', payload: 1 });
    const p2 = bus.emit({ source: 'm', kind: 'x', payload: 2 });
    const p3 = bus.emit({ source: 'm', kind: 'x', payload: 3 });
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('slow handler does not let later events overtake', async () => {
    const bus = new AgentBus();
    const order: string[] = [];
    bus.on('x', async (e) => {
      if (e.payload === 'slow') {
        await new Promise((r) => setTimeout(r, 20));
      }
      order.push(e.payload as string);
    });

    const p1 = bus.emit({ source: 'm', kind: 'x', payload: 'slow' });
    const p2 = bus.emit({ source: 'm', kind: 'x', payload: 'fast' });
    await Promise.all([p1, p2]);

    expect(order).toEqual(['slow', 'fast']);
  });
});

describe('AgentBus — depth-first reentrant emit', () => {
  it('nested emit completes before the next sibling handler runs', async () => {
    const bus = new AgentBus();
    const order: string[] = [];

    bus.on('outer', async () => {
      order.push('outer-h1-start');
      await bus.emit({ source: 'm', kind: 'inner', payload: {} });
      order.push('outer-h1-end');
    });
    bus.on('outer', () => {
      order.push('outer-h2');
    });
    bus.on('inner', () => {
      order.push('inner-h');
    });

    await bus.emit({ source: 'm', kind: 'outer', payload: {} });

    expect(order).toEqual(['outer-h1-start', 'inner-h', 'outer-h1-end', 'outer-h2']);
  });

  it('awaiting a nested emit inside a handler does not deadlock', async () => {
    const bus = new AgentBus();
    let nestedRan = false;
    bus.on('outer', async () => {
      await bus.emit({ source: 'm', kind: 'inner', payload: {} });
    });
    bus.on('inner', () => {
      nestedRan = true;
    });

    await bus.emit({ source: 'm', kind: 'outer', payload: {} });
    expect(nestedRan).toBe(true);
  });

  it('nested emit can carry causedBy linking back to its parent', async () => {
    const bus = new AgentBus();
    const events: AgentEvent[] = [];
    bus.on('*', (e) => {
      events.push(e);
    });

    bus.on('outer', async (parent) => {
      await bus.emit({
        source: 'm',
        kind: 'inner',
        payload: {},
        causedBy: parent.id,
      });
    });

    await bus.emit({ source: 'm', kind: 'outer', payload: {} });
    const outer = events.find((e) => e.kind === 'outer');
    const inner = events.find((e) => e.kind === 'inner');
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner?.causedBy).toBe((outer as AgentEvent).id);
  });
});
