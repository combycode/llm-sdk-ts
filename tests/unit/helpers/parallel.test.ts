/** parallel — fan-out helper tests. */

import { describe, expect, it } from 'bun:test';
import { parallel } from '../../../src/helpers/parallel';

describe('parallel', () => {
  it('fans the input out to every step and returns outputs in step order', async () => {
    const fn = parallel([
      async (input) => `A:${input}`,
      async (input) => `B:${input}`,
      async (input) => `C:${input}`,
    ]);
    const out = await fn('hi');
    expect(out).toEqual(['A:hi', 'B:hi', 'C:hi']);
  });

  it('runs steps concurrently (total time ≈ slowest step, not sum)', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const start = Date.now();
    const fn = parallel([
      async () => {
        await sleep(60);
        return 'a';
      },
      async () => {
        await sleep(60);
        return 'b';
      },
      async () => {
        await sleep(60);
        return 'c';
      },
    ]);
    await fn('x');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(150); // concurrent: ~60ms; sequential would be ~180ms
  });

  it('emits onStep once per step with index + name + output', async () => {
    const events: Array<{ index: number; name?: string; output: string }> = [];
    const fn = parallel([async (input) => `first:${input}`, async (input) => `second:${input}`], {
      onStep: (info) => events.push(info),
    });
    const out = await fn('go');
    expect(out).toEqual(['first:go', 'second:go']);
    expect(events).toHaveLength(2);
    const sorted = [...events].sort((a, b) => a.index - b.index);
    expect(sorted[0]).toEqual({ index: 0, name: undefined, output: 'first:go' });
    expect(sorted[1]).toEqual({ index: 1, name: undefined, output: 'second:go' });
  });

  it('propagates rejection from any step', async () => {
    const fn = parallel([
      async () => 'ok',
      async () => {
        throw new Error('boom');
      },
    ]);
    await expect(fn('x')).rejects.toThrow('boom');
  });

  it('handles an empty step list (returns [])', async () => {
    const fn = parallel([]);
    const out = await fn('anything');
    expect(out).toEqual([]);
  });
});
