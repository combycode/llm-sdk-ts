/** Tool-name collision policy (openai-agents 0.14 `tool_name_collision_policy`).
 *
 *  Tools are registered in a map keyed by function name / builtin type, so two tools sharing a key
 *  meant one silently replaced the other and the model never saw it — surfacing much later as "the
 *  model called the wrong tool", with nothing in the logs pointing at the cause. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { LLMClient } from '../../../src/llm/client';
import type { AgentTool } from '../../../src/agent/types';
import type { WarningContext } from '../../../src/bus/hook-map';

const tool = (name: string, marker: string): AgentTool => ({
  definition: { type: 'function', name, description: marker, parameters: { type: 'object', properties: {} } },
  execute: async () => marker,
});

/** The loop never runs here — these tests only exercise tool registration — so a stub adapter that
 *  throws if used is enough, and proves the tests really are registration-only. */
const client = () =>
  new LLMClient({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'k',
    adapter: {
      name: 'mock',
      buildRequest: () => ({ body: {} }),
      parseResponse: () => {
        throw new Error('the model must not be called in a registration test');
      },
    },
    fetch: (() => Promise.reject(new Error('not called'))) as never,
  } as never);

describe("toolNameCollisionPolicy: 'warn' (default)", () => {
  it('keeps last-write-wins but says which tool lost', async () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push(w);
    });

    const loop = new AgentLoop({
      client: client(),
      hooks,
      tools: [tool('lookup', 'first'), tool('lookup', 'second')],
    });
    await new Promise((r) => setTimeout(r, 0)); // the warning is emitted async

    expect(loop.toolNames()).toEqual(['lookup']);
    const collision = warnings.find((w) => w.code === 'tool_name_collision');
    expect(collision).toBeDefined();
    expect(collision?.message).toContain('lookup');
    expect(collision?.details?.shadowed).toBe('function:lookup');
  });

  it('says nothing when there is no collision', async () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push(w);
    });

    new AgentLoop({ client: client(), hooks, tools: [tool('a', '1'), tool('b', '2')] });
    await new Promise((r) => setTimeout(r, 0));

    expect(warnings.filter((w) => w.code === 'tool_name_collision')).toHaveLength(0);
  });

  it('warns on a colliding addTool() too, not just at construction', async () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push(w);
    });

    const loop = new AgentLoop({ client: client(), hooks, tools: [tool('dup', 'first')] });
    loop.addTool(tool('dup', 'second'));
    await new Promise((r) => setTimeout(r, 0));

    expect(warnings.filter((w) => w.code === 'tool_name_collision')).toHaveLength(1);
  });

  it('does not warn when the SAME tool object is registered twice', async () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push(w);
    });

    const t = tool('same', 'x');
    const loop = new AgentLoop({ client: client(), hooks, tools: [t] });
    loop.addTool(t); // idempotent re-registration is not a collision
    await new Promise((r) => setTimeout(r, 0));

    expect(warnings.filter((w) => w.code === 'tool_name_collision')).toHaveLength(0);
  });
});

describe("toolNameCollisionPolicy: 'error'", () => {
  it('throws at construction, before the model is ever called', () => {
    expect(
      () =>
        new AgentLoop({
          client: client(),
          toolNameCollisionPolicy: 'error',
          tools: [tool('lookup', 'first'), tool('lookup', 'second')],
        }),
    ).toThrow(/two tools registered under "lookup"/);
  });

  it('throws from addTool() as well', () => {
    const loop = new AgentLoop({
      client: client(),
      toolNameCollisionPolicy: 'error',
      tools: [tool('dup', 'first')],
    });
    expect(() => loop.addTool(tool('dup', 'second'))).toThrow(/two tools registered/);
  });
});

describe('toolKey / describeTool — builtin tools', () => {
  const builtin = (type: string, marker: string): AgentTool => ({
    definition: { type } as never,
    execute: async () => marker,
  });

  it('a builtin is keyed by its TYPE, so two of the same type collide', async () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push(w);
    });
    const loop = new AgentLoop({
      client: client(),
      hooks,
      tools: [builtin('web_search', 'first'), builtin('web_search', 'second')],
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(loop.toolNames()).toEqual(['web_search']);
    const collision = warnings.find((w) => w.code === 'tool_name_collision');
    // The diagnostic names the KIND, because "a builtin shadowed a builtin" and
    // "a function shadowed a builtin" need different fixes.
    expect(collision?.details?.shadowed).toBe('builtin:web_search');
    expect(collision?.details?.winner).toBe('builtin:web_search');
  });

  it('a function tool shadowing a builtin is described as exactly that', async () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push(w);
    });
    new AgentLoop({
      client: client(),
      hooks,
      tools: [builtin('web_search', 'builtin'), tool('web_search', 'fn')],
    });
    await new Promise((r) => setTimeout(r, 0));

    const collision = warnings.find((w) => w.code === 'tool_name_collision');
    expect(collision?.details?.shadowed).toBe('builtin:web_search');
    expect(collision?.details?.winner).toBe('function:web_search');
  });

  it('builtins of different types do not collide', () => {
    const loop = new AgentLoop({
      client: client(),
      tools: [builtin('web_search', 'a'), builtin('code_interpreter', 'b')],
    });
    expect(loop.toolNames().sort()).toEqual(['code_interpreter', 'web_search']);
  });
});
