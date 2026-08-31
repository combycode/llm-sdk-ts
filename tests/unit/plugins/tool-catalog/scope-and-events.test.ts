/** ToolCatalog — per-agent scope management and the AgentBus event trail.
 *
 *  `getDefinition` is what an agent loop uses to build the tool list it sends
 *  to a model. It takes an OPTIONAL agentId, and the difference matters: with
 *  one, a tool outside that agent's scope must be invisible — otherwise the
 *  model is told about a tool that `call()` will then refuse, which reads to
 *  the model as an unexplained failure and to the operator as a leak of one
 *  agent's capabilities into another's prompt.
 */

import { describe, expect, it } from 'bun:test';
import { AgentBus } from '../../../../src/bus/agent-bus';
import { ToolCatalog } from '../../../../src/plugins/tool-catalog/catalog';
import { PermissionPolicy } from '../../../../src/plugins/permissions/policy';
import type { AgentEvent } from '../../../../src/bus/agent-bus';
import type { CatalogedTool, ToolContext } from '../../../../src/plugins/tool-catalog/types';

function makeTool(
  name: string,
  execute: CatalogedTool['execute'] = async () => 'ok',
  category: 'internal' | 'external' = 'internal',
): CatalogedTool {
  return {
    definition: { name, description: `does ${name}`, parameters: { type: 'object' } },
    category,
    declaredTargets: [],
    declaredActions: ['execute'],
    execute,
  };
}

describe('ToolCatalog — agent scope lifecycle', () => {
  it('getAgentScope reads back a normalised scope, with externalAllowed defaulted', () => {
    const c = new ToolCatalog();
    c.setAgentScope('a', { toolNames: ['x'] });

    expect(c.getAgentScope('a')).toEqual({
      toolNames: ['x'],
      externalAllowed: false,
      policy: undefined,
    });
  });

  it('getAgentScope keeps an explicit externalAllowed and the scope policy', () => {
    const policy = new PermissionPolicy([{ effect: 'allow' }]);
    const c = new ToolCatalog();
    c.setAgentScope('a', { toolNames: '*', externalAllowed: true, policy });

    const scope = c.getAgentScope('a');
    expect(scope?.externalAllowed).toBe(true);
    expect(scope?.policy).toBe(policy);
  });

  it('getAgentScope for an agent that has none is undefined, not an empty scope', () => {
    // The difference is load-bearing: `call()` treats "no scope" as a hard
    // denial, while an empty scope would be a scope that simply allows nothing.
    expect(new ToolCatalog().getAgentScope('nobody')).toBeUndefined();
  });

  it('setAgentScope replaces rather than merges', () => {
    const c = new ToolCatalog();
    c.setAgentScope('a', { toolNames: '*', externalAllowed: true });
    c.setAgentScope('a', { toolNames: ['x'] });
    expect(c.getAgentScope('a')).toEqual({
      toolNames: ['x'],
      externalAllowed: false,
      policy: undefined,
    });
  });

  it('removeAgentScope revokes every tool from that agent, and only that agent', async () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    c.setAgentScope('a', { toolNames: '*' });
    c.setAgentScope('b', { toolNames: '*' });

    c.removeAgentScope('a');

    expect(c.getAgentScope('a')).toBeUndefined();
    expect(c.visibleTo('a')).toEqual([]);
    await expect(c.call({ toolName: 't', source: 'a', input: {} })).rejects.toThrow(
      /no scope registered/,
    );
    // b is untouched.
    expect(c.visibleTo('b').map((d) => d.name)).toEqual(['t']);
  });

  it('removing a scope that was never set is harmless', () => {
    const c = new ToolCatalog();
    expect(() => c.removeAgentScope('nobody')).not.toThrow();
  });

  it('visibleTo for an agent without a scope is empty — default-deny', () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    expect(c.visibleTo('unknown-agent')).toEqual([]);
  });
});

