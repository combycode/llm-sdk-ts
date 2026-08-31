/** createServer() — the agents→loaders wiring.
 *
 *  Behaviour pinned here:
 *   - `agents` registers one static server model per key, so /v1/models lists
 *     it and the router can resolve it; internalTools / allowExternalTools ride
 *     along onto the entry.
 *   - A spec carrying a prebuilt `agent` reuses that agent's client for the
 *     static entry instead of building a new one.
 *   - With `agents`, the helper builds an agentLoader + conversationLoader:
 *       · conversationLoader.save persists the history snapshot under
 *         "<userId|anon>:<conversationId>" in the `server-conversations`
 *         collection, and load reads it back as a ConversationHistory;
 *       · a null userId is keyed as "anon" — NOT as "null" and not shared with
 *         a user literally called "anon" by accident of some other key shape;
 *       · load returns null (not an empty history) for an unseen conversation;
 *       · agentLoader.load returns null for a model that was never registered,
 *         returns the SAME prebuilt agent instance every time when the spec has
 *         one, and otherwise builds a per-request agent whose history is the
 *         persisted snapshot — falling back to conversationId 'default'.
 *   - Without `agents`, caller-supplied loaders are left alone.
 *
 *  No ports are bound: OaiServer.handle(Request) is called directly. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from '../../../src/helpers/server';
import { createAgent } from '../../../src/helpers/agent';
import { createCollection } from '../../../src/helpers/collection';
import { coreRegistry, createEngine } from '../../../src/helpers/engine';
import { ConversationHistory } from '../../../src/agent/history';
import type { AgentLoaderPlugin, ConversationLoaderPlugin } from '../../../src/server/loaders';
import type { HistorySnapshot } from '../../../src/agent/history-types';
import type { OaiServer } from '../../../src/server/server';
import type { AgentLoop } from '../../../src/agent/loop';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  createEngine({ apiKeys: { anthropic: 'test-key' } });
});

/** The loaders createServer built, read off the server it configured. */
function loadersOf(server: OaiServer): {
  agentLoader: AgentLoaderPlugin | null;
  conversationLoader: ConversationLoaderPlugin | null;
} {
  return server as unknown as {
    agentLoader: AgentLoaderPlugin | null;
    conversationLoader: ConversationLoaderPlugin | null;
  };
}

async function listedModels(server: OaiServer): Promise<string[]> {
  const res = await server.handle(new Request('http://x/v1/models'));
  const body = (await res.json()) as { data: Array<{ model?: string; id?: string }> };
  return body.data.map((e) => e.model ?? e.id ?? '');
}

const AGENT_SPEC = { model: 'anthropic/claude-haiku-4-5' } as const;

// ─── Static registration ──────────────────────────────────────────────────────

describe('createServer — agents become static model entries', () => {
  it('registers one entry per agent key and lists it on /v1/models', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC }, writer: { ...AGENT_SPEC } } });
    expect((await listedModels(server)).sort()).toEqual(['helper', 'writer']);
  });

  it('registers nothing when no agents are given', async () => {
    const server = createServer({});
    expect(await listedModels(server)).toEqual([]);
    expect(loadersOf(server).agentLoader).toBeNull();
    expect(loadersOf(server).conversationLoader).toBeNull();
  });

  it('reuses a prebuilt agent’s client for the static entry', async () => {
    const prebuilt = createAgent({ model: 'anthropic/claude-haiku-4-5' });
    const server = createServer({ agents: { pinned: { agent: prebuilt } } });
    const resolved = (
      server as unknown as { router: { resolve(m: string): { client: unknown } } }
    ).router.resolve('pinned');
    expect(resolved.client).toBe(prebuilt.client);
  });

  it('carries internalTools and allowExternalTools onto the entry', () => {
    const tool = { definition: { name: 'ping', description: 'p', parameters: {} }, execute: async () => 'pong' };
    const server = createServer({
      agents: { gated: { ...AGENT_SPEC, internalTools: [tool], allowExternalTools: false } },
    });
    const resolved = (
      server as unknown as {
        router: { resolve(m: string): { internalTools: unknown[]; allowExternalTools: boolean } };
      }
    ).router.resolve('gated');
    expect(resolved.internalTools).toEqual([tool]);
    expect(resolved.allowExternalTools).toBe(false);
  });

  it('leaves caller-supplied loaders in place when `agents` is absent', () => {
    const agentLoader: AgentLoaderPlugin = { load: async () => null };
    const conversationLoader: ConversationLoaderPlugin = {
      load: async () => null,
      save: async () => {},
    };
    const server = createServer({ agentLoader, conversationLoader });
    expect(loadersOf(server).agentLoader).toBe(agentLoader);
    expect(loadersOf(server).conversationLoader).toBe(conversationLoader);
  });
});

// ─── conversationLoader ───────────────────────────────────────────────────────

