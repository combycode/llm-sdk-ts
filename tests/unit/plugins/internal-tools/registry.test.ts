import { describe, expect, it } from 'bun:test';
import { LocalBackend } from '../../../../src/plugins/internal-tools/backends/local';
import { ToolRegistry } from '../../../../src/plugins/internal-tools/registry';
import type { InternalTool, ToolBackend } from '../../../../src/plugins/internal-tools/types';
import type { ModelCatalog } from '../../../../src/catalog/catalog';

function makeTool(id: string, extra: Partial<InternalTool> = {}): InternalTool {
  const [ns, rest] = id.split(':');
  const [name, version] = (rest ?? '').split('@');
  return {
    id,
    namespace: ns,
    name,
    version,
    description: `tool ${id}`,
    inputSchema: { type: 'object' },
    execute: async () => 'ok',
    ...extra,
  };
}

/** A backend whose list() is scripted and whose calls are counted. */
function stubBackend(name: string, tools: InternalTool[]) {
  const backend = {
    name,
    calls: 0,
    getCalls: 0,
    async list() {
      backend.calls++;
      return tools;
    },
    async get(id: string) {
      backend.getCalls++;
      return tools.find((t) => t.id === id) ?? null;
    },
  };
  return backend as ToolBackend & { calls: number; getCalls: number };
}

/** Minimal ModelCatalog double — only `get` and `list` are consulted. */
function stubCatalog(
  models: Array<{
    provider: string;
    model: string;
    toolCompat?: Record<string, { score: number }>;
  }>,
): ModelCatalog {
  return {
    get: (provider: string, model: string) =>
      models.find((m) => m.provider === provider && m.model === model) ?? null,
    list: () => models,
  } as unknown as ModelCatalog;
}

describe('ToolRegistry — backends', () => {
  it('addBackend returns this for chaining', () => {
    const r = new ToolRegistry();
    expect(r.addBackend(stubBackend('a', []))).toBe(r);
  });

  it('rejects a second backend with the same name', () => {
    const r = new ToolRegistry();
    r.addBackend(stubBackend('local', []));
    expect(() => r.addBackend(stubBackend('local', []))).toThrow(
      'Backend "local" already registered',
    );
  });

  it('allows two backends with different names', async () => {
    const r = new ToolRegistry()
      .addBackend(stubBackend('a', [makeTool('ns:x@1.0.0')]))
      .addBackend(stubBackend('b', [makeTool('ns:y@1.0.0')]));
    expect((await r.list()).map((t) => t.id).sort()).toEqual(['ns:x@1.0.0', 'ns:y@1.0.0']);
  });

  it('removeBackend returns true and drops its tools from subsequent reads', async () => {
    const r = new ToolRegistry()
      .addBackend(stubBackend('a', [makeTool('ns:x@1.0.0')]))
      .addBackend(stubBackend('b', [makeTool('ns:y@1.0.0')]));
    await r.list();
    expect(r.removeBackend('a')).toBe(true);
    expect((await r.list()).map((t) => t.id)).toEqual(['ns:y@1.0.0']);
  });

  it('removeBackend returns false for an unknown name and keeps the others', async () => {
    const r = new ToolRegistry().addBackend(stubBackend('a', [makeTool('ns:x@1.0.0')]));
    expect(r.removeBackend('nope')).toBe(false);
    expect(await r.list()).toHaveLength(1);
  });

  it('first-added backend wins on an id conflict', async () => {
    const r = new ToolRegistry()
      .addBackend(stubBackend('first', [makeTool('ns:x@1.0.0', { description: 'from-first' })]))
      .addBackend(stubBackend('second', [makeTool('ns:x@1.0.0', { description: 'from-second' })]));
    expect((await r.get('ns:x@1.0.0'))?.description).toBe('from-first');
    expect(await r.list()).toHaveLength(1);
  });
});

describe('ToolRegistry — caching', () => {
  it('lists each backend exactly once and reuses the cache afterwards', async () => {
    const b = stubBackend('a', [makeTool('ns:x@1.0.0')]);
    const r = new ToolRegistry().addBackend(b);
    await r.list();
    await r.list();
    await r.get('ns:x@1.0.0');
    expect(b.calls).toBe(1);
  });

  it('invalidate() forces the next read to re-query the backends', async () => {
    const b = stubBackend('a', [makeTool('ns:x@1.0.0')]);
    const r = new ToolRegistry().addBackend(b);
    await r.list();
    r.invalidate();
    await r.list();
    expect(b.calls).toBe(2);
  });

  it('addBackend invalidates the cache so new tools appear', async () => {
    const r = new ToolRegistry().addBackend(stubBackend('a', [makeTool('ns:x@1.0.0')]));
    expect(await r.list()).toHaveLength(1);
    r.addBackend(stubBackend('b', [makeTool('ns:y@1.0.0')]));
    expect(await r.list()).toHaveLength(2);
  });

  it('removeBackend invalidates the cache', async () => {
    const b = stubBackend('a', [makeTool('ns:x@1.0.0')]);
    const r = new ToolRegistry().addBackend(b);
    await r.list();
    r.removeBackend('a');
    expect(await r.list()).toEqual([]);
  });
});

