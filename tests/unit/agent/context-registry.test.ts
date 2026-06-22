import { describe, expect, it } from 'bun:test';
import { ContextRegistry } from '../../../src/agent/context-registry/registry';
import type { ContextLayer, ContextRegistryEvent } from '../../../src/agent/context-registry/types';

// ─── CRUD ──────────────────────────────────────────────────────────────

describe('ContextRegistry — CRUD', () => {
  it('set creates a new layer with defaults', () => {
    const r = new ContextRegistry();
    const layer = r.set('system', 'You are a helper.');
    expect(layer.name).toBe('system');
    expect(layer.content).toBe('You are a helper.');
    expect(layer.priority).toBe(100);
    expect(layer.tags).toEqual([]);
    expect(layer.version).toBe(1);
    expect(layer.createdAt).toBeGreaterThan(0);
    expect(layer.updatedAt).toBe(layer.createdAt);
  });

  it('set replacing existing layer bumps version and preserves createdAt', () => {
    const r = new ContextRegistry();
    const first = r.set('x', 'a');
    const second = r.set('x', 'b');
    expect(second.version).toBe(first.version + 1);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('set inherits priority/tags/mergeParent from previous when not specified', () => {
    const r = new ContextRegistry();
    r.set('x', 'a', { priority: 42, tags: ['sys'], mergeParent: true });
    const second = r.set('x', 'b');
    expect(second.priority).toBe(42);
    expect(second.tags).toEqual(['sys']);
    expect(second.mergeParent).toBe(true);
  });

  it('set accepts ContentPart[] content', () => {
    const r = new ContextRegistry();
    r.set('x', [{ type: 'text', text: 'hello' }]);
    const layer = r.get('x');
    expect(Array.isArray(layer?.content)).toBe(true);
  });

  it('patch with string returns new content', () => {
    const r = new ContextRegistry();
    r.set('x', 'one');
    r.patch('x', (prev) => `${prev?.content as string} two`);
    expect(r.get('x')?.content).toBe('one two');
  });

  it('patch receives undefined when layer absent', () => {
    const r = new ContextRegistry();
    let seen: ContextLayer | undefined;
    let called = false;
    r.patch('new', (prev) => {
      seen = prev;
      called = true;
      return 'hello';
    });
    expect(called).toBe(true);
    expect(seen).toBeUndefined();
    expect(r.get('new')?.content).toBe('hello');
  });

  it('patch returning full layer shape merges fields', () => {
    const r = new ContextRegistry();
    r.set('x', 'a', { priority: 50 });
    r.patch('x', () => ({
      name: 'x',
      content: 'b',
      priority: 75,
      tags: ['new'],
      version: 0,
      createdAt: 0,
      updatedAt: 0,
    }));
    const l = r.get('x');
    expect(l?.content).toBe('b');
    expect(l?.priority).toBe(75);
    expect(l?.tags).toEqual(['new']);
  });

  it('get / has return as expected', () => {
    const r = new ContextRegistry();
    expect(r.has('x')).toBe(false);
    expect(r.get('x')).toBeUndefined();
    r.set('x', 'a');
    expect(r.has('x')).toBe(true);
    expect(r.get('x')?.content).toBe('a');
  });

  it('remove returns true once, false thereafter', () => {
    const r = new ContextRegistry();
    r.set('x', 'a');
    expect(r.remove('x')).toBe(true);
    expect(r.remove('x')).toBe(false);
    expect(r.has('x')).toBe(false);
  });

  it('list with no filter returns all', () => {
    const r = new ContextRegistry();
    r.set('a', '1');
    r.set('b', '2');
    r.set('c', '3');
    expect(r.list().length).toBe(3);
  });

  it('list filters by tag / tags / owner', () => {
    const r = new ContextRegistry();
    r.set('a', '1', { tags: ['sys'], owner: 'x' });
    r.set('b', '2', { tags: ['memory'], owner: 'y' });
    r.set('c', '3', { tags: ['sys', 'memory'], owner: 'x' });

    expect(
      r
        .list({ tag: 'sys' })
        .map((l) => l.name)
        .sort(),
    ).toEqual(['a', 'c']);
    expect(
      r
        .list({ tags: ['memory'] })
        .map((l) => l.name)
        .sort(),
    ).toEqual(['b', 'c']);
    expect(
      r
        .list({ owner: 'x' })
        .map((l) => l.name)
        .sort(),
    ).toEqual(['a', 'c']);
  });

  it('names() lists only local names (not parent)', () => {
    const p = new ContextRegistry();
    p.set('p1', 'x');
    const c = new ContextRegistry({ parent: p });
    c.set('c1', 'y');
    expect(c.names()).toEqual(['c1']);
  });
});

// ─── Rendering ────────────────────────────────────────────────────────

describe('ContextRegistry — render (single registry)', () => {
  it('renders empty to empty', () => {
    const r = new ContextRegistry();
    expect(r.render().flat).toBe('');
    expect(r.render().totalChars).toBe(0);
  });

  it('sorts by priority ascending', () => {
    const r = new ContextRegistry();
    r.set('c', 'C', { priority: 300 });
    r.set('a', 'A', { priority: 100 });
    r.set('b', 'B', { priority: 200 });
    const parts = r.render().parts.map((p) => p.name);
    expect(parts).toEqual(['a', 'b', 'c']);
  });

  it('filters by include / exclude', () => {
    const r = new ContextRegistry();
    r.set('a', 'A');
    r.set('b', 'B');
    r.set('c', 'C');
    expect(
      r
        .render({ include: ['a', 'c'] })
        .parts.map((p) => p.name)
        .sort(),
    ).toEqual(['a', 'c']);
    expect(
      r
        .render({ exclude: ['b'] })
        .parts.map((p) => p.name)
        .sort(),
    ).toEqual(['a', 'c']);
  });

  it('filters by tag / tags', () => {
    const r = new ContextRegistry();
    r.set('s1', 'A', { tags: ['system'] });
    r.set('s2', 'B', { tags: ['system'] });
    r.set('m1', 'C', { tags: ['memory'] });
    expect(
      r
        .render({ tag: 'system' })
        .parts.map((p) => p.name)
        .sort(),
    ).toEqual(['s1', 's2']);
    expect(r.render({ tags: ['memory', 'system'] }).parts.length).toBe(3);
  });

  it('filters by ownerFilter', () => {
    const r = new ContextRegistry();
    r.set('a', 'A', { owner: 'x' });
    r.set('b', 'B', { owner: 'y' });
    expect(r.render({ ownerFilter: 'x' }).parts.map((p) => p.name)).toEqual(['a']);
  });

  it('flat uses custom separator', () => {
    const r = new ContextRegistry();
    r.set('a', 'A', { priority: 1 });
    r.set('b', 'B', { priority: 2 });
    expect(r.flat({ separator: ' | ' })).toBe('A | B');
  });

  it('empty-content layers are excluded from flat but present in parts', () => {
    const r = new ContextRegistry();
    r.set('a', 'A');
    r.set('empty', '');
    r.set('b', 'B');
    const result = r.render();
    expect(result.parts.length).toBe(3);
    expect(result.flat).toBe('A\n\nB');
  });

  it('ContentPart[] content flattens to text', () => {
    const r = new ContextRegistry();
    r.set('x', [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
    expect(r.flat()).toBe('hello\nworld');
  });

  it('RenderResult.parts[n].registry is this registry id when no parent', () => {
    const r = new ContextRegistry({ id: 'r1' });
    r.set('x', 'a');
    expect(r.render().parts[0].registry).toBe('r1');
  });
});

// ─── Parent chain composition ──────────────────────────────────────────

describe('ContextRegistry — parent chain', () => {
  it('inherits parent layers in render by default', () => {
    const p = new ContextRegistry();
    p.set('role', 'You are a helper.', { tags: ['system'] });
    const c = new ContextRegistry({ parent: p });
    c.set('context', 'Current task: X.', { tags: ['system'] });

    const result = c.render({ tag: 'system' });
    expect(result.parts.map((r) => r.name).sort()).toEqual(['context', 'role']);
  });

  it('includeParent=false skips parent layers', () => {
    const p = new ContextRegistry();
    p.set('role', 'You are a helper.');
    const c = new ContextRegistry({ parent: p });
    c.set('context', 'Current task: X.');

    const result = c.render({ includeParent: false });
    expect(result.parts.map((r) => r.name)).toEqual(['context']);
  });

  it('same-named layer: child replaces parent by default', () => {
    const p = new ContextRegistry({ id: 'p' });
    p.set('x', 'parent-content');
    const c = new ContextRegistry({ id: 'c', parent: p });
    c.set('x', 'child-content');

    const result = c.render();
    expect(result.parts.length).toBe(1);
    expect(result.parts[0].content).toBe('child-content');
    expect(result.parts[0].registry).toBe('c');
  });

  it('same-named layer with mergeParent=true concatenates parent + child', () => {
    const p = new ContextRegistry({ id: 'p' });
    p.set('facts', 'parent-fact', { tags: ['system'] });
    const c = new ContextRegistry({ id: 'c', parent: p });
    c.set('facts', 'child-fact', { tags: ['system'], mergeParent: true });

    const result = c.render({ tag: 'system' });
    expect(result.parts.length).toBe(1);
    expect(result.parts[0].content).toBe('parent-fact\n\nchild-fact');
  });

  it('three-level chain walks correctly with mergeParent', () => {
    const g = new ContextRegistry({ id: 'g' });
    g.set('memory', 'G', { mergeParent: true });
    const p = new ContextRegistry({ id: 'p', parent: g });
    p.set('memory', 'P', { mergeParent: true });
    const c = new ContextRegistry({ id: 'c', parent: p });
    c.set('memory', 'C', { mergeParent: true });

    expect(c.flat()).toBe('G\n\nP\n\nC');
  });

  it('setParent throws on cycle (self as parent)', () => {
    const r = new ContextRegistry();
    expect(() => r.setParent(r)).toThrow(/cycle/);
  });

  it('setParent throws on cycle (ancestor as parent)', () => {
    const a = new ContextRegistry();
    const b = new ContextRegistry({ parent: a });
    const c = new ContextRegistry({ parent: b });
    expect(() => a.setParent(c)).toThrow(/cycle/);
  });

  it('setParent(null) detaches', () => {
    const p = new ContextRegistry();
    p.set('x', 'P');
    const c = new ContextRegistry({ parent: p });
    expect(c.flat()).toBe('P');
    c.setParent(null);
    expect(c.flat()).toBe('');
  });
});

// ─── Events ────────────────────────────────────────────────────────────

describe('ContextRegistry — events', () => {
  it('fires set event on new layer', () => {
    const r = new ContextRegistry();
    const events: ContextRegistryEvent[] = [];
    r.onChange((e) => {
      events.push(e);
    });
    r.set('x', 'a');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('set');
    expect(events[0].name).toBe('x');
    expect(events[0].current?.content).toBe('a');
  });

  it('fires update event on existing layer', () => {
    const r = new ContextRegistry();
    r.set('x', 'a');
    const events: ContextRegistryEvent[] = [];
    r.onChange((e) => {
      events.push(e);
    });
    r.set('x', 'b');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('update');
    expect(events[0].previous?.content).toBe('a');
    expect(events[0].current?.content).toBe('b');
  });

  it('fires remove event', () => {
    const r = new ContextRegistry();
    r.set('x', 'a');
    const events: ContextRegistryEvent[] = [];
    r.onChange((e) => {
      events.push(e);
    });
    r.remove('x');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('remove');
    expect(events[0].previous?.content).toBe('a');
  });

  it('subscribe with prefix pattern', () => {
    const r = new ContextRegistry();
    const memoryEvents: string[] = [];
    r.subscribe('memory.*', (e) => {
      memoryEvents.push(e.name);
    });
    r.set('memory.a', '1');
    r.set('memory.b', '2');
    r.set('other', '3');
    expect(memoryEvents.sort()).toEqual(['memory.a', 'memory.b']);
  });

  it('subscribe with exact name', () => {
    const r = new ContextRegistry();
    const facts: ContextRegistryEvent[] = [];
    r.subscribe('facts', (e) => {
      facts.push(e);
    });
    r.set('facts', 'a');
    r.set('other', 'b');
    expect(facts.length).toBe(1);
  });

  it('unsubscribe stops firing', () => {
    const r = new ContextRegistry();
    const seen: string[] = [];
    const unsub = r.onChange((e) => {
      seen.push(e.name);
    });
    r.set('x', 'a');
    unsub();
    r.set('y', 'b');
    expect(seen).toEqual(['x']);
  });

  it('handler error in one subscriber does not break others', () => {
    const r = new ContextRegistry();
    const seen: string[] = [];
    r.onChange(() => {
      throw new Error('boom');
    });
    r.onChange((e) => {
      seen.push(e.name);
    });
    r.set('x', 'a');
    expect(seen).toEqual(['x']);
  });

  it('parent events bubble to child subscribers', () => {
    const p = new ContextRegistry({ id: 'p' });
    const c = new ContextRegistry({ id: 'c', parent: p });
    const seen: ContextRegistryEvent[] = [];
    c.onChange((e) => {
      seen.push(e);
    });
    p.set('x', 'a');
    expect(seen.length).toBe(1);
    expect(seen[0].name).toBe('x');
    expect(seen[0].registry).toBe('p');
  });

  it('grandparent events bubble through two levels', () => {
    const g = new ContextRegistry({ id: 'g' });
    const p = new ContextRegistry({ id: 'p', parent: g });
    const c = new ContextRegistry({ id: 'c', parent: p });
    const seen: string[] = [];
    c.onChange((e) => {
      seen.push(`${e.registry}:${e.name}`);
    });
    g.set('x', 'a');
    expect(seen).toEqual(['g:x']);
  });

  it('setParent(null) stops bubbling', () => {
    const p = new ContextRegistry({ id: 'p' });
    const c = new ContextRegistry({ id: 'c', parent: p });
    const seen: string[] = [];
    c.onChange((e) => {
      seen.push(e.name);
    });

    p.set('a', '1');
    expect(seen.length).toBe(1);

    c.setParent(null);
    p.set('b', '2');
    expect(seen.length).toBe(1);
  });

  it('onSizeChange fires when size delta is non-zero', () => {
    const r = new ContextRegistry();
    const calls: Array<[number, number]> = [];
    r.onSizeChange((total, delta) => {
      calls.push([total, delta]);
    });

    r.set('x', 'aaa');
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe(3);

    r.set('x', 'aaaaa');
    expect(calls.length).toBe(2);
    expect(calls[1][1]).toBe(2);

    r.remove('x');
    expect(calls.length).toBe(3);
    expect(calls[2][1]).toBeLessThan(0);
  });

  it('onSizeChange does not fire on zero-delta mutation', () => {
    const r = new ContextRegistry();
    r.set('x', 'aaa');
    const calls: number[] = [];
    r.onSizeChange((_, delta) => {
      calls.push(delta);
    });

    r.set('x', 'bbb');
    expect(calls.length).toBe(0);
  });
});

// ─── Size ──────────────────────────────────────────────────────────────

describe('ContextRegistry — size', () => {
  it('sizeChars reflects rendered output', () => {
    const r = new ContextRegistry();
    r.set('a', 'aaaa');
    r.set('b', 'bbbb');
    expect(r.sizeChars()).toBe('aaaa\n\nbbbb'.length);
  });

  it('sizeTokens with heuristic fallback (~4 chars/token)', () => {
    const r = new ContextRegistry();
    r.set('x', 'a'.repeat(40));
    expect(r.sizeTokens()).toBe(10);
  });

  it('sizeTokens uses injected counter when available', () => {
    const mockCounter = {
      estimate: (text: string) => text.length,
      estimateMessage: () => 0,
      measure: async () => 0,
      measureMessage: async () => 0,
      learn: () => {},
    };
    const r = new ContextRegistry({ counter: mockCounter });
    r.set('x', 'abcde');
    expect(r.sizeTokens()).toBe(5);
  });

  it('sizeChars respects render filters', () => {
    const r = new ContextRegistry();
    r.set('a', 'aaaa', { tags: ['sys'] });
    r.set('b', 'bbbb', { tags: ['other'] });
    expect(r.sizeChars({ tag: 'sys' })).toBe(4);
  });
});

// ─── Persistence ───────────────────────────────────────────────────────

describe('ContextRegistry — persistence', () => {
  it('snapshot contains all layers and preserves separator', () => {
    const r = new ContextRegistry({ id: 'r1', separator: ' -- ' });
    r.set('a', 'A', { tags: ['x'], priority: 50 });
    r.set('b', 'B');
    const snap = r.snapshot();
    expect(snap.v).toBe(1);
    expect(snap.id).toBe('r1');
    expect(snap.separator).toBe(' -- ');
    expect(snap.layers.length).toBe(2);
  });

  it('fromSnapshot restores fidelity', () => {
    const r = new ContextRegistry({ id: 'r1', separator: ' | ' });
    r.set('a', 'A', { priority: 10, tags: ['sys'] });
    r.set('b', 'B', { priority: 20, mergeParent: true });
    const snap = r.snapshot();

    const restored = ContextRegistry.fromSnapshot(snap);
    expect(restored.id).toBe('r1');
    expect(restored.flat()).toBe('A | B');
    expect(restored.get('b')?.mergeParent).toBe(true);
  });

  it('fromSnapshot does NOT fire events for restored layers', () => {
    const r = new ContextRegistry();
    r.set('x', 'a');
    const snap = r.snapshot();

    const events: ContextRegistryEvent[] = [];
    const restored = ContextRegistry.fromSnapshot(snap);
    restored.onChange((e) => {
      events.push(e);
    });
    expect(events.length).toBe(0);
    expect(restored.has('x')).toBe(true);
  });

  it('parent is NOT part of snapshot', () => {
    const p = new ContextRegistry();
    p.set('parent-layer', 'P');
    const c = new ContextRegistry({ parent: p });
    c.set('x', 'C');
    const snap = c.snapshot();
    expect(snap.layers.map((l) => l.name)).toEqual(['x']);

    const restored = ContextRegistry.fromSnapshot(snap);
    expect(restored.parent).toBeNull();
    expect(restored.flat()).toBe('C');
  });
});

// ─── Bookkeeping / cleanup ────────────────────────────────────────────

describe('ContextRegistry — bookkeeping', () => {
  it('handlerCount tracks all subscription types', () => {
    const r = new ContextRegistry();
    expect(r.handlerCount).toBe(0);
    r.subscribe('x', () => {});
    r.subscribe('y.*', () => {});
    r.subscribe('*', () => {});
    r.onSizeChange(() => {});
    expect(r.handlerCount).toBe(4);
  });

  it('clear removes all subscriptions and detaches parent', () => {
    const p = new ContextRegistry();
    const r = new ContextRegistry({ parent: p });
    r.subscribe('*', () => {});
    r.onSizeChange(() => {});
    r.clear();
    expect(r.handlerCount).toBe(0);
    expect(r.parent).toBeNull();
  });
});

// ─── Integration: realistic scenarios ─────────────────────────────────

describe('ContextRegistry — realistic flow', () => {
  it('three-tier: global / module / conversation, rendered for system prompt', () => {
    const global = new ContextRegistry({ id: 'global' });
    global.set('user.identity', 'User: Alice', { tags: ['system'], priority: 10 });

    const moduleReg = new ContextRegistry({ id: 'module', parent: global });
    moduleReg.set('role', 'You are a research assistant.', { tags: ['system'], priority: 20 });

    const conv = new ContextRegistry({ id: 'conv', parent: moduleReg });
    conv.set('facts', '- location: Paris\n- time: 2pm', {
      tags: ['system'],
      priority: 300,
      mergeParent: true,
    });

    const systemPrompt = conv.flat({ tag: 'system' });
    expect(systemPrompt).toBe(
      'User: Alice\n\nYou are a research assistant.\n\n- location: Paris\n- time: 2pm',
    );

    const parts = conv.render({ tag: 'system' }).parts;
    expect(parts.find((p) => p.name === 'user.identity')?.registry).toBe('global');
    expect(parts.find((p) => p.name === 'role')?.registry).toBe('module');
    expect(parts.find((p) => p.name === 'facts')?.registry).toBe('conv');
  });

  it('writer identity captured via owner, filterable on render', () => {
    const r = new ContextRegistry();
    r.set('facts', 'F', { tags: ['system'], owner: 'context-guard' });
    r.set('memory', 'M', { tags: ['system'], owner: 'memory-manager' });
    r.set('retrieval', 'R', { tags: ['system'], owner: 'rag' });

    const onlyGuard = r.render({ ownerFilter: 'context-guard' }).parts.map((p) => p.name);
    expect(onlyGuard).toEqual(['facts']);
  });

  it('onSizeChange lets subscribers recompute total before send', () => {
    const r = new ContextRegistry();
    let latestSize = 0;
    r.onSizeChange((total) => {
      latestSize = total;
    });

    r.set('a', 'a'.repeat(100));
    r.set('b', 'b'.repeat(200));
    expect(latestSize).toBe(r.sizeChars());
  });
});