describe('createServer — built conversationLoader', () => {
  it('round-trips a history through persistence keyed by user + conversation', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    const cl = loadersOf(server).conversationLoader!;

    const history = new ConversationHistory('conv-1');
    history.append({ role: 'user', content: 'first turn' });
    await cl.save({ userId: 'u1', conversationId: 'c1' }, history);

    const loaded = await cl.load({ userId: 'u1', conversationId: 'c1' });
    expect(loaded).toBeInstanceOf(ConversationHistory);
    expect(loaded?.messages()).toEqual([{ role: 'user', content: 'first turn' }]);
  });

  it('stores under "<userId>:<conversationId>" in the server-conversations collection', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    const cl = loadersOf(server).conversationLoader!;
    await cl.save({ userId: 'u1', conversationId: 'c1' }, new ConversationHistory('h'));

    const collection = createCollection<HistorySnapshot>('server-conversations');
    expect(await collection.keys()).toEqual(['u1:c1']);
  });

  it('keys a null userId as "anon"', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    const cl = loadersOf(server).conversationLoader!;
    await cl.save({ userId: null, conversationId: 'c9' }, new ConversationHistory('h'));

    const collection = createCollection<HistorySnapshot>('server-conversations');
    expect(await collection.keys()).toEqual(['anon:c9']);
  });

  it('does not leak one user’s conversation into another user’s slot', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    const cl = loadersOf(server).conversationLoader!;
    const mine = new ConversationHistory('mine');
    mine.append({ role: 'user', content: 'secret' });
    await cl.save({ userId: 'u1', conversationId: 'c1' }, mine);

    expect(await cl.load({ userId: 'u2', conversationId: 'c1' })).toBeNull();
    expect(await cl.load({ userId: 'u1', conversationId: 'c2' })).toBeNull();
  });

  it('returns null for a conversation that was never saved', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    expect(await loadersOf(server).conversationLoader!.load({ userId: 'u', conversationId: 'nope' }))
      .toBeNull();
  });
});

// ─── agentLoader ──────────────────────────────────────────────────────────────

describe('createServer — built agentLoader', () => {
  it('returns null for a model that was never registered', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    expect(await loadersOf(server).agentLoader!.load({ userId: 'u', model: 'ghost' })).toBeNull();
  });

  it('returns the identical prebuilt agent on every load when the spec has one', async () => {
    const prebuilt = createAgent({ model: 'anthropic/claude-haiku-4-5' });
    const server = createServer({ agents: { pinned: { agent: prebuilt } } });
    const al = loadersOf(server).agentLoader!;
    const a = await al.load({ userId: 'u1', model: 'pinned', conversationId: 'c1' });
    const b = await al.load({ userId: 'u2', model: 'pinned', conversationId: 'c2' });
    expect(a).toBe(prebuilt);
    expect(b).toBe(prebuilt);
  });

  it('builds a distinct agent per load when the spec has no prebuilt agent', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    const al = loadersOf(server).agentLoader!;
    const a = (await al.load({ userId: 'u1', model: 'helper', conversationId: 'c1' })) as AgentLoop;
    const b = (await al.load({ userId: 'u1', model: 'helper', conversationId: 'c1' })) as AgentLoop;
    expect(a).not.toBe(b);
    expect(a.id).not.toBe(b.id);
  });

  it('hydrates the per-request agent with the persisted conversation history', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    const { agentLoader, conversationLoader } = loadersOf(server);
    const stored = new ConversationHistory('c1');
    stored.append({ role: 'user', content: 'remembered' });
    await conversationLoader!.save({ userId: 'u1', conversationId: 'c1' }, stored);

    const agent = (await agentLoader!.load({
      userId: 'u1',
      model: 'helper',
      conversationId: 'c1',
    })) as AgentLoop;
    expect(agent.history.messages()).toEqual([{ role: 'user', content: 'remembered' }]);
  });

  it('starts an empty history when nothing was persisted for that key', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    const agent = (await loadersOf(server).agentLoader!.load({
      userId: 'u1',
      model: 'helper',
      conversationId: 'fresh',
    })) as AgentLoop;
    expect(agent.history.messages()).toEqual([]);
  });

  it('falls back to conversationId "default" when the request carries none', async () => {
    const server = createServer({ agents: { helper: { ...AGENT_SPEC } } });
    const { agentLoader, conversationLoader } = loadersOf(server);
    const stored = new ConversationHistory('d');
    stored.append({ role: 'user', content: 'default-slot' });
    await conversationLoader!.save({ userId: 'u1', conversationId: 'default' }, stored);

    const agent = (await agentLoader!.load({ userId: 'u1', model: 'helper' })) as AgentLoop;
    expect(agent.history.messages()).toEqual([{ role: 'user', content: 'default-slot' }]);
  });
});

// ─── engine + responseStore wiring ────────────────────────────────────────────

describe('createServer — engine wiring', () => {
  it('adopts the ambient engine hooks when none are passed', () => {
    const server = createServer({});
    expect(server.hooks).toBe(coreRegistry.get().hooks);
  });

  it('an explicitly passed responseStore is used as-is', () => {
    const store = { marker: 'mine' } as unknown as never;
    const server = createServer({ responseStore: store });
    expect((server as unknown as { store: unknown }).store).toBe(store);
  });
});
