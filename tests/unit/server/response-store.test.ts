/** ResponseStore unit tests — multi-user keying + persistence integration. */

import { describe, expect, it } from 'bun:test';
import { ConversationHistory } from '../../../src/agent/history';
import { MemoryPersistence } from '../../../src/plugins/persistence/memory';
import { ResponseStore } from '../../../src/server/response-store';

function makeEntry(
  opts: { id?: string; userId?: string | null; model?: string; history?: ConversationHistory } = {},
) {
  return {
    localResponseId: opts.id ?? ResponseStore.newId(),
    userId: opts.userId ?? null,
    target: { kind: 'direct' as const, model: opts.model ?? 'm', id: 'mock/m' },
    history: opts.history ?? new ConversationHistory(),
    providerResponseId: null,
    providerStateExpiresAt: null,
  };
}

describe('ResponseStore — basic CRUD', () => {
  it('newId produces resp_-prefixed id', () => {
    expect(ResponseStore.newId()).toMatch(/^resp_/);
  });

  it('put + get round-trips in cache', async () => {
    const store = new ResponseStore();
    const entry = await store.put(makeEntry({ id: 'r1' }));
    const fetched = await store.get('r1');
    expect(fetched).toBe(entry);
  });

  it('get returns null when unknown', async () => {
    const store = new ResponseStore();
    expect(await store.get('nope')).toBeNull();
  });

  it('delete removes from cache and persistence', async () => {
    const persistence = new MemoryPersistence();
    const store = new ResponseStore({ persistence });
    await store.put(makeEntry({ id: 'r1' }));
    await store.delete('r1');
    expect(await store.get('r1')).toBeNull();
  });
});

describe('ResponseStore — multi-user scoping', () => {
  it('different users with same response id are isolated in cache', async () => {
    const store = new ResponseStore();
    const aHistory = new ConversationHistory();
    aHistory.append({ role: 'user', content: 'a' });
    const bHistory = new ConversationHistory();
    bHistory.append({ role: 'user', content: 'b' });

    await store.put(makeEntry({ id: 'r1', userId: 'alice', history: aHistory }));
    await store.put(makeEntry({ id: 'r1', userId: 'bob', history: bHistory }));

    const fromAlice = await store.get('r1', 'alice');
    const fromBob = await store.get('r1', 'bob');
    expect(fromAlice?.history.at(0)?.message.content).toBe('a');
    expect(fromBob?.history.at(0)?.message.content).toBe('b');
  });

  it('persistence keys include userId namespace', async () => {
    const persistence = new MemoryPersistence();
    const store = new ResponseStore({ persistence });
    await store.put(makeEntry({ id: 'r1', userId: 'alice' }));
    const keys = await persistence.list('response:');
    expect(keys.some((k) => k.includes('alice'))).toBe(true);
  });

  it('list filters to the requested user', async () => {
    const store = new ResponseStore();
    await store.put(makeEntry({ id: 'r1', userId: 'alice' }));
    await store.put(makeEntry({ id: 'r2', userId: 'bob' }));
    await store.put(makeEntry({ id: 'r3', userId: 'alice' }));

    const aliceIds = await store.list('alice');
    expect(aliceIds.sort()).toEqual(['r1', 'r3']);
  });

  it('persistence-backed get rehydrates ConversationHistory', async () => {
    const persistence = new MemoryPersistence();
    const store1 = new ResponseStore({ persistence });
    const history = new ConversationHistory();
    history.append({ role: 'user', content: 'hello' });
    await store1.put(makeEntry({ id: 'r1', history }));

    // Fresh store backed by same persistence — cache miss, reads from disk.
    const store2 = new ResponseStore({ persistence });
    const entry = await store2.get('r1');
    expect(entry?.history.at(0)?.message.content).toBe('hello');
  });
});

describe('ResponseStore — provider chain freshness', () => {
  it('hasFreshProviderState returns false when no providerResponseId', () => {
    expect(
      ResponseStore.hasFreshProviderState({
        providerResponseId: null,
        providerStateExpiresAt: null,
      }),
    ).toBe(false);
  });

  it('hasFreshProviderState true when before expiry', () => {
    expect(
      ResponseStore.hasFreshProviderState(
        {
          providerResponseId: 'p1',
          providerStateExpiresAt: Date.now() + 60_000,
        },
        Date.now(),
      ),
    ).toBe(true);
  });

  it('hasFreshProviderState false after expiry', () => {
    expect(
      ResponseStore.hasFreshProviderState({
        providerResponseId: 'p1',
        providerStateExpiresAt: Date.now() - 1,
      }),
    ).toBe(false);
  });
});

describe('ResponseStore — memory cap', () => {
  it('evicts oldest beyond capacity', async () => {
    const store = new ResponseStore({ memoryCapacity: 2 });
    await store.put(makeEntry({ id: 'a' }));
    await store.put(makeEntry({ id: 'b' }));
    await store.put(makeEntry({ id: 'c' }));
    expect(await store.get('a')).toBeNull(); // evicted
    expect(await store.get('b')).not.toBeNull();
    expect(await store.get('c')).not.toBeNull();
  });
});
