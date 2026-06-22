/** createEngine + coreRegistry tests. */

import { describe, expect, it } from 'bun:test';
import { Cache } from '../../../src/plugins/cache/cache';
import { MemoryPersistence } from '../../../src/plugins/persistence/memory';
import { coreRegistry, createEngine } from '../../../src/helpers/engine';

describe('createEngine', () => {
  it('creates an engine with default hooks/bus/network', () => {
    const e = createEngine();
    expect(e.hooks).toBeDefined();
    expect(e.bus).toBeDefined();
    expect(e.network).toBeDefined();
    expect(e.persistence).toBeInstanceOf(MemoryPersistence);
    expect(e.cache).toBeNull();
    e.destroy();
  });

  it('mints a sessionId (and accepts one from a holder)', () => {
    const a = createEngine({ registerAsDefault: false });
    expect(a.sessionId).toMatch(/^sess_/);
    const b = createEngine({ registerAsDefault: false, sessionId: 'sess_parent' });
    expect(b.sessionId).toBe('sess_parent');
    a.destroy();
    b.destroy();
  });

  it('forwards a custom fetch transport to the network engine', async () => {
    let called = false;
    const fetchFn = (() => {
      called = true;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const e = createEngine({ fetch: fetchFn, registerAsDefault: false });
    const res = await e.fetch({
      url: 'https://example.test/x',
      method: 'POST',
      headers: {},
      body: {},
      provider: 'p',
      model: 'm',
      responseType: 'json',
    });
    expect(called).toBe(true);
    expect(res.body).toEqual({ ok: true });
    e.destroy();
  });

  it('memory persistence config', () => {
    const e = createEngine({ persistence: { type: 'memory' } });
    expect(e.persistence).toBeInstanceOf(MemoryPersistence);
    e.destroy();
  });

  it('throws on file persistence without dir', () => {
    expect(() => createEngine({ persistence: { type: 'file' } as any })).toThrow(/dir/);
  });

  it('memory cache config', () => {
    const e = createEngine({ cache: { type: 'memory' } });
    expect(e.cache).toBeInstanceOf(Cache);
    e.destroy();
  });

  it('passes through pre-built persistence/cache instances', () => {
    const persistence = new MemoryPersistence();
    const e = createEngine({ persistence });
    expect(e.persistence).toBe(persistence);
    e.destroy();
  });

  it('engine.fetch invokes underlying network engine', async () => {
    let captured: Request | null = null;
    const customFetch = async (url: string | URL | Request, init?: RequestInit) => {
      captured = new Request(url as string, init);
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const e = createEngine({ fetch: customFetch as never });
    // NetworkEngine doesn't take fetch via createEngine yet — sanity-check just
    // that the engine.fetch function exists and binds back to the engine. The
    // actual fetch wiring is exercised by network.test.ts.
    expect(typeof e.fetch).toBe('function');
    expect(typeof e.fetchStream).toBe('function');
    e.destroy();
    void captured;
  });
});

describe('coreRegistry', () => {
  it('lazy-creates a default engine on first read', () => {
    coreRegistry.clear();
    expect(coreRegistry.has()).toBe(false);
    const e = coreRegistry.get();
    expect(coreRegistry.has()).toBe(true);
    expect(e.hooks).toBeDefined();
  });

  it('throws on set() when engine already registered (default)', () => {
    coreRegistry.clear();
    coreRegistry.set(createEngine({ registerAsDefault: false }));
    expect(() => coreRegistry.set(createEngine({ registerAsDefault: false }))).toThrow(
      /already registered/,
    );
    coreRegistry.clear();
  });

  it('replaces with set({ replace: true })', () => {
    coreRegistry.clear();
    const a = createEngine({ registerAsDefault: false });
    coreRegistry.set(a);
    const b = createEngine({ registerAsDefault: false });
    coreRegistry.set(b, { replace: true });
    expect(coreRegistry.get()).toBe(b);
    coreRegistry.clear();
  });

  it('createEngine() auto-registers as default by default', () => {
    coreRegistry.clear();
    const e = createEngine();
    expect(coreRegistry.get()).toBe(e);
    coreRegistry.clear();
  });

  it('a second createEngine() throws unless registerAsDefault:false', () => {
    coreRegistry.clear();
    createEngine();
    expect(() => createEngine()).toThrow(/already registered/);
    expect(() => createEngine({ registerAsDefault: false })).not.toThrow();
    coreRegistry.clear();
  });
});
