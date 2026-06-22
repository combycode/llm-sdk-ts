/** Tiktoken adapter — exact tokenization for OpenAI models. */

import type { Message } from '../../../llm/types/messages';
import type { TokenCountContext, TokenCounter, LearnInput } from '../../../agent/types';

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

    const tiktoken = await import('tiktoken');
    const enc = tiktoken.get_encoding(name as Parameters<typeof tiktoken.get_encoding>[0]);
    const wrapper = {
      encode: (text: string) => Array.from(enc.encode(text)),
    };
    this.encodings.set(name, wrapper);
    return wrapper;
  }
}
