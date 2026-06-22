/** chain — sequential pipeline where each step's output feeds the next.
 *
 *  Each step is either:
 *    - an object describing a `complete()` call with a `prompt(input)`
 *      function that takes the previous output and returns the user prompt,
 *    - or a plain async function `(input: string) => string` (handy for
 *      delegating to an AgentLoop or running custom logic).
 *
 *  Returns a callable. The optional `onStep` callback fires after every
 *  step with its index, optional name, and produced output — perfect for
 *  logging the Input → A → Output → B → Output → ... flow. */

import { complete, type CompleteOptions } from './one-shot';

export interface ChainStepConfig extends Omit<CompleteOptions, 'prompt'> {
  /** Optional label surfaced via `onStep` and useful for debugging. */
  name?: string;
  /** Receives the previous step's output (or the original input on step 1)
   *  and returns the user-visible prompt string for this LLM call. */
  prompt: (input: string) => string;
}

export type ChainStepFn = (input: string) => Promise<string> | string;
export type ChainStep = ChainStepConfig | ChainStepFn;

export interface ChainOptions {
  /** Fires after every step with its index, optional name, and output. */
  onStep?: (info: { index: number; name?: string; output: string }) => void;
}

export function chain(
  steps: ChainStep[],
  options: ChainOptions = {},
): (input: string) => Promise<string> {
  return async (input: string): Promise<string> => {
    let value = input;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let name: string | undefined;
      if (typeof step === 'function') {
        value = await step(value);
      } else {
        name = step.name;
        const { prompt: buildPrompt, name: _name, ...rest } = step;
        const result = await complete({ ...rest, prompt: buildPrompt(value) });
        value = result.text;
      }
      options.onStep?.({ index: i, name, output: value });
    }
    return value;
  };
}