describe('ToolCatalog — getDefinition', () => {
  it('without an agentId it reads the raw registration', () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    expect(c.getDefinition('t')).toEqual({
      name: 't',
      description: 'does t',
      parameters: { type: 'object' },
    });
  });

  it('an unregistered tool is undefined, with or without an agentId', () => {
    const c = new ToolCatalog();
    c.setAgentScope('a', { toolNames: '*' });
    expect(c.getDefinition('nope')).toBeUndefined();
    expect(c.getDefinition('nope', 'a')).toBeUndefined();
  });

  it('with an agentId it hides a tool outside that agent scope', () => {
    const c = new ToolCatalog();
    c.register(makeTool('allowed'));
    c.register(makeTool('secret'));
    c.setAgentScope('a', { toolNames: ['allowed'] });

    expect(c.getDefinition('allowed', 'a')?.name).toBe('allowed');
    expect(c.getDefinition('secret', 'a')).toBeUndefined();
    // ...but it is still there for an unscoped read.
    expect(c.getDefinition('secret')?.name).toBe('secret');
  });

  it('with an agentId that has no scope at all, everything is hidden', () => {
    const c = new ToolCatalog();
    c.register(makeTool('t'));
    expect(c.getDefinition('t', 'no-such-agent')).toBeUndefined();
  });

  it('hides an external tool from an agent that may not use them', () => {
    const c = new ToolCatalog();
    c.register(makeTool('ext', async () => 'ok', 'external'));
    c.setAgentScope('a', { toolNames: '*' });
    expect(c.getDefinition('ext', 'a')).toBeUndefined();

    c.setAgentScope('a', { toolNames: '*', externalAllowed: true });
    expect(c.getDefinition('ext', 'a')?.name).toBe('ext');
  });

  it('what getDefinition shows and what visibleTo lists always agree', () => {
    const c = new ToolCatalog();
    c.register(makeTool('a1'));
    c.register(makeTool('a2'));
    c.register(makeTool('ext', async () => 'ok', 'external'));
    c.setAgentScope('agent', { toolNames: ['a1', 'ext'] });

    const listed = c.visibleTo('agent').map((d) => d.name);
    expect(listed).toEqual(['a1']);
    for (const name of ['a1', 'a2', 'ext']) {
      expect(c.getDefinition(name, 'agent') !== undefined).toBe(listed.includes(name));
    }
  });
});

describe('ToolCatalog — search', () => {
  it('filters by description as well as name, case-insensitively', () => {
    const c = new ToolCatalog();
    c.register({
      ...makeTool('alpha'),
      definition: { name: 'alpha', description: 'Reads a FILE', parameters: {} },
    });
    c.register({
      ...makeTool('beta'),
      definition: { name: 'beta', description: 'writes a file', parameters: {} },
    });
    c.setAgentScope('a', { toolNames: '*' });

    expect(c.search({ description: 'file' }, 'a').map((d) => d.name).sort()).toEqual([
      'alpha',
      'beta',
    ]);
    expect(c.search({ description: 'READS' }, 'a').map((d) => d.name)).toEqual(['alpha']);
    expect(c.search({ name: 'ALPHA', description: 'file' }, 'a').map((d) => d.name)).toEqual([
      'alpha',
    ]);
  });

  it('an empty query returns everything visible', () => {
    const c = new ToolCatalog();
    c.register(makeTool('a'));
    c.register(makeTool('b'));
    c.setAgentScope('agent', { toolNames: ['a'] });
    expect(c.search({}, 'agent').map((d) => d.name)).toEqual(['a']);
    // No agentId at all → no scope filtering.
    expect(c.search({}).map((d) => d.name).sort()).toEqual(['a', 'b']);
  });

  it('an agentId with no scope finds nothing', () => {
    const c = new ToolCatalog();
    c.register(makeTool('a'));
    expect(c.search({}, 'ghost')).toEqual([]);
  });
});

