import { describe, expect, it } from 'bun:test';
import { LocalBackend } from '../../../../src/plugins/internal-tools/backends/local';
import type { InternalTool } from '../../../../src/plugins/internal-tools/types';

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

describe('LocalBackend — identity', () => {
  it('reports the backend name "local"', () => {
    expect(new LocalBackend().name).toBe('local');
  });

  it('starts empty', () => {
    expect(new LocalBackend().size).toBe(0);
  });
});

describe('LocalBackend — register', () => {
  it('stores the tool and returns this for chaining', () => {
    const b = new LocalBackend();
    const returned = b.register(makeTool('orxa:a@1.0.0'));
    expect(returned).toBe(b);
    expect(b.size).toBe(1);
  });

  it('chains multiple registrations', () => {
    const b = new LocalBackend()
      .register(makeTool('orxa:a@1.0.0'))
      .register(makeTool('orxa:b@1.0.0'));
    expect(b.size).toBe(2);
  });

  it('refuses to overwrite an existing id and points at replace()', () => {
    const b = new LocalBackend();
    b.register(makeTool('orxa:a@1.0.0'));
    expect(() => b.register(makeTool('orxa:a@1.0.0'))).toThrow(
      'Tool orxa:a@1.0.0 already registered. Use replace() to overwrite.',
    );
    expect(b.size).toBe(1);
  });

  it('treats different versions of the same name as distinct tools', () => {
    const b = new LocalBackend();
    b.register(makeTool('orxa:a@1.0.0'));
    b.register(makeTool('orxa:a@2.0.0'));
    expect(b.size).toBe(2);
  });
});

describe('LocalBackend — replace', () => {
  it('overwrites an existing tool without throwing', async () => {
    const b = new LocalBackend();
    b.register(makeTool('orxa:a@1.0.0', { description: 'first' }));
    const returned = b.replace(makeTool('orxa:a@1.0.0', { description: 'second' }));
    expect(returned).toBe(b);
    expect(b.size).toBe(1);
    expect((await b.get('orxa:a@1.0.0'))?.description).toBe('second');
  });

  it('inserts when the id is not yet present', async () => {
    const b = new LocalBackend();
    b.replace(makeTool('orxa:a@1.0.0'));
    expect(b.size).toBe(1);
    expect(await b.get('orxa:a@1.0.0')).not.toBeNull();
  });
});

describe('LocalBackend — unregister', () => {
  it('returns true and removes the tool when present', async () => {
    const b = new LocalBackend();
    b.register(makeTool('orxa:a@1.0.0'));
    expect(b.unregister('orxa:a@1.0.0')).toBe(true);
    expect(b.size).toBe(0);
    expect(await b.get('orxa:a@1.0.0')).toBeNull();
  });

  it('returns false for an unknown id and leaves the store untouched', () => {
    const b = new LocalBackend();
    b.register(makeTool('orxa:a@1.0.0'));
    expect(b.unregister('orxa:missing@1.0.0')).toBe(false);
    expect(b.size).toBe(1);
  });
});

describe('LocalBackend — async access', () => {
  it('list returns every registered tool', async () => {
    const b = new LocalBackend();
    b.register(makeTool('orxa:a@1.0.0'));
    b.register(makeTool('orxa:b@1.0.0'));
    const ids = (await b.list()).map((t) => t.id);
    expect(ids).toEqual(['orxa:a@1.0.0', 'orxa:b@1.0.0']);
  });

  it('list returns a snapshot array, not the live store', async () => {
    const b = new LocalBackend();
    b.register(makeTool('orxa:a@1.0.0'));
    const first = await b.list();
    first.pop();
    expect(b.size).toBe(1);
    expect(await b.list()).toHaveLength(1);
  });

  it('list is empty for a fresh backend', async () => {
    expect(await new LocalBackend().list()).toEqual([]);
  });

  it('get returns the tool by id', async () => {
    const b = new LocalBackend();
    const tool = makeTool('orxa:a@1.0.0');
    b.register(tool);
    expect(await b.get('orxa:a@1.0.0')).toBe(tool);
  });

  it('get returns null (not undefined) for an unknown id', async () => {
    expect(await new LocalBackend().get('orxa:nope@1.0.0')).toBeNull();
  });
});
