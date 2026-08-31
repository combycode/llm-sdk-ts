/** Browser reentrancy-context fallback (no node:async_hooks). Verifies the
 *  semantics AgentBus relies on: flag visible synchronously inside run(),
 *  nested restore, held across the async lifetime, undefined outside. */

import { describe, expect, it } from 'bun:test';
import { handlerContext } from '../../../src/bus/async-context.browser';

describe('async-context.browser handlerContext', () => {
  it('getStore() is undefined outside any run()', () => {
    expect(handlerContext.getStore()).toBeUndefined();
  });

  it('exposes the flag synchronously inside run()', () => {
    let seen: boolean | undefined;
    handlerContext.run(true, () => {
      seen = handlerContext.getStore();
    });
    expect(seen).toBe(true);
    expect(handlerContext.getStore()).toBeUndefined(); // restored after
  });

  it('restores the previous value when nested (stack discipline)', () => {
    const trail: Array<boolean | undefined> = [];
    handlerContext.run(true, () => {
      trail.push(handlerContext.getStore()); // true
      handlerContext.run(false, () => {
        trail.push(handlerContext.getStore()); // false
      });
      trail.push(handlerContext.getStore()); // back to true
    });
    expect(trail).toEqual([true, false, true]);
  });

  it('holds the flag across an async run and restores after it settles', async () => {
    let duringAwait: boolean | undefined;
    const p = handlerContext.run(true, async () => {
      await Promise.resolve();
      duringAwait = handlerContext.getStore(); // still set while suspended
    });
    await p;
    expect(duringAwait).toBe(true);
    expect(handlerContext.getStore()).toBeUndefined();
  });

  it('restores on a SYNCHRONOUSLY thrown run, and rethrows', () => {
    // The async path restores via .finally(); a sync throw never reaches it, so
    // it needs its own catch. Without it the flag stays stuck on and every later
    // top-level emit is misread as reentrant.
    expect(() =>
      handlerContext.run(true, () => {
        throw new Error('sync boom');
      }),
    ).toThrow('sync boom');
    expect(handlerContext.getStore()).toBeUndefined();
  });

  it('a sync throw NESTED inside a run restores the outer value, not undefined', () => {
    let afterInner: boolean | undefined;
    handlerContext.run(true, () => {
      try {
        handlerContext.run(false, () => {
          throw new Error('inner');
        });
      } catch {
        // swallowed
      }
      afterInner = handlerContext.getStore();
    });
    expect(afterInner).toBe(true);
  });

  it('restores on a thrown async run', async () => {
    await expect(
      handlerContext.run(true, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(handlerContext.getStore()).toBeUndefined();
  });
});