describe('ToolCatalog — the AgentBus event trail', () => {
  function busCatalog(): { bus: AgentBus; events: AgentEvent[]; catalog: ToolCatalog } {
    const bus = new AgentBus();
    const events: AgentEvent[] = [];
    bus.on('tool.*', (e) => {
      events.push(e);
    });
    return { bus, events, catalog: new ToolCatalog({ bus }) };
  }

  it('a successful call emits started then completed, sharing one callId', async () => {
    const { events, catalog } = busCatalog();
    catalog.register(makeTool('t', async () => 'the answer'));
    catalog.setAgentScope('a', { toolNames: '*' });

    const result = await catalog.call({
      toolName: 't',
      source: 'a',
      input: { q: 1 },
      correlationId: 'corr-1',
    });

    expect(events.map((e) => e.kind)).toEqual(['tool.call.started', 'tool.call.completed']);
    const started = events[0].payload as Record<string, unknown>;
    const completed = events[1].payload as Record<string, unknown>;
    expect(started.callId).toBe(result.callId);
    expect(completed.callId).toBe(result.callId);
    expect(String(result.callId).startsWith('tc_')).toBe(true);
    expect(started.input).toEqual({ q: 1 });
    expect(completed.output).toBe('the answer');
    expect(events.every((e) => e.correlationId === 'corr-1')).toBe(true);
    expect(events.every((e) => e.source === 'a')).toBe(true);
  });

  it('a failing call emits started then failed, and still rethrows', async () => {
    const { events, catalog } = busCatalog();
    catalog.register(
      makeTool('t', async () => {
        throw new Error('tool blew up');
      }),
    );
    catalog.setAgentScope('a', { toolNames: '*' });

    await expect(catalog.call({ toolName: 't', source: 'a', input: {} })).rejects.toThrow(
      'tool blew up',
    );

    expect(events.map((e) => e.kind)).toEqual(['tool.call.started', 'tool.call.failed']);
    const failed = events[1].payload as Record<string, unknown>;
    expect(failed.error).toBe('tool blew up');
    expect(typeof failed.durationMs).toBe('number');
  });

  it('a call refused before the tool runs still leaves a started/failed trail', async () => {
    const { events, catalog } = busCatalog();
    catalog.register(makeTool('t'));

    await expect(catalog.call({ toolName: 't', source: 'no-scope', input: {} })).rejects.toThrow();

    // An access denial is auditable, not silent.
    expect(events.map((e) => e.kind)).toEqual(['tool.call.started', 'tool.call.failed']);
    expect((events[1].payload as Record<string, unknown>).error).toContain('no scope registered');
  });

  it('two calls get distinct callIds', async () => {
    const { events, catalog } = busCatalog();
    catalog.register(makeTool('t'));
    catalog.setAgentScope('a', { toolNames: '*' });

    const first = await catalog.call({ toolName: 't', source: 'a', input: {} });
    const second = await catalog.call({ toolName: 't', source: 'a', input: {} });

    expect(first.callId).not.toBe(second.callId);
    expect(events).toHaveLength(4);
  });

  it('ctx.emit publishes a tool-authored event under the calling agent identity', async () => {
    const { bus, catalog } = busCatalog();
    const custom: AgentEvent[] = [];
    bus.on('progress.*', (e) => {
      custom.push(e);
    });
    catalog.register(
      makeTool('t', async (_input, ctx: ToolContext) => {
        await ctx.emit('progress.update', { percent: 50 });
        return 'done';
      }),
    );
    catalog.setAgentScope('a', { toolNames: '*' });

    await catalog.call({ toolName: 't', source: 'a', input: {}, correlationId: 'corr-9' });

    expect(custom).toHaveLength(1);
    expect(custom[0].kind).toBe('progress.update');
    expect(custom[0].source).toBe('a');
    expect(custom[0].correlationId).toBe('corr-9');
    expect(custom[0].payload).toEqual({ percent: 50 });
  });

  it('without a bus, ctx.emit is a silent no-op and the call still succeeds', async () => {
    const catalog = new ToolCatalog();
    catalog.register(
      makeTool('t', async (_input, ctx: ToolContext) => {
        await ctx.emit('progress.update', { percent: 50 });
        return 'done';
      }),
    );
    catalog.setAgentScope('a', { toolNames: '*' });

    const result = await catalog.call({ toolName: 't', source: 'a', input: {} });
    expect(result.output).toBe('done');
  });

  it('a scope policy overrides the catalog default policy', async () => {
    const denyAll = new PermissionPolicy([{ effect: 'deny' }]);
    const allowAll = new PermissionPolicy([{ effect: 'allow' }]);
    const catalog = new ToolCatalog({ policy: denyAll });
    catalog.register(
      makeTool('t', async (_input, ctx: ToolContext) => {
        ctx.checkAccess({ kind: 'fs', path: '/tmp/x' }, 'read');
        return 'ok';
      }),
    );

    catalog.setAgentScope('strict', { toolNames: '*' });
    await expect(catalog.call({ toolName: 't', source: 'strict', input: {} })).rejects.toThrow(
      /denied/i,
    );

    catalog.setAgentScope('trusted', { toolNames: '*', policy: allowAll });
    await expect(catalog.call({ toolName: 't', source: 'trusted', input: {} })).resolves
      .toMatchObject({ output: 'ok' });
  });

  it('a thrown string is reported verbatim on the failure event', async () => {
    const { events, catalog } = busCatalog();
    catalog.register(
      makeTool('t', async () => {
        throw 'plain string failure';
      }),
    );
    catalog.setAgentScope('a', { toolNames: '*' });

    await expect(catalog.call({ toolName: 't', source: 'a', input: {} })).rejects.toBeDefined();
    expect(events[1].kind).toBe('tool.call.failed');
    expect((events[1].payload as Record<string, unknown>).error).toBe('plain string failure');
  });

  it('a thrown plain object degrades to "[object Object]" rather than crashing the trail', async () => {
    // `(err as Error).message ?? String(err)` has no useful branch for a bare
    // object. Worth knowing when reading a failure event: the diagnostic value
    // is in the rethrown error, not in the event payload.
    const { events, catalog } = busCatalog();
    catalog.register(
      makeTool('t', async () => {
        throw { code: 'E_WEIRD' };
      }),
    );
    catalog.setAgentScope('a', { toolNames: '*' });

    await expect(catalog.call({ toolName: 't', source: 'a', input: {} })).rejects.toBeDefined();
    expect(events[1].kind).toBe('tool.call.failed');
    expect((events[1].payload as Record<string, unknown>).error).toBe('[object Object]');
  });
});
