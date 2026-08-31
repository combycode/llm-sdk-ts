/** The two shipped ContextTools adapters.
 *
 *  ContextTools is the seam between a compaction policy and whatever can
 *  actually summarise text. Two things must hold or a compaction silently
 *  destroys a conversation:
 *
 *    - the no-op adapter returns an EMPTY summary, never a plausible-looking
 *      one, so the strategy takes its documented placeholder path;
 *    - the runner-backed adapter returns '' / [] when the tool answers with a
 *      malformed payload, rather than letting `undefined` reach the caller.
 */

import { describe, expect, it } from 'bun:test';
import {
  NoopContextTools,
  RunnerContextTools,
} from '../../../../src/plugins/context-guard/types';
import type { ContextTools } from '../../../../src/plugins/context-guard/types';
import type { ExtractedFact } from '../../../../src/plugins/context-guard/facts';

type RunArgs = { toolId: string; input: unknown };

function fakeRunner(opts: {
  result?: unknown;
  registered?: string[];
}): {
  runner: {
    run<T>(toolId: string, input: unknown): Promise<T>;
    registry: { get(toolId: string): Promise<unknown> };
  };
  calls: RunArgs[];
  lookups: string[];
} {
  const calls: RunArgs[] = [];
  const lookups: string[] = [];
  const registered = opts.registered ?? null;
  return {
    calls,
    lookups,
    runner: {
      async run<T>(toolId: string, input: unknown): Promise<T> {
        calls.push({ toolId, input });
        return opts.result as T;
      },
      registry: {
        async get(toolId: string): Promise<unknown> {
          lookups.push(toolId);
          if (registered === null) return { id: toolId };
          return registered.includes(toolId) ? { id: toolId } : undefined;
        },
      },
    },
  };
}

describe('NoopContextTools', () => {
  it('summarises to the empty string so callers take their placeholder path', async () => {
    const noop: ContextTools = new NoopContextTools();
    expect(await noop.summarize('anything', 100)).toBe('');
  });

  it('extracts no facts', async () => {
    const noop: ContextTools = new NoopContextTools();
    expect(await noop.extractFacts('anything')).toEqual([]);
  });
});

describe('RunnerContextTools — summarize', () => {
  it('runs the built-in summarize tool and returns its summary field', async () => {
    const { runner, calls } = fakeRunner({ result: { summary: 'the gist' } });
    const tools = new RunnerContextTools({ runner });

    expect(await tools.summarize('long text', 300, 'decisions')).toBe('the gist');
    expect(calls).toEqual([
      {
        toolId: 'orxa:summarize@1.0.0',
        input: { content: 'long text', maxLength: 300, focus: 'decisions' },
      },
    ]);
  });

  it('honours a custom summarize tool id', async () => {
    const { runner, calls } = fakeRunner({ result: { summary: 's' } });
    const tools = new RunnerContextTools({ runner, summarizeId: 'acme:brief@2' });

    await tools.summarize('text', 100);

    expect(calls[0].toolId).toBe('acme:brief@2');
    expect(calls[0].input).toEqual({ content: 'text', maxLength: 100, focus: undefined });
  });

  it('a tool answering without a summary field yields "" — never undefined', async () => {
    const { runner } = fakeRunner({ result: {} });
    expect(await new RunnerContextTools({ runner }).summarize('text', 100)).toBe('');
  });

  it('a tool answering with nothing at all yields "" rather than throwing', async () => {
    const { runner } = fakeRunner({ result: null });
    expect(await new RunnerContextTools({ runner }).summarize('text', 100)).toBe('');
  });
});

describe('RunnerContextTools — extractFacts', () => {
  const facts: ExtractedFact[] = [{ key: 'city', value: 'Prague', category: 'name' }];

  it('checks the registry first, then runs the fact-extract tool', async () => {
    const { runner, calls, lookups } = fakeRunner({
      result: { facts },
      registered: ['orxa:fact-extract@1.0.0'],
    });
    const tools = new RunnerContextTools({ runner });

    expect(await tools.extractFacts('text', ['name'])).toEqual(facts);
    expect(lookups).toEqual(['orxa:fact-extract@1.0.0']);
    expect(calls).toEqual([
      {
        toolId: 'orxa:fact-extract@1.0.0',
        input: { content: 'text', categories: ['name'] },
      },
    ]);
  });

  it('returns [] without running anything when the tool is not registered', async () => {
    // fact-extract ships in extensions/, not core — its absence is normal.
    const { runner, calls } = fakeRunner({ result: { facts }, registered: [] });

    expect(await new RunnerContextTools({ runner }).extractFacts('text')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('honours a custom fact-extract tool id for both lookup and run', async () => {
    const { runner, calls, lookups } = fakeRunner({
      result: { facts },
      registered: ['acme:facts@3'],
    });
    const tools = new RunnerContextTools({ runner, factExtractId: 'acme:facts@3' });

    expect(await tools.extractFacts('text')).toEqual(facts);
    expect(lookups).toEqual(['acme:facts@3']);
    expect(calls[0].toolId).toBe('acme:facts@3');
  });

  it('a tool answering without a facts field yields [] — never undefined', async () => {
    const { runner } = fakeRunner({ result: {} });
    expect(await new RunnerContextTools({ runner }).extractFacts('text')).toEqual([]);
  });

  it('a tool answering with nothing at all yields [] rather than throwing', async () => {
    const { runner } = fakeRunner({ result: undefined });
    expect(await new RunnerContextTools({ runner }).extractFacts('text')).toEqual([]);
  });
});
