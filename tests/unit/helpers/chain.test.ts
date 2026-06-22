/** chain() unit tests.
 *  chain() is a sequential pipeline. We exercise it entirely with plain
 *  async-function steps (ChainStepFn) so no LLM network call is needed.
 *  ChainStepConfig steps (those that call complete()) are NOT tested here
 *  since they require a real engine+fetch — those are integration territory. */

import { describe, expect, it } from 'bun:test';
import { chain } from '../../../src/helpers/chain';

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('chain — sequential execution with function steps', () => {
  it('threads output of each step into the next', async () => {
    const fn = chain([
      async (input) => `${input}-A`,
      async (input) => `${input}-B`,
      async (input) => `${input}-C`,
    ]);
    expect(await fn('start')).toBe('start-A-B-C');
  });

  it('single step returns that step output', async () => {
    const fn = chain([async (input) => input.toUpperCase()]);
    expect(await fn('hello')).toBe('HELLO');
  });

  it('zero steps returns the original input', async () => {
    const fn = chain([]);
    expect(await fn('passthrough')).toBe('passthrough');
  });

  it('is callable multiple times independently', async () => {
    const fn = chain([async (s) => `${s}!`]);
    expect(await fn('a')).toBe('a!');
    expect(await fn('b')).toBe('b!');
  });
});

// ─── onStep callback ──────────────────────────────────────────────────────────

describe('chain — onStep callback', () => {
  it('fires once per step with correct index and output', async () => {
    const events: Array<{ index: number; name?: string; output: string }> = [];
    const fn = chain(
      [async (s) => `${s}:1`, async (s) => `${s}:2`],
      { onStep: (info) => events.push(info) },
    );
    await fn('x');
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ index: 0, name: undefined, output: 'x:1' });
    expect(events[1]).toEqual({ index: 1, name: undefined, output: 'x:1:2' });
  });

  it('does not fire when no onStep is provided', async () => {
    // Just ensuring no error is thrown with no onStep.
    const fn = chain([async (s) => s]);
    await expect(fn('quiet')).resolves.toBe('quiet');
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('chain — error propagation', () => {
  it('rejects with the error thrown by any step', async () => {
    const fn = chain([
      async (s) => s,
      async () => { throw new Error('step failed'); },
      async (s) => s,
    ]);
    await expect(fn('x')).rejects.toThrow('step failed');
  });

  it('earlier steps do not run after a failure', async () => {
    const ran: number[] = [];
    const fn = chain([
      async (s) => { ran.push(0); return s; },
      async () => { ran.push(1); throw new Error('boom'); },
      async (s) => { ran.push(2); return s; },
    ]);
    await fn('x').catch(() => null);
    expect(ran).toEqual([0, 1]);
    expect(ran).not.toContain(2);
  });
});

// ─── Mixed sync / async ───────────────────────────────────────────────────────

describe('chain — sync functions in steps', () => {
  it('accepts synchronous functions (ChainStepFn can return string)', async () => {
    const fn = chain([(input) => `${input}+sync`]);
    expect(await fn('base')).toBe('base+sync');
  });
});
