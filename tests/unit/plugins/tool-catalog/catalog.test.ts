import { describe, expect, it } from 'bun:test';
import { ToolCatalog } from '../../../../src/plugins/tool-catalog/catalog';
import {
  NoToolAccess,
  PermissionDenied,
  ToolNotFound,
  ToolRegistrationError,
} from '../../../../src/plugins/tool-catalog/errors';
import { PermissionPolicy } from '../../../../src/plugins/permissions/policy';

function makeTool(name: string, fn: () => unknown = () => 'ok') {
  return {
    definition: { name, description: 'd', parameters: { type: 'object' } },
    category: 'internal' as const,
    declaredTargets: [],
    declaredActions: ['execute'],
    execute: async () => fn(),
  };
}

describe('ToolCatalog — registration', () => {
  it('register and has', () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    expect(c.has('t')).toBe(true);
  });

  it('rejects duplicate', () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    expect(() => c.register(makeTool('t'))).toThrow(ToolRegistrationError);
  });

  it('rejects bad shape', () => {
    const c = new ToolCatalog();
    expect(() => c.register({ ...makeTool('x'), declaredActions: [] })).toThrow();
  });

  it('unregister removes', () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    expect(c.unregister('t')).toBe(true);
    expect(c.has('t')).toBe(false);
  });
});

describe('ToolCatalog — scopes & visibility', () => {
  it('visibleTo returns scoped tools', () => {
    const c = new ToolCatalog();
    c.register(makeTool('a'));
    c.register(makeTool('b'));
    c.setAgentScope('agent-1', { toolNames: ['a'] });
    expect(c.visibleTo('agent-1').map((d) => d.name)).toEqual(['a']);
  });

  it('* scope returns all internal tools', () => {
    const c = new ToolCatalog();
    c.register(makeTool('a'));
    c.register(makeTool('b'));
    c.setAgentScope('agent-1', { toolNames: '*' });
    expect(c.visibleTo('agent-1').length).toBe(2);
  });

  it('external tools hidden unless externalAllowed', () => {
    const c = new ToolCatalog();
    c.register({ ...makeTool('ext'), category: 'external' });
    c.setAgentScope('agent-1', { toolNames: '*' });
    expect(c.visibleTo('agent-1').length).toBe(0);
    c.setAgentScope('agent-1', { toolNames: '*', externalAllowed: true });
    expect(c.visibleTo('agent-1').length).toBe(1);
  });

  it('search filters by name substring', () => {
    const c = new ToolCatalog();
    c.register(makeTool('lookup_data'));
    c.register(makeTool('lookup_meta'));
    c.register(makeTool('compute'));
    c.setAgentScope('a', { toolNames: '*' });
    expect(c.search({ name: 'lookup' }, 'a').length).toBe(2);
  });
});

describe('ToolCatalog — call', () => {
  it('runs a tool with valid scope', async () => {
    const c = new ToolCatalog();
    c.register(makeTool('t', () => 'result'));
    c.setAgentScope('agent-1', { toolNames: '*' });
    const res = await c.call({ toolName: 't', source: 'agent-1', input: {} });
    expect(res.output).toBe('result');
  });

  it('throws ToolNotFound for unknown', async () => {
    const c = new ToolCatalog();
    c.setAgentScope('a', { toolNames: '*' });
    await expect(c.call({ toolName: 'nope', source: 'a', input: {} })).rejects.toThrow(
      ToolNotFound,
    );
  });

  it('throws NoToolAccess when scope missing', async () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    await expect(c.call({ toolName: 't', source: 'a', input: {} })).rejects.toThrow(NoToolAccess);
  });

  it('throws NoToolAccess for tool not in scope', async () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    c.setAgentScope('a', { toolNames: ['other'] });
    await expect(c.call({ toolName: 't', source: 'a', input: {} })).rejects.toThrow(NoToolAccess);
  });

  it('checkAccess raises PermissionDenied when no policy', async () => {
    const c = new ToolCatalog();
    c.register({
      ...makeTool('t'),
      execute: async (_input, ctx) => {
        ctx.checkAccess({ kind: 'fs', path: '/' }, 'read');
        return 'ok';
      },
    });
    c.setAgentScope('a', { toolNames: '*' });
    await expect(c.call({ toolName: 't', source: 'a', input: {} })).rejects.toThrow(
      PermissionDenied,
    );
  });

  it('checkAccess succeeds when policy allows', async () => {
    const policy = new PermissionPolicy([{ effect: 'allow' }]);
    const c = new ToolCatalog({ policy });
    c.register({
      ...makeTool('t'),
      execute: async (_input, ctx) => {
        ctx.checkAccess({ kind: 'fs', path: '/' }, 'read');
        return 'ok';
      },
    });
    c.setAgentScope('a', { toolNames: '*' });
    await expect(c.call({ toolName: 't', source: 'a', input: {} })).resolves.toMatchObject({
      output: 'ok',
    });
  });
});