describe('ToolRegistry — get / list', () => {
  it('get returns the tool for a known id', async () => {
    const tool = makeTool('ns:x@1.0.0');
    const r = new ToolRegistry().addBackend(stubBackend('a', [tool]));
    expect(await r.get('ns:x@1.0.0')).toBe(tool);
  });

  it('answers get() from its own cache — it never delegates to backend.get()', async () => {
    const b = stubBackend('a', [makeTool('ns:x@1.0.0')]);
    const r = new ToolRegistry().addBackend(b);
    const viaRegistry = await r.get('ns:x@1.0.0');
    expect(b.getCalls).toBe(0);
    // the backend can still answer directly, and yields the very same instance
    expect(viaRegistry).toBe(await b.get('ns:x@1.0.0'));
    expect(b.getCalls).toBe(1);
  });

  it('get returns null for an unknown id', async () => {
    const r = new ToolRegistry().addBackend(stubBackend('a', [makeTool('ns:x@1.0.0')]));
    expect(await r.get('ns:missing@1.0.0')).toBeNull();
  });

  it('list on a registry with no backends is empty', async () => {
    expect(await new ToolRegistry().list()).toEqual([]);
  });

  it('works with the real LocalBackend', async () => {
    const local = new LocalBackend();
    local.register(makeTool('orxa:a@1.0.0'));
    const r = new ToolRegistry().addBackend(local);
    expect((await r.list()).map((t) => t.id)).toEqual(['orxa:a@1.0.0']);
  });
});

describe('ToolRegistry — find', () => {
  const tools = [
    makeTool('orxa:a@1.0.0', { tags: ['fast', 'text'] }),
    makeTool('orxa:b@1.0.0', { tags: ['slow'] }),
    makeTool('other:c@1.0.0', { tags: ['fast'] }),
    makeTool('other:d@1.0.0'),
  ];
  const registry = () => new ToolRegistry().addBackend(stubBackend('a', tools));

  it('returns everything for an empty filter', async () => {
    expect(await registry().find({})).toHaveLength(4);
  });

  it('filters by namespace', async () => {
    const found = await registry().find({ namespace: 'orxa' });
    expect(found.map((t) => t.id)).toEqual(['orxa:a@1.0.0', 'orxa:b@1.0.0']);
  });

  it('filters by id prefix', async () => {
    const found = await registry().find({ prefix: 'other:' });
    expect(found.map((t) => t.id)).toEqual(['other:c@1.0.0', 'other:d@1.0.0']);
  });

  it('filters by tag, excluding tools with no tags at all', async () => {
    const found = await registry().find({ tag: 'fast' });
    expect(found.map((t) => t.id)).toEqual(['orxa:a@1.0.0', 'other:c@1.0.0']);
  });

  it('ANDs multiple filter fields', async () => {
    const found = await registry().find({ namespace: 'orxa', tag: 'fast' });
    expect(found.map((t) => t.id)).toEqual(['orxa:a@1.0.0']);
  });

  it('returns nothing when a filter matches no tool', async () => {
    expect(await registry().find({ namespace: 'nobody' })).toEqual([]);
    expect(await registry().find({ prefix: 'zzz' })).toEqual([]);
    expect(await registry().find({ tag: 'zzz' })).toEqual([]);
  });
});

describe('ToolRegistry — find with a model filter', () => {
  const tools = [
    makeTool('orxa:good@1.0.0'),
    makeTool('orxa:weak@1.0.0'),
    makeTool('orxa:untested@1.0.0'),
  ];
  const catalog = stubCatalog([
    {
      provider: 'openai',
      model: 'gpt-x',
      toolCompat: {
        'orxa:good@1.0.0': { score: 0.9 },
        'orxa:weak@1.0.0': { score: 0.5 },
      },
    },
  ]);
  const registry = () => new ToolRegistry().addBackend(stubBackend('a', tools));

  it('keeps only tools scoring at or above the default 0.8 threshold', async () => {
    const found = await registry().find({ model: { provider: 'openai', model: 'gpt-x' } }, catalog);
    expect(found.map((t) => t.id)).toEqual(['orxa:good@1.0.0']);
  });

  it('honours an explicit minScore', async () => {
    const found = await registry().find(
      { model: { provider: 'openai', model: 'gpt-x', minScore: 0.4 } },
      catalog,
    );
    expect(found.map((t) => t.id)).toEqual(['orxa:good@1.0.0', 'orxa:weak@1.0.0']);
  });

  it('treats a score exactly at minScore as passing', async () => {
    const found = await registry().find(
      { model: { provider: 'openai', model: 'gpt-x', minScore: 0.9 } },
      catalog,
    );
    expect(found.map((t) => t.id)).toEqual(['orxa:good@1.0.0']);
  });

  it('excludes tools the model has no compat record for', async () => {
    const found = await registry().find(
      { model: { provider: 'openai', model: 'gpt-x', minScore: 0 } },
      catalog,
    );
    expect(found.map((t) => t.id)).not.toContain('orxa:untested@1.0.0');
  });

  it('excludes every tool when the model is absent from the catalog', async () => {
    const found = await registry().find(
      { model: { provider: 'openai', model: 'unknown' } },
      catalog,
    );
    expect(found).toEqual([]);
  });

  it('ignores the model filter entirely when no catalog is supplied', async () => {
    const found = await registry().find({ model: { provider: 'openai', model: 'gpt-x' } });
    expect(found).toHaveLength(3);
  });
});

