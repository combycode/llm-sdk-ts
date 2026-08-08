/** Tiktoken adapter — exact tokenization for OpenAI models.
 *
 *  `tiktoken` is an OPTIONAL PEER dependency: it is not installed unless the consumer asks for it,
 *  and nothing here runs until local token counting is actually used. See the standing decisions in
 *  CONSTITUTION.md (2026-08-08).
 */

import type { Message } from '../../../llm/types/messages';
import type { TokenCountContext, TokenCounter, LearnInput } from '../../../agent/types';

/** The module specifier lives in a VARIABLE on purpose — do not inline it back into `import()`.
 *
 *  A string-literal `import('tiktoken')` is statically resolvable, so every bundler (rolldown,
 *  rollup, esbuild, webpack) walks it while building the module graph and emits tiktoken's ~5.6 MB
 *  wasm asset into the consumer's output — even when the code path is never reached. A consumer
 *  reported exactly this on 2026-08-08: the wasm was 88% of their production bundle for a feature
 *  their app never invokes. `sideEffects: false` cannot help, because emitting a dynamic-import
 *  chunk is a graph-resolution outcome, not a dead-code-elimination one.
 *
 *  Since tiktoken is now an optional PEER dependency, a literal is worse than wasteful: it makes
 *  bundlers fail the build outright for everyone who chose not to install it.
 *
 *  A variable specifier is opaque to bundlers and resolves identically at runtime. */
const TIKTOKEN_SPECIFIER = 'tiktoken';

/** Minimal structural shape of the bits of `tiktoken` we use. Declared locally because a variable
 *  specifier is deliberately unresolvable at type level — and because the package must remain
 *  uninstalled without breaking our typecheck. */
interface TiktokenModule {
  get_encoding(name: string): { encode(text: string): Iterable<number> };
}

/** Build the error thrown when the optional peer is missing. Exported for tests; not public API. */
export function tiktokenUnavailableError(cause: unknown): Error {
  return new Error(
    `Local token counting needs the optional peer dependency "tiktoken", which is not installed. ` +
      `Install it (npm i tiktoken) to use exact OpenAI tokenization, or use a counter that does ` +
      `not require it — the heuristic and count-API strategies need no extra packages.`,
    { cause },
  );
}

const MODEL_TO_ENCODING: Record<string, string> = {
  'gpt-5': 'o200k_base',
  'gpt-4o': 'o200k_base',
  'gpt-4.1': 'o200k_base',
  o3: 'o200k_base',
  o4: 'o200k_base',
  'gpt-4': 'cl100k_base',
  'gpt-3.5': 'cl100k_base',
};

function pickEncoding(model: string, override?: string): string {
  if (override) return override;
  for (const [prefix, enc] of Object.entries(MODEL_TO_ENCODING)) {
    if (model.startsWith(prefix)) return enc;
  }
  return 'o200k_base';
}

export class TiktokenCounter implements TokenCounter {
  private encodings = new Map<string, { encode: (text: string) => number[] }>();

  estimate(text: string, ctx?: TokenCountContext): number {
    const encodingName = this.encodingFor(ctx);
    const enc = this.encodings.get(encodingName);
    if (enc) return enc.encode(text).length;
    return Math.ceil(text.length / 3.8);
  }

  estimateMessage(msg: Message, ctx?: TokenCountContext): number {
    const content = msg.content;
    if (typeof content === 'string') return this.estimate(content, ctx);
    let tokens = 0;
    for (const part of content) {
      if (part.type === 'text') tokens += this.estimate(part.text, ctx);
      else if (part.type === 'tool_call') {
        tokens += this.estimate(part.name + JSON.stringify(part.arguments), ctx) + 4;
      } else if (part.type === 'tool_result') {
        const s = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
        tokens += this.estimate(s, ctx);
      } else {
        tokens += 250;
      }
    }
    return tokens;
  }

  async measure(text: string, ctx?: TokenCountContext): Promise<number> {
    const encoder = await this.getEncoder(ctx);
    return encoder.encode(text).length;
  }

  async measureMessage(msg: Message, ctx?: TokenCountContext): Promise<number> {
    const encoder = await this.getEncoder(ctx);
    const content = msg.content;
    if (typeof content === 'string') return encoder.encode(content).length;

    let tokens = 0;
    for (const part of content) {
      if (part.type === 'text') tokens += encoder.encode(part.text).length;
      else if (part.type === 'tool_call') {
        tokens += encoder.encode(part.name + JSON.stringify(part.arguments)).length + 4;
      } else if (part.type === 'tool_result') {
        const s = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
        tokens += encoder.encode(s).length;
      } else {
        tokens += 250;
      }
    }
    return tokens;
  }

  learn(_input: LearnInput): void {
    // Tiktoken is exact — no calibration needed.
  }

  private encodingFor(ctx?: TokenCountContext): string {
    return pickEncoding(ctx?.model ?? '', undefined);
  }

  private async getEncoder(
    ctx?: TokenCountContext,
  ): Promise<{ encode: (text: string) => number[] }> {
    const name = this.encodingFor(ctx);
    const cached = this.encodings.get(name);
    if (cached) return cached;

    let tiktoken: TiktokenModule;
    try {
      tiktoken = (await import(/* @vite-ignore */ /* webpackIgnore: true */ TIKTOKEN_SPECIFIER)) as TiktokenModule;
    } catch (cause) {
      throw tiktokenUnavailableError(cause);
    }
    const enc = tiktoken.get_encoding(name);
    const wrapper = {
      encode: (text: string) => Array.from(enc.encode(text)),
    };
    this.encodings.set(name, wrapper);
    return wrapper;
  }
}
