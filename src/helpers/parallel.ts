/** parallel — fan-out a single input across N steps and collect their
 *  outputs in order. Companion to `chain` (sequential).
 *
 *  Each step is either a `complete()` config with `prompt(input)` or a
 *  plain async function. Optional `onStep` fires per-completion (in
 *  whichever order they finish). */

import { complete } from './one-shot';
import type { ChainStep } from './chain';

export interface ParallelOptions {
  /** Fires once per step as it completes (NOT necessarily in step order). */
  onStep?: (info: { index: number; name?: string; output: string }) => void;
}

export function parallel(
  steps: ChainStep[],
  options: ParallelOptions = {},
): (input: string) => Promise<string[]> {
  return async (input: string): Promise<string[]> => {
    return Promise.all(
      steps.map(async (step, index) => {
        let output: string;
        let name: string | undefined;
        if (typeof step === 'function') {
          output = await step(input);
        } else {
          name = step.name;
          const { prompt: buildPrompt, name: _name, ...rest } = step;
          const result = await complete({ ...rest, prompt: buildPrompt(input) });
          output = result.text;
        }
        options.onStep?.({ index, name, output });
        return output;
      }),
    );
  };
}