describe('ToolRegistry — search', () => {
  const tools = [
    makeTool('orxa:summarize@1.0.0', {
      description: 'compact long content',
      tags: ['compaction'],
    }),
    makeTool('orxa:summarizer-pro@1.0.0', { description: 'nothing here', tags: [] }),
    makeTool('orxa:presummarize@1.0.0', { description: 'nothing here', tags: [] }),
    makeTool('orxa:tagexact@1.0.0', { description: 'nothing here', tags: ['summarize'] }),
    makeTool('orxa:tagpartial@1.0.0', { description: 'nothing here', tags: ['xsummarizex'] }),
    makeTool('orxa:descmatch@1.0.0', { description: 'a summarize helper', tags: [] }),
    makeTool('other:unrelated@1.0.0', { description: 'nothing here', tags: [] }),
  ];
  const registry = () => new ToolRegistry().addBackend(stubBackend('a', tools));

  it('ranks exact name > prefix > substring > exact tag > partial tag > description', async () => {
    const found = await registry().search('summarize');
    expect(found.map((t) => t.name)).toEqual([
      'summarize',
      'summarizer-pro',
      'presummarize',
      'tagexact',
      'tagpartial',
      'descmatch',
    ]);
  });

  it('drops tools that match nothing', async () => {
    const found = await registry().search('summarize');
    expect(found.map((t) => t.id)).not.toContain('other:unrelated@1.0.0');
  });

  it('is case-insensitive and trims the query', async () => {
    const found = await registry().search('  SUMMARIZE  ');
    expect(found[0]?.name).toBe('summarize');
  });

  it('returns everything (capped) for a blank query without scoring', async () => {
    const found = await registry().search('   ');
    expect(found).toHaveLength(7);
  });

  it('applies the limit to a blank query', async () => {
    expect(await registry().search('', { limit: 2 })).toHaveLength(2);
  });

  it('defaults the limit to 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) => makeTool(`ns:t${i}@1.0.0`));
    const r = new ToolRegistry().addBackend(stubBackend('a', many));
    expect(await r.search('')).toHaveLength(20);
  });

  it('applies the limit to a scored query', async () => {
    const found = await registry().search('summarize', { limit: 2 });
    expect(found.map((t) => t.name)).toEqual(['summarize', 'summarizer-pro']);
  });

  it('restricts a scored query to one namespace', async () => {
    const found = await registry().search('unrelated', { namespace: 'orxa' });
    expect(found).toEqual([]);
    expect(await registry().search('unrelated', { namespace: 'other' })).toHaveLength(1);
  });

  it('does NOT apply the namespace option to a blank query', async () => {
    expect(await registry().search('', { namespace: 'orxa' })).toHaveLength(7);
  });
});

describe('ToolRegistry — modelsFor', () => {
  it('returns an empty list when no catalog is available', () => {
    expect(new ToolRegistry().modelsFor('orxa:a@1.0.0')).toEqual([]);
    expect(new ToolRegistry().modelsFor('orxa:a@1.0.0', { minScore: 0 })).toEqual([]);
  });

  it('returns "provider/model" for every model at or above the default 0.8', () => {
    const catalog = stubCatalog([
      { provider: 'openai', model: 'good', toolCompat: { 'orxa:a@1.0.0': { score: 0.95 } } },
      { provider: 'google', model: 'edge', toolCompat: { 'orxa:a@1.0.0': { score: 0.8 } } },
      { provider: 'anthropic', model: 'weak', toolCompat: { 'orxa:a@1.0.0': { score: 0.79 } } },
      { provider: 'xai', model: 'othertool', toolCompat: { 'orxa:b@1.0.0': { score: 1 } } },
      { provider: 'mistral', model: 'nocompat' },
    ]);
    expect(new ToolRegistry().modelsFor('orxa:a@1.0.0', { catalog })).toEqual([
      'openai/good',
      'google/edge',
    ]);
  });

  it('honours an explicit minScore', () => {
    const catalog = stubCatalog([
      { provider: 'openai', model: 'good', toolCompat: { 'orxa:a@1.0.0': { score: 0.95 } } },
      { provider: 'anthropic', model: 'weak', toolCompat: { 'orxa:a@1.0.0': { score: 0.5 } } },
    ]);
    expect(new ToolRegistry().modelsFor('orxa:a@1.0.0', { minScore: 0.4, catalog })).toEqual([
      'openai/good',
      'anthropic/weak',
    ]);
  });

  it('returns an empty list when the catalog has no models', () => {
    expect(new ToolRegistry().modelsFor('orxa:a@1.0.0', { catalog: stubCatalog([]) })).toEqual([]);
  });
});
